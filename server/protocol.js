import { AppError } from "./errors.js";

/**
 * Wire format: one ordered channel of JSON messages, screen paints among them.
 *
 * @typedef {{ type: 'action', action: string, args?: string[] }} ActionMessage
 * @typedef {{ type: 'text', value: string }} TextMessage
 * @typedef {{ type: 'paste', text: string }} PasteMessage
 * @typedef {{ type: 'connect', host: string | null }} ConnectMessage
 * @typedef {{ type: 'disconnect' }} DisconnectMessage
 * @typedef {{ type: 'model', model: number }} ModelMessage
 * @typedef {{ type: 'oversize', value: string }} OversizeMessage `<cols>x<rows>`, or '' for the model's own size
 * @typedef {{ type: 'refresh' }} RefreshMessage
 * @typedef {{ type: 'copyField' }} CopyFieldMessage
 * @typedef {{ type: 'sharing', allowView: boolean, allowEdit: boolean }} SharingMessage
 * @typedef {{ type: 'recorder', action: 'start' | 'stop' }} RecorderMessage
 * @typedef {{ type: 'hints' }} HintsRequestMessage
 * @typedef {ActionMessage | TextMessage | PasteMessage | ConnectMessage | DisconnectMessage | ModelMessage | OversizeMessage | RefreshMessage | CopyFieldMessage | SharingMessage | RecorderMessage | HintsRequestMessage} ClientMessage
 *
 * @typedef {object} HelloMessage
 * @property {'hello'} type
 * @property {string} sessionId
 * @property {number} rows
 * @property {number} cols
 * @property {number} model
 * @property {import('./b3270.js').ModelInfo[]} models
 * @property {string} oversize `<cols>x<rows>`, or '' for the model's own size
 * @property {boolean} hostLocked
 * @property {'controller' | 'observer'} role
 * @property {number} viewers
 * @property {boolean} allowSharing
 * @property {boolean} allowSharedEditing
 * @property {number} idleTimeoutMs How long a viewerless session survives; 0 never reaps.
 *
 * Always sent immediately before the repaint that uses it, so no viewer writes
 * new-sized bytes into an old-sized terminal.
 *
 * @typedef {object} ScreenMessage
 * @property {'screen'} type
 * @property {number} model
 * @property {number} rows
 * @property {number} cols
 * @property {string} oversize `<cols>x<rows>`, or '' for the model's own size
 *
 * @typedef {object} StatusMessage
 * @property {'status'} type
 * @property {string} connection b3270's own word for it
 * @property {boolean} connected what that word means
 * @property {boolean} touched whether any viewer has ever aimed input at this session
 * @property {string | null} host
 * @property {string} lock b3270's own word for why the keyboard is locked;
 *   'unlocked' when it is not, '' before b3270 has said either way
 * @property {boolean} insert
 * @property {boolean} typeahead
 * @property {'controller' | 'observer'} role
 * @property {number} viewers
 * @property {boolean} allowSharing
 * @property {boolean} allowSharedEditing
 *
 * A run of cells sharing one style. Colours are b3270's own names — `red`,
 * `deepBlue`, `neutralWhite` — and `gr` is its own comma-separated rendition
 * string, both passed through untouched: the browser owns what they look like.
 * An omitted key means the screen default, or false for `editable`.
 *
 * @typedef {object} PaintRun
 * @property {number} col 0-based
 * @property {string} text
 * @property {string} [fg]
 * @property {string} [bg]
 * @property {string} [gr]
 * @property {boolean} [editable]
 *
 * @typedef {object} PaintRow
 * @property {number} row 0-based
 * @property {PaintRun[]} runs
 *
 * @typedef {object} PaintMessage
 * @property {'paint'} type
 * @property {boolean} full whether every cell not mentioned is now blank
 * @property {boolean} color false for a 3278: mono green, invent no colours
 * @property {{ rows: number, cols: number }} [size] sent on a full paint only:
 *   the screen it fills, so the paint needs nothing else to be applied
 *   (`rows` above is the rows it carries, which is not the same question)
 * @property {string} [defaultFg] sent on a full paint only; what an omitted fg means
 * @property {string} [defaultBg]
 * @property {PaintRow[]} rows only the rows that changed, unless `full`
 * @property {{ row: number, col: number, on: boolean }} cursor
 *
 * @typedef {object} ErrorMessage
 * @property {'error'} type
 * @property {string} code
 * @property {string} message
 *
 * @typedef {object} FieldContentMessage
 * @property {'fieldContent'} type
 * @property {string} text
 *
 * @typedef {object} RecorderStep
 * @property {string[]} screen one plain-text line per row, as of just before this step
 * @property {string} [action] omitted for a password marker
 * @property {string[]} [args]
 * @property {true} [password] a whole run of password keystrokes, collapsed so none are recorded
 *
 * @typedef {object} RecorderStepMessage
 * @property {'recorderStep'} type
 * @property {RecorderStep} step
 *
 * @typedef {object} HintsMessage
 * @property {'hints'} type
 * @property {{ row: number, col: number, letter: string }[]} hints
 *
 * @typedef {HelloMessage | ScreenMessage | PaintMessage | StatusMessage | ErrorMessage | FieldContentMessage | RecorderStepMessage | HintsMessage} ServerMessage
 */

/**
 * Allow-list: b3270 also accepts actions that read files and run programs.
 * `BackNewline` is ours alone; the session turns it into a cursor move, as it
 * turns `Undo` and `Redo` into a retype of the fields as they were.
 *
 * @type {ReadonlySet<string>}
 */
const ALLOWED_ACTIONS = new Set([
  "Enter",
  "Clear",
  "Reset",
  "Tab",
  "BackTab",
  "Home",
  "End",
  "Up",
  "Down",
  "Left",
  "Right",
  "Newline",
  "BackNewline",
  "Backspace",
  "Delete",
  "DeleteField",
  "DeleteWord",
  "EraseEOF",
  "EraseInput",
  "Insert",
  "ToggleInsert",
  "Attn",
  "SysReq",
  "Dup",
  "FieldMark",
  "PF",
  "PA",
  "CursorSelect",
  "MoveCursor1",
  "Undo",
  "Redo",
]);

/**
 * @param {string} raw
 * @returns {ClientMessage}
 */
export function parseClientMessage(raw) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new AppError("E4001", raw.slice(0, 120), cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError("E4001", "expected a JSON object");
  }

  const message = /** @type {Record<string, unknown>} */ (parsed);
  const type = message["type"];

  if (type === "action") {
    const action = message["action"];
    if (typeof action !== "string" || !ALLOWED_ACTIONS.has(action)) {
      throw new AppError("E4002", `action "${String(action)}" is not allowed`);
    }
    const rawArgs = message["args"];
    /** @type {string[]} */
    let args = [];
    if (rawArgs !== undefined) {
      if (!Array.isArray(rawArgs))
        throw new AppError("E4002", "args must be an array");
      args = rawArgs.map((arg) => String(arg));
    }
    return { type: "action", action, args };
  }

  if (type === "text") {
    const value = message["value"];
    if (typeof value !== "string")
      throw new AppError("E4002", "text.value must be a string");
    return { type: "text", value };
  }

  // b3270 types a paste one character at a time; a model 5 screenful is 3564 characters.
  if (type === "paste") {
    const text = message["text"];
    if (typeof text !== "string")
      throw new AppError("E4002", "paste.text must be a string");
    if (text.length > 16384)
      throw new AppError(
        "E4003",
        `paste of ${text.length} characters is too large`,
      );
    return { type: "paste", text };
  }

  if (type === "connect") {
    const host = message["host"];
    // A locked host never reaches the browser, so no host means the one the session knows.
    if (host === undefined || host === null)
      return { type: "connect", host: null };
    if (typeof host !== "string" || host === "") {
      throw new AppError("E4002", "connect.host must be a non-empty string");
    }
    return { type: "connect", host };
  }

  if (type === "disconnect") return { type: "disconnect" };

  if (type === "refresh") return { type: "refresh" };

  if (type === "copyField") return { type: "copyField" };

  if (type === "hints") return { type: "hints" };

  if (type === "sharing") {
    const allowView = message["allowView"];
    const allowEdit = message["allowEdit"];
    if (typeof allowView !== "boolean" || typeof allowEdit !== "boolean") {
      throw new AppError(
        "E4002",
        "sharing.allowView and allowEdit must be booleans",
      );
    }
    return { type: "sharing", allowView, allowEdit };
  }

  if (type === "recorder") {
    const action = message["action"];
    if (action !== "start" && action !== "stop") {
      throw new AppError(
        "E4002",
        `recorder.action must be "start" or "stop", got ${String(action)}`,
      );
    }
    return { type: "recorder", action };
  }

  if (type === "model") {
    const model = message["model"];
    if (
      typeof model !== "number" ||
      !Number.isInteger(model) ||
      model < 2 ||
      model > 5
    ) {
      throw new AppError(
        "E4002",
        `model must be a whole number between 2 and 5, got ${String(model)}`,
      );
    }
    return { type: "model", model };
  }

  // b3270 checks the size against the model but not the buffer: 16383 cells is its ctlr.c limit.
  if (type === "oversize") {
    const value = message["value"];
    if (typeof value !== "string")
      throw new AppError("E4002", "oversize.value must be a string");
    if (value === "") return { type: "oversize", value };
    const parts = /^(\d{1,5})x(\d{1,5})$/.exec(value);
    if (parts === null)
      throw new AppError(
        "E4002",
        `oversize must be <cols>x<rows>, got "${value}"`,
      );
    const cells = Number(parts[1]) * Number(parts[2]);
    if (cells > 16383)
      throw new AppError("E4004", `oversize ${value} is ${cells} cells`);
    return { type: "oversize", value };
  }

  throw new AppError("E4002", `unknown message type "${String(type)}"`);
}

/**
 * @param {string} host "name" or "name:port"
 * @param {string[]} allowed
 * @returns {boolean}
 */
export function isHostAllowed(host, allowed) {
  if (allowed.length === 0) return true;
  const bare = host.includes(":") ? host.slice(0, host.lastIndexOf(":")) : host;
  return allowed.some((entry) => entry === host || entry === bare);
}
