import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError, describeError } from './errors.js';

/** @typedef {'debug' | 'info' | 'warn' | 'error'} Level */

/** @type {Record<Level, number>} */
const RANK = { debug: 10, info: 20, warn: 30, error: 40 };

/** @type {Level} */
let threshold = 'info';

/** @type {{ path: string, maxBytes: number, fd: number, size: number } | null} */
let file = null;

/** @param {Level} level */
export function setLogLevel(level) {
  threshold = level;
}

/**
 * Also write every line to a file, which rolls over to `<path>.1` once it
 * passes `maxBytes` — so at most two files, and never more than twice
 * `maxBytes` on disk. Only `main.js` calls this: a test that imported a logger
 * has no business writing files.
 *
 * @param {string} path
 * @param {number} maxBytes
 * @returns {void}
 */
export function setLogFile(path, maxBytes) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'a');
    file = { path, maxBytes, fd, size: fstatSync(fd).size };
  } catch (cause) {
    throw new AppError('E6005', path, cause);
  }
}

/** @returns {void} */
export function closeLogFile() {
  if (file === null) return;
  closeSync(file.fd);
  file = null;
}

/**
 * @param {string} line
 * @returns {void}
 */
function write(line) {
  process.stderr.write(line);
  if (file === null) return;

  try {
    file.size += writeSync(file.fd, line);
    if (file.size < file.maxBytes) return;
    closeSync(file.fd);
    renameSync(file.path, `${file.path}.1`);
    file.fd = openSync(file.path, 'a');
    file.size = 0;
  } catch (cause) {
    // Losing the file must not take the server with it, and must not leave
    // every later line throwing the same way: stderr keeps it.
    const lost = new AppError('E6006', file.path, cause);
    file = null;
    process.stderr.write(`${lost.message}\n`);
  }
}

/**
 * @param {Level} level
 * @param {string} scope
 * @param {Record<string, unknown>} context
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 */
function emit(level, scope, context, message, fields) {
  if (RANK[level] < RANK[threshold]) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), scope, message];
  for (const [key, value] of Object.entries({ ...context, ...fields })) {
    // A field nobody filled in is not news: `user=` on every line until an
    // authenticating proxy is in front of this server would be noise.
    if (value === '' || value === null || value === undefined) continue;
    parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  write(parts.join(' ') + '\n');
}

/**
 * Bound to one subsystem, so every line says where it came from, and to
 * whatever context that subsystem shares — the session id, the viewer's
 * address and user — so every line says who it was for without each call site
 * repeating it. Empty fields are left out, so a line only carries what is
 * actually known.
 *
 * @param {string} scope
 * @param {Record<string, unknown>} [context]
 */
export function logger(scope, context = {}) {
  return {
    /** @param {string} m @param {Record<string, unknown>} [f] */
    debug: (m, f) => emit('debug', scope, context, m, f),
    /** @param {string} m @param {Record<string, unknown>} [f] */
    info: (m, f) => emit('info', scope, context, m, f),
    /** @param {string} m @param {Record<string, unknown>} [f] */
    warn: (m, f) => emit('warn', scope, context, m, f),

    /**
     * A one-line summary with the code, then the error itself so no stack
     * trace is lost.
     * @param {unknown} err
     * @param {Record<string, unknown>} [f]
     */
    error: (err, f) => {
      const { code, summary } = describeError(err);
      emit('error', scope, context, `[${code}] ${summary}`, f);
      if (RANK.error >= RANK[threshold] && err instanceof Error) {
        write(`${err.stack ?? err.message}\n`);
        if (err.cause) write(`  caused by: ${String(err.cause)}\n`);
      }
    },

    /**
     * The same subsystem, with more bound to it — one viewer's address on top
     * of its session's id.
     * @param {Record<string, unknown>} extra
     */
    with: (extra) => logger(scope, { ...context, ...extra }),
  };
}

/** @typedef {ReturnType<typeof logger>} Logger */
