/**
 * The browser's copy of a screen: the same cell shape `server/screen.js` holds,
 * so a paint off the wire lands here unchanged and the two can be compared cell
 * for cell. Two of these make a display — the host's screen, and an overlay of
 * the chrome this page draws over it — which is why a cell's character can be
 * null: in the overlay that means "let the host's cell through".
 *
 * @typedef {object} Cell
 * @property {string | null} ch A single character, ' ' when blank, null when transparent.
 * @property {string | null} fg A host colour name, a `#rrggbb`, or null for the default.
 * @property {string | null} bg
 * @property {string | null} gr b3270's comma-separated graphic rendition, or null.
 * @property {boolean} editable
 */

/**
 * @typedef {object} Cursor
 * @property {number} row 0-based
 * @property {number} col 0-based
 * @property {boolean} visible
 */

/**
 * @typedef {object} Style
 * @property {string | null} [fg]
 * @property {string | null} [bg]
 * @property {string | null} [gr]
 * @property {boolean} [editable]
 */

export class Grid {
  /**
   * @param {number} rows
   * @param {number} cols
   * @param {string | null} [blank] what an untouched cell holds
   */
  constructor(rows, cols, blank = " ") {
    /** @type {string | null} */
    this.blank = blank;
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
    /** @type {boolean} False for a screen without fields, where typing goes anywhere. */
    this.fieldsFormatted = false;
    /** @type {Cursor | null} null leaves the cursor to whatever is underneath. */
    this.cursor = null;
    /** @type {Cell[]} Row-major, length rows*cols. */
    this.cells = [];

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
    for (let i = 0; i < this.cells.length; i++)
      this.cells[i] = this.blankCell();
  }

  /** @returns {Cell} */
  blankCell() {
    return { ch: this.blank, fg: null, bg: null, gr: null, editable: false };
  }

  /** @returns {void} The cursor goes with it: nothing is left to put it on. */
  clear() {
    for (const cell of this.cells) {
      cell.ch = this.blank;
      cell.fg = null;
      cell.bg = null;
      cell.gr = null;
      cell.editable = false;
    }
    this.cursor = null;
  }

  /**
   * @param {number} row 0-based
   * @param {number} col 0-based
   * @returns {Cell | null} null when it is off the grid
   */
  cellAt(row, col) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return null;
    return this.cells[row * this.cols + col] ?? null;
  }

  /**
   * Anything past the last column is cut, never wrapped: a 3270 row is a row.
   *
   * @param {number} row 0-based
   * @param {number} col 0-based
   * @param {string} text
   * @param {Style} [style]
   * @returns {void}
   */
  put(row, col, text, style = {}) {
    if (row < 0 || row >= this.rows) return;
    let x = col;
    for (const ch of text) {
      if (x >= this.cols) break;
      if (x >= 0) {
        const cell = this.cells[row * this.cols + x];
        if (cell !== undefined) {
          cell.ch = ch;
          cell.fg = style.fg ?? null;
          cell.bg = style.bg ?? null;
          cell.gr = style.gr ?? null;
          cell.editable = style.editable ?? false;
        }
      }
      x += 1;
    }
  }

  /**
   * @param {import('../server/protocol.js').PaintMessage} paint
   * @returns {void}
   */
  applyPaint(paint) {
    if (paint.full) {
      const size = paint.size;
      if (
        size !== undefined &&
        (size.rows !== this.rows || size.cols !== this.cols)
      )
        this.resize(size.rows, size.cols);
      this.clear();
      this.color = paint.color;
      this.defaultFg = paint.defaultFg ?? null;
      this.defaultBg = paint.defaultBg ?? null;
    }

    for (const row of paint.rows) {
      for (const run of row.runs) {
        this.put(row.row, run.col, run.text, {
          fg: run.fg ?? null,
          bg: run.bg ?? null,
          gr: run.gr ?? null,
          editable: run.editable ?? false,
        });
      }
    }

    this.fieldsFormatted = paint.fieldsFormatted;
    const { row, col, on } = paint.cursor;
    this.cursor = { row, col, visible: on };
  }

  /**
   * The editable field a cell is in, the way Ctrl+C copies it. A field can wrap
   * past the last cell into the first, so the walk wraps too.
   *
   * @param {number} row 0-based
   * @param {number} col 0-based
   * @returns {string | null} trimmed, or null off any editable field
   */
  fieldText(row, col) {
    const total = this.cells.length;
    const at = row * this.cols + col;
    const editable = (/** @type {number} */ pos) =>
      this.cells[(pos + total) % total]?.editable ?? false;
    if (!editable(at)) return null;

    let start = at;
    while (start > at - total + 1 && editable(start - 1)) start--;
    let text = "";
    for (let pos = start; pos < start + total && editable(pos); pos++)
      text += this.cells[(pos + total) % total]?.ch ?? " ";
    return text.trim();
  }

  /**
   * @param {number} row 0-based
   * @returns {string} trailing blanks included
   */
  rowText(row) {
    let text = "";
    for (let col = 0; col < this.cols; col++)
      text += this.cellAt(row, col)?.ch ?? " ";
    return text;
  }

  /**
   * The rectangle a 3270 selection is, rather than the stream of text a terminal
   * selection would be. Trailing blanks are dropped per row: they are the shape
   * of the screen, not something anybody meant to copy.
   *
   * @param {number} top 0-based, inclusive
   * @param {number} left
   * @param {number} bottom inclusive
   * @param {number} right inclusive
   * @returns {string}
   */
  text(top, left, bottom, right) {
    /** @type {string[]} */
    const lines = [];
    for (
      let row = Math.max(0, top);
      row <= Math.min(bottom, this.rows - 1);
      row++
    ) {
      let line = "";
      for (
        let col = Math.max(0, left);
        col <= Math.min(right, this.cols - 1);
        col++
      )
        line += this.cellAt(row, col)?.ch ?? " ";
      lines.push(line.replace(/\s+$/, ""));
    }
    return lines.join("\n");
  }
}

/**
 * What a display shows at one position: the overlay's cell wherever it has a
 * character, the host's everywhere else. An overlay cell wins whole — its
 * colours come with it — so a panel never inherits a field's tint underneath.
 *
 * @param {Grid} host
 * @param {Grid} overlay
 * @param {number} row
 * @param {number} col
 * @returns {Cell | null}
 */
export function visibleCell(host, overlay, row, col) {
  const above = overlay.cellAt(row, col);
  if (above !== null && above.ch !== null) return above;
  return host.cellAt(row, col);
}

/**
 * @param {Grid} host
 * @param {Grid} overlay
 * @returns {Cursor | null}
 */
export function visibleCursor(host, overlay) {
  return overlay.cursor ?? host.cursor;
}
