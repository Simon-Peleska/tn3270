import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";
import { logger } from "./log.js";

const log = logger("userdata");

/** @typedef {'settings' | 'macros' | 'keymap' | 'recordings'} UserDataKey */

/** @type {readonly UserDataKey[]} */
export const USER_DATA_KEYS = Object.freeze([
  "settings",
  "macros",
  "keymap",
  "recordings",
]);

/**
 * A name when one is known, the address otherwise: without a proxy that
 * authenticates, everyone behind one address shares one set of settings.
 *
 * @param {{ ip: string, user: string }} client
 * @returns {string}
 */
export function ownerOf(client) {
  return client.user !== "" ? `user:${client.user}` : `ip:${client.ip}`;
}

/**
 * Blue and green deployments open the same file at once. WAL lets one write
 * while the other reads, the busy timeout makes a writer wait out the other's
 * lock instead of failing, and every write is one statement, so neither
 * process ever sees half of the other's. Two tabs saving the same key: the
 * last one wins, as it did in IndexedDB.
 *
 * @param {string} file
 */
export function openUserData(file) {
  /** @type {DatabaseSync} */
  let db;
  try {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS userdata (
      owner TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner, key)
    ) STRICT`);
  } catch (cause) {
    throw new AppError("E8001", file, cause);
  }
  log.info("opened", { file });

  const selectOne = db.prepare(
    "SELECT value FROM userdata WHERE owner = ? AND key = ?",
  );
  const upsert =
    db.prepare(`INSERT INTO userdata (owner, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (owner, key) DO UPDATE SET
      value = excluded.value, updated_at = excluded.updated_at`);

  return {
    /**
     * @param {string} owner
     * @param {readonly UserDataKey[]} [keys]
     * @returns {Partial<Record<UserDataKey, unknown>>} null for a key never saved
     */
    load(owner, keys = USER_DATA_KEYS) {
      /** @type {Partial<Record<UserDataKey, unknown>>} */
      const data = {};
      try {
        for (const key of keys) {
          const row = selectOne.get(owner, key);
          data[key] =
            row === undefined ? null : JSON.parse(String(row["value"]));
        }
      } catch (cause) {
        throw new AppError("E8002", owner, cause);
      }
      return data;
    },

    /**
     * @param {string} owner
     * @param {UserDataKey} key
     * @param {string} json already checked to parse
     * @returns {void}
     */
    save(owner, key, json) {
      try {
        upsert.run(owner, key, json, new Date().toISOString());
      } catch (cause) {
        throw new AppError("E8003", `${owner} ${key}`, cause);
      }
    },

    /** @returns {void} */
    close() {
      db.close();
    },
  };
}
