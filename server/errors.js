// A code is an identity: append only, never renumber, never reuse. E1xxx config,
// E2xxx emulator, E3xxx session, E4xxx client, E5xxx browser, E6xxx transport,
// E8xxx user data, E9xxx single sign-on.
export const ERRORS = Object.freeze({
  E1001: "Config file could not be read",
  E1002: "Config file is not valid JSONC",
  E1003: "Config value has the wrong type",
  E1004: "Config value is out of range",
  E1005: "Config setting is not an emulator setting",
  E1006: "Code page is in the wrong config section",
  E1007: "Config section was renamed",
  E1008: "Vendored ws does not match package-lock.json",
  E1009: "Single sign-on is off: its config is incomplete",

  // E2001-E2003 and E2006 were the b3270 child process's, which is gone. Retired, not free.
  E2004: "Emulator reported a protocol error",
  E2005: "Emulator action failed",
  // E2007 was the emulator thread pool's, which sessions no longer use. Retired, not free.

  E3001: "Session not found",
  E3002: "Session limit reached",
  E3003: "Session has too many viewers",
  E3004: "Screen indication referenced a cell outside the screen",
  E3005: "Host address is not allowed by config",
  E3006: "Input rejected: viewer is an observer",
  // E3007 is spent.
  E3008: "The session's owner did not let the viewer in",
  E3009: "The session's owner stopped sharing it",
  E3010: "Only the session's owner may answer requests or stop sharing",
  E3011: "The session's owner did not let the viewer edit",
  E3012: "The session's owner took editing back",
  E3013: "Session input queue is full",
  E3014: "Only the session's owner may terminate it",
  E3015: "Session terminated by its owner",
  // E3016 was the session worker threads', which are gone. Retired, not free.
  E3017: "Session size asked for is not valid",
  E3018: "Input waits until the logon has finished",
  E3019: "Only the session's owner may log on",
  E3020: "Logon screen did not appear in time",
  E3021: "Logon did not finish in time",
  E3022: "Not connected to the host for the logon",
  E3023: "No user name to sign on with: the proxy sent none",
  E3024: "Logon is not configured",
  E3025: "Logon request is not valid",
  E3026: "A logon is already running",
  E3027: "Logon could not be typed",
  E3028: "Session closed during the logon",

  E4001: "WebSocket message was not valid JSON",
  E4002: "WebSocket message had an unknown type",
  E4003: "Pasted text is too large to type into a screen",
  E4004: "Oversize screen has more cells than b3270 can hold",
  E4005: "Typed text is too large for one input",

  E5001: "Terminal renderer failed to initialise",
  E5002: "WebSocket connection to the server failed",
  E5003: "Settings could not be read from the server",
  E5004: "Settings could not be saved on the server",
  E5005: "Clipboard could not be read for a Shift+Insert paste",
  // E5006 was opening a second session in the same page, which is gone. Retired, not free.
  // E5007 is spent.
  E5008: "Macros could not be read from the server",
  E5009: "Macros could not be saved on the server",
  // E5010 is spent.
  E5011: "The keymap could not be saved on the server",
  // E5012 is spent.
  E5013: "The keymap could not be read from the server",
  E5014: "A dropped session could not be restarted",
  E5015: "A panel's command line held a command that panel does not know",
  E5016: "A line command was typed on a line that does not take it",
  E5017: "The text size is not a whole number in range",
  E5018: "A key was named that no key is called",
  E5019: "Connect was asked for with no host to connect to",
  E5020: "A macro was given a blank name",
  E5021: "Field background must be Y or N",
  E5022: "Force max font size must be Y or N",
  E5023: "Macro cursor position is invalid",
  E5024: "A macro step must be one key",
  E5025: "A macro step cannot be typed as free text",
  E5026: "Recording step number is invalid",
  E5027: "Recording has no steps",
  E5028: "Recordings could not be saved on the server",
  E5029: "Recordings could not be read from the server",
  E5030: "Recording could not be imported",
  E5031: "Recording file could not be read",
  E5032: "Open sessions could not be loaded",
  E5033: "No character was selected",
  E5034: "Character code is not two hex digits",
  E5035: "Character is not printable in this code page",
  E5036: "A recording was given a blank name",
  E5037: "Server sent a malformed WebSocket message",
  E5038: "First terminal session could not be opened",
  E5039: "Session could not be terminated",
  E5040: "No saved recording is available to repeat",
  E5041: "No macro has the number given on the command line",
  // E5042 is spent.
  E5043: "Page carries no saved settings from the server",
  E5044: "Logon could not be sent to the server",
  E5045: "Logon needs a user name and a password",

  E6001: "Static file not found",
  E6002: "WebSocket upgrade path is not a session",
  E6003: "WebSocket closed unexpectedly",
  E6004: "Server could not start",
  E6005: "Log file could not be opened",
  E6006: "Log file could not be written or rolled over",
  // E6007-E6009 were the page inliner's, which is gone. Retired, not free.
  E6010: "Viewer is too slow to receive the screen",
  E6011: "Page has no place for the user's settings",

  // E7001-E7004 were the REST proxy's, which is gone. Retired, not free.

  E8001: "User data database could not be opened",
  E8002: "User data could not be read",
  E8003: "User data could not be saved",
  E8004: "User data key is not one the server keeps",
  E8005: "User data is too large to save",
  E8006: "User data to save is not valid JSON",
  E8007: "User data key to read is not one the server keeps",

  E9001: "DCAS could not be reached",
  E9002: "DCAS did not answer in time",
  E9003: "DCAS refused the PassTicket request",
  E9004: "DCAS answer was not understood",
  E9005: "DCAS certificate files could not be read",
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
