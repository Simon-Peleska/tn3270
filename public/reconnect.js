/**
 * Reconnect policy: retry only as long as the server still holds the
 * viewer-less session (`sessions.idleTimeoutMs`), backing off with jitter.
 */

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

/**
 * The server is asked rather than guessed at: a dead server and a reaped
 * session look identical from the socket but need opposite answers.
 *
 * @param {object} state
 * @param {boolean} state.answered whether the server answered at all
 * @param {boolean} state.sessionLive whether it still lists this session
 * @param {number} state.msLeft of the window the server holds a session for
 * @returns {'reconnect' | 'retry' | 'fresh'}
 */
export function reconnectStep({ answered, sessionLive, msLeft }) {
  if (answered && sessionLive) return "reconnect";
  // Server is up and has forgotten the session; waiting cannot bring it back.
  if (answered) return "fresh";
  return msLeft > 0 ? "retry" : "fresh";
}
