// Sessions live on worker threads (worker.js), so a busy server uses every core for them. This
// side only picks a thread for each new session, remembers where each one lives, and passes
// requests and websocket frames through.
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { logger, writeLogLine } from "./log.js";

/**
 * @typedef {object} Thread
 * @property {Worker} worker
 * @property {Set<string>} sessions
 * @property {Map<string, ViewerSocket>} viewers
 * @property {Map<number, { resolve: (value: any) => void, reject: (err: Error) => void }>} requests
 * @property {boolean} dead
 */

/**
 * The main thread's end of a viewer: its websocket.
 * @typedef {object} ViewerSocket
 * @property {(text: string) => void} send a message already serialized by the worker
 * @property {(code: number, reason: string) => void} close
 */

/**
 * An error as the worker described it, rebuilt so it keeps its code here.
 * @param {{ code: string, summary: string }} remote
 * @returns {Error}
 */
function rebuildError({ code, summary }) {
  if (code === "E0000") return new Error(summary);
  const err = new AppError(
    /** @type {import('./errors.js').ErrorCode} */ (code),
  );
  err.summary = summary;
  err.message = `[${code}] ${summary}`;
  return err;
}

export class SessionRegistry {
  /** @param {import('./config.js').Config} config */
  constructor(config) {
    this.config = config;
    this.log = logger("registry");
    this.size = config.emulator.workers || availableParallelism();
    /** @type {Thread[]} */
    this.threads = [];
    /** @type {Map<string, Thread>} */
    this.sessions = new Map();
    this.creating = 0;
    this.nextRequest = 1;
  }

  /** @returns {Thread} the thread with the fewest sessions, starting one while there are fewer than `size`. */
  pickThread() {
    if (this.threads.length < this.size) return this.startThread();
    let best = /** @type {Thread} */ (this.threads[0]);
    for (const thread of this.threads)
      if (thread.sessions.size < best.sessions.size) best = thread;
    return best;
  }

  /** @returns {Thread} */
  startThread() {
    const worker = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: { config: this.config },
    });
    /** @type {Thread} */
    const thread = {
      worker,
      sessions: new Set(),
      viewers: new Map(),
      requests: new Map(),
      dead: false,
    };
    this.threads.push(thread);
    this.log.info("worker thread started", { threads: this.threads.length });

    worker.on("message", (/** @type {any[]} */ message) => {
      const [type] = message;
      if (type === "send") {
        thread.viewers.get(message[1])?.send(message[2]);
      } else if (type === "close") {
        thread.viewers.get(message[1])?.close(message[2], message[3]);
      } else if (type === "log") {
        writeLogLine(message[1]);
      } else if (type === "reply") {
        const [, request, value, error] = message;
        const pending = thread.requests.get(request);
        thread.requests.delete(request);
        if (error) pending?.reject(rebuildError(error));
        else pending?.resolve(value);
      } else if (type === "closed") {
        const id = message[1];
        thread.sessions.delete(id);
        this.sessions.delete(id);
        this.log.info("session removed", {
          session: id,
          remaining: this.sessions.size,
        });
      }
    });
    const died = (/** @type {unknown} */ cause) => {
      if (thread.dead) return;
      thread.dead = true;
      this.threads = this.threads.filter((t) => t !== thread);
      const err = new AppError("E3016", "", cause);
      this.log.error(err, {
        sessions: thread.sessions.size,
        viewers: thread.viewers.size,
      });
      for (const id of thread.sessions) this.sessions.delete(id);
      for (const viewer of thread.viewers.values()) {
        viewer.send(
          JSON.stringify({
            type: "error",
            code: err.code,
            message: err.summary,
          }),
        );
        viewer.close(1011, err.code);
      }
      for (const pending of thread.requests.values()) pending.reject(err);
    };
    worker.on("error", died);
    worker.on("exit", (code) => died(`exit code ${code}`));
    return thread;
  }

  /**
   * @param {Thread} thread @param {any[]} message the request id goes in second place
   * @returns {Promise<any>}
   */
  ask(thread, [type, ...args]) {
    const request = this.nextRequest++;
    return new Promise((resolve, reject) => {
      thread.requests.set(request, { resolve, reject });
      thread.worker.postMessage([type, request, ...args]);
    });
  }

  /**
   * @param {{ ip: string, user: string }} [client]
   * @returns {Promise<{ id: string, rows: number, cols: number, model: number }>}
   */
  async create(client = { ip: "", user: "" }) {
    const open = this.sessions.size + this.creating;
    if (open >= this.config.sessions.maxSessions)
      throw new AppError("E3002", `${open} sessions are already open`);
    const thread = this.pickThread();
    this.creating++;
    try {
      const described = await this.ask(thread, ["create", client]);
      thread.sessions.add(described.id);
      this.sessions.set(described.id, thread);
      this.log.info("session created", {
        session: described.id,
        ...client,
        total: this.sessions.size,
      });
      return described;
    } finally {
      this.creating--;
    }
  }

  /** @param {string} id @returns {Thread} */
  threadOf(id) {
    const thread = this.sessions.get(id);
    if (thread === undefined) throw new AppError("E3001", id);
    return thread;
  }

  /** @param {string} id @param {string} pass @returns {Promise<void>} */
  async terminate(id, pass) {
    await this.ask(this.threadOf(id), ["terminate", id, pass]);
  }

  /** @returns {Promise<Array<{ id: string, viewers: number, connection: string, host: string | null, startedAt: string, startedBy: string }>>} */
  async list() {
    const lists = await Promise.all(
      this.threads.map((thread) => this.ask(thread, ["list"])),
    );
    return lists.flat();
  }

  /**
   * Joins a websocket to a session as a viewer; the session decides its role.
   * @param {string} id
   * @param {{ ip: string, user: string }} client
   * @param {string | undefined} pass
   * @param {ViewerSocket} socket
   * @returns {{ viewerId: string, message: (text: string) => void, detach: () => void }}
   */
  attach(id, client, pass, socket) {
    const thread = this.threadOf(id);
    const viewerId = randomUUID().slice(0, 8);
    thread.viewers.set(viewerId, socket);
    thread.worker.postMessage(["attach", viewerId, id, client, pass]);
    return {
      viewerId,
      message: (text) => {
        if (!thread.dead)
          thread.worker.postMessage(["message", viewerId, text]);
      },
      detach: () => {
        if (!thread.viewers.delete(viewerId) || thread.dead) return;
        thread.worker.postMessage(["detach", viewerId]);
      },
    };
  }

  /** @returns {void} */
  closeAll() {
    for (const thread of this.threads) thread.worker.postMessage(["closeAll"]);
  }

  /** Ends every thread and the sessions on it, without the error a dying thread reports. @returns {Promise<void>} */
  async stop() {
    const threads = this.threads;
    this.threads = [];
    for (const thread of threads) thread.dead = true;
    this.sessions.clear();
    await Promise.all(threads.map((thread) => thread.worker.terminate()));
  }
}
