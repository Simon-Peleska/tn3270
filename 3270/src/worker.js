// One thread of a SessionPool (pool.js): runs its share of the sessions and answers in batches.
import { parentPort } from "node:worker_threads";
import { Session } from "./session.js";

const port = /** @type {import("node:worker_threads").MessagePort} */ (
  parentPort
);

/** @type {Map<number, Session>} */
const sessions = new Map();

/** @type {any[][]} */
let outbox = [];
/** One postMessage per event-loop turn: cloning a message costs more than a small indication. */
function send(/** @type {any[]} */ message) {
  if (outbox.length === 0) setImmediate(flush);
  outbox.push(message);
}
function flush() {
  const batch = outbox;
  outbox = [];
  port.postMessage(batch);
}

port.on("message", (/** @type {any[]} */ message) => {
  const [type, id] = message;
  if (type === "open") {
    const [, , options, levels] = message;
    /** @param {string} level */
    const forward = (level) =>
      levels.includes(level)
        ? (/** @type {string} */ m) => send(["log", id, level, m])
        : () => {};
    const session = new Session(options, {
      warn: forward("warn"),
      info: forward("info"),
      debug: forward("debug"),
    });
    session.on("quit", () => send(["quit", id]));
    sessions.set(id, session);
    return;
  }

  const session = sessions.get(id);
  if (!session) return;
  if (type === "indications") {
    session.indications(({ kind, body }) => send(["ind", id, kind, body]));
  } else if (type === "run") {
    const [, , seq, actions, tag] = message;
    session.run(actions, tag).then(
      (result) => send(["done", id, seq, result]),
      (/** @type {any} */ err) =>
        send(["failed", id, seq, String(err?.stack ?? err)]),
    );
  } else if (type === "close") {
    sessions.delete(id);
    session.close();
  }
});
