import {
  ansiColorIndex, grToSgr, MONO_FOREGROUND, DEFAULT_BACKGROUND,
  DEFAULT_FOREGROUND_ANSI, DEFAULT_BACKGROUND_ANSI,
} from './colors.js';

/**
 * Turns the authoritative ScreenModel into the VT bytes ghostty-web renders.
 * The same model emits either a delta or a complete repaint, which is what
 * makes a late-joining viewer possible.
 */

const ESC = '\x1b';

/**
 * Written once per viewer, before any painting. Autowrap must be off: with it
 * on, a character in the last column of the last row scrolls the whole screen
 * and every absolute cursor address after it is wrong.
 */
export const INIT_SEQUENCE = `${ESC}[?7l${ESC}[?25l${ESC}[0m${ESC}[H${ESC}[2J`;

/**
 * @param {number} index ANSI colour index, 0-15
 * @returns {number} the SGR foreground parameter
 */
function fgSgr(index) {
  return index < 8 ? 30 + index : 82 + index;
}

/**
 * @param {number} index ANSI colour index, 0-15
 * @returns {number} the SGR background parameter
 */
function bgSgr(index) {
  return index < 8 ? 40 + index : 92 + index;
}

/**
 * On an empty form a 3270 gives no hint of where the typeable fields are.
 * Tinting them is the one thing this emulator adds to what the host asked for,
 * and the viewer's own theme picks the colour.
 *
 * @param {string | null} hex `#rrggbb`; anything else means no tint, which is
 *   also the guard against a browser posting bytes every *other* viewer gets.
 * @returns {number[] | null} SGR parameters selecting it as a background
 */
export function fieldTintSgr(hex) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex ?? '');
  if (match === null) return null;
  const value = Number.parseInt(match[1], 16);
  return [48, 2, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * @param {import('./screen.js').Cell} cell
 * @param {import('./screen.js').ScreenModel} screen
 * @param {boolean} hostColors false emits no colour at all, leaving the cell to
 *   the terminal's own theme; only graphic rendition still carries meaning.
 * @param {number[] | null} fieldTint
 * @returns {string} the SGR sequence selecting this cell's appearance
 */
function sgrFor(cell, screen, hostColors, fieldTint) {
  /** @type {number[]} */
  const params = [0, ...grToSgr(cell.gr)];

  if (!hostColors) {
    // Nothing to add; the renderer's own default paints this cell.
  } else if (screen.color) {
    // The host only names a colour; which RGB that is comes from the viewer's
    // theme via the standard ANSI slot, as a shell's "red" does.
    const fg = ansiColorIndex(cell.fg ?? screen.defaultFg, DEFAULT_FOREGROUND_ANSI);
    const bg = ansiColorIndex(cell.bg ?? screen.defaultBg, DEFAULT_BACKGROUND_ANSI);
    params.push(fgSgr(fg), bgSgr(bg));
  } else {
    // A 3278 reports no colour, so it is the green-on-black terminal it is.
    params.push(38, 2, MONO_FOREGROUND[0], MONO_FOREGROUND[1], MONO_FOREGROUND[2]);
    params.push(48, 2, DEFAULT_BACKGROUND[0], DEFAULT_BACKGROUND[1], DEFAULT_BACKGROUND[2]);
  }

  // Last background wins, so this goes after the host's — but never over one
  // the host named itself, which was saying something.
  if (fieldTint !== null && cell.editable && cell.bg === null) params.push(...fieldTint);

  return `${ESC}[${params.join(';')}m`;
}

/**
 * @param {import('./screen.js').Cell} a
 * @param {import('./screen.js').Cell} b
 * @returns {boolean} whether the two would be painted identically
 */
function sameStyle(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.gr === b.gr && a.editable === b.editable;
}

/**
 * One full row, grouping runs of identically-styled cells so a typical 3270 row
 * costs a handful of escape sequences rather than eighty.
 *
 * @param {import('./screen.js').ScreenModel} screen
 * @param {number} row 0-based
 * @param {boolean} hostColors
 * @param {number[] | null} fieldTint
 * @returns {string}
 */
function encodeRow(screen, row, hostColors, fieldTint) {
  let out = `${ESC}[${row + 1};1H`;
  /** @type {import('./screen.js').Cell | null} */
  let styled = null;
  let runText = '';

  for (let col = 0; col < screen.cols; col++) {
    const cell = screen.cellAt(row, col);
    if (styled === null || !sameStyle(cell, styled)) {
      out += runText;
      out += sgrFor(cell, screen, hostColors, fieldTint);
      styled = cell;
      runText = '';
    }
    runText += cell.ch === '' ? ' ' : cell.ch;
  }
  return out + runText;
}

/**
 * @param {number} row 1-based terminal row for the status line
 * @param {string} text
 * @returns {string}
 */
function encodeOia(row, text) {
  return `${ESC}[${row};1H${ESC}[0;7m${text}${ESC}[0m`;
}

/**
 * @param {import('./screen.js').ScreenModel} screen
 * @returns {string}
 */
function encodeCursor(screen) {
  const { row, col, enabled } = screen.cursor;
  const clampedRow = Math.min(Math.max(row, 0), screen.rows - 1);
  const clampedCol = Math.min(Math.max(col, 0), screen.cols - 1);
  return `${ESC}[${clampedRow + 1};${clampedCol + 1}H${enabled ? `${ESC}[?25h` : `${ESC}[?25l`}`;
}

/**
 * Everything a viewer needs to show the screen from nothing, sent the moment it
 * attaches however long the session has been running.
 *
 * @param {import('./screen.js').ScreenModel} screen
 * @param {string} oiaText
 * @param {boolean} [hostColors] Off renders every cell in the viewer's own
 *   theme. Defaults to on, the real 3270's behaviour.
 * @param {string | null} [fieldColor] see {@link fieldTintSgr}
 * @returns {string}
 */
export function fullRepaint(screen, oiaText, hostColors = true, fieldColor = null) {
  const fieldTint = fieldTintSgr(fieldColor);
  let out = INIT_SEQUENCE;
  for (let row = 0; row < screen.rows; row++) out += encodeRow(screen, row, hostColors, fieldTint);
  out += encodeOia(screen.rows + 1, oiaText);
  return out + encodeCursor(screen);
}

/**
 * @param {import('./screen.js').ScreenModel} screen
 * @param {number[]} dirtyRows 0-based
 * @param {string} oiaText
 * @param {boolean} oiaChanged
 * @param {boolean} [hostColors] see {@link fullRepaint}
 * @param {string | null} [fieldColor] see {@link fieldTintSgr}
 * @returns {string} empty when there is nothing to send
 */
export function delta(screen, dirtyRows, oiaText, oiaChanged, hostColors = true, fieldColor = null) {
  if (dirtyRows.length === 0 && !oiaChanged) return encodeCursor(screen);

  const fieldTint = fieldTintSgr(fieldColor);
  let out = '';
  for (const row of dirtyRows) {
    if (row >= 0 && row < screen.rows) out += encodeRow(screen, row, hostColors, fieldTint);
  }
  if (oiaChanged) out += encodeOia(screen.rows + 1, oiaText);
  return out + encodeCursor(screen);
}
