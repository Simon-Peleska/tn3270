import { Grid, visibleCell, visibleCursor, visibleText } from "./grid.js";
import { chooseFontSize } from "./fitfont.js";
import {
  ansiColorIndex,
  grFlags,
  DEFAULT_FOREGROUND_ANSI,
  DEFAULT_BACKGROUND_ANSI,
  MONO_FOREGROUND,
  DEFAULT_BACKGROUND,
} from "./colors.js";

/**
 * A 3270 screen is a fixed grid of single-width cells with no scrollback, no
 * reflow and no alternate screen, so this draws exactly that and nothing else.
 *
 * There is one canvas for the whole page, and one session on it.
 * `Screen.render()` clears the canvas and draws it whole, every time. Making a
 * frame whole is the only way to be sure it is not half of the last one.
 *
 * The screen composites two grids: `host`, what the server painted, and
 * `overlay`, the chrome this page draws over it — panels, the status line, the
 * error bar. The overlay is why closing a panel needs nothing from the server:
 * the host grid never lost what was underneath.
 *
 * @typedef {Record<string, string>} Theme keys as in settings.js's `colors`
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 */

/** ANSI slot 0-15 → the theme key that colours it. */
const SLOT_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/**
 * Box-drawing characters are drawn as rectangles rather than taken from the
 * font: a font's "│" is rarely exactly one row tall or centred where the next
 * row's "┼" is, so its lines never quite meet. Each is the arms it has from the
 * cell's centre, up, right, down and left: 0 none, 1 light, 2 heavy.
 *
 * @type {Map<string, number[]>}
 */
const BOX_ARMS = new Map([
  ["─", [0, 1, 0, 1]],
  ["━", [0, 2, 0, 2]],
  ["│", [1, 0, 1, 0]],
  ["┃", [2, 0, 2, 0]],
  ["┌", [0, 1, 1, 0]],
  ["┏", [0, 2, 2, 0]],
  ["┐", [0, 0, 1, 1]],
  ["┓", [0, 0, 2, 2]],
  ["└", [1, 1, 0, 0]],
  ["┗", [2, 2, 0, 0]],
  ["┘", [1, 0, 0, 1]],
  ["┛", [2, 0, 0, 2]],
  ["├", [1, 1, 1, 0]],
  ["┣", [2, 2, 2, 0]],
  ["┤", [1, 0, 1, 1]],
  ["┫", [2, 0, 2, 2]],
  ["┬", [0, 1, 1, 1]],
  ["┳", [0, 2, 2, 2]],
  ["┴", [1, 1, 0, 1]],
  ["┻", [2, 2, 0, 2]],
  ["┼", [1, 1, 1, 1]],
  ["╋", [2, 2, 2, 2]],
  ["╴", [0, 0, 0, 1]],
  ["╵", [1, 0, 0, 0]],
  ["╶", [0, 1, 0, 0]],
  ["╷", [0, 0, 1, 0]],
]);

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const URL_END_PUNCTUATION = /[.,;:!?)}\]]+$/;

/**
 * The page's one canvas and the session's cells on it: their grids, where they
 * sit and how big they are. Everything visible is drawn here, in one pass.
 */
export class Screen {
  /**
   * @param {{ canvas: HTMLCanvasElement, theme: Theme, fieldBackground: boolean, redraw?: () => void }} options
   *   the canvas is the one in `index.html`; the page's markup is fixed.
   *   `redraw` asks the page for a frame when a drag changes the selection.
   */
  constructor(options) {
    /** @type {Theme} */
    this.theme = options.theme;
    /** @type {boolean} false leaves a typeable field the background it would
     * otherwise have had, so only its contents mark it out. */
    this.fieldBackground = options.fieldBackground;

    /** @type {number} 0 until the server has said how big the screen is */
    this.cols = 0;
    /** @type {number} the host's screen, not counting the status row */
    this.rows = 0;
    /** @type {Grid} What the server painted. */
    this.host = new Grid(0, 0);
    /** @type {Grid} Panels, bars, buttons and hints, drawn over the host. */
    this.overlay = new Grid(0, 0, null);
    /** @type {(string | null)[]} */
    this.links = [];

    /** @type {string} */
    this.fontFamily = "";
    /** @type {number} */
    this.fontSize = 15;
    /** @type {{ width: number, height: number, baseline: number }} */
    this.metrics = { width: 0, height: 0, baseline: 0 };
    /** @type {Rect} where the cells sit on the canvas, in CSS pixels */
    this.rect = { x: 0, y: 0, width: 0, height: 0 };
    /** @type {{ width: number, height: number }} the whole canvas, in CSS pixels */
    this.page = { width: 0, height: 0 };

    /** @type {'block' | 'underline'} */
    this.cursorStyle = "block";
    /** @type {{ row: number, col: number } | null} */
    this.selectionStart = null;
    /** @type {{ row: number, col: number } | null} */
    this.selectionEnd = null;
    /** @type {boolean} whether a drag is selecting, for as long as it lasts */
    this.dragging = false;

    /** @type {HTMLCanvasElement} */
    this.canvas = options.canvas;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("no 2D context on the screen canvas");
    /** @type {CanvasRenderingContext2D} */
    this.ctx = ctx;
    /** @type {number} */
    this.dpr = window.devicePixelRatio || 1;
    /** @type {() => void} */
    this.redraw = options.redraw ?? (() => this.render());
    /** @type {Map<string, boolean>} font and glyph → whether it is one cell wide */
    this.oneCellGlyphs = new Map();

    this.canvas.addEventListener("mousedown", (event) =>
      this.beginSelection(event),
    );
    this.canvas.addEventListener("mousemove", (event) =>
      this.extendSelection(event),
    );
    document.addEventListener("mouseup", () => {
      this.dragging = false;
    });
  }

  /** @returns {number} the host's rows plus the status row the page owns */
  get displayRows() {
    return this.rows + 1;
  }

  /** @returns {number} the one row below the host's screen, drawn by the page */
  get statusRow() {
    return this.rows;
  }

  /**
   * @param {number} cols
   * @param {number} rows
   * @returns {void}
   */
  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.host.resize(rows, cols);
    this.overlay.resize(this.displayRows, cols);
    this.links = Array(rows * cols).fill(null);
    this.clearSelection();
  }

  /** @param {import('../server/protocol.js').PaintMessage} paint */
  applyHostPaint(paint) {
    this.host.applyPaint(paint);
    const rows = paint.full
      ? Array.from({ length: this.rows }, (_, row) => row)
      : [...new Set(paint.rows.map((row) => row.row))];
    for (const row of rows) {
      if (row < 0 || row >= this.rows) continue;
      this.links.fill(null, row * this.cols, (row + 1) * this.cols);
      for (const match of this.host.rowText(row).matchAll(URL_PATTERN)) {
        const url = match[0].replace(URL_END_PUNCTUATION, "");
        if (url === "") continue;
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
            continue;
        } catch {
          continue;
        }
        const start = row * this.cols + (match.index ?? 0);
        this.links.fill(url, start, start + url.length);
      }
    }
  }

  /** @param {number} row @param {number} col @returns {string | null} */
  linkAt(row, col) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return null;
    return this.links[row * this.cols + col] ?? null;
  }

  /** @returns {void} */
  clearSelection() {
    this.selectionStart = null;
    this.selectionEnd = null;
  }

  /** @returns {boolean} */
  hasSelection() {
    return this.selectionBox() !== null;
  }

  /**
   * A click is a drag that never moved, and one cell is not a selection: it is
   * a point and shoot at the cursor. Saying so here is what keeps the highlight,
   * the clipboard and the click routing from disagreeing about it.
   *
   * @returns {{ top: number, left: number, bottom: number, right: number } | null}
   */
  selectionBox() {
    const start = this.selectionStart;
    const end = this.selectionEnd;
    if (start === null || end === null) return null;
    if (start.row === end.row && start.col === end.col) return null;
    return {
      top: Math.min(start.row, end.row),
      left: Math.min(start.col, end.col),
      bottom: Math.max(start.row, end.row),
      right: Math.max(start.col, end.col),
    };
  }

  /**
   * Shift+arrow is a drag by keyboard: the cursor is where it was pressed, and
   * each step moves the far corner. A selection not anchored at the cursor
   * (a mouse drag, or the cursor moved since) is left behind for a new one.
   *
   * @param {number} rowStep
   * @param {number} colStep
   * @returns {void}
   */
  stepSelection(rowStep, colStep) {
    const cursor = this.host.cursor ?? { row: 0, col: 0 };
    const start = this.selectionStart;
    const anchoredAtCursor =
      start !== null && start.row === cursor.row && start.col === cursor.col;
    if (!this.hasSelection() || !anchoredAtCursor) {
      this.selectionStart = { row: cursor.row, col: cursor.col };
      this.selectionEnd = { row: cursor.row, col: cursor.col };
    }
    const end = this.selectionEnd ?? { row: 0, col: 0 };
    this.selectionEnd = {
      row: Math.min(Math.max(end.row + rowStep, 0), this.rows - 1),
      col: Math.min(Math.max(end.col + colStep, 0), this.cols - 1),
    };
  }

  /**
   * @param {number} row
   * @param {number} col
   * @returns {boolean}
   */
  inSelection(row, col) {
    const box = this.selectionBox();
    if (box === null) return false;
    return (
      row >= box.top && row <= box.bottom && col >= box.left && col <= box.right
    );
  }

  /** @returns {string} A 3270 selection is the rectangle, not the text between. */
  getSelection() {
    const box = this.selectionBox();
    if (box === null) return "";
    return visibleText(
      this.host,
      this.overlay,
      box.top,
      box.left,
      box.bottom,
      box.right,
    );
  }

  /**
   * `fontBoundingBoxAscent`/`Descent` describe the face, so every glyph sits on
   * the same baseline. `actualBoundingBox*` describes the sample string, which
   * moves the baseline whenever the sample changes.
   *
   * @param {string} family
   * @param {number} size
   * @returns {{ width: number, height: number, baseline: number }}
   */
  measure(family, size) {
    this.ctx.font = `${size}px ${family}`;
    const m = this.ctx.measureText("M");
    const ascent = m.fontBoundingBoxAscent || size * 0.8;
    const descent = m.fontBoundingBoxDescent || size * 0.2;
    // The exact advance, not rounded: a run of neighbours drawn as one string
    // steps by it, and has to land on the same cells as the fills.
    return {
      width: m.width,
      // No padding between rows: the font's own block and double-line glyphs,
      // like "█" or "║", span the face's full height and only join if the rows
      // are no taller.
      height: Math.ceil(ascent + descent),
      baseline: Math.ceil(ascent),
    };
  }

  /**
   * Size the backing store to the page, then pick the largest font that fits
   * the cells inside it and centre them.
   *
   * The backing store is set here and nowhere else. Setting `width`/`height`
   * clears the canvas and resets the context, so anything that touches them
   * outside this method loses the frame — and, if it forgets the ratio, the
   * HiDPI sharpness with it.
   *
   * @param {{ width: number, height: number }} box the page, in CSS pixels
   * @param {string} fontFamily
   * @param {number} [maxFontSize]
   * @returns {void}
   */
  layout(box, fontFamily, maxFontSize) {
    this.dpr = window.devicePixelRatio || 1;
    this.page = { width: box.width, height: box.height };

    this.canvas.width = Math.round(box.width * this.dpr);
    this.canvas.height = Math.round(box.height * this.dpr);
    this.canvas.style.width = `${box.width}px`;
    this.canvas.style.height = `${box.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.textBaseline = "alphabetic";
    if (this.cols === 0) return;

    this.fontFamily = fontFamily;
    this.fontSize = chooseFontSize({
      measure: (probe) => this.measure(fontFamily, probe),
      cols: this.cols,
      rows: this.displayRows,
      box,
      start: this.fontSize,
      max: maxFontSize,
    });
    this.metrics = this.measure(fontFamily, this.fontSize);
    this.oneCellGlyphs.clear();
    const width = this.cols * this.metrics.width;
    const height = this.displayRows * this.metrics.height;
    this.rect = {
      x: Math.floor((box.width - width) / 2),
      y: Math.floor((box.height - height) / 2),
      width,
      height,
    };
  }

  /**
   * A host colour is one of sixteen slots, named; the theme says which RGB each
   * slot is.
   *
   * @param {string | null} name
   * @param {number} fallbackSlot
   * @returns {string}
   */
  color(name, fallbackSlot) {
    const key = SLOT_KEYS[ansiColorIndex(name, fallbackSlot)] ?? "white";
    return this.theme[key] ?? "#ffffff";
  }

  /**
   * @param {import('./grid.js').Cell} cell
   * @returns {{ fg: string, bg: string, bold: boolean, underline: boolean }}
   */
  styleOf(cell) {
    const { bold, underline, reverse } = grFlags(cell.gr);
    const background = this.theme["background"] ?? "#000000";

    let fg;
    let bg;
    if (cell.fg !== null && cell.fg.startsWith("#")) {
      // The page's own chrome names its colours outright, and means them.
      fg = cell.fg;
      bg = cell.bg ?? background;
    } else if (!this.host.color) {
      // A 3278 reports no colour, so it is the green-on-black terminal it is.
      fg = MONO_FOREGROUND;
      bg = DEFAULT_BACKGROUND;
    } else {
      fg = this.color(cell.fg ?? this.host.defaultFg, DEFAULT_FOREGROUND_ANSI);
      bg = this.color(cell.bg ?? this.host.defaultBg, DEFAULT_BACKGROUND_ANSI);
    }

    // The tint that shows where a field may be typed into, but never over a
    // colour the host named for itself.
    const tint = this.fieldBackground ? (this.theme["field"] ?? "") : "";
    if (tint.startsWith("#") && cell.editable && cell.bg === null) bg = tint;

    if (reverse) [fg, bg] = [bg, fg];
    return { fg, bg, bold, underline };
  }

  /**
   * A cell edge falls between two device pixels whenever devicePixelRatio is
   * fractional (1.4 at 140% zoom), and two antialiased edges do not add up to
   * one opaque pixel: the background shows through as a hairline seam. Snapping
   * every fill to the device grid gives neighbours the exact same edge.
   *
   * @param {number} value
   * @returns {number}
   */
  snap(value) {
    return Math.round(value * this.dpr) / this.dpr;
  }

  /** @returns {void} The whole page, every time. */
  render() {
    const background = this.theme["background"] ?? "#000000";
    this.ctx.fillStyle = background;
    this.ctx.fillRect(0, 0, this.page.width, this.page.height);

    const { width, height, baseline } = this.metrics;
    if (this.cols === 0 || width < 1 || height < 1) return;
    const cols = this.cols;
    const rows = this.displayRows;

    // Everything below is constant for the whole frame, and the loops run once
    // per cell: a 3279 at 80x44 is 3600 of them, redrawn on every keystroke.
    const selectedFill = this.theme["selectionBackground"] ?? "#ffffff";
    const selectedInk = this.theme["selectionForeground"] ?? "#000000";
    const regularFont = `${this.fontSize}px ${this.fontFamily}`;
    const boldFont = `bold ${regularFont}`;
    const underlineThickness = Math.max(1, Math.round(height * 0.06));
    const box = this.selectionBox();
    const cursor = visibleCursor(this.host, this.overlay);

    // Every row shares one set of column edges, and every column one set of row
    // edges, so the snapping is done once here instead of four times per cell.
    const colEdge = new Array(cols + 1);
    for (let col = 0; col <= cols; col++)
      colEdge[col] = this.snap(this.rect.x + col * width);
    const rowEdge = new Array(rows + 1);
    for (let row = 0; row <= rows; row++)
      rowEdge[row] = this.snap(this.rect.y + row * height);

    // Glyphs go on the exact grid, not the snapped edges: inside a string they
    // step by the exact advance, so a glyph drawn on its own has to as well, or
    // a "│" on its own row is a fraction of a pixel off the "┼" below it.
    const glyphX = (/** @type {number} */ col) => this.rect.x + col * width;

    /** @type {(import('./grid.js').Cell | null)[]} */
    const cells = new Array(cols);
    /** @type {({ fg: string, bg: string, bold: boolean, underline: boolean } | null)[]} */
    const styles = new Array(cols);

    for (let row = 0; row < rows; row++) {
      const top = rowEdge[row];
      const bottom = rowEdge[row + 1];
      // Snapped like every other fill edge: an underline runs the width of a
      // field, so an edge of it between two device pixels is a seam the length
      // of the field.
      const underlineBottom = this.snap(bottom - 1);
      const underlineTop = this.snap(bottom - underlineThickness - 1);
      const rowSelected = box !== null && row >= box.top && row <= box.bottom;
      // The cursor's cell is drawn on its own, so a ligature it sits in comes
      // apart rather than leaving half of itself beside the cursor.
      const cursorCol =
        cursor !== null && cursor.visible && cursor.row === row
          ? cursor.col
          : -1;

      // Decoded once per row: the backgrounds and the glyphs want the same
      // answer for the same cell, and working it out is this loop's real cost.
      for (let col = 0; col < cols; col++) {
        const cell = visibleCell(this.host, this.overlay, row, col);
        cells[col] = cell;
        const style = cell === null ? null : this.styleOf(cell);
        const at = row * cols + col;
        if (
          style !== null &&
          this.links[at] != null &&
          this.overlay.cells[at]?.ch === null
        )
          style.underline = true;
        styles[col] = style;
      }

      // Backgrounds first, whole row, so a glyph that overhangs its cell is not
      // clipped by the next cell's fill. Neighbours of one colour are filled as
      // one rectangle rather than one each: an edge inside a run is an edge the
      // canvas can antialias into a hairline seam at a fractional
      // devicePixelRatio, and an edge never drawn cannot. One column past the
      // last closes whatever run is open.
      let runFill = "";
      let runStart = 0;
      for (let col = 0; col <= cols; col++) {
        const style = styles[col];
        const selected =
          rowSelected && box !== null && col >= box.left && col <= box.right;
        let wanted = "";
        if (style !== undefined && style !== null)
          wanted = selected ? selectedFill : style.bg;
        // The page was cleared to the theme's background, so a cell asking for
        // it again is a cell with nothing to draw.
        if (!selected && wanted === background) wanted = "";
        if (wanted === runFill) continue;

        if (runFill !== "") {
          this.ctx.fillStyle = runFill;
          this.ctx.fillRect(
            colEdge[runStart],
            top,
            colEdge[col] - colEdge[runStart],
            bottom - top,
          );
        }
        runFill = wanted;
        runStart = col;
      }

      // Neighbours in one font and colour are drawn as one string, so a font
      // with ligatures can join "=>" or "───" the way it was designed to. One
      // column past the last closes whatever string is open.
      let font = "";
      let fill = "";
      let text = "";
      let textStart = 0;
      for (let col = 0; col <= cols; col++) {
        const cell = cells[col];
        const style = styles[col];
        const ch = cell?.ch ?? " ";
        const blank = style === undefined || style === null || ch === " ";
        const selected =
          rowSelected && box !== null && col >= box.left && col <= box.right;
        const wanted = blank ? "" : selected ? selectedInk : style.fg;
        const wantedFont = blank ? "" : style.bold ? boldFont : regularFont;
        const arms = blank ? undefined : BOX_ARMS.get(ch);
        const alone =
          !blank &&
          arms === undefined &&
          (col === cursorCol || !this.fillsOneCell(ch, wantedFont));
        const joins = !blank && arms === undefined && !alone;
        if (text !== "" && (!joins || wanted !== fill || wantedFont !== font)) {
          this.ctx.fillText(text, glyphX(textStart), top + baseline);
          text = "";
        }
        if (blank) continue;

        if (wantedFont !== font) {
          this.ctx.font = wantedFont;
          font = wantedFont;
        }
        if (wanted !== fill) {
          this.ctx.fillStyle = wanted;
          fill = wanted;
        }
        if (style.underline)
          this.ctx.fillRect(
            colEdge[col],
            underlineTop,
            colEdge[col + 1] - colEdge[col],
            underlineBottom - underlineTop,
          );
        if (arms !== undefined) {
          this.drawBox(arms, colEdge[col], top, colEdge[col + 1], bottom);
          continue;
        }
        if (alone) {
          this.ctx.fillText(ch, glyphX(col), top + baseline);
          continue;
        }
        if (text === "") textStart = col;
        text += ch;
      }
    }

    this.renderCursor();
  }

  /**
   * A glyph the font lacks comes from a fallback font, at that font's width.
   * Inside a string it would push every neighbour after it off its cell, so it
   * is drawn on its own.
   *
   * @param {string} ch
   * @param {string} font
   * @returns {boolean}
   */
  fillsOneCell(ch, font) {
    const key = `${font} ${ch}`;
    let fits = this.oneCellGlyphs.get(key);
    if (fits === undefined) {
      const current = this.ctx.font;
      this.ctx.font = font;
      fits =
        Math.abs(this.ctx.measureText(ch).width - this.metrics.width) < 0.01;
      this.ctx.font = current;
      this.oneCellGlyphs.set(key, fits);
    }
    return fits;
  }

  /**
   * Every edge lands on the device pixel grid and every cell of a column finds
   * the same centre, so a line runs on through its neighbours without a seam or
   * a step. The arms reach over the crossing stroke, which fills the corner.
   *
   * @param {number[]} arms up, right, down, left; see BOX_ARMS
   * @param {number} left snapped, like the other three
   * @param {number} top
   * @param {number} right
   * @param {number} bottom
   * @returns {void}
   */
  drawBox(arms, left, top, right, bottom) {
    const light = Math.max(1, Math.round((this.metrics.width * this.dpr) / 8));
    const [up, east, down, west] = arms.map((arm) => (arm * light) / this.dpr);
    const vertical = Math.max(up, down);
    const horizontal = Math.max(east, west);
    const x = this.snap((left + right) / 2 - vertical / 2);
    const y = this.snap((top + bottom) / 2 - horizontal / 2);

    if (up > 0) this.ctx.fillRect(x, top, vertical, y + horizontal - top);
    if (down > 0) this.ctx.fillRect(x, y, vertical, bottom - y);
    if (west > 0) this.ctx.fillRect(left, y, x + vertical - left, horizontal);
    if (east > 0) this.ctx.fillRect(x, y, right - x, horizontal);
  }

  /** @returns {void} */
  renderCursor() {
    const cursor = visibleCursor(this.host, this.overlay);
    if (cursor === null || !cursor.visible) return;
    const { row, col } = cursor;
    if (row < 0 || row >= this.displayRows || col < 0 || col >= this.cols)
      return;

    const { width, height, baseline } = this.metrics;
    const left = this.snap(this.rect.x + col * width);
    const top = this.snap(this.rect.y + row * height);
    const right = this.snap(this.rect.x + (col + 1) * width);
    const bottom = this.snap(this.rect.y + (row + 1) * height);
    this.ctx.fillStyle = this.theme["cursor"] ?? "#ffffff";

    if (this.cursorStyle === "underline") {
      const thickness = Math.max(2, Math.floor(height * 0.15));
      const barTop = this.snap(bottom - thickness);
      this.ctx.fillRect(left, barTop, right - left, bottom - barTop);
      return;
    }

    this.ctx.fillRect(left, top, right - left, bottom - top);

    // A block cursor that hides the character under it is a block cursor nobody
    // can type behind, so the glyph is redrawn in the accent.
    const cell = visibleCell(this.host, this.overlay, row, col);
    const ch = cell?.ch ?? null;
    if (ch === null || ch === " ") return;
    this.ctx.fillStyle = this.theme["cursorAccent"] ?? "#000000";
    const arms = BOX_ARMS.get(ch);
    if (arms !== undefined) {
      this.drawBox(arms, left, top, right, bottom);
      return;
    }
    const { bold } = this.styleOf(cell ?? this.host.blankCell());
    this.ctx.font = `${bold ? "bold " : ""}${this.fontSize}px ${this.fontFamily}`;
    this.ctx.fillText(ch, this.rect.x + col * width, top + baseline);
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{ row: number, col: number } | null} may be outside the grid;
   *   null before the screen has a size
   */
  cellAt(clientX, clientY) {
    if (this.cols === 0 || this.metrics.width < 1) return null;
    const canvas = this.canvas.getBoundingClientRect();
    return {
      row: Math.floor(
        (clientY - canvas.top - this.rect.y) / this.metrics.height,
      ),
      col: Math.floor(
        (clientX - canvas.left - this.rect.x) / this.metrics.width,
      ),
    };
  }

  /**
   * @param {MouseEvent} event
   * @returns {void}
   */
  beginSelection(event) {
    if (event.button !== 0) return;
    const hit = this.cellAt(event.clientX, event.clientY);
    if (hit === null) return;
    const had = this.hasSelection();
    this.dragging = true;
    this.selectionStart = hit;
    this.selectionEnd = hit;
    // A press is not a selection yet; only a previous one has to come off.
    if (had) this.redraw();
  }

  /**
   * @param {MouseEvent} event
   * @returns {void}
   */
  extendSelection(event) {
    if (!this.dragging) return;
    const at = this.cellAt(event.clientX, event.clientY);
    if (at === null) return;
    const row = Math.min(Math.max(at.row, 0), this.statusRow);
    const col = Math.min(Math.max(at.col, 0), this.cols - 1);

    // A cell is ten pixels wide and mousemove fires at the refresh rate, so most
    // of a drag's events land where the last one did and change nothing.
    const end = this.selectionEnd;
    if (end !== null && end.row === row && end.col === col) return;

    this.selectionEnd = { row, col };
    this.redraw();
  }
}
