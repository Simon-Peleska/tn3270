import { AppError } from "./errors.js";

/**
 * @typedef {object} Cell
 * @property {string} ch A single character; ' ' when blank.
 * @property {string | null} fg Host colour name, or null for the screen default.
 * @property {string | null} bg
 * @property {string | null} gr Comma-separated graphic rendition, or null.
 * @property {boolean} editable From a ReadBuffer, not from screen indications.
 */

/**
 * @typedef {object} Cursor
 * @property {number} row 0-based
 * @property {number} col 0-based
 * @property {boolean} enabled
 */

/** @returns {Cell} */
function blankCell() {
  return { ch: " ", fg: null, bg: null, gr: null, editable: false };
}

export class ScreenModel {
  /**
   * @param {number} rows
   * @param {number} cols
   */
  constructor(rows = 24, cols = 80) {
    /** @type {number} */
    this.rows = rows;
    /** @type {number} */
    this.cols = cols;
    /** @type {boolean} Whether the host reports colours: 3279 vs 3278. */
    this.color = true;
    /** @type {string | null} */
    this.defaultFg = null;
    /** @type {string | null} */
    this.defaultBg = null;
    /** @type {Cursor} */
    this.cursor = { row: 0, col: 0, enabled: false };
    /** @type {Cell[]} Row-major, length rows*cols. */
    this.cells = [];
    /** @type {boolean} False for an unformatted screen, or before the first read. */
    this.fieldsFormatted = false;
    /** @type {Set<number>} */
    this.dirtyRows = new Set();

    this.resize(rows, cols);
  }

  /**
   * @param {number} rows
   * @param {number} cols
   * @returns {void}
   */
  resize(rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.cells = new Array(rows * cols);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = blankCell();
    this.cursor = { row: 0, col: 0, enabled: this.cursor.enabled };
    this.fieldsFormatted = false;
    this.markAllDirty();
  }

  /** @returns {void} */
  markAllDirty() {
    for (let row = 0; row < this.rows; row++) this.dirtyRows.add(row);
  }

  /**
   * @param {number} row 0-based
   * @param {number} col 0-based
   * @returns {Cell}
   */
  cellAt(row, col) {
    const cell = this.cells[row * this.cols + col];
    if (cell === undefined)
      throw new AppError("E3004", `row=${row} col=${col}`);
    return cell;
  }

  /**
   * The fg/bg an erase carries become the screen-wide defaults.
   *
   * @param {import('./b3270.js').EraseIndication} erase
   * @returns {void}
   */
  applyErase(erase) {
    const rows = erase["logical-rows"];
    const cols = erase["logical-columns"];
    if (
      typeof rows === "number" &&
      typeof cols === "number" &&
      (rows !== this.rows || cols !== this.cols)
    ) {
      this.resize(rows, cols);
    }
    if (typeof erase.fg === "string") this.defaultFg = erase.fg;
    if (typeof erase.bg === "string") this.defaultBg = erase.bg;

    for (const cell of this.cells) {
      cell.ch = " ";
      cell.fg = null;
      cell.bg = null;
      cell.gr = null;
      cell.editable = false;
    }
    this.fieldsFormatted = false;
    this.cursor = { row: 0, col: 0, enabled: this.cursor.enabled };
    this.markAllDirty();
  }

  /**
   * @param {boolean[]} editable row-major
   * @param {boolean} formatted whether the screen has any fields at all
   * @returns {void}
   */
  applyFields(editable, formatted) {
    this.fieldsFormatted = formatted;
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      const next = editable[i] ?? false;
      if (cell === undefined || cell.editable === next) continue;
      cell.editable = next;
      this.dirtyRows.add(Math.floor(i / this.cols));
    }
  }

  /**
   * @param {import('./b3270.js').ScreenModeIndication} mode
   * @returns {void}
   */
  applyScreenMode(mode) {
    this.color = mode.color;
    if (mode.rows !== this.rows || mode.columns !== this.cols) {
      this.resize(mode.rows, mode.columns);
    }
  }

  /**
   * b3270's rows and columns are 1-based, and an attribute it does not mention
   * keeps its old value per cell.
   *
   * @param {import('./b3270.js').ScreenIndication} screen
   * @returns {void}
   */
  applyScreen(screen) {
    for (const row of screen.rows ?? []) {
      const y = row.row - 1;
      if (y < 0 || y >= this.rows) continue;

      for (const change of row.changes ?? []) {
        const startX = change.column - 1;
        if (startX < 0 || startX >= this.cols) continue;

        const characters =
          typeof change.text === "string" ? [...change.text] : null;
        const span =
          characters !== null ? characters.length : (change.count ?? 0);

        for (let i = 0; i < span; i++) {
          const x = startX + i;
          if (x >= this.cols) break;
          const cell = this.cellAt(y, x);
          if (characters !== null) cell.ch = characters[i] ?? " ";
          if (change.fg !== undefined) cell.fg = change.fg;
          if (change.bg !== undefined) cell.bg = change.bg;
          if (change.gr !== undefined)
            cell.gr = change.gr === "" ? null : change.gr;
        }
        if (span > 0) this.dirtyRows.add(y);
      }
    }

    if (screen.cursor) {
      const { enabled, row, column } = screen.cursor;
      const previous = this.cursor;
      this.cursor = {
        row: typeof row === "number" ? row - 1 : previous.row,
        col: typeof column === "number" ? column - 1 : previous.col,
        enabled: typeof enabled === "boolean" ? enabled : previous.enabled,
      };
    }
  }

  /**
   * @returns {number[]} dirty row indices, ascending; the set is then cleared
   */
  takeDirtyRows() {
    const rows = [...this.dirtyRows].sort((a, b) => a - b);
    this.dirtyRows.clear();
    return rows;
  }

  /**
   * @param {number} row 0-based
   * @returns {string} trailing blanks included
   */
  rowText(row) {
    let text = "";
    for (let col = 0; col < this.cols; col++) text += this.cellAt(row, col).ch;
    return text;
  }
}
