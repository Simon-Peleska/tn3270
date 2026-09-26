/**
 * Turns the screen model into the paint messages the browser draws from. No
 * colour work happens here: a run carries b3270's own names and the browser
 * decides what they look like. A row is always sent whole, so a run never has
 * to say what it leaves behind.
 */

import { paintRow } from "../public/paint-runs.js";

/**
 * @param {import('./screen.js').ScreenModel} screen
 * @returns {{ row: number, col: number, on: boolean }}
 */
function paintCursor(screen) {
  const { row, col, enabled } = screen.cursor;
  return {
    row: Math.min(Math.max(row, 0), screen.rows - 1),
    col: Math.min(Math.max(col, 0), screen.cols - 1),
    on: enabled,
  };
}

/**
 * @param {import('./screen.js').ScreenModel} screen
 * @returns {import('./protocol.js').PaintMessage}
 */
export function fullPaint(screen) {
  /** @type {import('./protocol.js').PaintRow[]} */
  const rows = [];
  for (let row = 0; row < screen.rows; row++)
    rows.push(paintRow(screen.cells, row, screen.cols));

  /** @type {import('./protocol.js').PaintMessage} */
  const paint = {
    type: "paint",
    full: true,
    color: screen.color,
    fieldsFormatted: screen.fieldsFormatted,
    size: { rows: screen.rows, cols: screen.cols },
    rows,
    cursor: paintCursor(screen),
  };
  if (screen.defaultFg !== null) paint.defaultFg = screen.defaultFg;
  if (screen.defaultBg !== null) paint.defaultBg = screen.defaultBg;
  return paint;
}

/**
 * @param {import('./screen.js').ScreenModel} screen
 * @param {number[]} dirtyRows 0-based
 * @returns {import('./protocol.js').PaintMessage}
 */
export function paintDelta(screen, dirtyRows) {
  /** @type {import('./protocol.js').PaintRow[]} */
  const rows = [];
  for (const row of dirtyRows) {
    if (row >= 0 && row < screen.rows)
      rows.push(paintRow(screen.cells, row, screen.cols));
  }

  return {
    type: "paint",
    full: false,
    color: screen.color,
    fieldsFormatted: screen.fieldsFormatted,
    rows,
    cursor: paintCursor(screen),
  };
}
