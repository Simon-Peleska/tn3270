import { Session } from "./session.js";
import { AppError } from "./errors.js";
import { logger } from "./log.js";

export class SessionRegistry {
  /** @param {import('./config.js').Config} config */
  constructor(config) {
    this.config = config;
    this.log = logger("registry");
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
  }

  /**
   * @param {{ ip: string, user: string }} [client]
   * @returns {Session}
   */
  create(client = { ip: "", user: "" }) {
    if (this.sessions.size >= this.config.sessions.maxSessions) {
      throw new AppError(
        "E3002",
        `${this.sessions.size} sessions are already open`,
      );
    }
    const session = new Session(this.config);
    session.startedBy = client.user || client.ip || "Unknown";
    session.onClosed = () => {
      this.sessions.delete(session.id);
      this.log.info("session removed", {
        session: session.id,
        remaining: this.sessions.size,
      });
    };
    this.sessions.set(session.id, session);
    this.log.info("session created", {
      session: session.id,
      ...client,
      total: this.sessions.size,
    });

    if (this.config.emulator.defaultHost !== null)
      session.connect(this.config.emulator.defaultHost);
    return session;
  }

  /**
   * @param {string} id
   * @returns {Session}
   */
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

  /** @returns {void} */
  closeAll() {
    for (const session of [...this.sessions.values()]) session.close();
  }
}
