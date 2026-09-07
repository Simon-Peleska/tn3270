import { describeError } from './errors.js';

/** @typedef {'debug' | 'info' | 'warn' | 'error'} Level */

/** @type {Record<Level, number>} */
const RANK = { debug: 10, info: 20, warn: 30, error: 40 };

/** @type {Level} */
let threshold = 'info';

/** @param {Level} level */
export function setLogLevel(level) {
  threshold = level;
}

/**
 * @param {Level} level
 * @param {string} scope
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 */
function emit(level, scope, message, fields) {
  if (RANK[level] < RANK[threshold]) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), scope, message];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }
  process.stderr.write(parts.join(' ') + '\n');
}

/**
 * A logger bound to one subsystem, so every line says where it came from.
 * @param {string} scope
 */
export function logger(scope) {
  return {
    /** @param {string} m @param {Record<string, unknown>} [f] */
    debug: (m, f) => emit('debug', scope, m, f),
    /** @param {string} m @param {Record<string, unknown>} [f] */
    info: (m, f) => emit('info', scope, m, f),
    /** @param {string} m @param {Record<string, unknown>} [f] */
    warn: (m, f) => emit('warn', scope, m, f),

    /**
     * Errors get a one-line summary with the code, then the full error so a
     * stack trace is never lost.
     * @param {unknown} err
     * @param {Record<string, unknown>} [f]
     */
    error: (err, f) => {
      const { code, summary } = describeError(err);
      emit('error', scope, `[${code}] ${summary}`, f);
      if (RANK.error >= RANK[threshold] && err instanceof Error) {
        process.stderr.write(`${err.stack ?? err.message}\n`);
        if (err.cause) process.stderr.write(`  caused by: ${String(err.cause)}\n`);
      }
    },
  };
}

/** @typedef {ReturnType<typeof logger>} Logger */
