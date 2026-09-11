/**
 * Stable error codes. A code is an identity: once assigned to a site it never
 * changes, so a code reported by a user leads straight back to one log line and
 * one place in the source. Add new codes at the end of a block; never renumber.
 *
 * E1xxx config, E2xxx b3270, E3xxx session, E4xxx websocket, E5xxx frontend,
 * E6xxx http.
 */
export const ERRORS = Object.freeze({
  E1001: 'Config file could not be read',
  E1002: 'Config file is not valid JSONC',
  E1003: 'Config value has the wrong type',
  E1004: 'Config value is out of range',
  E1005: 'Config value is not a usable b3270 resource name',

  E2001: 'b3270 could not be spawned',
  E2002: 'b3270 exited unexpectedly',
  E2003: 'b3270 emitted a line that is not valid JSON',
  E2004: 'b3270 reported a protocol error',
  E2005: 'b3270 action failed',
  E2006: 'b3270 stdin is closed',

  E3001: 'Session not found',
  E3002: 'Session limit reached',
  E3003: 'Session has too many viewers',
  E3004: 'Screen indication referenced a cell outside the screen',
  E3005: 'Host address is not allowed by config',
  // Retired: the session now drops and reopens the connection around a model
  // change instead of refusing it. The code stays here so it is never reused.
  E3006: 'The screen model cannot be changed while a host connection is open',

  E4001: 'WebSocket message was not valid JSON',
  E4002: 'WebSocket message had an unknown type',
  E4003: 'Input rejected: viewer is an observer',
  E4004: 'WebSocket closed unexpectedly',
  E4005: 'Pasted text is too large to type into a screen',

  E5001: 'Terminal renderer failed to initialise',
  E5002: 'WebSocket connection to the server failed',
  E5003: 'Settings could not be read from the browser database',
  E5004: 'Settings could not be saved to the browser database',
  E5005: 'Clipboard could not be read for a Shift+Insert paste',

  E6001: 'Static file not found',
  E6002: 'HTTP request failed',
  E6003: 'WebSocket upgrade path is not a session',
  E6004: 'Server could not start',
});

/** @typedef {keyof typeof ERRORS} ErrorCode */

/**
 * An error that carries a stable code all the way to the UI.
 */
export class AppError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} [detail] Context for this particular occurrence.
   * @param {unknown} [cause]
   */
  constructor(code, detail, cause) {
    const summary = detail ? `${ERRORS[code]}: ${detail}` : ERRORS[code];
    super(`[${code}] ${summary}`);
    this.name = 'AppError';
    /** @type {ErrorCode} */
    this.code = code;
    /** @type {string} */
    this.summary = summary;
    /** @type {unknown} */
    this.cause = cause;
  }
}

/**
 * @param {unknown} err
 * @returns {{ code: ErrorCode | 'E0000', summary: string }}
 */
export function describeError(err) {
  if (err instanceof AppError) return { code: err.code, summary: err.summary };
  if (err instanceof Error) return { code: 'E0000', summary: err.message };
  return { code: 'E0000', summary: String(err) };
}
