import { Grid, visibleCell, visibleCursor } from "./grid.js";
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
 * There is one canvas for the whole page. Every session is a `Pane` on it — a
 * rectangle with its own grids, its own fitted font and its own cell size — and
 * `Screen.render()` clears the canvas and draws all of them, every time. Making
 * a frame whole is the only way to be sure it is not half of the last one.
 *
 * Each pane composites two grids: `host`, what the server painted, and
 * `overlay`, the chrome this page draws over it — panels, the status line, the
 * error bar. The overlay is why there is no `{type:"refresh"}` round trip for
 * closing a panel: the host grid never lost what was underneath.
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
 * One session's rectangle on the page's canvas: its cells, where they are and
 * how big they are. It holds no DOM and draws nothing — `Screen` does both, so
 * that there is exactly one place a frame can come from.
 */
export class Pane {
  /**
   * @param {number} cols
   * @param {number} rows the host's screen, not counting the status row
   */
  constructor(cols, rows) {
    /** @type {number} */
    this.cols = cols;
    /** @type {number} */
    this.rows = rows;

    /** @type {Grid} What the server painted. */
    this.host = new Grid(rows, cols);
    /** @type {Grid} Panels, bars, buttons and hints, drawn over the host. */
    this.overlay = new Grid(this.displayRows, cols, null);

    /** @type {string} */
    this.fontFamily = "";
    /** @type {number} */
    this.fontSize = 15;
    /** @type {{ width: number, height: number, baseline: number }} */
    this.metrics = { width: 0, height: 0, baseline: 0 };
    /** @type {Rect} where the cells sit on the page canvas, in CSS pixels */
    this.rect = { x: 0, y: 0, width: 0, height: 0 };
    /** @type {Rect} the share of the page this pane was given, before centring */
    this.box = { x: 0, y: 0, width: 0, height: 0 };

    /** @type {'block' | 'underline'} */
    this.cursorStyle = "block";

    /** @type {{ row: number, col: number } | null} */
    this.selectionStart = null;
    /** @type {{ row: number, col: number } | null} */
    this.selectionEnd = null;
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
   * @returns {boolean} whether anything changed
   */
  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    this.host.resize(rows, cols);
    this.overlay.resize(this.displayRows, cols);
    this.clearSelection();
    return true;
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
    return this.host.text(box.top, box.left, box.bottom, box.right);
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{ row: number, col: number }} may be outside the grid
   */
  cellAt(clientX, clientY) {
    return {
      row: Math.floor((clientY - this.rect.y) / this.metrics.height),
      col: Math.floor((clientX - this.rect.x) / this.metrics.width),
    };
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @returns {boolean}
   */
  holds(clientX, clientY) {
    const { x, y, width, height } = this.box;
    return (
      clientX >= x &&
      clientX < x + width &&
      clientY >= y &&
      clientY < y + height
    );
  }
}

/**
 * The page's one canvas. Everything visible is drawn here, in one pass, from
 * the panes it was given.
 */
export class Screen {
  /**
   * @param {{ canvas: HTMLCanvasElement, theme: Theme, fieldBackground: boolean }} options
   *   the canvas is the one in `index.html`; the page's markup is fixed.
   */
  constructor(options) {
    /** @type {Theme} */
    this.theme = options.theme;
    /** @type {boolean} false leaves a typeable field the background it would
     * otherwise have had, so only its contents mark it out. */
    this.fieldBackground = options.fieldBackground;

    /** @type {Pane[]} the panes on screen, in pane order */
    this.panes = [];
    /** @type {Pane | null} the pane a drag started in, for as long as it lasts */
    this.dragging = null;

    /** @type {HTMLCanvasElement} */
    this.canvas = options.canvas;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("no 2D context on the screen canvas");
    /** @type {CanvasRenderingContext2D} */
    this.ctx = ctx;

    /** @type {number} */
    this.dpr = window.devicePixelRatio || 1;
    /** @type {Rect} the whole canvas, in CSS pixels */
    this.rect = { x: 0, y: 0, width: 0, height: 0 };
    /** @type {number | null} */
    this.frame = null;

    this.canvas.addEventListener("mousedown", (event) =>
      this.beginSelection(event),
    );
    this.canvas.addEventListener("mousemove", (event) =>
      this.extendSelection(event),
    );
    document.addEventListener("mouseup", () => this.endSelection());
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
    return {
      width: Math.ceil(m.width),
      height: Math.ceil(ascent + descent) + 2,
      baseline: Math.ceil(ascent) + 1,
    };
  }

  /**
   * Give each pane its share of the page and the largest font that fits its
   * cells inside it, then size the backing store to the page.
   *
   * The backing store is set here and nowhere else. Setting `width`/`height`
   * clears the canvas and resets the context, so anything that touches them
   * outside this method loses the frame — and, if it forgets the ratio, the
   * HiDPI sharpness with it.
   *
   * @param {readonly Pane[]} panes on screen, in pane order
   * @param {readonly Rect[]} shares one per pane, fractions of the page
   * @param {{ width: number, height: number }} box the page, in CSS pixels
   * @param {string} fontFamily
   * @returns {void}
   */
  layout(panes, shares, box, fontFamily) {
    this.panes = [...panes];
    this.dpr = window.devicePixelRatio || 1;
    this.rect = { x: 0, y: 0, width: box.width, height: box.height };

    this.canvas.width = Math.round(box.width * this.dpr);
    this.canvas.height = Math.round(box.height * this.dpr);
    this.canvas.style.width = `${box.width}px`;
    this.canvas.style.height = `${box.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.textBaseline = "alphabetic";

    for (const [index, pane] of this.panes.entries()) {
      const share = shares[index] ?? { x: 0, y: 0, width: 1, height: 1 };
      pane.box = {
        x: Math.round(share.x * box.width),
        y: Math.round(share.y * box.height),
        width: Math.round(share.width * box.width),
        height: Math.round(share.height * box.height),
      };
      pane.fontFamily = fontFamily;
      pane.fontSize = chooseFontSize({
        measure: (probe) => this.measure(fontFamily, probe),
        cols: pane.cols,
        rows: pane.displayRows,
        box: pane.box,
        start: pane.fontSize,
      });
      pane.metrics = this.measure(fontFamily, pane.fontSize);
      // Centred in its share, as the CSS that used to lay the panes out did.
      const width = pane.cols * pane.metrics.width;
      const height = pane.displayRows * pane.metrics.height;
      pane.rect = {
        x: pane.box.x + Math.floor((pane.box.width - width) / 2),
        y: pane.box.y + Math.floor((pane.box.height - height) / 2),
        width,
        height,
      };
    }
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
   * @param {Pane} pane
   * @param {import('./grid.js').Cell} cell
   * @returns {{ fg: string, bg: string, bold: boolean, underline: boolean }}
   */
  styleOf(pane, cell) {
    const { bold, underline, reverse } = grFlags(cell.gr);
    const background = this.theme["background"] ?? "#000000";

    let fg;
    let bg;
    if (cell.fg !== null && cell.fg.startsWith("#")) {
      // The page's own chrome names its colours outright, and means them.
      fg = cell.fg;
      bg = cell.bg ?? background;
    } else if (!pane.host.color) {
      // A 3278 reports no colour, so it is the green-on-black terminal it is.
      fg = MONO_FOREGROUND;
      bg = DEFAULT_BACKGROUND;
    } else {
      fg = this.color(cell.fg ?? pane.host.defaultFg, DEFAULT_FOREGROUND_ANSI);
      bg = this.color(cell.bg ?? pane.host.defaultBg, DEFAULT_BACKGROUND_ANSI);
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

  /** @returns {void} Coalesces a burst of changes into one frame. */
  requestRender() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  /** @returns {void} The whole page, every time. */
  render() {
    this.ctx.fillStyle = this.theme["background"] ?? "#000000";
    this.ctx.fillRect(0, 0, this.rect.width, this.rect.height);
    for (const pane of this.panes) this.renderPane(pane);
  }

  /**
   * @param {Pane} pane
   * @returns {void}
   */
  renderPane(pane) {
    const { width, height, baseline } = pane.metrics;
    if (width < 1 || height < 1) return;
    const rows = pane.displayRows;

    // Everything below is constant for the whole pane, and the loops run once
    // per cell: a 3279 at 80x44 is 3600 of them, redrawn on every keystroke.
    const background = this.theme["background"] ?? "#000000";
    const selectedFill = this.theme["selectionBackground"] ?? "#ffffff";
    const selectedInk = this.theme["selectionForeground"] ?? "#000000";
    const regularFont = `${pane.fontSize}px ${pane.fontFamily}`;
    const boldFont = `bold ${regularFont}`;
    const underlineThickness = Math.max(1, Math.round(height * 0.06));
    const box = pane.selectionBox();

    // Every row shares one set of column edges, and every column one set of row
    // edges, so the snapping is done once here instead of four times per cell.
    const colEdge = new Array(pane.cols + 1);
    for (let col = 0; col <= pane.cols; col++)
      colEdge[col] = this.snap(pane.rect.x + col * width);
    const rowEdge = new Array(rows + 1);
    for (let row = 0; row <= rows; row++)
      rowEdge[row] = this.snap(pane.rect.y + row * height);

    /** @type {(import('./grid.js').Cell | null)[]} */
    const cells = new Array(pane.cols);
    /** @type {({ fg: string, bg: string, bold: boolean, underline: boolean } | null)[]} */
    const styles = new Array(pane.cols);

    // A screen that cannot shrink past MIN_FONT_SIZE is drawn larger than its
    // share of the page. With one canvas under every pane, the overflow would
    // land on the neighbour rather than being cut off at the pane's edge.
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(pane.box.x, pane.box.y, pane.box.width, pane.box.height);
    this.ctx.clip();

    for (let row = 0; row < rows; row++) {
      const top = rowEdge[row];
      const bottom = rowEdge[row + 1];
      // Snapped like every other fill edge: an underline runs the width of a
      // field, so an edge of it between two device pixels is a seam the length
      // of the field.
      const underlineBottom = this.snap(bottom - 1);
      const underlineTop = this.snap(bottom - underlineThickness - 1);
      const rowSelected = box !== null && row >= box.top && row <= box.bottom;

      // Decoded once per row: the backgrounds and the glyphs want the same
      // answer for the same cell, and working it out is this loop's real cost.
      for (let col = 0; col < pane.cols; col++) {
        const cell = visibleCell(pane.host, pane.overlay, row, col);
        cells[col] = cell;
        styles[col] = cell === null ? null : this.styleOf(pane, cell);
      }

      // Backgrounds first, whole row, so a glyph that overhangs its cell is not
      // clipped by the next cell's fill. Neighbours of one colour are filled as
      // one rectangle rather than one each: an edge inside a run is an edge the
      // canvas can antialias into a hairline seam at a fractional
      // devicePixelRatio, and an edge never drawn cannot. One column past the
      // last closes whatever run is open.
      let runFill = "";
      let runStart = 0;
      for (let col = 0; col <= pane.cols; col++) {
        const style = styles[col];
        const selected =
          rowSelected && box !== null && col >= box.left && col <= box.right;
        let wanted = "";
        if (style !== undefined && style !== null)
          wanted = selected ? selectedFill : style.bg;
        // The pane was cleared to the theme's background, so a cell asking for
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

      let font = "";
      let fill = "";
      for (let col = 0; col < pane.cols; col++) {
        const cell = cells[col];
        const style = styles[col];
        if (style === undefined || style === null) continue;
        if (cell?.ch === undefined || cell.ch === null || cell.ch === " ")
          continue;
        const selected =
          rowSelected && box !== null && col >= box.left && col <= box.right;
        const wanted = selected ? selectedInk : style.fg;
        const wantedFont = style.bold ? boldFont : regularFont;
        if (wantedFont !== font) {
          this.ctx.font = wantedFont;
          font = wantedFont;
        }
        if (wanted !== fill) {
          this.ctx.fillStyle = wanted;
          fill = wanted;
        }
        this.ctx.fillText(cell.ch, colEdge[col], top + baseline);
        if (style.underline)
          this.ctx.fillRect(
            colEdge[col],
            underlineTop,
            colEdge[col + 1] - colEdge[col],
            underlineBottom - underlineTop,
          );
      }
    }

    this.renderCursor(pane);
    this.ctx.restore();
  }

  /**
   * @param {Pane} pane
   * @returns {void}
   */
  renderCursor(pane) {
    const cursor = visibleCursor(pane.host, pane.overlay);
    if (cursor === null || !cursor.visible) return;
    const { row, col } = cursor;
    if (row < 0 || row >= pane.displayRows || col < 0 || col >= pane.cols)
      return;

    const { width, height, baseline } = pane.metrics;
    const left = this.snap(pane.rect.x + col * width);
    const top = this.snap(pane.rect.y + row * height);
    const right = this.snap(pane.rect.x + (col + 1) * width);
    const bottom = this.snap(pane.rect.y + (row + 1) * height);
    this.ctx.fillStyle = this.theme["cursor"] ?? "#ffffff";

    if (pane.cursorStyle === "underline") {
      const thickness = Math.max(2, Math.floor(height * 0.15));
      const barTop = this.snap(bottom - thickness);
      this.ctx.fillRect(left, barTop, right - left, bottom - barTop);
      return;
    }

    this.ctx.fillRect(left, top, right - left, bottom - top);

    // A block cursor that hides the character under it is a block cursor nobody
    // can type behind, so the glyph is redrawn in the accent.
    const cell = visibleCell(pane.host, pane.overlay, row, col);
    const ch = cell?.ch ?? null;
    if (ch === null || ch === " ") return;
    const { bold } = this.styleOf(pane, cell ?? pane.host.blankCell());
    this.ctx.font = `${bold ? "bold " : ""}${pane.fontSize}px ${pane.fontFamily}`;
    this.ctx.fillStyle = this.theme["cursorAccent"] ?? "#000000";
    this.ctx.fillText(ch, left, top + baseline);
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{ pane: Pane, row: number, col: number } | null}
   */
  paneAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const pane = this.panes.find((each) => each.holds(x, y));
    if (pane === undefined) return null;
    return { pane, ...pane.cellAt(x, y) };
  }

  /**
   * @param {MouseEvent} event
   * @returns {void}
   */
  beginSelection(event) {
    if (event.button !== 0) return;
    const hit = this.paneAt(event.clientX, event.clientY);
    const had = this.panes.some((pane) => pane.hasSelection());
    for (const pane of this.panes) pane.clearSelection();
    if (hit !== null) {
      this.dragging = hit.pane;
      hit.pane.selectionStart = { row: hit.row, col: hit.col };
      hit.pane.selectionEnd = { row: hit.row, col: hit.col };
    }
    // A press is not a selection yet; only a previous one has to come off.
    if (had) this.requestRender();
  }

  /**
   * @param {MouseEvent} event
   * @returns {void}
   */
  extendSelection(event) {
    const pane = this.dragging;
    if (pane === null) return;
    const rect = this.canvas.getBoundingClientRect();
    // The drag belongs to the pane it started in, however far out of it it goes.
    const at = pane.cellAt(event.clientX - rect.left, event.clientY - rect.top);
    const row = Math.min(Math.max(at.row, 0), pane.statusRow);
    const col = Math.min(Math.max(at.col, 0), pane.cols - 1);

    // A cell is ten pixels wide and mousemove fires at the refresh rate, so most
    // of a drag's events land where the last one did and change nothing.
    const end = pane.selectionEnd;
    if (end !== null && end.row === row && end.col === col) return;

    pane.selectionEnd = { row, col };
    this.requestRender();
  }

  /** @returns {void} */
  endSelection() {
    this.dragging = null;
  }
}
