import { AppError } from "./errors.js";
import { fieldMap } from "./fields.js";
import {
  BLUE,
  COLOR_NAMES,
  NEUTRAL_BLACK,
  NEUTRAL_WHITE,
  seeGr,
} from "../3270/src/index.js";

/**
 * @typedef {object} Cell
 * @property {string} ch A single character; ' ' when blank.
 * @property {string | null} fg Host colour name, or null for the screen default.
 * @property {string | null} bg
 * @property {string | null} gr Comma-separated graphic rendition, or null.
 * @property {boolean} editable From the emulator's field attributes, not from screen indications.
 */

/**
 * What the shared helpers (paint runs, paste, history) read a screen through:
 * a plain array of cells in the browser, the emulator's own buffer here.
 *
 * @typedef {{ readonly length: number, at(i: number): Cell | undefined }} Cells
 */

/**
 * @typedef {object} Cursor
 * @property {number} row 0-based
 * @property {number} col 0-based
 * @property {boolean} enabled
 */

/** @typedef {import('../3270/src/index.js').Session['s']} EmulatorState */

/**
 * The screen as viewers are sent it. The characters and colours are read
 * straight from the emulator's last render, so there is one copy of the screen;
 * the screen indications only say which rows to send again.
 */
export class ScreenModel {
  /**
   * @param {EmulatorState} emulator
   * @param {number} rows
   * @param {number} cols
   */
  constructor(emulator, rows = 24, cols = 80) {
    this.emulator = emulator;
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
    /** @type {Uint8Array} Row-major, 1 where a cell can be typed into. */
    this.editable = new Uint8Array(0);
    /** @type {boolean} False for an unformatted screen, or before the first read. */
    this.fieldsFormatted = false;
    /** @type {Uint8Array} Row-major, 1 in a non-display field: a password is typed here. */
    this.fieldsHidden = new Uint8Array(0);
    /** @type {number[]} Where the editable cells are, ascending. */
    this.inputCells = [];
    /** @type {Uint8Array | null} The emulator's field attributes the above came from. */
    this.fieldAttributes = null;
    /** @type {Set<number>} */
    this.dirtyRows = new Set();
    /** @type {number} Goes up with every change to a cell. */
    this.version = 0;
    /** @type {boolean} A cursor move touches no row, so it is tracked apart. */
    this.cursorMoved = false;
    const screen = this;
    /** @type {Cells} */
    this.cells = {
      get length() {
        return screen.rows * screen.cols;
      },
      at: (i) => screen.cell(i),
    };

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
    this.editable = new Uint8Array(rows * cols);
    this.moveCursor(0, 0, this.cursor.enabled);
    this.fieldsFormatted = false;
    this.fieldsHidden = new Uint8Array(0);
    this.inputCells = [];
    this.fieldAttributes = null;
    this.markAllDirty();
  }

  /** @returns {void} */
  markAllDirty() {
    this.version++;
    for (let row = 0; row < this.rows; row++) this.dirtyRows.add(row);
  }

  /**
   * @param {number} i row-major
   * @returns {Cell | undefined}
   */
  cell(i) {
    if (i < 0 || i >= this.rows * this.cols) return undefined;
    const editable = this.editable[i] === 1;
    const rendered = this.emulator.ui?.saved;
    // The render is laid out at the model's largest size, whatever the host uses now.
    const at =
      Math.floor(i / this.cols) * this.emulator.maxCols + (i % this.cols);
    if (rendered === undefined || at >= rendered.cc.length)
      return { ch: " ", fg: null, bg: null, gr: null, editable };
    const cc = rendered.cc[at];
    const fg = rendered.fg[at];
    const bg = rendered.bg[at];
    const gr = rendered.gr[at];
    const defaultFg = this.emulator.mode3279 ? BLUE : NEUTRAL_WHITE;
    return {
      ch: cc ? String.fromCodePoint(cc) : " ",
      // The colours a blank screen is filled with are the defaults, and a
      // named background would hide the editable-field tint.
      fg: fg === defaultFg ? null : (COLOR_NAMES[fg] ?? null),
      bg: bg === NEUTRAL_BLACK ? null : (COLOR_NAMES[bg] ?? null),
      gr: gr ? seeGr(gr) : null,
      editable,
    };
  }

  /**
   * @param {number} row 0-based
   * @param {number} col 0-based
   * @returns {Cell}
   */
  cellAt(row, col) {
    const cell =
      col >= 0 && col < this.cols
        ? this.cell(row * this.cols + col)
        : undefined;
    if (cell === undefined)
      throw new AppError("E3004", `row=${row} col=${col}`);
    return cell;
  }

  /**
   * @param {number} row 0-based
   * @param {number} col 0-based
   * @param {boolean} enabled
   * @returns {void}
   */
  moveCursor(row, col, enabled) {
    const at = this.cursor;
    if (at.row === row && at.col === col && at.enabled === enabled) return;
    this.cursor = { row, col, enabled };
    this.cursorMoved = true;
  }

  /**
   * The fg/bg an erase carries become the screen-wide defaults.
   *
   * @param {import('./indications.js').EraseIndication} erase
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

    this.editable.fill(0);
    this.fieldsFormatted = false;
    this.fieldsHidden = new Uint8Array(0);
    this.inputCells = [];
    this.fieldAttributes = null;
    this.moveCursor(0, 0, this.cursor.enabled);
    this.markAllDirty();
  }

  /**
   * The fields as the emulator holds them, one attribute per cell (0 for none).
   * They seldom change between two screen updates, and mapping them is a walk
   * over every cell, so an unchanged copy is skipped.
   *
   * @param {Uint8Array} fa row-major
   * @returns {void}
   */
  applyFieldAttributes(fa) {
    const last = this.fieldAttributes;
    if (last !== null && Buffer.compare(last, fa) === 0) return;
    this.fieldAttributes = fa.slice();
    const { editable, hidden, formatted } = fieldMap(fa);
    this.applyFields(editable, hidden, formatted);
  }

  /**
   * The hidden map is kept whole rather than reduced to "the cursor is in one
   * now": the cursor moves without the fields changing, and a stale answer
   * writes a password into a recording.
   *
   * @param {Uint8Array} editable row-major, 1 where typeable
   * @param {Uint8Array} hidden row-major, 1 in a non-display field
   * @param {boolean} formatted whether the screen has any fields at all
   * @returns {void}
   */
  applyFields(editable, hidden, formatted) {
    // Every paint carries it, but a paint is only sent for a changed row.
    if (formatted !== this.fieldsFormatted) this.markAllDirty();
    this.fieldsFormatted = formatted;
    this.fieldsHidden = hidden;
    this.inputCells = [];
    for (let i = 0; i < this.editable.length; i++) {
      if (editable[i]) this.inputCells.push(i);
      if (this.editable[i] === editable[i]) continue;
      this.editable[i] = editable[i];
      this.dirtyRows.add(Math.floor(i / this.cols));
      this.version++;
    }
  }

  /** @returns {boolean} Whether what is typed now goes into a password field. */
  cursorHidden() {
    const at = this.cursor.row * this.cols + this.cursor.col;
    return this.fieldsHidden[at] === 1;
  }

  /**
   * The non-display input cells, a run per field and row, for a recording to
   * replay as password fields.
   *
   * @returns {{ row: number, col: number, length: number }[]}
   */
  hiddenRuns() {
    /** @type {{ row: number, col: number, length: number }[]} */
    const runs = [];
    for (const i of this.inputCells) {
      if (!this.fieldsHidden[i]) continue;
      const row = Math.floor(i / this.cols);
      const col = i % this.cols;
      const last = runs.at(-1);
      if (last?.row === row && last.col + last.length === col) last.length += 1;
      else runs.push({ row, col, length: 1 });
    }
    return runs;
  }

  /**
   * @param {import('./indications.js').ScreenModeIndication} mode
   * @returns {void}
   */
  applyScreenMode(mode) {
    this.color = mode.color;
    if (mode.rows !== this.rows || mode.columns !== this.cols) {
      this.resize(mode.rows, mode.columns);
    }
  }

  /**
   * The rows and the cursor are 1-based, as b3270 counts. The rows are already
   * drawn in the emulator's render; they only need sending again.
   *
   * @param {import('./indications.js').ScreenIndication} screen
   * @returns {void}
   */
  applyScreen(screen) {
    for (const row of screen.rows ?? []) {
      const y = row - 1;
      if (y < 0 || y >= this.rows) continue;
      this.dirtyRows.add(y);
      this.version++;
    }

    if (screen.cursor) {
      const { enabled, row, column } = screen.cursor;
      const previous = this.cursor;
      this.moveCursor(
        typeof row === "number" ? row - 1 : previous.row,
        typeof column === "number" ? column - 1 : previous.col,
        typeof enabled === "boolean" ? enabled : previous.enabled,
      );
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
   * @returns {boolean} whether the cursor moved; the flag is then cleared
   */
  takeCursorMoved() {
    const moved = this.cursorMoved;
    this.cursorMoved = false;
    return moved;
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
