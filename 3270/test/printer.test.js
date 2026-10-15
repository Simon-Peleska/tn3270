// pr3287's own tests (pr3287/Test/testSmoke.py and testPrtodir.py), ported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHost, sharedPort } from "../../test/fakehost.js";
import { PrinterSession } from "../src/printer.js";
import { Session } from "../src/session.js";
import { TRACES } from "./harness.js";
import { codePage, unicodeToEbcdic } from "../src/charset.js";

const fixture = (/** @type {string} */ name) =>
  new URL(`fixtures/printer/${name}`, import.meta.url);
const SILENT = { warn() {}, info() {}, debug() {} };

/**
 * A printer on a fake host, collecting what it prints, one string per job.
 * @param {FakeHost} host @param {Partial<import("../src/printer.js").PrinterOptions>} [options]
 */
function startPrinter(host, options = {}) {
  const printer = new PrinterSession({
    host: "127.0.0.1",
    port: host.port,
    tls: false,
    assoc: null,
    lu: null,
    codePage: codePage("cp037"),
    log: SILENT,
    ...options,
  });
  /** @type {string[]} */
  const jobs = [];
  let open = "";
  printer.on("data", (text) => (open += text));
  printer.on("eoj", () => {
    jobs.push(open);
    open = "";
  });
  return { printer, jobs };
}

/**
 * The trace up to its first "+" mark, which is as far as testSmoke.py plays: how many records
 * the host sends, and what pr3287 answered.
 * @param {URL} trace
 */
function beforeMark(trace) {
  const lines = readFileSync(trace, "utf8").split("\n");
  const head = lines.slice(0, lines.indexOf("+"));
  const hex = (/** @type {string} */ dir) =>
    head
      .filter((line) => line.startsWith(`${dir} 0x`))
      .map((line) => line.trim().split(/\s+/)[2]);
  return {
    records: hex("<").filter((bytes) => bytes.endsWith("ffef")).length,
    sent: hex(">").join(""),
  };
}

test("pr3287 smoke: the trace prints the two jobs pr3287 printed", async (t) => {
  const host = await FakeHost.listen(fixture("smoke.trc").pathname);
  t.after(() => host.close());
  const { printer, jobs } = startPrinter(host, { assoc: "TDC01702" });
  t.after(() => printer.close());
  const { records, sent } = beforeMark(fixture("smoke.trc"));

  await host.sendRecords(records);

  assert.equal(jobs.length, 2);
  assert.equal(jobs[0], readFileSync(fixture("smoke-job1.out"), "latin1"));
  assert.equal(jobs[1], readFileSync(fixture("smoke.out"), "latin1"));
  assert.equal(
    host.received,
    `${sent}fffb06`,
    "every negotiation and response as pr3287 sent it, then the timing mark",
  );
});

const PR3287 = process.env["PR3287_PATH"] ?? "pr3287";
const noPr3287 =
  spawnSync(PR3287, ["-v"], { stdio: "pipe" }).error && "pr3287 not installed";

/** Text in code page 037. @param {string} s */
const e = (s) =>
  [...s].map((c) => unicodeToEbcdic(codePage("cp037"), c.codePointAt(0) ?? 0));

/**
 * A TN3270E host that binds the printer, sends `records` as `dataType` and ends the job,
 * resolving with what the printer answered after the negotiation.
 * @param {number} dataType 0 for 3270, 1 for SCS
 * @param {number[][]} records
 */
async function scriptedHost(dataType, records) {
  const server = net.createServer();
  /** @type {Promise<string>} */
  const answered = new Promise((resolve, reject) => {
    server.once("connection", (socket) => {
      let received = "";
      let step = 0;
      let negotiated = 0;
      const send = (/** @type {number[]} */ bytes) =>
        socket.write(Buffer.from(bytes));
      const header = (
        /** @type {number} */ type,
        /** @type {number} */ seq,
      ) => [type, 0, 2, seq >> 8, seq & 0xff];
      socket.on("data", (chunk) => {
        received += chunk.toString("hex");
        if (step === 0 && received.endsWith("fffb28")) {
          step = 1;
          send([0xff, 0xfa, 0x28, 0x08, 0x02, 0xff, 0xf0]);
        } else if (step === 1 && received.endsWith("fff0")) {
          step = 2;
          send([
            ...[0xff, 0xfa, 0x28, 0x02, 0x04],
            ...Buffer.from("IBM-3287-1\x01LU1"),
            ...[0xff, 0xf0],
          ]);
        } else if (step === 2 && received.endsWith("fff0")) {
          step = 3;
          negotiated = received.length;
          const funcs = received.slice(
            received.lastIndexOf("fffa280307") + 10,
            -4,
          );
          send([
            ...[0xff, 0xfa, 0x28, 0x03, 0x04],
            ...Buffer.from(funcs, "hex"),
            ...[0xff, 0xf0],
          ]);
          send([...header(3, 1), 0x31, 0x01, 0xff, 0xef]);
          records.forEach((record, i) =>
            send([
              ...header(dataType, i + 2),
              ...record.flatMap((b) => (b === 0xff ? [b, b] : [b])),
              0xff,
              0xef,
            ]),
          );
          send([...header(8, 0x7f00), 0xff, 0xef]);
        }
        if (received.endsWith("0200007f0000ffef")) {
          resolve(received.slice(negotiated));
          socket.destroy();
        }
      });
      socket.on("error", reject);
      send([0xff, 0xfd, 0x28]);
    });
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  const address = /** @type {net.AddressInfo} */ (server.address());
  return { port: address.port, answered, close: () => server.close() };
}

/** @param {number} dataType @param {number[][]} records */
async function printWithPr3287(dataType, records) {
  const host = await scriptedHost(dataType, records);
  const out = join(mkdtempSync(join(tmpdir(), "pr3287-")), "out");
  const pr3287 = spawn(
    PR3287,
    [
      "-codepage",
      "cp037",
      "-command",
      `cat >>'${out}'; echo JOB >>'${out}'`,
      `127.0.0.1:${host.port}`,
    ],
    { env: { ...process.env, LC_ALL: "C.UTF-8" }, stdio: "ignore" },
  );
  try {
    const answered = await host.answered;
    const jobs = existsSync(out)
      ? readFileSync(out, "utf8").split("JOB\n").slice(0, -1)
      : [];
    return { jobs, answered };
  } finally {
    pr3287.kill();
    host.close();
  }
}

/** @param {number} dataType @param {number[][]} records */
async function printWithOurs(dataType, records) {
  const host = await scriptedHost(dataType, records);
  const printer = new PrinterSession({
    host: "127.0.0.1",
    port: host.port,
    tls: false,
    assoc: null,
    lu: null,
    codePage: codePage("cp037"),
    log: SILENT,
  });
  /** @type {string[]} */
  const jobs = [];
  let open = "";
  printer.on("data", (text) => (open += text));
  printer.on("eoj", () => {
    jobs.push(open);
    open = "";
  });
  try {
    const answered = await host.answered;
    return { jobs, answered };
  } finally {
    printer.close();
    host.close();
  }
}

const NL = 0x15;
const CR = 0x0d;
const FF = 0x0c;
const BS = 0x16;
const HT = 0x05;
const VT = 0x0b;
const LF = 0x25;
const SCS = 1;
const DS = 0;
/** EraseWrite with a WCC that starts the printer, at the line length given by `bits` (0x10, 0x20, 0x30). */
const ew = (bits = 0) => [0xf5, 0xc8 | bits];
/** A 14-bit buffer address. @param {number} a */
const addr = (a) => [(a >> 8) & 0x3f, a & 0xff];

/** @type {Array<[string, number, number[][]]>} */
const CASES = [
  ["SCS lines", SCS, [[...e("HELLO"), NL, ...e("WORLD"), NL]]],
  [
    "SCS carriage return and backspace overprint",
    SCS,
    [[...e("ABC"), CR, ...e("X"), BS, ...e("Y"), NL]],
  ],
  ["SCS form feed", SCS, [[...e("PAGE1"), FF, ...e("PAGE2"), NL, FF]]],
  [
    "SCS horizontal tabs from SHF",
    SCS,
    [
      [
        0x2b,
        0xc1,
        0x05,
        0x28,
        0x01,
        0x0a,
        0x14,
        ...e("A"),
        HT,
        ...e("B"),
        HT,
        ...e("C"),
        NL,
      ],
    ],
  ],
  [
    "SCS vertical format from SVF",
    SCS,
    [
      [
        0x2b,
        0xc2,
        0x05,
        0x0c,
        0x02,
        0x0b,
        0x06,
        ...e("X"),
        VT,
        ...e("Y"),
        LF,
        ...e("Z"),
        NL,
        FF,
        ...e("NEXT"),
        NL,
      ],
    ],
  ],
  ["SCS line density", SCS, [[0x2b, 0xc6, 0x02, 0x00, ...e("D"), NL]]],
  // pr3287 writes transparent bytes out raw, which only matches our code points for ASCII.
  [
    "SCS transparent data",
    SCS,
    [[0x35, 0x04, 0x41, 0x42, 0x43, ...e("!"), NL]],
  ],
  [
    "SCS a line past the right margin wraps",
    SCS,
    [[...e("0123456789".repeat(15)), NL]],
  ],
  ["SCS non-ASCII characters", SCS, [[...e("Grüße & <x> {y} ¬¢"), NL]]],
  [
    "SCS controls split across records",
    SCS,
    [
      [...e("ONE"), 0x2b, 0xc1],
      [0x03, 0x14, ...e("TWO"), NL],
    ],
  ],
  [
    "SCS indent and interchange record",
    SCS,
    [[0x24, ...e("I"), 0x14, ...e("E"), 0x1e, ...e("R"), NL]],
  ],
  ["SCS two jobs", SCS, [[...e("FIRST"), NL]]],
  [
    "3270 unformatted lines",
    DS,
    [[...ew(), ...e("HELLO"), NL, ...e("WORLD"), NL, 0x19]],
  ],
  ["3270 line length 40", DS, [[...ew(0x10), ...e("x".repeat(100))]]],
  ["3270 line length 64", DS, [[...ew(0x20), ...e("y".repeat(100))]]],
  [
    "3270 line length 80 with CR and FF",
    DS,
    [[...ew(0x30), ...e("ABC"), CR, ...e("D"), NL, FF, ...e("E")]],
  ],
  [
    "3270 formatted fields, one invisible",
    DS,
    [
      [
        ...ew(0x30),
        0x11,
        ...addr(0),
        0x1d,
        0x60,
        ...e("VISIBLE"),
        0x1d,
        0x4c,
        ...e("SECRET"),
        0x1d,
        0x60,
        ...e("AGAIN"),
        0x11,
        ...addr(160),
        ...e("ROW3"),
      ],
    ],
  ],
  [
    "3270 repeat to address",
    DS,
    [[...ew(0x30), 0x3c, ...addr(30), ...e("*"), ...e("END")]],
  ],
  [
    "3270 write after erase write",
    DS,
    [
      [...ew(), ...e("ONE"), NL],
      [0xf1, 0xc8, ...e("TWO"), NL],
    ],
  ],
  [
    "3270 erase all unprotected",
    DS,
    [[...ew(), ...e("GONE"), NL], [0x6f], [0xf1, 0xc8, ...e("KEPT"), NL]],
  ],
  ["3270 bad command is rejected", DS, [[0x99, ...e("NO")]]],
  ["3270 read partition query", DS, [[0xf3, 0x00, 0x05, 0x01, 0xff, 0x02]]],
];

/**
 * pr3287 4.5 tests set_uni_dbcs() == 0, but it returns true on success, so for a single-byte
 * code page its query replies claim DBCS: undone here, as we answer what pr3287 means to.
 * @param {string} hex
 */
function withoutDbcsBug(hex) {
  return hex
    .replace("000e81808081848586878891a695", "000d818080818485868788a695")
    .replace(
      "002e81858e000a14000000000b0000000000000002b900250110f10000000003c301368020f81414417f00000025",
      "001b818582000a14000000000700100002b900250110f103c30136",
    )
    .replace("000b819100030180030201", "");
}

for (const [name, dataType, records] of CASES) {
  test(
    `like pr3287: ${name}`,
    { skip: noPr3287, timeout: 10_000 },
    async () => {
      const [theirs, ours] = await Promise.all([
        printWithPr3287(dataType, records),
        printWithOurs(dataType, records),
      ]);
      assert.deepEqual(ours.jobs, theirs.jobs);
      assert.equal(ours.answered, withoutDbcsBug(theirs.answered));
    },
  );
}

test("printerLu . associates a printer with the session's LU and hands out its jobs", async (t) => {
  process.env["PRINTER_DELAY_MS"] = "1";
  const display = await FakeHost.listen(`${TRACES}lu.trc`);
  t.after(() => display.close());
  const printerHost = await FakeHost.listen(fixture("smoke.trc").pathname);
  t.after(() => printerHost.close());
  const shared = await sharedPort([display.port, printerHost.port]);
  t.after(() => shared.close());
  const session = new Session({ model: "3278-4-E", printerLu: "." });
  t.after(() => session.close());
  /** @type {any[]} */
  const printerOia = [];
  session.indications(({ kind, body }) => {
    if (kind === "oia" && body.field === "printer-session")
      printerOia.push(body);
  });
  /** @type {string[]} */
  const jobs = [];
  let open = "";
  session.on("print", (text) => (open += text));
  session.on("print-end", () => {
    jobs.push(open);
    open = "";
  });

  await session.connect("127.0.0.1", shared.port);
  await display.sendRecords(1);
  assert.equal(session.s.connectedLu, "IBM0TE01");
  await printerHost.sendRecords(beforeMark(fixture("smoke.trc")).records);

  assert.deepEqual(jobs, [
    readFileSync(fixture("smoke-job1.out"), "latin1"),
    readFileSync(fixture("smoke.out"), "latin1"),
  ]);
  assert.match(
    printerHost.received,
    new RegExp(
      `^fffb28fffa2802074942\\w+00${Buffer.from("IBM0TE01").toString("hex")}fff0`,
    ),
    "the printer asks to be associated with the display's LU",
  );
  assert.deepEqual(printerOia, [
    { field: "printer-session", value: true, lu: "IBM0TE01" },
  ]);

  session.disconnect();
  await printerHost.waitUntil(
    () => printerOia.length === 2,
    5000,
    "the printer did not stop with the display",
  );
  assert.deepEqual(printerOia[1], { field: "printer-session", value: false });
});
