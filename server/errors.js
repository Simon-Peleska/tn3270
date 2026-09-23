// A code is an identity: append only, never renumber, never reuse. E1xxx config,
// E2xxx b3270, E3xxx session, E4xxx client, E5xxx browser, E6xxx transport, E7xxx REST.
const ERRORS = Object.freeze({
  E1001: "Config file could not be read",
  E1002: "Config file is not valid JSONC",
  E1003: "Config value has the wrong type",
  E1004: "Config value is out of range",
  E1005: "Config value is not a usable b3270 resource name",

  E2001: "b3270 could not be spawned",
  E2002: "b3270 exited unexpectedly",
  E2003: "b3270 emitted a line that is not valid JSON",
  E2004: "b3270 reported a protocol error",
  E2005: "b3270 action failed",
  E2006: "b3270 stdin is closed",

  E3001: "Session not found",
  E3002: "Session limit reached",
  E3003: "Session has too many viewers",
  E3004: "Screen indication referenced a cell outside the screen",
  E3005: "Host address is not allowed by config",
  E3006: "Input rejected: viewer is an observer",
  E3007: "Session is not accepting new viewers",

  E4001: "WebSocket message was not valid JSON",
  E4002: "WebSocket message had an unknown type",
  E4003: "Pasted text is too large to type into a screen",
  E4004: "Oversize screen has more cells than b3270 can hold",

  E5001: "Terminal renderer failed to initialise",
  E5002: "WebSocket connection to the server failed",
  E5003: "Settings could not be read from the browser database",
  E5004: "Settings could not be saved to the browser database",
  E5005: "Clipboard could not be read for a Shift+Insert paste",
  E5006: "Another terminal session could not be opened",
  // E5007 is spent.
  E5008: "Macros could not be read from the browser database",
  E5009: "Macros could not be saved to the browser database",
  E5010: "A macro file could not be read",
  E5011: "The keymap could not be saved to the browser database",
  E5012: "A keymap file could not be read",
  E5013: "The keymap could not be read from the browser database",
  E5014: "A dropped session could not be restarted",

  E6001: "Static file not found",
  E6002: "WebSocket upgrade path is not a session",
  E6003: "WebSocket closed unexpectedly",
  E6004: "Server could not start",
  E6005: "Log file could not be opened",
  E6006: "Log file could not be written or rolled over",
  // E6007-E6009 were the page inliner's, which is gone. Retired, not free.

  // E7001 is spent.
  E7002: "REST is not available for this session",
  E7003: "REST request to b3270 failed",
  // E7004 gated REST on a per-session switch, which is gone. Retired, not free.
});

/** @typedef {keyof typeof ERRORS} ErrorCode */

export class AppError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} [detail]
   * @param {unknown} [cause]
   */
  constructor(code, detail, cause) {
    const summary = detail ? `${ERRORS[code]}: ${detail}` : ERRORS[code];
    super(`[${code}] ${summary}`);
    this.name = "AppError";
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
  if (err instanceof Error) return { code: "E0000", summary: err.message };
  return { code: "E0000", summary: String(err) };
}
