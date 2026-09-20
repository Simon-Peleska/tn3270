import { AppError } from './errors.js';

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The WebSocket wire format: screen output as **binary** frames of VT bytes,
 * control traffic as **text** frames of JSON. The frame type alone tells them
 * apart, so neither needs an envelope.
 *
 * @typedef {{ type: 'action', action: string, args?: string[] }} ActionMessage
 * @typedef {{ type: 'text', value: string }} TextMessage
 * @typedef {{ type: 'paste', text: string }} PasteMessage
 * @typedef {{ type: 'connect', host: string | null }} ConnectMessage
 * @typedef {{ type: 'disconnect' }} DisconnectMessage
 * @typedef {{ type: 'model', model: number }} ModelMessage
 * @typedef {{ type: 'oversize', value: string }} OversizeMessage `<cols>x<rows>`, or '' for the model's own size
 * @typedef {{ type: 'refresh' }} RefreshMessage
 * @typedef {{ type: 'hostColors', enabled: boolean }} HostColorsMessage
 * @typedef {{ type: 'copyField' }} CopyFieldMessage
 * @typedef {{ type: 'fieldColor', color: string | null }} FieldColorMessage
 * @typedef {{ type: 'sharing', allowView: boolean, allowEdit: boolean }} SharingMessage
 *   The controller's own call: allowView lets a second viewer attach at all,
 *   allowEdit lets one who has typed.
 * @typedef {{ type: 'recorder', action: 'start' | 'stop' }} RecorderMessage
 * @typedef {{ type: 'hints' }} HintsRequestMessage Ctrl-B's hint mode, asking
 *   which letter jumps to which field — answered synchronously from the field
 *   map already cached for tinting and Backspace, no b3270 round trip needed.
 * @typedef {ActionMessage | TextMessage | PasteMessage | ConnectMessage | DisconnectMessage | ModelMessage | OversizeMessage | RefreshMessage | HostColorsMessage | CopyFieldMessage | FieldColorMessage | SharingMessage | RecorderMessage | HintsRequestMessage} ClientMessage
 *
 * @typedef {object} HelloMessage
 * @property {'hello'} type
 * @property {string} sessionId
 * @property {number} rows
 * @property {number} cols
 * @property {number} model
 * @property {import('./b3270.js').ModelInfo[]} models
 * @property {string} oversize `<cols>x<rows>`, or '' for the model's own size
 * @property {boolean} hostLocked The host comes from the config; the page hides it.
 * @property {'controller' | 'observer'} role
 * @property {number} viewers
 * @property {boolean} allowSharing Whether a second viewer may attach at all.
 * @property {boolean} allowSharedEditing Whether a viewer who is not the
 *   controller may still type.
 * @property {number} idleTimeoutMs How long the server keeps this session alive
 *   once its last viewer is gone, so a page that drops knows how long it is
 *   worth reconnecting for. 0 means the session is never reaped.
 *
 * Sent whenever the grid changes size, always immediately before the repaint
 * that uses it: the WebSocket keeps that order, so no viewer ever writes
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
 * @property {boolean} connected what that word means — decided here, so no
 *   client has to keep its own list of which states count as connected
 * @property {boolean} touched whether input has ever been aimed at this
 *   session, by any viewer
 * @property {string | null} host
 * @property {boolean} locked
 * @property {boolean} insert
 * @property {'controller' | 'observer'} role
 * @property {number} viewers
 * @property {boolean} allowSharing
 * @property {boolean} allowSharedEditing
 *
 * @typedef {object} ErrorMessage
 * @property {'error'} type
 * @property {string} code
 * @property {string} message
 *
 * Answers a `copyField` request. A refused request (no field under the cursor,
 * or a protected one) sends nothing and leaves the clipboard alone.
 *
 * @typedef {object} FieldContentMessage
 * @property {'fieldContent'} type
 * @property {string} text
 *
 * One step of a recording in progress, sent to every viewer the moment it
 * happens so a `RecorderPage` can build up its export without polling.
 *
 * @typedef {object} RecorderStep
 * @property {string[]} screen The screen, one plain-text line per row, as it
 *   stood right before this step was applied.
 * @property {string} [action] A b3270 action name — omitted for a password
 *   marker, which carries no action of its own.
 * @property {string[]} [args]
 * @property {true} [password] A whole run of keystrokes into a password field,
 *   collapsed to this one marker so none of them are ever recorded.
 *
 * @typedef {object} RecorderStepMessage
 * @property {'recorderStep'} type
 * @property {RecorderStep} step
 *
 * Answers a `hints` request: one letter per editable field, in screen order.
 * A screen with no fields at all — or none of them free letters ran out
 * before reaching — sends an empty list, not an error.
 *
 * @typedef {object} HintsMessage
 * @property {'hints'} type
 * @property {{ row: number, col: number, letter: string }[]} hints
 *
 * @typedef {HelloMessage | ScreenMessage | StatusMessage | ErrorMessage | FieldContentMessage | RecorderStepMessage | HintsMessage} ServerMessage
 */

/**
 * b3270 accepts far more actions than these, including ones that read files and
 * run programs, so this is an allow-list and not a pass-through.
 *
 * @type {ReadonlySet<string>}
 */
const ALLOWED_ACTIONS = new Set([
  'Enter', 'Clear', 'Reset', 'Tab', 'BackTab', 'Home', 'End',
  'Up', 'Down', 'Left', 'Right', 'Newline',
  'Backspace', 'Delete', 'DeleteField', 'DeleteWord', 'EraseEOF', 'EraseInput',
  'Insert', 'ToggleInsert', 'Attn', 'SysReq', 'Dup', 'FieldMark',
  'PF', 'PA', 'CursorSelect', 'MoveCursor1',
]);

/**
 * Parse a text frame from a browser, rejecting anything unrecognised with a
 * stable code rather than forwarding it to b3270.
 *
 * @param {string} raw
 * @returns {ClientMessage}
 */
export function parseClientMessage(raw) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new AppError('E4001', raw.slice(0, 120), cause);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('E4001', 'expected a JSON object');
  }

  const message = /** @type {Record<string, unknown>} */ (parsed);
  const type = message['type'];

  if (type === 'action') {
    const action = message['action'];
    if (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
      throw new AppError('E4002', `action "${String(action)}" is not allowed`);
    }
    const rawArgs = message['args'];
    /** @type {string[]} */
    let args = [];
    if (rawArgs !== undefined) {
      if (!Array.isArray(rawArgs)) throw new AppError('E4002', 'args must be an array');
      args = rawArgs.map((arg) => String(arg));
    }
    return { type: 'action', action, args };
  }

  if (type === 'text') {
    const value = message['value'];
    if (typeof value !== 'string') throw new AppError('E4002', 'text.value must be a string');
    return { type: 'text', value };
  }

  // b3270 types a paste one character at a time, and a model 5 screenful is
  // 3564 characters; a few of those over is a mistake, not a paste.
  if (type === 'paste') {
    const text = message['text'];
    if (typeof text !== 'string') throw new AppError('E4002', 'paste.text must be a string');
    if (text.length > 16384) throw new AppError('E4003', `paste of ${text.length} characters is too large`);
    return { type: 'paste', text };
  }

  if (type === 'connect') {
    const host = message['host'];
    // A locked host never reaches the browser, so "connect" without one means
    // the host the session already knows.
    if (host === undefined || host === null) return { type: 'connect', host: null };
    if (typeof host !== 'string' || host === '') {
      throw new AppError('E4002', 'connect.host must be a non-empty string');
    }
    return { type: 'connect', host };
  }

  if (type === 'disconnect') return { type: 'disconnect' };

  if (type === 'hostColors') {
    const enabled = message['enabled'];
    if (typeof enabled !== 'boolean') throw new AppError('E4002', 'hostColors.enabled must be a boolean');
    return { type: 'hostColors', enabled };
  }

  // Echoed back into VT bytes every viewer of this session may receive, so the
  // shape is checked here rather than trusted.
  if (type === 'fieldColor') {
    const color = message['color'];
    if (color === null || color === undefined) return { type: 'fieldColor', color: null };
    if (typeof color !== 'string' || !HEX_COLOR.test(color)) {
      throw new AppError('E4002', `fieldColor.color must be #rrggbb, got ${String(color)}`);
    }
    return { type: 'fieldColor', color };
  }

  // The settings page draws over the terminal and needs the host screen back.
  if (type === 'refresh') return { type: 'refresh' };

  if (type === 'copyField') return { type: 'copyField' };

  if (type === 'hints') return { type: 'hints' };

  if (type === 'sharing') {
    const allowView = message['allowView'];
    const allowEdit = message['allowEdit'];
    if (typeof allowView !== 'boolean' || typeof allowEdit !== 'boolean') {
      throw new AppError('E4002', 'sharing.allowView and allowEdit must be booleans');
    }
    return { type: 'sharing', allowView, allowEdit };
  }

  if (type === 'recorder') {
    const action = message['action'];
    if (action !== 'start' && action !== 'stop') {
      throw new AppError('E4002', `recorder.action must be "start" or "stop", got ${String(action)}`);
    }
    return { type: 'recorder', action };
  }

  if (type === 'model') {
    const model = message['model'];
    if (typeof model !== 'number' || !Number.isInteger(model) || model < 2 || model > 5) {
      throw new AppError('E4002', `model must be a whole number between 2 and 5, got ${String(model)}`);
    }
    return { type: 'model', model };
  }

  // b3270 checks the size against the model itself. What it cannot check is a
  // screen it has no buffer for: 16383 cells is the limit in its own ctlr.c.
  if (type === 'oversize') {
    const value = message['value'];
    if (typeof value !== 'string') throw new AppError('E4002', 'oversize.value must be a string');
    if (value === '') return { type: 'oversize', value };
    const parts = /^(\d{1,5})x(\d{1,5})$/.exec(value);
    if (parts === null) throw new AppError('E4002', `oversize must be <cols>x<rows>, got "${value}"`);
    const cells = Number(parts[1]) * Number(parts[2]);
    if (cells > 16383) throw new AppError('E4004', `oversize ${value} is ${cells} cells`);
    return { type: 'oversize', value };
  }

  throw new AppError('E4002', `unknown message type "${String(type)}"`);
}

/**
 * An empty list is open, for trusted networks. An entry may omit the port to
 * allow any port on that host.
 *
 * @param {string} host as given by the client, "name" or "name:port"
 * @param {string[]} allowed
 * @returns {boolean}
 */
export function isHostAllowed(host, allowed) {
  if (allowed.length === 0) return true;
  const bare = host.includes(':') ? host.slice(0, host.lastIndexOf(':')) : host;
  return allowed.some((entry) => entry === host || entry === bare);
}
