/**
 * Turns the screen model into the paint messages the browser draws from. No
 * colour work happens here: a run carries b3270's own names and the browser
 * decides what they look like. A row is always sent whole, so a run never has
 * to say what it leaves behind.
 */

/**
 * @param {import('./screen.js').Cell} a
 * @param {import('./screen.js').Cell} b
 * @returns {boolean}
 */
function sameStyle(a, b) {
  return (
    a.fg === b.fg && a.bg === b.bg && a.gr === b.gr && a.editable === b.editable
  );
}

/**
 * @param {import('./screen.js').ScreenModel} screen
 * @param {number} row 0-based
 * @returns {import('./protocol.js').PaintRow}
 */
function paintRow(screen, row) {
  /** @type {import('./protocol.js').PaintRun[]} */
  const runs = [];
  /** @type {import('./protocol.js').PaintRun | null} */
  let run = null;
  /** @type {import('./screen.js').Cell | null} */
  let styled = null;

  for (let col = 0; col < screen.cols; col++) {
    const cell = screen.cellAt(row, col);
    if (run === null || styled === null || !sameStyle(cell, styled)) {
      run = { col, text: "" };
      if (cell.fg !== null) run.fg = cell.fg;
      if (cell.bg !== null) run.bg = cell.bg;
      if (cell.gr !== null) run.gr = cell.gr;
      if (cell.editable) run.editable = true;
      runs.push(run);
      styled = cell;
    }
    run.text += cell.ch === "" ? " " : cell.ch;
  }

  return { row, runs };
}

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
  for (let row = 0; row < screen.rows; row++) rows.push(paintRow(screen, row));

  /** @type {import('./protocol.js').PaintMessage} */
  const paint = {
    type: "paint",
    full: true,
    color: screen.color,
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
    if (row >= 0 && row < screen.rows) rows.push(paintRow(screen, row));
  }

  return {
    type: "paint",
    full: false,
    color: screen.color,
    rows,
    cursor: paintCursor(screen),
  };
}
