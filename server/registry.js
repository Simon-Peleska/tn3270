import { Session } from "./session.js";
import { AppError } from "./errors.js";
import { reserveRestEndpoint } from "./restproxy.js";
import { logger } from "./log.js";

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
   * @returns {Promise<Session>}
   */
  async create(client = { ip: "", user: "" }) {
    const occupied = this.sessions.size + this.creating;
    if (occupied >= this.config.sessions.maxSessions) {
      throw new AppError(
        "E3002",
        `${occupied} sessions are already open or starting`,
      );
    }
    this.creating++;
    try {
      const session = new Session(
        this.config,
        await reserveRestEndpoint(),
        undefined,
        client.user,
      );
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

      if (this.config.b3270.defaultHost !== null)
        session.connect(this.config.b3270.defaultHost);
      return session;
    } finally {
      this.creating--;
    }
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
