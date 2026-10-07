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
import { screenText, statusString } from "./read.js";

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
 * @param {string} trace @param {Action[]} actions @param {"s3270" | "b3270"} frontend
 * @returns {Promise<Outcome>}
 */
async function withOurs(trace, actions, frontend) {
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
      results.push(/** @type {boolean} */ (session.action(name, ...args)));
      if (AID_ACTIONS.has(name)) await answerAid(host, from, ++aids);
    }
    await host.sendTimingMark();
    const status =
      frontend === "s3270" ? statusString(session.s) : b3270Status(session);
    return {
      sent: host.received,
      screen: screenText(session.s),
      status,
      results,
    };
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

/** @param {string} trace @param {Action[]} actions @returns {Promise<Outcome>} */
async function withS3270(trace, actions) {
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
      // An AID action only finishes once the host unlocks the keyboard.
      const done = s3270.run(`${name}(${args.map(quote).join(",")})`);
      if (AID_ACTIONS.has(name)) await answerAid(host, from, ++aids);
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

/** @param {string} trace @param {Action[]} actions @returns {Promise<Outcome>} */
async function withB3270(trace, actions) {
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
      const done = b3270.run(name, args);
      if (AID_ACTIONS.has(name)) await answerAid(host, from, ++aids);
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
 * @param {string} trace @param {Action[]} actions
 */
async function compare(trace, actions) {
  const [oursS, s3270, oursB, b3270] = await Promise.all([
    withOurs(trace, actions, "s3270"),
    withS3270(trace, actions),
    noB3270 ? undefined : withOurs(trace, actions, "b3270"),
    noB3270 ? undefined : withB3270(trace, actions),
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
