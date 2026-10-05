// Load test of the whole server: browsers as the real one talks to it, over HTTP and websockets,
// against fake hosts (3270/test/loadhost.js). Each user types and presses PF3 over and over; an
// operation ends with the paint of the host's answer.
//   node scripts/load.mjs [--sessions 1000] [--seconds 15] [--workers 0] [--hosts 4] [--clients 8]
// --workers is the server's emulator.workers; --clients is how many processes play the browsers,
// so that they are not what runs out of CPU. PROF=1 writes the server's CPU profiles to /tmp/prof.
// Prints the totals; exits 1 on any error.
import { fork, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { freePort, waitUntil } from "../test/helpers.js";
import { WebSocket } from "../vendor/ws.mjs";

const OPERATION = JSON.stringify({
  type: "macro",
  steps: [
    { type: "text", value: "HELLO WORLD" },
    { type: "action", action: "PF", args: ["3"] },
  ],
});

if (process.argv[2] === "--client") await client();
else await main();

async function main() {
  const { values } = parseArgs({
    options: {
      sessions: { type: "string", default: "1000" },
      seconds: { type: "string", default: "15" },
      workers: { type: "string", default: "0" },
      hosts: { type: "string", default: "4" },
      clients: { type: "string", default: "8" },
    },
  });
  const sessions = Number(values.sessions);
  const clients = Number(values.clients);

  const hosts = await Promise.all(
    Array.from({ length: Number(values.hosts) }, async () => {
      const child = fork(new URL("../3270/test/loadhost.js", import.meta.url));
      const port = await new Promise((resolve) =>
        child.once("message", resolve),
      );
      return { child, port };
    }),
  );

  const port = await freePort();
  const configFile = `/tmp/tn3270-load-${port}.jsonc`;
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { host: "127.0.0.1", port },
      sessions: { maxSessions: sessions + 10, idleTimeoutMs: 0 },
      logLevel: "warn",
      emulator: {
        model: 4,
        tls: false,
        workers: Number(values.workers),
        settings: { saveLines: 0 },
      },
    }),
  );
  const server = spawn(
    "node",
    [
      ...(process.env.PROF ? ["--cpu-prof", "--cpu-prof-dir=/tmp/prof"] : []),
      "server/main.js",
    ],
    {
      env: { ...process.env, TN3270_CONFIG: configFile },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  const base = `http://127.0.0.1:${port}`;
  await waitUntil(
    () =>
      fetch(`${base}/api/version`).then(
        () => true,
        () => false,
      ),
    "the server to listen",
  );

  const children = Array.from({ length: clients }, (_, i) => {
    const child = fork(new URL(import.meta.url), ["--client"]);
    const share =
      Math.floor(sessions / clients) + (i < sessions % clients ? 1 : 0);
    child.send({
      base,
      sessions: share,
      hosts: hosts.map((_, h) => hosts[(i + h) % hosts.length].port),
    });
    return child;
  });
  /** @param {string} type */
  const fromAll = (type) =>
    Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) =>
            child.on("message", (/** @type {any} */ m) => {
              if (m.type === type) resolve(m);
            }),
          ),
      ),
    );

  const connectStarted = performance.now();
  await fromAll("ready");
  const connectSeconds = (performance.now() - connectStarted) / 1000;

  const cpuBefore = cpuOf(server.pid);
  const mainBefore = cpuOf(server.pid, server.pid);
  const started = performance.now();
  const seconds = Number(values.seconds);
  for (const child of children) child.send({ go: seconds });
  const results = /** @type {any[]} */ (await fromAll("done"));
  const elapsed = (performance.now() - started) / 1000;
  const cpu = cpuOf(server.pid) - cpuBefore;
  const mainCpu = cpuOf(server.pid, server.pid) - mainBefore;

  const operations = results.reduce((sum, r) => sum + r.operations, 0);
  const latencies = Float64Array.from(
    results.flatMap((r) => r.latencies),
  ).sort();
  const at = (/** @type {number} */ p) =>
    latencies[Math.floor((latencies.length - 1) * p)] ?? 0;
  const errors = results.flatMap((r) => r.errors);

  console.log(
    `${sessions} sessions connected in ${connectSeconds.toFixed(1)} s; ` +
      `${operations} operations in ${elapsed.toFixed(1)} s: ${(operations / elapsed).toFixed(0)}/s`,
  );
  console.log(
    `server CPU ${((cpu / elapsed) * 100).toFixed(0)}%, of it main thread ${((mainCpu / elapsed) * 100).toFixed(0)}%; ` +
      `${((cpu / operations) * 1e6).toFixed(0)} µs server CPU per operation`,
  );
  console.log(
    `latency p50 ${at(0.5).toFixed(1)} ms  p95 ${at(0.95).toFixed(1)} ms  p99 ${at(0.99).toFixed(1)} ms  max ${at(1).toFixed(1)} ms`,
  );

  for (const child of children) child.kill();
  for (const host of hosts) host.child.kill();
  server.kill("SIGTERM");
  rmSync(configFile, { force: true });
  if (errors.length) {
    console.log(
      `${errors.length} errors, first: ${errors.slice(0, 5).join(" | ")}`,
    );
    process.exit(1);
  }
  console.log("no errors");
  process.exit(0);
}

/** One process's share of the browsers. */
async function client() {
  /** @type {{ base: string, sessions: number, hosts: number[] }} */
  const job = await new Promise((resolve) => process.once("message", resolve));
  /** @type {string[]} */
  const errors = [];
  /** @type {number[]} */
  const latencies = [];
  let operations = 0;

  const users = await Promise.all(
    Array.from({ length: job.sessions }, async (_, i) => {
      const response = await fetch(`${job.base}/api/sessions`, {
        method: "POST",
      });
      const { id } = /** @type {{ id: string }} */ (await response.json());
      const socket = new WebSocket(
        `${job.base.replace("http", "ws")}/ws/${id}`,
      );
      /** @type {((text: string) => void) | null} */
      let waiter = null;
      socket.on("message", (data) => {
        const text = String(data);
        if (text.includes('"type":"error"')) errors.push(text);
        waiter?.(text);
      });
      /** @param {(text: string) => boolean} done */
      const until = (done) =>
        new Promise((resolve) => {
          waiter = (text) => {
            if (!done(text)) return;
            waiter = null;
            resolve(undefined);
          };
        });
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const unlocked = until((text) => text.includes('"fieldsFormatted":true'));
      socket.send(
        JSON.stringify({
          type: "connect",
          host: `127.0.0.1:${job.hosts[i % job.hosts.length]}`,
        }),
      );
      await unlocked;
      return { socket, until };
    }),
  );
  process.send?.({ type: "ready" });

  /** @type {{ go: number }} */
  const { go } = await new Promise((resolve) =>
    process.once("message", resolve),
  );
  const deadline = performance.now() + go * 1000;
  await Promise.all(
    users.map(async ({ socket, until }) => {
      while (performance.now() < deadline) {
        const sent = performance.now();
        const answered = until(
          (text) =>
            text.includes('"type":"paint"') && text.includes('"row":41,'),
        );
        socket.send(OPERATION);
        await answered;
        latencies.push(performance.now() - sent);
        operations++;
      }
    }),
  );
  process.send?.({ type: "done", operations, latencies, errors });
}

/** User+system seconds of a process, or of one of its threads. @param {number | undefined} pid @param {number} [tid] */
function cpuOf(pid, tid) {
  const stat = readFileSync(
    tid === undefined ? `/proc/${pid}/stat` : `/proc/${pid}/task/${tid}/stat`,
    "utf8",
  );
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) / 100;
}
