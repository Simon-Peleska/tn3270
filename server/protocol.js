import { AppError, describeError } from "./errors.js";

/** The most cells a 3270 buffer address reaches: x3270's ctlr.c limit. */
export const MAX_CELLS = 16383;

/**
 * Wire format: one ordered channel of JSON messages, screen paints among them.
 *
 * @typedef {{ type: 'action', action: string, args?: string[], repeat?: boolean }} ActionMessage
 * @typedef {{ type: 'text', value: string }} TextMessage
 * @typedef {{ type: 'paste', text: string }} PasteMessage
 * @typedef {{ type: 'macro', steps: (ActionMessage | TextMessage | PasteMessage)[], repeat?: boolean }} MacroMessage
 *   played in order, as one entry in the input queue
 * @typedef {{ type: 'connect', host: string | null }} ConnectMessage
 * @typedef {{ type: 'disconnect' }} DisconnectMessage
 * @typedef {{ type: 'model', model: number }} ModelMessage
 * @typedef {{ type: 'oversize', value: string }} OversizeMessage `<cols>x<rows>`, or '' for the model's own size
 * @typedef {{ type: 'askEdit' }} AskEditMessage
 * @typedef {{ type: 'answer', viewer: string, allow: boolean }} AnswerMessage the owner's yes or no to a request
 * @typedef {{ type: 'stopSharing' }} StopSharingMessage
 * @typedef {{ type: 'stopEditing' }} StopEditingMessage
 * @typedef {{ type: 'recorder', action: 'start' | 'stop' }} RecorderMessage
 * @typedef {ActionMessage | TextMessage | PasteMessage | MacroMessage | ConnectMessage | DisconnectMessage | ModelMessage | OversizeMessage | AskEditMessage | AnswerMessage | StopSharingMessage | StopEditingMessage | RecorderMessage} ClientMessage
 *
 * @typedef {object} HelloMessage
 * @property {'hello'} type
 * @property {number} rows
 * @property {number} cols
 * @property {number} model
 * @property {string} codePage the emulator's host code page, by its canonical name
 * @property {string} chart what each EBCDIC byte from 0x40 to 0xFF shows on that code page
 * @property {string} oversize `<cols>x<rows>`, or '' for the model's own size
 * @property {boolean} hostLocked
 * @property {'controller' | 'observer'} role
 * @property {boolean} owner
 * @property {string} pass comes back on the next connection, so a reload is let in without asking
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
 * @property {boolean} owner
 * @property {number} guests viewers let in by an owner
 * @property {string | null} editor the guest who may edit, by name
 * @property {SharingRequest[]} requests empty for everyone but an owner
 * @property {boolean} editRequested this viewer asked to edit and has no answer yet
 *
 * @typedef {object} SharingRequest
 * @property {string} viewer
 * @property {string} name the user the proxy vouched for, else the address
 * @property {'watch' | 'edit'} kind
 *
 * Sent to a viewer that has to wait for an owner's yes before it sees anything.
 * @typedef {{ type: 'waiting' }} WaitingMessage
 *
 * The connection closes right after; the browser must not come back on its own.
 * @typedef {{ type: 'refused', code: string, message: string }} RefusedMessage
 * @typedef {{ type: 'logon', code: string, message: string }} LogonMessage single sign-on failed: the owner logs on by hand
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
 * @property {boolean} fieldsFormatted false for a screen without fields
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
 * @typedef {object} RecorderStep
 * @property {string[]} screen one plain-text line per row, as of just before this step
 * @property {PaintMessage} [paint] the same full, styled screen sent to a client; absent in older recordings
 * @property {{ row: number, col: number }} cursor 0-based position before this step
 * @property {{ row: number, col: number, length: number }[]} [hidden] the non-display input fields; absent when there are none, and in older recordings
 * @property {string} [action] omitted for a password marker
 * @property {string[]} [args]
 * @property {true} [password] a whole run of password keystrokes, collapsed so none are recorded
 * @property {true} [final] the last screen after the recorded inputs
 *
 * @typedef {object} RecorderStepMessage
 * @property {'recorderStep'} type
 * @property {RecorderStep} step
 *
 * @typedef {{ type: 'recorderStopped' }} RecorderStoppedMessage
 *
 * Another tab of the same user saved this key.
 * @typedef {{ type: 'userdata', key: import('./userdata.js').UserDataKey }} UserDataMessage
 *
 * @typedef {HelloMessage | ScreenMessage | PaintMessage | StatusMessage | ErrorMessage | RecorderStepMessage | RecorderStoppedMessage | WaitingMessage | RefusedMessage | LogonMessage | UserDataMessage} ServerMessage
 */

/**
 * Allow-list: what a browser may run. Connecting, disconnecting and sizing
 * have messages of their own, which the session checks first. `BackNewline` and `FieldStart` are ours alone; the session turns them into
 * cursor moves, as it turns `Undo` and `Redo` into a retype of the fields as
 * they were.
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
  "FieldEnd",
  "FieldStart",
  "Up",
  "Down",
  "Left",
  "Right",
  "PreviousWord",
  "NextWord",
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
  return parseMessage(/** @type {Record<string, unknown>} */ (parsed));
}

/**
 * The size a new session starts at, checked as the model and oversize messages
 * are. Starting there is what keeps a page from seeing a 24x80 screen first,
 * and a host connection from being dropped to resize it.
 *
 * @param {string} body JSON, or empty for the server's own size
 * @returns {{ model?: number, oversize?: string }}
 */
export function parseSessionSize(body) {
  if (body === "") return {};
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new AppError("E3017", body.slice(0, 120), cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new AppError("E3017", "expected a JSON object");
  const raw = /** @type {Record<string, unknown>} */ (parsed);

  /** @type {{ model?: number, oversize?: string }} */
  const size = {};
  try {
    if (raw["model"] !== undefined) {
      const message = parseMessage({ type: "model", model: raw["model"] });
      if (message.type === "model") size.model = message.model;
    }
    if (raw["oversize"] !== undefined) {
      const message = parseMessage({
        type: "oversize",
        value: raw["oversize"],
      });
      if (message.type === "oversize") size.oversize = message.value;
    }
  } catch (cause) {
    throw new AppError("E3017", describeError(cause).summary, cause);
  }
  return size;
}

/**
 * The body is never quoted back: it holds a password.
 *
 * @param {string} body JSON `{ user, password }`
 * @returns {{ user: string, password: string }}
 */
export function parseLogon(body) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError("E3025", "not JSON");
  }
  const raw = /** @type {Record<string, unknown> | null} */ (parsed);
  const user = raw?.["user"];
  const password = raw?.["password"];
  if (typeof user !== "string" || user === "" || user.length > 64)
    throw new AppError("E3025", "user must be 1 to 64 characters");
  if (typeof password !== "string" || password === "" || password.length > 256)
    throw new AppError("E3025", "password must be 1 to 256 characters");
  return { user, password };
}

/**
 * @param {Record<string, unknown>} message
 * @returns {ClientMessage}
 */
function parseMessage(message) {
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
    if (message["repeat"] === true)
      return { type: "action", action, args, repeat: true };
    return { type: "action", action, args };
  }

  if (type === "text") {
    const value = message["value"];
    if (typeof value !== "string")
      throw new AppError("E4002", "text.value must be a string");
    if (value.length > 16384)
      throw new AppError(
        "E4005",
        `text of ${value.length} characters is too large`,
      );
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

  if (type === "macro") {
    const rawSteps = message["steps"];
    if (!Array.isArray(rawSteps))
      throw new AppError("E4002", "macro.steps must be an array");
    const steps = rawSteps.map((rawStep) => {
      const step =
        typeof rawStep === "object" &&
        rawStep !== null &&
        !Array.isArray(rawStep)
          ? parseMessage(/** @type {Record<string, unknown>} */ (rawStep))
          : null;
      if (
        step?.type !== "action" &&
        step?.type !== "text" &&
        step?.type !== "paste"
      )
        throw new AppError(
          "E4002",
          "macro.steps must be actions, text and pastes",
        );
      return step;
    });
    if (message["repeat"] === true)
      return { type: "macro", steps, repeat: true };
    return { type: "macro", steps };
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

  if (type === "askEdit") return { type: "askEdit" };

  if (type === "stopSharing") return { type: "stopSharing" };

  if (type === "stopEditing") return { type: "stopEditing" };

  if (type === "answer") {
    const viewer = message["viewer"];
    const allow = message["allow"];
    if (typeof viewer !== "string" || typeof allow !== "boolean") {
      throw new AppError(
        "E4002",
        "answer.viewer must be a string and answer.allow a boolean",
      );
    }
    return { type: "answer", viewer, allow };
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

  // The emulator checks the size against the model but not the buffer.
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
    if (cells > MAX_CELLS)
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
