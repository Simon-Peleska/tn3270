/**
 * When a socket drops, the session behind it is usually still there: the server
 * holds a viewer-less session for `sessions.idleTimeoutMs` and only then reaps
 * it, so that window is exactly how long reconnecting is worth trying.
 *
 * Retries back off exponentially with jitter, after
 * https://dev.to/hexshift/robust-websocket-reconnection-strategies-in-javascript-with-exponential-backoff-40n1
 * — a server coming back up is met by browsers spread over the window rather
 * than all of them at once on the same tick.
 */

/** @type {number} The first retry waits about this long. */
export const BASE_DELAY_MS = 500;

/** @type {number} No retry waits longer than this, however long the outage. */
export const MAX_DELAY_MS = 10000;

/**
 * Half the delay is the backoff, half is random: without the fixed half the
 * first retries can still land on top of each other, and without the random
 * half every browser retries on the same tick forever.
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
 * What to do with a session whose socket has dropped, once the server has been
 * asked whether it still has it.
 *
 * The server is asked rather than guessed at, because a browser never says why
 * a WebSocket failed: "the server is down" and "the session was reaped" look
 * identical from the socket, and they need opposite answers — wait for the
 * first, start over for the second.
 *
 * @param {object} state
 * @param {boolean} state.answered whether the server answered at all
 * @param {boolean} state.sessionLive whether it still lists this session
 * @param {number} state.msLeft of the window the server holds a session for
 * @returns {'reconnect' | 'retry' | 'fresh'}
 */
export function reconnectStep({ answered, sessionLive, msLeft }) {
  if (answered && sessionLive) return 'reconnect';
  // The server is up and has forgotten this session; no amount of waiting
  // brings it back, so take a new one now instead of sitting out the window.
  if (answered) return 'fresh';
  return msLeft > 0 ? 'retry' : 'fresh';
}
