import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { FakeHost } from "../../test/fakehost.js";
import { Session } from "../src/index.js";
import { b3270Indications } from "./b3270.js";
import "./read.js";

export { FakeHost };

// Runs b3270 and our Session side by side against the same fake host, so tests can
// require their indication streams to match line by line.

export const TRACES = new URL("../../test/traces/", import.meta.url).pathname;
const B3270 = process.env["B3270_PATH"] ?? "b3270";
export const noB3270 =
  spawnSync(B3270, ["-v"], { stdio: "pipe" }).error && "b3270 not installed";

/** What we don't emulate: connect retries, TLS details and DBCS code pages. */
export const IGNORED = new Set(["code-pages", "tls", "connect-attempt"]);

/** @param {string} kind @param {any} body */
export function normalize(kind, body) {
  if (IGNORED.has(kind)) return null;
  if (kind === "oia" && body.field === "timing") return null;
  if (kind === "hello") body = { ...body, build: "" };
  if (kind === "tls-hello") body = { ...body, provider: "" };
  if (kind === "setting" && body.name === "confDir")
    body = { ...body, value: "" };
  if (kind === "run-result") {
    const { time, ...rest } = body;
    if (rest.text)
      rest.text = rest.text.map((/** @type {string} */ line) =>
        line
          .replace(
            /^(confDir|BuildOptions|TlsProvider|Version|ConnectTime): .*/,
            "$1:",
          )
          .replace(/127\.0\.0\.1 \d+$/, "127.0.0.1 PORT")
          .replace(/^(b3270|node3270) v4\.5ga5.*/, "BUILD"),
      );
    return JSON.stringify({ [kind]: rest });
  }
  return JSON.stringify({ [kind]: body });
}

/**
 * A b3270 or our Session behind the same small interface: run() resolves with the run-result,
 * and lines holds the normalized indications so far.
 * @typedef {{lines: string[], run: (action: string | (string | number)[][], args?: (string | number)[]) => Promise<any>, waitFor: (line: string) => Promise<void>, stop: () => void}} Emulator
 * @typedef {[string, ...(string | number)[]] | ["run", ...[string, ...(string | number)[]][]]} Step
 */

/** @returns {Emulator} */
export function startB3270() {
  const env = { ...process.env, LC_ALL: "C", LC_NUMERIC: "C" };
  const child = spawn(B3270, ["-json", "-model", "3279-4-E"], {
    stdio: ["pipe", "pipe", "ignore"],
    env,
  });
  return track((push, results, died) => {
    // Writing to a b3270 that died must not take the test runner down with it.
    child.stdin.on("error", () => {});
    child.on("exit", (code, signal) =>
      died(new Error(`b3270 exited (${signal ?? code})`)),
    );
    createInterface({ input: child.stdout }).on("line", (line) => {
      for (const [kind, body] of Object.entries(JSON.parse(line))) {
        if (kind === "initialize")
          for (const item of body)
            for (const [k, b] of Object.entries(item)) push(k, b);
        else push(kind, body);
        if (kind === "run-result") results.get(body["r-tag"])?.(body);
      }
    });
    return {
      send: (tag, actions) =>
        child.stdin.write(
          `${JSON.stringify({ run: { actions, "r-tag": tag } })}\n`,
        ),
      stop: () => {
        child.stdin.end();
        child.kill();
      },
    };
  });
}

/**
 * @param {boolean} [b3270] write what b3270 writes, or only what the app gets
 * @param {(s: import("../src/session.js").State, kind: string, body: any) => void} [watch] sees each indication first
 * @returns {Emulator}
 */
export function startOurs(b3270 = true, watch) {
  // LOG=1 shows node3270's log, for debugging a mismatch.
  const log = (/** @type {string} */ m) => console.error(m);
  const session = new Session(
    { model: "3279-4-E" },
    process.env.LOG ? { warn: log, info: log, debug: log } : undefined,
  );
  return track((push, results) => {
    /** @param {{kind: string, body: any}} indication */
    const listener = ({ kind, body }) => {
      watch?.(session.s, kind, body);
      push(kind, body);
      if (kind === "run-result") results.get(body["r-tag"])?.(body);
    };
    if (b3270) b3270Indications(session, listener);
    else session.indications(listener);
    return {
      send: (tag, actions) => void session.run(actions, tag),
      stop: () => session.close(),
    };
  });
}

/**
 * @param {(push: (kind: string, body: any) => void, results: Map<string, (r: any) => void>,
 *   died: (error: Error) => void) => {send: (tag: string, actions: {action: string, args: (string | number)[]}[]) => void, stop: () => void}} start
 * @returns {Emulator}
 */
function track(start) {
  /** @type {string[]} */
  const lines = [];
  /** @type {Map<string, (r: any) => void>} */
  const results = new Map();
  /** @type {(() => void)[]} */
  let watchers = [];
  /** Rejects whatever waits on an emulator that is gone. @type {Set<(e: Error) => void>} */
  const waiting = new Set();
  /** @type {Error | null} */
  let dead = null;
  /** @param {(resolve: (v: any) => void) => void} register */
  const wait = (register) => {
    const promise = new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      waiting.add(reject);
      register((v) => {
        waiting.delete(reject);
        resolve(v);
      });
    });
    // A scenario that already failed may have stopped waiting on this one.
    promise.catch(() => {});
    return promise;
  };
  const { send, stop } = start(
    (kind, body) => {
      const line = normalize(kind, body);
      if (line === null) return;
      lines.push(line);
      for (const watcher of watchers) watcher();
    },
    results,
    (error) => {
      dead = error;
      for (const reject of waiting) reject(error);
      waiting.clear();
    },
  );
  let tags = 0;
  return {
    lines,
    /** One run of one action, or of several when `action` is a list of [name, ...args]. @param {string | (string | number)[][]} action @param {(string | number)[]} [args] */
    run(action, args = []) {
      const tag = String(tags++);
      const done = wait((resolve) => results.set(tag, resolve));
      send(
        tag,
        typeof action === "string"
          ? [{ action, args }]
          : action.map(([name, ...rest]) => ({
              action: String(name),
              args: rest,
            })),
      );
      return done;
    },
    waitFor(line) {
      if (lines.includes(line)) return Promise.resolve();
      return wait((resolve) => {
        const watcher = () => {
          if (!lines.includes(line)) return;
          watchers = watchers.filter((w) => w !== watcher);
          resolve(undefined);
        };
        watchers.push(watcher);
      });
    },
    stop,
  };
}

/** What a host answers to an AID: TN3270E header, Write, WCC keyboard restore. */
export const UNLOCK_KEYBOARD = Buffer.from("0000000000f1c2ffef", "hex");

/** Waits until the emulator has read everything sent so far, or has hung up. @param {FakeHost} host */
export async function sync(host) {
  const socket = host.socket;
  if (!socket || socket.destroyed) return;
  const before = host.received.length;
  socket.write(Buffer.from("fffd06", "hex"));
  await host.waitUntil(
    () => socket.destroyed || host.received.slice(before).endsWith("fffc06"),
    5000,
    "no timing mark",
  );
}

/**
 * Splits the host's bytes into whole records and the telnet commands between them, since
 * a timing mark inside a record or an IAC sequence would corrupt it.
 * @param {string[]} payloads
 */
export function telnetUnits(payloads) {
  const bytes = Buffer.from(payloads.join(""), "hex");
  /** @type {Buffer[]} */
  const units = [];
  let start = 0;
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const command = bytes[i + 1];
    if (command === 0xff) {
      i += 2;
      continue;
    }
    const isCommandBetweenRecords = i === start;
    if (command === 0xfa) i = bytes.indexOf(Buffer.from([0xff, 0xf0]), i) + 2;
    else if (command >= 0xfb && command <= 0xfe) i += 3;
    else i += 2;
    if (command === 0xef || isCommandBetweenRecords) {
      units.push(bytes.subarray(start, i));
      start = i;
    }
  }
  if (start < bytes.length) units.push(bytes.subarray(start));
  return units;
}

/**
 * Connects to a host replaying the trace one telnet unit at a time, so both emulators
 * see the same reads, then runs the actions and disconnects.
 * Besides actions, steps can be ["host", hex] to send the emulator bytes, ["hostClose"] to hang up,
 * ["+Action", ...args] to start an action without waiting for it, ["await"] to wait for those, and
 * ["run", [Action, ...args], [Action, ...args], ...] to run several actions as one run.
 * @param {Emulator} emulator @param {string} trace @param {Step[]} actions
 * @param {[string, ...(string | number)[]][]} [setup] actions before connecting
 * @param {string | ((port: number) => Promise<string>)} [target] what to Open, with PORT
 *   for the host's port, or a function of that port
 */
export async function scenario(
  emulator,
  trace,
  actions,
  setup = [],
  target = "127.0.0.1:PORT",
) {
  const host = await FakeHost.listen(TRACES + trace);
  try {
    for (const [name, ...args] of setup) await emulator.run(name, args);
    // Some traces never get past telnet negotiation, so Open may only finish at Disconnect.
    const opened = emulator.run("Open", [
      typeof target === "string"
        ? target.replace("PORT", String(host.port))
        : await target(host.port),
    ]);
    await host.waitForConnection();
    for (const unit of telnetUnits(host.payloads)) {
      host.socket?.write(unit);
      await sync(host);
    }
    /** @type {Promise<any>[]} */
    let pending = [];
    for (const [name, ...args] of actions) {
      if (name === "host") {
        host.socket?.write(Buffer.from(String(args[0]), "hex"));
        await sync(host);
        continue;
      }
      if (name === "hostClose") {
        host.socket?.end();
        await emulator.waitFor(
          JSON.stringify({ connection: { state: "not-connected" } }),
        );
        continue;
      }
      if (name === "await") {
        await Promise.all(pending);
        pending = [];
        continue;
      }
      if (name.startsWith("+")) {
        pending.push(emulator.run(name.slice(1), args));
        continue;
      }
      let finished = false;
      const done =
        name === "run"
          ? emulator.run(/** @type {(string | number)[][]} */ (args))
          : emulator.run(name, /** @type {(string | number)[]} */ (args));
      const finish = () => {
        finished = true;
        host.wake();
      };
      done.then(finish, finish);
      // A String can send several AIDs, each waiting for the host to unlock the keyboard.
      let records = host.received.split("ffef").length;
      while (!finished) {
        await host.waitUntil(
          () => finished || host.received.split("ffef").length > records,
          5000,
          "no AID record",
        );
        records = host.received.split("ffef").length;
        // No timing mark after the unlock: its answer would race the next AID of a String.
        if (!finished) host.socket?.write(UNLOCK_KEYBOARD);
      }
      await done;
    }
    await emulator.run("Disconnect");
    await emulator.waitFor(
      JSON.stringify({ connection: { state: "not-connected" } }),
    );
    await opened;
    await Promise.all(pending);
    return { lines: emulator.lines, received: host.received };
  } finally {
    emulator.stop();
    await host.close();
  }
}

/**
 * @param {string} trace @param {Step[]} actions
 * @param {[string, ...(string | number)[]][]} [setup]
 * @param {string | ((port: number) => Promise<string>)} [target]
 */
export async function compare(trace, actions, setup, target) {
  const [theirs, ours] = await Promise.all([
    scenario(startB3270(), trace, actions, setup, target),
    scenario(startOurs(), trace, actions, setup, target),
  ]);
  assertSameLines(ours.lines, theirs.lines);
  assert.equal(ours.received, theirs.received);
}

/** Compares from the first difference on, so a failure shows where the streams part. @param {string[]} ours @param {string[]} theirs */
export function assertSameLines(ours, theirs) {
  // b3270 reports its counters on a 2-second timer, so where a stats line lands is up to the
  // clock; what they finally say must still agree.
  const isStats = (/** @type {string} */ line) => line.startsWith('{"stats":');
  assert.equal(
    ours.findLast(isStats),
    theirs.findLast(isStats),
    "the last stats differ",
  );
  ours = ours.filter((line) => !isStats(line));
  theirs = theirs.filter((line) => !isStats(line));
  // b3270 flushes screen changes later than connection states, so how many connection states
  // its cursor changes trail depends on how busy the machine is. In each stretch of nothing but
  // cursor and connection lines, the connection lines go first; each kind keeps its own order.
  const isCursor = (/** @type {string} */ line) =>
    /^\{"screen":\{"cursor":\{[^}]*\}\}\}$/.test(line);
  const isConnection = (/** @type {string} */ line) =>
    line.startsWith('{"connection":');
  const connectionFirst = (/** @type {string[]} */ lines) => {
    /** @type {string[]} */
    const out = [];
    for (let j = 0; j < lines.length;) {
      let end = j;
      while (
        end < lines.length &&
        (isCursor(lines[end]) || isConnection(lines[end]))
      )
        end++;
      if (end === j) {
        out.push(lines[j++]);
        continue;
      }
      const stretch = lines.slice(j, end);
      out.push(...stretch.filter(isConnection), ...stretch.filter(isCursor));
      j = end;
    }
    return out;
  };
  ours = connectionFirst(ours);
  theirs = connectionFirst(theirs);
  let i = 0;
  while (i < ours.length && i < theirs.length && ours[i] === theirs[i]) i++;
  assert.deepEqual(
    ours.slice(Math.max(0, i - 3), i + 12),
    theirs.slice(Math.max(0, i - 3), i + 12),
    `streams part at line ${i}`,
  );
}
