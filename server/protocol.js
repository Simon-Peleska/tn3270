import { AppError } from './errors.js';

/**
 * The WebSocket wire format.
 *
 * Screen output travels as **binary** frames containing VT bytes; control
 * traffic travels as **text** frames containing JSON. The frame type alone
 * distinguishes them, so neither needs an envelope.
 *
 * @typedef {{ type: 'action', action: string, args?: string[] }} ActionMessage
 * @typedef {{ type: 'text', value: string }} TextMessage
 * @typedef {{ type: 'connect', host: string | null }} ConnectMessage
 * @typedef {{ type: 'disconnect' }} DisconnectMessage
 * @typedef {{ type: 'model', model: number }} ModelMessage
 * @typedef {{ type: 'refresh' }} RefreshMessage
 * @typedef {{ type: 'hostColors', enabled: boolean }} HostColorsMessage
 * @typedef {ActionMessage | TextMessage | ConnectMessage | DisconnectMessage | ModelMessage | RefreshMessage | HostColorsMessage} ClientMessage
 *
 * @typedef {object} HelloMessage
 * @property {'hello'} type
 * @property {string} sessionId
 * @property {number} rows
 * @property {number} cols
 * @property {number} model
 * @property {import('./b3270.js').ModelInfo[]} models
 * @property {boolean} hostLocked The host comes from the config; the page hides it.
 * @property {'controller' | 'observer'} role
 * @property {number} viewers
 *
 * Sent whenever the grid changes size, always immediately before the repaint
 * that uses the new size — the WebSocket keeps them in that order, so a viewer
 * never writes new-sized bytes into an old-sized terminal.
 *
 * @typedef {object} ScreenMessage
 * @property {'screen'} type
 * @property {number} model
 * @property {number} rows
 * @property {number} cols
 *
 * @typedef {object} StatusMessage
 * @property {'status'} type
 * @property {string} connection
 * @property {string | null} host
 * @property {boolean} locked
 * @property {boolean} insert
 * @property {'controller' | 'observer'} role
 * @property {number} viewers
 *
 * @typedef {object} ErrorMessage
 * @property {'error'} type
 * @property {string} code
 * @property {string} message
 *
 * @typedef {HelloMessage | ScreenMessage | StatusMessage | ErrorMessage} ServerMessage
 */

/**
 * Actions a client may ask for. b3270 accepts far more, including ones that
 * read files and run programs, so the set is a strict allow-list rather than a
 * pass-through.
 *
 * @type {ReadonlySet<string>}
 */
export const ALLOWED_ACTIONS = new Set([
  'Enter', 'Clear', 'Reset', 'Tab', 'BackTab', 'Home', 'End',
  'Up', 'Down', 'Left', 'Right', 'Newline',
  'Backspace', 'Delete', 'DeleteField', 'DeleteWord', 'EraseEOF', 'EraseInput',
  'Insert', 'ToggleInsert', 'Attn', 'SysReq', 'Dup', 'FieldMark',
  'PF', 'PA', 'CursorSelect',
]);

/**
 * Parse and validate a text frame from a browser. Anything unrecognised is
 * rejected with a stable code rather than being forwarded to b3270.
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

  if (type === 'connect') {
    const host = message['host'];
    // With the host locked in the config the browser never learns it, so
    // "connect" without one means the host the session already knows.
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

  // The settings page draws over the terminal, so the browser needs a way to
  // ask for the host screen back when it closes.
  if (type === 'refresh') return { type: 'refresh' };

  if (type === 'model') {
    const model = message['model'];
    if (typeof model !== 'number' || !Number.isInteger(model) || model < 2 || model > 5) {
      throw new AppError('E4002', `model must be a whole number between 2 and 5, got ${String(model)}`);
    }
    return { type: 'model', model };
  }

  throw new AppError('E4002', `unknown message type "${String(type)}"`);
}

/**
 * A host is allowed when the list is empty (open, for trusted networks) or when
 * it matches an entry. Entries may omit the port to allow any port on that host.
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
