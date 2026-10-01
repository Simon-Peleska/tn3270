import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { connect, createServer } from "node:net";
import { createInterface } from "node:readline";
import { FakeHost, parseTrace } from "../../test/fakehost.js";
import { Session } from "../src/index.js";
import { CSTATE_NAMES } from "../src/ui.js";
import { TRACES, UNLOCK_KEYBOARD, noB3270, startB3270 } from "./harness.js";

// Every trace is replayed into our Session and into a real s3270 with the same options.
// Everything each one sends to the host, from the first TELNET byte on, must match,
// and so must the screen, the status line and which actions fail.

const S3270 = process.env["S3270_PATH"] ?? "s3270";
const haveS3270 = !spawnSync(S3270, ["-v"], { stdio: "pipe" }).error;

/** @type {Record<string, string>} */
const SKIPPED = {};

/** Actions after which s3270 waits for the host to unlock the keyboard. */
const AID_ACTIONS = new Set(["Enter", "PF", "PA", "Clear"]);

/**
 * @typedef {[string, ...(string | number)[]]} Action
 * @typedef {{ sent: string, screen: string[], status: string, results: boolean[] }} Outcome
 */

/** Pseudo-action: the host sends this text as TN3270E NVT data. */
const HOST_NVT = "HostNvt";

/** @param {FakeHost} host @param {string} text */
async function sendNvt(host, text) {
  const body = [...Buffer.from(text, "utf8")].flatMap((b) =>
    b === 0xff ? [0xff, 0xff] : [b],
  );
  host.socket?.write(Buffer.from([0x05, 0, 0, 0, 0, ...body, 0xff, 0xef]));
  await host.sendTimingMark();
}

/** @param {string} trace */
function recordCount(trace) {
  return parseTrace(TRACES + trace).filter((hex) => hex.endsWith("ffef"))
    .length;
}

/** @param {FakeHost} host @param {number} from */
function recordsSince(host, from) {
  return host.received
    .slice(from)
    .split(/(?<=ffef)/)
    .filter((record) => record.endsWith("ffef")).length;
}

/** Waits for the emulator's AID record, then unlocks the keyboard. @param {FakeHost} host @param {number} from @param {number} count */
async function answerAid(host, from, count) {
  await host.waitUntil(
    () => recordsSince(host, from) >= count,
    5000,
    "emulator sent no record",
  );
  host.socket?.write(UNLOCK_KEYBOARD);
  await host.sendTimingMark();
}

/** What b3270's Query() tells about the session, in the same shape for both sides. @param {Session} session */
function b3270Status(session) {
  const s = session.s;
  const row = Math.floor(s.cursor / s.cols) + 1;
  const column = (s.cursor % s.cols) + 1;
  return (
    `${CSTATE_NAMES[s.cstate]} lock ${s.kybdlock !== 0} ${s.formatted ? "formatted" : "unformatted"} ` +
    `rows ${s.rows} columns ${s.cols} row ${row} column ${column}`
  );
}

/**
 * @param {string} trace @param {Action[]} actions @param {boolean} nvt @param {"s3270" | "b3270"} frontend
 * @returns {Promise<Outcome>}
 */
async function withOurs(trace, actions, nvt, frontend) {
  const host = await FakeHost.listen(TRACES + trace);
  const session = new Session({ frontend, model: "3279-4-E" });
  try {
    const connected = session.connect("127.0.0.1", host.port);
    await host.sendRecords(recordCount(trace));
    await connected;
    const from = host.received.length;
    let aids = 0;
    /** @type {boolean[]} */
    const results = [];
    for (const [name, ...args] of actions) {
      if (name === HOST_NVT) {
        await sendNvt(host, String(args[0]));
        continue;
      }
      results.push(/** @type {boolean} */ (session.action(name, ...args)));
      if (!nvt && AID_ACTIONS.has(name)) await answerAid(host, from, ++aids);
    }
    await host.sendTimingMark();
    const status =
      frontend === "s3270" ? session.status() : b3270Status(session);
    return { sent: host.received, screen: session.text(), status, results };
  } finally {
    session.close();
    await host.close();
  }
}

/**
 * A command channel to s3270: one action per line, answered by data lines, a status line and ok/error.
 * @param {import("node:net").Socket} socket
 */
function channel(socket) {
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  /** @param {string} action @returns {Promise<{ok: boolean, data: string[], status: string}>} */
  return async (action) => {
    socket.write(`${action}\n`);
    /** @type {string[]} */
    const data = [];
    let status = "";
    for (;;) {
      const { value, done } = await lines.next();
      if (done) throw new Error(`s3270 went away during ${action}`);
      if (value === "ok" || value === "error")
        return { ok: value === "ok", data, status };
      if (value.startsWith("data: ")) data.push(value.slice(6));
      else status = value;
    }
  };
}

/** @returns {Promise<number>} */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  const address = /** @type {import("node:net").AddressInfo} */ (
    server.address()
  );
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

/**
 * Starts s3270 with two command channels: Connect() blocks one of them until the host
 * reaches 3270 mode, which some traces never do, so everything else goes over the other.
 */
async function startS3270() {
  const callback = createServer();
  await new Promise((resolve) =>
    callback.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  const scriptPort = await freePort();
  const port = /** @type {import("node:net").AddressInfo} */ (
    callback.address()
  ).port;
  const process = spawn(
    S3270,
    [
      "-model",
      "3279-4-E",
      "-callback",
      String(port),
      "-scriptport",
      `127.0.0.1:${scriptPort}`,
    ],
    {
      stdio: "ignore",
    },
  );
  const connecting = await new Promise((resolve) =>
    callback.once("connection", resolve),
  );
  callback.close();
  const commands = connect(scriptPort, "127.0.0.1");
  await new Promise((resolve, reject) =>
    commands.once("connect", resolve).once("error", reject),
  );
  return {
    connect: channel(connecting),
    run: channel(commands),
    stop() {
      commands.destroy();
      connecting.destroy();
      process.kill();
    },
  };
}

/** x3270's quoted action arguments keep backslashes as they are, except before a quote. @param {string | number} arg */
function quote(arg) {
  return `"${String(arg).replaceAll('"', '\\"')}"`;
}

/** @param {string} trace @param {Action[]} actions @param {boolean} nvt @returns {Promise<Outcome>} */
async function withS3270(trace, actions, nvt) {
  const host = await FakeHost.listen(TRACES + trace);
  const s3270 = await startS3270();
  try {
    s3270.connect(`Connect(127.0.0.1:${host.port})`).catch(() => {});
    await host.sendRecords(recordCount(trace));
    const from = host.received.length;
    let aids = 0;
    /** @type {boolean[]} */
    const results = [];
    for (const [name, ...args] of actions) {
      if (name === HOST_NVT) {
        await sendNvt(host, String(args[0]));
        continue;
      }
      // An AID action only finishes once the host unlocks the keyboard.
      const done = s3270.run(`${name}(${args.map(quote).join(",")})`);
      if (!nvt && AID_ACTIONS.has(name)) await answerAid(host, from, ++aids);
      results.push((await done).ok);
    }
    await host.sendTimingMark();
    const ascii = await s3270.run("Ascii()");
    const status = ascii.status.split(" ").slice(0, 10).join(" ");
    return { sent: host.received, screen: ascii.data, status, results };
  } finally {
    s3270.stop();
    await host.close();
  }
}

/** @param {string} trace @param {Action[]} actions @param {boolean} nvt @returns {Promise<Outcome>} */
async function withB3270(trace, actions, nvt) {
  const host = await FakeHost.listen(TRACES + trace);
  const b3270 = startB3270();
  try {
    b3270.run("Connect", [`127.0.0.1:${host.port}`]);
    await host.sendRecords(recordCount(trace));
    const from = host.received.length;
    let aids = 0;
    /** @type {boolean[]} */
    const results = [];
    for (const [name, ...args] of actions) {
      if (name === HOST_NVT) {
        await sendNvt(host, String(args[0]));
        continue;
      }
      const done = b3270.run(name, args);
      if (!nvt && AID_ACTIONS.has(name)) await answerAid(host, from, ++aids);
      results.push((await done).success);
    }
    await host.sendTimingMark();
    const screen = (await b3270.run("Ascii")).text ?? [];
    /** @param {string} key */
    const query = async (key) =>
      (await b3270.run("Query", [key])).text?.[0] ?? "";
    const cursor = (await query("Cursor1")).replace(/ offset \d+$/, "");
    const status =
      `${await query("ConnectionState")} lock ${await query("KeyboardLock")} ${await query("Formatted")} ` +
      `${await query("ScreenSizeCurrent")} ${cursor}`;
    return { sent: host.received, screen, status, results };
  } finally {
    b3270.stop();
    await host.close();
  }
}

/**
 * Checks us against s3270 and, with the b3270 front end, against b3270.
 * In NVT mode AID keys send escape sequences, so there is no AID record to answer.
 * @param {string} trace @param {Action[]} actions @param {{nvt?: boolean}} [options]
 */
async function compare(trace, actions, { nvt = false } = {}) {
  const [oursS, s3270, oursB, b3270] = await Promise.all([
    withOurs(trace, actions, nvt, "s3270"),
    withS3270(trace, actions, nvt),
    noB3270 ? undefined : withOurs(trace, actions, nvt, "b3270"),
    noB3270 ? undefined : withB3270(trace, actions, nvt),
  ]);
  for (const [name, ours, theirs] of /** @type {const} */ ([
    ["s3270", oursS, s3270],
    ["b3270", oursB, b3270],
  ])) {
    if (!ours || !theirs) continue;
    assert.equal(ours.sent, theirs.sent, `${name}: bytes sent to the host`);
    assert.deepEqual(ours.screen, theirs.screen, `${name}: screen`);
    assert.equal(ours.status, theirs.status, `${name}: status`);
    assert.deepEqual(ours.results, theirs.results, `${name}: action results`);
  }
}

const noS3270 = !haveS3270 && "s3270 not installed";

describe("traces", { concurrency: 16 }, () => {
  for (const trace of readdirSync(TRACES).filter((name) =>
    name.endsWith(".trc"),
  )) {
    test(
      `${trace} replays like s3270`,
      { skip: noS3270 || SKIPPED[trace], timeout: 20_000 },
      () => compare(trace, []),
    );
  }
});

test(
  "typing into fields and pressing Enter",
  { skip: noS3270, timeout: 20_000 },
  () =>
    compare("three-fields.trc", [
      ["String", "abc"],
      ["Tab"],
      ["String", "xy"],
      ["Enter"],
    ]),
);

test("PA1 sends only the AID", { skip: noS3270, timeout: 20_000 }, () =>
  compare("fields.trc", [
    ["String", "123"],
    ["PA", 1],
  ]),
);

test(
  "Clear sends the AID and blanks the screen",
  { skip: noS3270, timeout: 20_000 },
  () => compare("fields.trc", [["Clear"]]),
);

test(
  "editing keys leave the same fields",
  { skip: noS3270, timeout: 20_000 },
  () =>
    compare("three-fields.trc", [
      ["String", "abc"],
      ["Left"],
      ["Left"],
      ["Delete"],
      ["Tab"],
      ["String", "xyz"],
      ["BackTab"],
      ["EraseEOF"],
      ["Tab"],
      ["Tab"],
      ["String", "q"],
      ["Enter"],
    ]),
);

const ESC = "\x1b";

test(
  "NVT cursor motion, erasing and editing",
  { skip: noS3270, timeout: 20_000 },
  () =>
    compare("nvt-data.trc", [
      [
        HOST_NVT,
        `${ESC}[2J${ESC}[H0123456789\r\nabcdefghij${ESC}[5;10Hmid${ESC}[2A<${ESC}[3B>${ESC}[4D!${ESC}[20C?`,
      ],
      [
        HOST_NVT,
        `${ESC}[1;3H${ESC}[2P${ESC}[2;4H${ESC}[3@${ESC}[4hINS${ESC}[4l${ESC}[5;1H${ESC}[K${ESC}[6;5H${ESC}[1K`,
      ],
      [
        HOST_NVT,
        `${ESC}[3;1HL3\r\nL4\r\nL5${ESC}[4;1H${ESC}[2L${ESC}[1;1H${ESC}[M${ESC}[10G@${ESC}[8d#${ESC}[s`,
      ],
      [
        HOST_NVT,
        `\ttab\tx${ESC}[1;20H${ESC}H${ESC}[1;1H\t=${ESC}[3g\t+${ESC}7${ESC}[40;70Hfar${ESC}8saved${ESC}[6n${ESC}[5n${ESC}[c`,
      ],
    ]),
);

test(
  "NVT wrapping, scrolling regions and the alternate screen",
  { skip: noS3270, timeout: 20_000 },
  () =>
    compare("nvt-data.trc", [
      [
        HOST_NVT,
        `${ESC}[2J${ESC}[1;75Hwrapping-past-the-edge${ESC}[?7l${ESC}[3;75Hno-wrap-here${ESC}[?7h`,
      ],
      [
        HOST_NVT,
        `${ESC}[5;10r${ESC}[10;1Hone\ntwo\nthree${ESC}M${ESC}[5;1H${ESC}M${ESC}Mrev${ESC}Edown${ESC}[r`,
      ],
      [
        HOST_NVT,
        `${ESC}[43;1Hbottom\n\nscrolled${ESC}[?1049hALT${ESC}[2;2Halt-screen${ESC}[?1049lback`,
      ],
      [
        HOST_NVT,
        `${ESC}[20;1H${ESC}[1;31;44mcolor${ESC}[0m${ESC}(0lqqk${ESC}(B${ESC})0\x0eqq\x0f${ESC}(A#`,
      ],
      [
        HOST_NVT,
        `${ESC}[25;1Hgrüße € 日本語 bad:\xff\xfe ok${ESC}[25;2H漢${ESC}[26;80H字${ESC}]0;title\x07after`,
      ],
    ]),
);

test(
  "NVT keys follow application cursor mode",
  { skip: noS3270, timeout: 20_000 },
  () =>
    compare(
      "nvt-data.trc",
      [
        ["Up"],
        ["Left"],
        ["Home"],
        ["PF", 1],
        ["PF", 5],
        ["PF", 24],
        ["PA", 2],
        ["Clear"],
        ["PageUp"],
        [HOST_NVT, `${ESC}[?1h`],
        ["Up"],
        ["Right"],
        ["Down"],
        ["Home"],
        [HOST_NVT, `${ESC}[?1l`],
        ["Down"],
        ["String", "hi\\n"],
      ],
      { nvt: true },
    ),
);

test(
  "NVT line mode edits locally and sends whole lines",
  { skip: noS3270, timeout: 20_000 },
  () =>
    compare(
      "nvt-data.trc",
      [
        ["String", "abc def\\x17gh\\x08i\\x7fj"],
        ["String", "\\x12 more\\x15xyz\\x16\\x08\\x5c\\x08 \\n"],
        ["String", "日本\\x08語\\x17wide\\n"],
        ["String", "dropped\\x03 after\\x1c quit\\x04"],
      ],
      { nvt: true },
    ),
);
