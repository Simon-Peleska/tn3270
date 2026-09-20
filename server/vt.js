import {
  ansiColorIndex, grToSgr, MONO_FOREGROUND, DEFAULT_BACKGROUND,
  DEFAULT_FOREGROUND_ANSI, DEFAULT_BACKGROUND_ANSI,
} from './colors.js';

const ESC = '\x1b';

/**
 * Autowrap must stay off: a character in the last cell would scroll the screen
 * and throw off every absolute cursor address after it.
 */
export const INIT_SEQUENCE = `${ESC}[?7l${ESC}[?25l${ESC}[0m${ESC}[H${ESC}[2J`;

/**
 * @param {number} index ANSI colour index, 0-15
 * @returns {number}
 */
function fgSgr(index) {
  return index < 8 ? 30 + index : 82 + index;
}

/**
 * @param {number} index ANSI colour index, 0-15
 * @returns {number}
 */
function bgSgr(index) {
  return index < 8 ? 40 + index : 92 + index;
}

/**
 * @param {string | null} hex `#rrggbb`; anything else means no tint
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
 * @param {boolean} hostColors false leaves the cell to the terminal's own theme
 * @param {number[] | null} fieldTint
 * @returns {string}
 */
function sgrFor(cell, screen, hostColors, fieldTint) {
  /** @type {number[]} */
  const params = [0, ...grToSgr(cell.gr)];

  if (!hostColors) {
    // Nothing to add; the renderer's own default paints this cell.
  } else if (screen.color) {
    // The host names a colour; the viewer's theme picks the RGB, via the ANSI slot.
    const fg = ansiColorIndex(cell.fg ?? screen.defaultFg, DEFAULT_FOREGROUND_ANSI);
    const bg = ansiColorIndex(cell.bg ?? screen.defaultBg, DEFAULT_BACKGROUND_ANSI);
    params.push(fgSgr(fg), bgSgr(bg));
  } else {
    // A 3278 reports no colour, so it is the green-on-black terminal it is.
    params.push(38, 2, MONO_FOREGROUND[0], MONO_FOREGROUND[1], MONO_FOREGROUND[2]);
    params.push(48, 2, DEFAULT_BACKGROUND[0], DEFAULT_BACKGROUND[1], DEFAULT_BACKGROUND[2]);
  }

  // Last background wins, so tint after the host's — but never over one it named itself.
  if (fieldTint !== null && cell.editable && cell.bg === null) params.push(...fieldTint);

  return `${ESC}[${params.join(';')}m`;
}

/**
 * @param {import('./screen.js').Cell} a
 * @param {import('./screen.js').Cell} b
 * @returns {boolean}
 */
function sameStyle(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.gr === b.gr && a.editable === b.editable;
}

/**
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
 * @param {number} row 1-based
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
 * @param {import('./screen.js').ScreenModel} screen
 * @param {string} oiaText
 * @param {boolean} [hostColors]
 * @param {string | null} [fieldColor]
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
 * @param {boolean} [hostColors]
 * @param {string | null} [fieldColor]
 * @returns {string}
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
