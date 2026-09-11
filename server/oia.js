/**
 * The Operator Information Area: the status line a real 3270 draws below the
 * screen. It is the only place a user can see *why* the keyboard is dead, so
 * it is worth rendering faithfully rather than dropping.
 */

/**
 * b3270's `lock` values, in the wording a 3270 operator expects. Unknown values
 * still show up (as "X <value>") rather than being swallowed.
 * @type {Readonly<Record<string, string>>}
 */
const LOCK_TEXT = Object.freeze({
  'not-connected': 'X Not Connected',
  'system': 'X SYSTEM',
  'wait': 'X Wait',
  'field': 'X Protected',
  'protected': 'X Protected',
  'numeric': 'X Numeric',
  'overflow': 'X Overflow',
  'dbcs': 'X DBCS',
  'minus': 'X -f',
  'deleted': 'X Deleted',
  'oerr': 'X Operator Error',
  'inhibit': 'X Inhibit',
  'disabled': 'X Disabled',
  'scrolled': 'X Scrolled',
});

/**
 * Columns held clear at the right-hand end of the line. The browser paints its
 * settings button over them (SETTINGS_BUTTON_LABEL in public/app.js is exactly
 * one narrower, so a space is left between the button and the status text) and
 * nothing the operator needs ever ends up underneath it.
 */
const SETTINGS_BUTTON_COLUMNS = 11;

/**
 * @typedef {object} OiaSnapshot
 * @property {string} connection
 * @property {string} lock
 * @property {boolean} insert
 * @property {string} lu
 */

export class OiaModel {
  constructor() {
    /** @type {string} */
    this.connectionState = 'not-connected';
    /** @type {string | null} */
    this.host = null;
    /** @type {string} */
    this.lock = 'not-connected';
    /** @type {boolean} */
    this.insert = false;
    /** @type {boolean} */
    this.typeahead = false;
    /** @type {string} */
    this.lu = '';
  }

  /**
   * @param {import('./b3270.js').OiaIndication} oia
   * @returns {void}
   */
  applyOia(oia) {
    const value = oia.value;
    switch (oia.field) {
      case 'lock':
        this.lock = typeof value === 'string' ? value : '';
        break;
      case 'insert':
        this.insert = value === true || value === 'true';
        break;
      case 'typeahead':
        this.typeahead = value === true || value === 'true';
        break;
      case 'lu':
        this.lu = typeof value === 'string' ? value : '';
        break;
      default:
        break;
    }
  }

  /**
   * @param {import('./b3270.js').ConnectionIndication} connection
   * @returns {void}
   */
  applyConnection(connection) {
    this.connectionState = connection.state;
    this.host = typeof connection.host === 'string' ? connection.host : null;
  }

  /** @returns {boolean} */
  get connected() {
    return this.connectionState.startsWith('connected');
  }

  /** @returns {boolean} Whether the keyboard is locked and input is pointless. */
  get keyboardLocked() {
    return this.lock !== '' && this.lock !== 'unlocked';
  }

  /**
   * Lay the status line out: connection on the left, lock state in the middle,
   * cursor position right — all of it squeezed into the width the settings
   * button leaves over, so the two never overlap.
   *
   * @param {number} cols
   * @param {import('./screen.js').Cursor} cursor
   * @returns {string} exactly `cols` characters
   */
  render(cols, cursor) {
    const width = Math.max(0, cols - SETTINGS_BUTTON_COLUMNS);
    const left = this.connected ? (this.host ?? 'connected') : this.connectionState;
    const lock = this.keyboardLocked ? (LOCK_TEXT[this.lock] ?? `X ${this.lock}`) : '';
    const flags = [this.insert ? 'Insert' : '', this.typeahead ? 'TA' : ''].filter(Boolean).join(' ');
    const position = `${String(cursor.row + 1).padStart(2, '0')}/${String(cursor.col + 1).padStart(3, '0')}`;

    const right = [flags, position].filter(Boolean).join('  ');
    const middle = lock;

    let line = left.slice(0, width);
    // Centre the lock message when there is room, otherwise just append it.
    const centreStart = Math.max(line.length + 2, Math.floor((width - middle.length) / 2));
    if (middle && centreStart + middle.length <= width - right.length - 2) {
      line = line.padEnd(centreStart, ' ') + middle;
    } else if (middle) {
      line = `${line}  ${middle}`;
    }

    if (right.length + 1 <= width) {
      line = line.slice(0, width - right.length - 1).padEnd(width - right.length, ' ') + right;
    }
    return line.slice(0, width).padEnd(cols, ' ');
  }
}
