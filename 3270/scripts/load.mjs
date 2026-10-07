// Load test: many simulated users on one node3270 process, all working at the same time.
//   node --expose-gc scripts/load.mjs [--sessions 1000] [--seconds 20] [--think 0] [--hosts 4]
// --think is each user's mean pause in ms between operations; 0 runs every user flat out,
// which finds the saturation point. The whole server is measured by the top-level scripts/load.mjs. Prints a line per second, then the totals; exits 1 on any error.
import { parseArgs } from "node:util";
import { load } from "../test/load.js";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "1000" },
    seconds: { type: "string", default: "20" },
    think: { type: "string", default: "0" },
    hosts: { type: "string", default: "4" },
  },
});

const ms = (/** @type {number} */ n) => `${n.toFixed(1)} ms`;
const stats = await load({
  sessions: Number(values.sessions),
  seconds: Number(values.seconds),
  thinkMs: Number(values.think),
  hosts: Number(values.hosts),
  onTick: (tick) =>
    console.log(
      `  ${String(tick.second).padStart(3)} s  ${String(tick.operations).padStart(6)} ops/s  ` +
        `loop delay max so far ${ms(tick.loopDelayMs)}  rss ${tick.rssMiB.toFixed(0)} MiB heap ${tick.heapMiB.toFixed(0)} MiB`,
    ),
});

console.log(
  `\n${stats.sessions} sessions connected in ${stats.connectSeconds.toFixed(2)} s ` +
    `(Open p50 ${ms(stats.open.p50)}, p99 ${ms(stats.open.p99)}, max ${ms(stats.open.max)}), ` +
    `${stats.heapPerSessionKiB.toFixed(1)} KiB heap per session, rss ${stats.rssMiB.toFixed(0)} MiB`,
);
console.log(
  `${stats.operations} operations in ${stats.elapsed.toFixed(1)} s: ${stats.operationsPerSecond.toFixed(0)}/s, ` +
    `CPU ${stats.cpuPercent.toFixed(0)}%, ${stats.cpuMicrosPerOperation.toFixed(0)} µs CPU per operation`,
);
console.log(
  `event loop delay p50 ${ms(stats.loopDelayMs.p50)}, p99 ${ms(stats.loopDelayMs.p99)}, max ${ms(stats.loopDelayMs.max)}; ` +
    `${stats.indicationsPerSecond.toFixed(0)} indications/s, ${stats.indicationMiBPerSecond.toFixed(1)} MiB/s of JSON`,
);
console.log("latency per operation (run() to run-result):");
for (const [name, l] of Object.entries(stats.latencies))
  console.log(
    `  ${name.padEnd(11)} ${String(l.count).padStart(7)}×  p50 ${ms(l.p50)}  p95 ${ms(l.p95)}  p99 ${ms(l.p99)}  max ${ms(l.max)}`,
  );
if (stats.errors.length) {
  console.log(
    `${stats.errors.length} errors, first: ${stats.errors.slice(0, 5).join(" | ")}`,
  );
  process.exit(1);
}
console.log("no errors");
process.exit(0);
