import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { test } from "node:test";
import { SessionPool } from "../src/index.js";
import {
  assertSameLines,
  scenario,
  startOurs,
  startPooled,
} from "./harness.js";

test("a session on a pool thread streams exactly what one in this thread does", async () => {
  const pool = new SessionPool({ workers: 2 });
  try {
    const actions = /** @type {[string, ...(string | number)[]][]} */ ([
      ["String", "hello"],
      ["Tab"],
      ["String", "world"],
      ["Enter"],
      ["Ascii", 0, 0, 80],
      ["ReadBuffer"],
      ["Bogus"],
      ["Scroll", "Backward"],
      ["Query", "Cursor"],
    ]);
    const [inThread, pooled] = await Promise.all([
      scenario(startOurs(), "three-fields.trc", actions),
      scenario(startPooled(pool), "three-fields.trc", actions),
    ]);
    assertSameLines(pooled.lines, inThread.lines);
    assert.equal(pooled.received, inThread.received);
  } finally {
    pool.close();
  }
});

test("sessions spread evenly over the pool's threads", () => {
  const pool = new SessionPool({ workers: 3 });
  try {
    const sessions = Array.from({ length: 7 }, () => pool.session());
    assert.deepEqual(
      pool.threads.map((t) => t.sessions.size),
      [3, 2, 2],
    );
    for (const session of sessions.slice(0, 3)) session.close();
    pool.session();
    assert.equal(
      pool.threads.reduce((sum, t) => sum + t.sessions.size, 0),
      5,
    );
  } finally {
    pool.close();
  }
});

test("a crashed thread fails only its own sessions, and the next session gets a new thread", async () => {
  /** @type {string[]} */
  const warnings = [];
  const log = {
    warn: (/** @type {string} */ m) => warnings.push(m),
    info() {},
  };
  const pool = new SessionPool({ workers: 2 });
  try {
    const doomed = pool.session({}, log);
    const survivor = pool.session({}, log);
    doomed.indications(() => {});
    survivor.indications(() => {});
    // A host that accepts and never speaks keeps the doomed thread's Open waiting.
    const silent = net.createServer();
    silent.listen(0, "127.0.0.1");
    await once(silent, "listening");
    const port = /** @type {net.AddressInfo} */ (silent.address()).port;
    const pending = doomed.run([
      { action: "Open", args: [`127.0.0.1:${port}`] },
    ]);
    const [socket] = await once(silent, "connection");
    const died = once(doomed, "died");
    await doomed.thread.worker.terminate();

    await assert.rejects(pending, { code: "N4001" });
    const [err] = await died;
    assert.equal(err.code, "N4001");
    assert.ok(
      warnings.some((w) => w.startsWith("N4001")),
      warnings.join(),
    );
    await assert.rejects(doomed.run([{ action: "Query" }]), { code: "N4002" });

    const answer = await survivor.run([{ action: "Query", args: ["Model"] }]);
    assert.equal(answer.success, true);
    const fresh = pool.session();
    assert.notEqual(fresh.thread, doomed.thread);
    fresh.indications(() => {});
    assert.equal(
      (await fresh.run([{ action: "Query", args: ["Model"] }])).success,
      true,
    );
    socket.destroy();
    silent.close();
  } finally {
    pool.close();
  }
});
