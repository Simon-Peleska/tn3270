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

/**
 * @typedef {import('../3270/src/index.js').Session['s']} EmulatorState
 * @typedef {NonNullable<EmulatorState['ui']>} Ui
 */

/**
 * The screen as viewers are sent it. The size, the cursor and every cell are
 * read straight from the emulator's last render, so there is one copy of the
 * screen; the screen indications only say which rows to send again.
 */
export class ScreenModel {
  /** @param {EmulatorState} emulator */
  constructor(emulator) {
    this.emulator = emulator;
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
    /** @type {string} The cursor as last painted: a move touches no row, so it is tracked apart. */
    this.paintedCursor = "";
    const screen = this;
    /** @type {Cells} */
    this.cells = {
      get length() {
        return screen.rows * screen.cols;
      },
      at: (i) => screen.cell(i),
    };
  }

  /** @returns {Ui} */
  get ui() {
    return /** @type {Ui} */ (this.emulator.ui);
  }

  /** @returns {number} */
  get rows() {
    return this.ui.lastRows;
  }

  /** @returns {number} */
  get cols() {
    return this.ui.lastCols;
  }

  /** @returns {boolean} Whether the host reports colours: 3279 vs 3278. */
  get color() {
    return this.emulator.mode3279;
  }

  /** @returns {string | null} what an uncoloured cell means; erase's word for it */
  get defaultFg() {
    return this.color ? "blue" : null;
  }

  /** @returns {string | null} */
  get defaultBg() {
    return this.color ? "neutralBlack" : null;
  }

  /** @returns {Cursor} */
  get cursor() {
    const at = this.emulator.savedBaddr;
    return {
      row: Math.floor(at / this.cols),
      col: at % this.cols,
      enabled: this.ui.cursorEnabled,
    };
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
    const rendered = this.ui.saved;
    // The render is laid out at the model's largest size, whatever the host uses now.
    const at =
      Math.floor(i / this.cols) * this.emulator.maxCols + (i % this.cols);
    if (at >= rendered.cc.length)
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
    if (fa.length !== this.editable.length) {
      this.editable = new Uint8Array(fa.length);
      this.markAllDirty();
    }
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
   * The rows are 1-based, as b3270 counts. They are already drawn in the
   * emulator's render; they only need sending again.
   *
   * @param {number[]} rows
   * @returns {void}
   */
  markRows(rows) {
    for (const row of rows) {
      const y = row - 1;
      if (y < 0 || y >= this.rows) continue;
      this.dirtyRows.add(y);
      this.version++;
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
   * @returns {boolean} whether the cursor moved since it was last painted
   */
  takeCursorMoved() {
    const { row, col, enabled } = this.cursor;
    const cursor = `${row},${col},${enabled}`;
    if (cursor === this.paintedCursor) return false;
    this.paintedCursor = cursor;
    return true;
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
