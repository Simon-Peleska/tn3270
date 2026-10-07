import { fork } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { Session } from "../src/index.js";
import "./read.js";

// Many sessions in one process, each a simulated user driving node3270 the way the web server does:
// run() for actions, every indication serialized to JSON as if sent to a browser. The hosts are
// child processes (test/loadhost.js). scripts/load.mjs runs this from the command line.

/** What one simulated user does, with how often, and what a correct answer looks like. */
const OPERATIONS = [
  {
    name: "type+Enter",
    weight: 35,
    actions: [
      { action: "Home" },
      { action: "String", args: ["HELLO WORLD"] },
      { action: "Enter" },
    ],
  },
  { name: "PF3", weight: 20, actions: [{ action: "PF", args: [3] }] },
  {
    name: "edit",
    weight: 25,
    actions: [
      { action: "Home" },
      { action: "String", args: ["abc def"] },
      { action: "BackTab" },
      { action: "Tab" },
      { action: "EraseEOF" },
    ],
  },
  {
    name: "Ascii",
    weight: 15,
    actions: [{ action: "Ascii", args: [0, 1, 6] }],
    expect: "ROW 00",
  },
  { name: "ReadBuffer", weight: 5, actions: [{ action: "ReadBuffer" }] },
];
const TOTAL_WEIGHT = OPERATIONS.reduce((sum, op) => sum + op.weight, 0);

/** @param {number} rand 0 <= rand < 1 */
function pickOperation(rand) {
  let left = rand * TOTAL_WEIGHT;
  for (const op of OPERATIONS) {
    left -= op.weight;
    if (left < 0) return op;
  }
  return OPERATIONS[0];
}

/** @param {number[]} values */
function summary(values) {
  const sorted = Float64Array.from(values).sort();
  const at = (/** @type {number} */ p) =>
    sorted.length ? sorted[Math.floor(((sorted.length - 1) * p) / 100)] : 0;
  return {
    count: sorted.length,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: at(100),
  };
}

/** @param {number} count */
async function startHosts(count) {
  const url = new URL("./loadhost.js", import.meta.url);
  return Promise.all(
    Array.from({ length: count }, async () => {
      const child = fork(url.pathname);
      const port = await new Promise((resolve, reject) => {
        child.once("message", resolve);
        child.once("exit", () => reject(new Error("a load host died")));
      });
      return { child, port: /** @type {number} */ (port) };
    }),
  );
}

/**
 * Connects `sessions` users at once, lets them all work for `seconds`, then disconnects them.
 * thinkMs is each user's mean pause between operations (exponential); 0 runs them flat out.
 * @param {{sessions: number, seconds: number, thinkMs?: number, hosts?: number,
 *   onTick?: (tick: {second: number, operations: number, loopDelayMs: number, rssMiB: number, heapMiB: number}) => void}} options
 */
export async function load({
  sessions,
  seconds,
  thinkMs = 0,
  hosts = 4,
  onTick,
}) {
  const hostList = await startHosts(hosts);
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  // The histogram counts its own 1 ms sampling interval.
  const lag = (/** @type {number} */ ns) => Math.max(0, ns / 1e6 - 1);
  /** @type {Map<string, number[]>} */
  const latencies = new Map(OPERATIONS.map((op) => [op.name, []]));
  /** @type {string[]} */
  const errors = [];
  let indications = 0;
  let indicationBytes = 0;
  let operations = 0;
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;

  /** @type {Session[]} */
  const all = [];
  for (let i = 0; i < sessions; i++) {
    // As the web server runs it: its UI has no use for the scrollback.
    const options = { model: "3279-4-E", saveLines: 0 };
    const session = new Session(options);
    session.indications((indication) => {
      indications++;
      indicationBytes += JSON.stringify({
        [indication.kind]: indication.body,
      }).length;
    });
    all.push(session);
  }

  const connectStarted = performance.now();
  /** @type {number[]} */
  const openLatencies = [];
  await Promise.all(
    all.map(async (session, i) => {
      const started = performance.now();
      const { port } = hostList[i % hostList.length];
      const result = await session.run([
        { action: "Open", args: [`127.0.0.1:${port}`] },
      ]);
      openLatencies.push(performance.now() - started);
      if (!result.success) errors.push(`Open: ${result.text.join(" ")}`);
    }),
  );
  const connectSeconds = (performance.now() - connectStarted) / 1000;
  global.gc?.();
  const connected = process.memoryUsage();

  indications = 0;
  indicationBytes = 0;
  loopDelay.enable();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const deadline = started + seconds * 1000;
  let lastTick = started;
  let lastOperations = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    onTick?.({
      second: Math.round((now - started) / 1000),
      operations: Math.round(
        ((operations - lastOperations) * 1000) / (now - lastTick),
      ),
      loopDelayMs: lag(loopDelay.max),
      rssMiB: process.memoryUsage().rss / 2 ** 20,
      heapMiB: process.memoryUsage().heapUsed / 2 ** 20,
    });
    lastTick = now;
    lastOperations = operations;
  }, 1000);

  await Promise.all(
    all.map(async (session) => {
      // Users don't start in lockstep.
      if (thinkMs)
        await sleep(Math.min(Math.random() * thinkMs, seconds * 1000));
      while (performance.now() < deadline) {
        const op = pickOperation(Math.random());
        const opStarted = performance.now();
        const result = await session.run(op.actions);
        latencies.get(op.name)?.push(performance.now() - opStarted);
        operations++;
        if (!result.success)
          errors.push(`${op.name}: ${result.text.join(" ")}`);
        else if (op.expect && result.text[0] !== op.expect)
          errors.push(
            `${op.name}: read ${JSON.stringify(result.text[0])}, expected ${op.expect}`,
          );
        if (thinkMs) {
          const pause = -Math.log(1 - Math.random()) * thinkMs;
          await sleep(Math.min(pause, deadline - performance.now()));
        }
      }
    }),
  );
  clearInterval(ticker);
  loopDelay.disable();
  const elapsed = (performance.now() - started) / 1000;
  const cpu = process.cpuUsage(cpuBefore);

  for (const session of all) session.close();
  for (const { child } of hostList) child.kill();

  return {
    sessions,
    connectSeconds,
    open: summary(openLatencies),
    heapPerSessionKiB: (connected.heapUsed - heapBefore) / sessions / 1024,
    rssMiB: connected.rss / 2 ** 20,
    elapsed,
    operations,
    operationsPerSecond: operations / elapsed,
    cpuPercent: ((cpu.user + cpu.system) / 1e6 / elapsed) * 100,
    cpuMicrosPerOperation: (cpu.user + cpu.system) / operations,
    loopDelayMs: {
      p50: lag(loopDelay.percentile(50)),
      p99: lag(loopDelay.percentile(99)),
      max: lag(loopDelay.max),
    },
    indicationsPerSecond: indications / elapsed,
    indicationMiBPerSecond: indicationBytes / elapsed / 2 ** 20,
    latencies: Object.fromEntries(
      [...latencies].map(([name, values]) => [name, summary(values)]),
    ),
    errors,
  };
}
