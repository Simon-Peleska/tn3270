import { createServer } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTrace } from "./fakehost.js";
import { CODE_PAGE_CHARTS } from "../public/codepages.js";

/**
 * A fake host made from a session recording, the JSON the Recorder panel saves.
 * It shows the first recorded screen and answers each AID key the recording
 * pressed with the screen that came after it. Any other AID gets the current
 * screen again; past the end, the last one stays. Every connection starts over.
 *
 *   npm run start:recording -- recording.json [--codepage cp273]
 *
 * starts it together with the server, on the recording's model.
 */

/**
 * @typedef {import('../server/protocol.js').PaintMessage} Paint
 * @typedef {{ row: number, col: number, length: number }[]} Hidden
 * @typedef {{ paint: Paint, hidden: Hidden }} Screen
 * @typedef {Screen & { aid: string }} Answer what one AID key brings
 * @typedef {{ model: number, first: Screen, answers: Answer[] }} Script
 */

const MODELS = { "24x80": 2, "32x80": 3, "43x80": 4, "27x132": 5 };

/** AID key → byte the emulator sends for it. */
const AIDS = new Map([
  ["Enter", 0x7d],
  ["Clear", 0x6d],
  ["PA1", 0x6c],
  ["PA2", 0x6e],
  ["PA3", 0x6b],
  ...[
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c,
    0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c,
  ].map((byte, i) => /** @type {[string, number]} */ ([`PF${i + 1}`, byte])),
]);

const COLORS = [
  "neutralBlack",
  "blue",
  "red",
  "pink",
  "green",
  "turquoise",
  "yellow",
  "neutralWhite",
  "black",
  "deepBlue",
  "orange",
  "purple",
  "paleGreen",
  "paleTurquoise",
  "grey",
  "white",
];

/** 6-bit values as a 3270 buffer address or field attribute carries them. */
const CODES = [
  0x40, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c,
  0x4d, 0x4e, 0x4f, 0x50, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
  0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
  0xe7, 0xe8, 0xe9, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0xf0, 0xf1, 0xf2, 0xf3,
  0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f,
];

const SBA = 0x11,
  IC = 0x13,
  SA = 0x28,
  SFE = 0x29,
  EWA = 0x7e,
  WCC_RESTORE = 0xc2;
const IAC = 0xff,
  EOR = 0xef;

/**
 * The screen the host showed before each AID key and the one after it. A
 * recorded step holds the screen as it stood when that step's input arrived,
 * so the screen an AID brought is the one the next step saw.
 *
 * @param {import('../public/recorder.js').Recording} recording
 * @returns {Script}
 */
export function recordedScript(recording) {
  const steps = recording.steps;
  if (steps.length === 0) throw new Error("the recording has no steps");
  const first = screenOf(steps[0]);
  const size = `${first.paint.size?.rows}x${first.paint.size?.cols}`;
  const model = MODELS[/** @type {keyof typeof MODELS} */ (size)];
  if (model === undefined)
    throw new Error(`a ${size} screen is no 3270 model's size`);

  /** @type {Answer[]} */
  const answers = [];
  steps.forEach((step, i) => {
    const aid =
      step.action === "PF" || step.action === "PA"
        ? `${step.action}${step.args?.[0] ?? ""}`
        : (step.action ?? "");
    const next = steps[i + 1];
    if (AIDS.has(aid) && next !== undefined)
      answers.push({ aid, ...screenOf(next) });
  });
  return { model, first, answers };
}

/**
 * Older recordings have only the screen's text: it comes back unformatted,
 * so every cell takes input and nothing has colour.
 *
 * @param {import('../server/protocol.js').RecorderStep} step
 * @returns {Screen}
 */
function screenOf(step) {
  const hidden = step.hidden ?? [];
  if (step.paint?.size !== undefined) return { paint: step.paint, hidden };
  const paint = {
    type: "paint",
    full: true,
    color: false,
    fieldsFormatted: false,
    size: { rows: step.screen.length, cols: step.screen[0]?.length ?? 0 },
    rows: step.screen.map((text, row) => ({ row, runs: [{ col: 0, text }] })),
    cursor: { ...(step.cursor ?? { row: 0, col: 0 }), on: true },
  };
  return { paint: /** @type {Paint} */ (paint), hidden };
}

/**
 * A paint as the Erase/Write Alternate that draws it, in a TN3270E record.
 * A field attribute goes wherever editable cells start or end, on the cell
 * before an input field and the first cell after it — where a real host's are,
 * and blank on the screen. Colours and highlighting go in each field's SFE,
 * and in SA orders where a cell differs from its field. A hidden field is
 * non-display, so what is typed into it stays unseen.
 *
 * @param {Screen} screen
 * @param {string} page the code page's chart, EBCDIC 0x40 to 0xFF
 * @returns {Buffer}
 */
export function screenRecord({ paint, hidden }, page) {
  const { rows, cols } = paint.size ?? { rows: 24, cols: 80 };
  const total = rows * cols;
  const cells = Array.from({ length: total }, () => ({
    ch: " ",
    fg: 0,
    hl: 0,
    gr: "",
    editable: false,
    hidden: false,
  }));
  for (const { row, runs } of paint.rows) {
    for (const run of runs) {
      [...run.text].forEach((ch, i) => {
        const cell = cells[row * cols + run.col + i];
        if (cell === undefined) return;
        const gr = run.gr ?? "";
        cell.ch = ch;
        cell.fg = run.fg ? 0xf0 + Math.max(0, COLORS.indexOf(run.fg)) : 0;
        cell.hl = gr.includes("reverse")
          ? 0xf2
          : gr.includes("underline")
            ? 0xf4
            : gr.includes("blink")
              ? 0xf1
              : 0;
        cell.gr = gr;
        cell.editable = run.editable === true;
      });
    }
  }
  for (const { row, col, length } of hidden)
    for (let i = 0; i < length; i++) {
      const cell = cells[row * cols + col + i];
      if (cell !== undefined) cell.hidden = true;
    }

  /** @type {Map<number, boolean>} attribute position → protected */
  const attributes = new Map();
  if (paint.fieldsFormatted) {
    for (let i = 0; i < total; i++) {
      const before = cells[(i - 1 + total) % total];
      if (before.editable && !cells[i].editable) attributes.set(i, true);
    }
    for (let i = 0; i < total; i++) {
      const before = (i - 1 + total) % total;
      if (!cells[before].editable && cells[i].editable)
        attributes.set(before, false);
    }
    if (attributes.size === 0) attributes.set(0, !cells[0].editable);
  }

  /** @type {number[]} */
  const bytes = [0, 0, 0, 0, 0, EWA, WCC_RESTORE, SBA, ...address(0, total)];
  let fieldFg = 0,
    fieldHl = 0,
    fg = 0,
    hl = 0;
  for (let i = 0; i < total; i++) {
    const isProtected = attributes.get(i);
    if (isProtected !== undefined) {
      const first = cells[(i + 1) % total];
      const intensity = first.hidden
        ? 0x0c
        : first.gr.includes("highlight")
          ? 0x08
          : first.gr.includes("selectable")
            ? 0x04
            : 0;
      const pairs = [0xc0, CODES[(isProtected ? 0x20 : 0) | intensity]];
      if (first.fg) pairs.push(0x42, first.fg);
      if (first.hl) pairs.push(0x41, first.hl);
      bytes.push(SFE, pairs.length / 2, ...pairs);
      fieldFg = first.fg;
      fieldHl = first.hl;
      fg = 0;
      hl = 0;
      continue;
    }
    const cell = cells[i];
    if ((fg || fieldFg) !== cell.fg) {
      fg = cell.fg;
      bytes.push(SA, 0x42, fg);
    }
    if ((hl || fieldHl) !== cell.hl) {
      hl = cell.hl;
      bytes.push(SA, 0x41, hl);
    }
    const at = [...page].indexOf(cell.ch);
    bytes.push(at < 0 ? 0x40 : 0x40 + at);
  }
  if (paint.cursor)
    bytes.push(
      SBA,
      ...address(paint.cursor.row * cols + paint.cursor.col, total),
      IC,
    );

  const escaped = bytes.flatMap((byte) => (byte === IAC ? [IAC, IAC] : byte));
  return Buffer.from([...escaped, IAC, EOR]);
}

/**
 * 12-bit addresses while they reach, 14-bit past them.
 * @param {number} at
 * @param {number} total
 */
function address(at, total) {
  if (total <= 4096) return [CODES[(at >> 6) & 0x3f], CODES[at & 0x3f]];
  return [(at >> 8) & 0x3f, at & 0xff];
}

/**
 * The TELNET side of fields.trc, telling the emulator the recording's model.
 * @param {number} model
 * @returns {Buffer[]}
 */
function negotiation(model) {
  const trace = new URL("traces/fields.trc", import.meta.url).pathname;
  return parseTrace(trace)
    .filter((hex) => hex.startsWith("ff"))
    .map((hex) =>
      hex.startsWith("fffa280204")
        ? Buffer.concat([
            Buffer.from([IAC, 0xfa, 0x28, 0x02, 0x04]),
            Buffer.from(`IBM-3278-${model}-E`, "ascii"),
            Buffer.from([0x01]),
            Buffer.from("IBM0TEQO", "ascii"),
            Buffer.from([IAC, 0xf0]),
          ])
        : Buffer.from(hex, "hex"),
    );
}

export class RecordingHost {
  /**
   * @param {import('../public/recorder.js').Recording} recording
   * @param {{ port?: number, codePage?: string, log?: (line: string) => void }} [options]
   * @returns {Promise<RecordingHost>}
   */
  static async listen(recording, options = {}) {
    const host = new RecordingHost(recording, options);
    await new Promise((resolve, reject) => {
      host.server.once("error", reject);
      host.server.listen(options.port ?? 0, "127.0.0.1", () => {
        host.server.removeListener("error", reject);
        resolve(undefined);
      });
    });
    return host;
  }

  /**
   * @param {import('../public/recorder.js').Recording} recording
   * @param {{ codePage?: string, log?: (line: string) => void }} options
   */
  constructor(recording, { codePage: name = "cp273", log = () => {} }) {
    this.script = recordedScript(recording);
    const page =
      CODE_PAGE_CHARTS[/** @type {keyof typeof CODE_PAGE_CHARTS} */ (name)];
    if (page === undefined) throw new Error(`no chart for code page ${name}`);
    const first = screenRecord(this.script.first, page);
    const answers = this.script.answers.map((answer) => ({
      aid: /** @type {number} */ (AIDS.get(answer.aid)),
      name: answer.aid,
      record: screenRecord(answer, page),
    }));
    const telnet = negotiation(this.script.model);
    /** @type {Set<import('node:net').Socket>} */
    this.sockets = new Set();

    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.setNoDelay(true);
      socket.on("error", () => {});
      log(`emulator connected; showing screen 0 of ${answers.length}`);
      for (const bytes of telnet) socket.write(bytes);
      socket.write(first);

      let next = 0;
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk.toString("latin1");
        const records = pending.split("\xff\xef");
        pending = records.pop() ?? "";
        for (const record of records) {
          // A 3270-DATA header is three zero bytes and a sequence number; the
          // first record still has the emulator's TELNET replies in front.
          const header = record.indexOf("\0\0\0");
          if (header < 0) continue;
          const aid = record.charCodeAt(header + 5);
          const expected = answers[next];
          if (expected !== undefined && aid === expected.aid) {
            next += 1;
            log(`${expected.name}: screen ${next} of ${answers.length}`);
            socket.write(expected.record);
            continue;
          }
          log(
            `AID 0x${aid.toString(16)} where the recording ${expected ? `pressed ${expected.name}` : "ends"}: screen ${next} again`,
          );
          socket.write(next === 0 ? first : answers[next - 1].record);
        }
      });
    });
  }

  /** @returns {number} */
  get port() {
    const address = this.server.address();
    if (address === null || typeof address === "string")
      throw new Error("RecordingHost is not listening on a TCP port");
    return address.port;
  }

  /** @returns {Promise<void>} */
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(() => resolve(undefined)));
  }
}

// npm run start:recording -- recording.json [--codepage cp273]
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))
) {
  const args = process.argv.slice(2);
  const pageAt = args.indexOf("--codepage");
  const page = pageAt >= 0 ? args.splice(pageAt, 2)[1] : "cp273";
  const file = args[0];
  if (file === undefined) {
    process.stderr.write(
      "usage: npm run start:recording -- recording.json [--codepage german]\n",
    );
    process.exit(2);
  }
  const host = await RecordingHost.listen(
    JSON.parse(readFileSync(file, "utf8")),
    { codePage: page, log: (line) => process.stdout.write(`${line}\n`) },
  );
  const { model, answers } = host.script;
  process.stdout.write(
    `fake host from ${file} on 127.0.0.1:${host.port}: model ${model}, ${answers.length} AID key(s): ${answers.map((answer) => answer.aid).join(" ")}\n`,
  );

  const config = join(tmpdir(), `tn3270-recording-${process.pid}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 8017 },
      b3270: {
        model,
        tls: false,
        defaultHost: `127.0.0.1:${host.port}`,
        settings: { codePage: page },
      },
      logLevel: "info",
    }),
  );
  process.env["TN3270_CONFIG"] = config;
  await import("../server/main.js");
}
