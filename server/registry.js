import { Session } from "./session.js";
import { AppError } from "./errors.js";
import { reserveRestEndpoint } from "./restproxy.js";
import { logger } from "./log.js";

const LU_SUFFIXES = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * An LU name is at most eight characters and may not start with a digit: the
 * user's name cut to seven, behind a U if it starts with one, and a suffix none
 * of their other sessions holds. Without a user, or once the suffixes run out,
 * the session id stands in behind an S.
 *
 * @param {string} user as the proxy vouched for it, `alice@corp` or `CORP\alice`
 * @param {string} id the session's
 * @param {Set<string>} taken LU names other sessions hold
 * @returns {string}
 */
export function luName(user, id, taken) {
  const account = user.split("@")[0]?.split("\\").pop() ?? "";
  const letters = account.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const name = (/^[0-9]/.test(letters) ? `U${letters}` : letters).slice(0, 7);
  if (name !== "") {
    for (const suffix of LU_SUFFIXES)
      if (!taken.has(name + suffix)) return name + suffix;
  }
  return `S${id.slice(0, 7).toUpperCase()}`;
}

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
      if (this.config.sessions.assignLu) {
        const taken = new Set([...this.sessions.values()].map((s) => s.lu));
        session.lu = luName(client.user, session.id, taken);
      }
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
        lu: session.lu,
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
