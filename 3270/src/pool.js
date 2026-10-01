// Sessions spread over worker threads, so a busy server uses every core. Each worker (worker.js)
// runs whole sessions; the main thread only passes actions in and indications out.
import { EventEmitter } from "node:events";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { NodeError } from "./errors.js";

/** @typedef {{warn: (m: string) => void, info: (m: string) => void, debug?: (m: string) => void}} PoolLogger */
/** @typedef {{worker: Worker, sessions: Map<number, PooledSession>, dead: boolean}} Thread */

const SILENT = { warn() {}, info() {} };

export class SessionPool {
  /** @param {{workers?: number}} [options] 0 or none is one per core. */
  constructor({ workers = 0 } = {}) {
    this.size = workers || availableParallelism();
    /** @type {Thread[]} */
    this.threads = [];
    this.nextId = 1;
  }

  /**
   * Like new Session(options, log), on the least busy thread. A log without debug spares
   * the thread from sending every debug line over.
   * @param {Partial<import("./session.js").Options>} [options] @param {PoolLogger} [log]
   */
  session(options = {}, log = SILENT) {
    let thread = this.threads.length < this.size ? this.start() : null;
    for (const t of this.threads)
      if (!thread || t.sessions.size < thread.sessions.size) thread = t;
    return new PooledSession(
      /** @type {Thread} */ (thread),
      this.nextId++,
      options,
      log,
    );
  }

  /** Ends every thread and with it every session. */
  close() {
    for (const thread of this.threads) thread.worker.terminate();
    this.threads = [];
  }

  /** @returns {Thread} */
  start() {
    const worker = new Worker(new URL("./worker.js", import.meta.url));
    /** @type {Thread} */
    const thread = { worker, sessions: new Map(), dead: false };
    // Only a thread with sessions keeps the process alive.
    worker.unref();
    worker.on("message", (/** @type {any[][]} */ batch) => {
      for (const message of batch)
        thread.sessions.get(message[1])?.receive(message);
    });
    const died = (/** @type {unknown} */ cause) => {
      if (thread.dead) return;
      thread.dead = true;
      this.threads = this.threads.filter((t) => t !== thread);
      for (const session of [...thread.sessions.values()]) session.lost(cause);
    };
    worker.on("error", died);
    worker.on("exit", (code) => died(new Error(`exit code ${code}`)));
    this.threads.push(thread);
    return thread;
  }
}

/**
 * A Session that lives on a pool thread: the same run(), indications(), close() and "quit" event.
 * "died" (a NodeError) means its thread crashed and took the session with it.
 */
export class PooledSession extends EventEmitter {
  /** @param {Thread} thread @param {number} id @param {object} options @param {PoolLogger} log */
  constructor(thread, id, options, log) {
    super();
    this.thread = thread;
    this.id = id;
    this.log = log;
    this.closed = false;
    this.nextSeq = 1;
    /** @type {Map<number, {resolve: (r: {success: boolean, text: string[]}) => void, reject: (e: Error) => void}>} */
    this.pending = new Map();
    /** @type {(indication: {kind: string, body: any}) => void} */
    this.listener = () => {};
    if (thread.sessions.size === 0) thread.worker.ref();
    thread.sessions.set(id, this);
    const levels = log.debug ? ["warn", "info", "debug"] : ["warn", "info"];
    thread.worker.postMessage(["open", id, options, levels]);
  }

  /** @param {(indication: {kind: string, body: any}) => void} listener */
  indications(listener) {
    this.listener = listener;
    this.thread.worker.postMessage(["indications", this.id]);
  }

  /**
   * @param {{action: string, args?: any[]}[]} actions @param {string} [tag]
   * @returns {Promise<{success: boolean, text: string[]}>}
   */
  run(actions, tag) {
    if (this.closed)
      return Promise.reject(
        new NodeError("N4002", "run() on a closed pooled session"),
      );
    const seq = this.nextSeq++;
    this.thread.worker.postMessage(["run", this.id, seq, actions, tag]);
    return new Promise((resolve, reject) =>
      this.pending.set(seq, { resolve, reject }),
    );
  }

  close() {
    if (this.closed) return;
    this.thread.worker.postMessage(["close", this.id]);
    this.forget();
  }

  /** @param {any[]} message */
  receive(message) {
    const [type] = message;
    if (type === "ind") this.listener({ kind: message[2], body: message[3] });
    else if (type === "done") {
      this.pending.get(message[2])?.resolve(message[3]);
      this.pending.delete(message[2]);
    } else if (type === "failed") {
      this.log.warn(`N4003 run failed on its thread: ${message[3]}`);
      this.pending
        .get(message[2])
        ?.reject(new NodeError("N4003", "run failed on its thread"));
      this.pending.delete(message[2]);
    } else if (type === "quit") this.emit("quit");
    else if (type === "log") {
      const level = /** @type {"warn" | "info" | "debug"} */ (message[2]);
      this.log[level]?.(message[3]);
    }
  }

  /** @param {unknown} cause */
  lost(cause) {
    this.log.warn(`N4001 the session's worker thread died: ${String(cause)}`);
    const err = new NodeError(
      "N4001",
      "the session's worker thread died",
      cause,
    );
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    this.forget();
    this.emit("died", err);
  }

  forget() {
    this.closed = true;
    this.thread.sessions.delete(this.id);
    if (this.thread.sessions.size === 0) this.thread.worker.unref();
  }
}
