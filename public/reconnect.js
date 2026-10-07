/** Reconnect policy: wait while the server is unreachable, backing off with jitter. */

/** @type {number} */
export const BASE_DELAY_MS = 500;

/** @type {number} */
export const MAX_DELAY_MS = 10000;

/**
 * Half fixed, half random: the jitter keeps every browser off the same tick.
 *
 * @param {number} attempt 0 for the first retry after a drop
 * @param {number} [random] injectable for the tests
 * @returns {number}
 */
export function backoffDelay(attempt, random = Math.random()) {
  const window = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(window / 2 + (window / 2) * random);
}
