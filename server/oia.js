/**
 * The Operator Information Area: the status line a real 3270 draws below the
 * screen, and the only place a user can see *why* the keyboard is dead.
 */

/**
 * b3270's `lock` values in the wording an operator expects. Anything else still
 * shows, as "X <value>".
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

/** Held clear at the right for the browser's own buttons, which are one column
 *  narrower together (BUTTONS in public/app.js) so a space is left. */
const BUTTON_COLUMNS = 46;

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

  /** @returns {boolean} Locked means input is pointless. */
  get keyboardLocked() {
    return this.lock !== '' && this.lock !== 'unlocked';
  }

  /**
   * Connection left, lock state middle, cursor position right — inside the width
   * the buttons leave over, so the two never overlap.
   *
   * @param {number} cols
   * @param {import('./screen.js').Cursor} cursor
   * @returns {string} exactly `cols` characters
   */
  render(cols, cursor) {
    const width = Math.max(0, cols - BUTTON_COLUMNS);
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
