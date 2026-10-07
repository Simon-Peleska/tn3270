// The open sessions, and the websockets watching them: each frame from a browser goes to its
// session, each message back is serialized and handed to the socket.
import { randomUUID } from "node:crypto";
import { Session } from "./session.js";
import { parseClientMessage } from "./protocol.js";
import { AppError, describeError } from "./errors.js";
import { logger } from "./log.js";

/**
 * A viewer's websocket.
 * @typedef {object} ViewerSocket
 * @property {(text: string) => void} send a serialized message
 * @property {(code: number, reason: string) => void} close
 */

export class SessionRegistry {
  /** @param {import('./config.js').Config} config */
  constructor(config) {
    this.config = config;
    this.log = logger("registry");
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this.creating = 0;
  }

  /**
   * @param {{ ip: string, user: string }} [client]
   * @param {{ model?: number, oversize?: string }} [size]
   * @returns {Promise<{ id: string, rows: number, cols: number, model: number }>}
   */
  async create(client = { ip: "", user: "" }, size = {}) {
    const open = this.sessions.size + this.creating;
    if (open >= this.config.sessions.maxSessions)
      throw new AppError("E3002", `${open} sessions are already open`);
    const session = new Session(this.config, size);
    session.startedBy = client.user || client.ip || "Unknown";
    session.onClosed = () => {
      this.sessions.delete(session.id);
      this.log.info("session removed", {
        session: session.id,
        remaining: this.sessions.size,
      });
    };
    this.creating++;
    try {
      if (this.config.emulator.defaultHost !== null)
        session.connect(this.config.emulator.defaultHost);
      await session.ready;
    } finally {
      this.creating--;
    }
    this.sessions.set(session.id, session);
    this.log.info("session created", {
      session: session.id,
      ...client,
      model: session.model,
      oversize: session.oversize,
      total: this.sessions.size,
    });
    return {
      id: session.id,
      rows: session.screen.rows,
      cols: session.screen.cols,
      model: session.model,
    };
  }

  /** @param {string} id @returns {Session} */
  get(id) {
    const session = this.sessions.get(id);
    if (session === undefined) throw new AppError("E3001", id);
    return session;
  }

  /** @param {string} id @param {string} pass @returns {void} */
  terminate(id, pass) {
    this.get(id).terminate(pass);
  }

  /** @returns {Array<{ id: string, viewers: number, connection: string, host: string | null, startedAt: string, startedBy: string }>} */
  list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      viewers: session.viewers.size,
      connection: session.oia.connectionState,
      host: session.oia.host,
      startedAt: session.startedAt,
      startedBy: session.startedBy,
    }));
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
    const session = this.get(id);
    const viewerId = randomUUID().slice(0, 8);
    // What a viewer is sent in one turn, a paint and the status with it, goes
    // out as one frame: an array when there is more than one message.
    /** @type {import('./protocol.js').ServerMessage[] | null} */
    let outbox = null;
    let attached = true;
    /** @type {import('./session.js').Viewer} */
    const viewer = {
      id: viewerId,
      role: "observer",
      ip: client.ip,
      user: client.user,
      pass,
      sendMessage: (msg) => {
        if (outbox === null) {
          outbox = [];
          queueMicrotask(() => {
            const batch = /** @type {any[]} */ (outbox);
            outbox = null;
            socket.send(JSON.stringify(batch.length === 1 ? batch[0] : batch));
          });
        }
        outbox.push(msg);
      },
      // Behind the messages still in the outbox, which say why.
      close: (code = 1008, reason = "refused") =>
        queueMicrotask(() => socket.close(code, reason)),
    };
    session.attach(viewer);
    return {
      viewerId,
      message: (text) => {
        if (!attached) return;
        try {
          session.handleClientMessage(viewer, parseClientMessage(text));
        } catch (err) {
          const { code, summary } = describeError(err);
          this.log.warn("bad client message", {
            session: id,
            viewer: viewerId,
            code,
            summary,
          });
          viewer.sendMessage({ type: "error", code, message: summary });
        }
      },
      detach: () => {
        if (!attached) return;
        attached = false;
        session.detach(viewer);
      },
    };
  }

  /** @returns {void} */
  closeAll() {
    for (const session of [...this.sessions.values()]) session.close();
  }
}
