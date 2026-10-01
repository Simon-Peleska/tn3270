// scroll.c: the scrollback buffer and the scrollbar thumb.

import {
  CELL_ARRAYS,
  ctlrEnableCursor,
  EC_SCROLL,
  GR_INTENSIFY,
  newCells,
} from "./ctlr.js";
import { popupError, screenDisp, statusScrolled } from "./ui.js";
import { in3270, CONNECTED_UNBOUND, isConnected } from "./session.js";
import { KL_SCROLLED } from "./kybd.js";

/** @typedef {import("./session.js").State} State */
/** One typed array per cell attribute, maxCols cells per row. @typedef {Record<(typeof CELL_ARRAYS)[number], Uint8Array | Uint32Array>} Rows */

const HOST_COLOR_BLACK = 8;

export function createScroll() {
  return {
    max: 0,
    /** Ring of max saved rows, grown as rows are saved; a few thousand rows per session add up. */
    ring: /** @type {Rows | null} */ (null),
    capacity: 0,
    /** The live screen while scrolled back. */
    image: /** @type {Rows | null} */ (null),
    next: 0,
    saved: 0,
    back: 0,
    needSaving: true,
    swapped: false,
    has3270: false,
    top: 0,
    topBase: 0,
    shown: 1,
    last: { top: -1, shown: -1, saved: -1, back: -1 },
  };
}
/** @typedef {ReturnType<typeof createScroll>} Scroll */

/** b3270 prints thumb doubles with %g, and scroll.c computes them in float. @param {number} x */
function g(x) {
  return Number(Math.fround(x).toPrecision(6));
}

/** screen_set_thumb(): b3270 drops repeats. @param {State} s */
function setThumb(s, top = s.scroll.top) {
  const sc = s.scroll;
  const last = sc.last;
  if (!s.ui) return;
  if (
    top === last.top &&
    sc.shown === last.shown &&
    sc.saved === last.saved &&
    sc.back === last.back
  )
    return;
  last.top = top;
  last.shown = sc.shown;
  last.saved = sc.saved;
  last.back = sc.back;
  s.ui?.out("thumb", {
    top: g(top),
    shown: g(sc.shown),
    saved: sc.saved,
    screen: s.maxRows,
    back: sc.back,
  });
}

/** @param {State} s @param {number} rows @returns {Rows} */
function allocate(s, rows, old = /** @type {Rows | null} */ (null)) {
  const cells = rows * s.maxCols;
  const out = newCells(cells);
  if (old) for (const name of CELL_ARRAYS) out[name].set(old[name]);
  return out;
}

/** Makes room for n rows in the ring, doubling up to its full size. @param {State} s @param {number} n */
function ensureRows(s, n) {
  const sc = s.scroll;
  if (sc.capacity >= n) return sc.ring;
  sc.capacity = Math.min(sc.max, Math.max(n, sc.capacity * 2, s.maxRows));
  sc.ring = allocate(s, sc.capacity, sc.ring);
  return sc.ring;
}

/** @param {State} s @param {Rows} rows @param {number} at @param {number} from */
function fillDefaults(s, rows, at, from) {
  const end = at + s.maxCols;
  for (const name of CELL_ARRAYS) rows[name].fill(0, at + from, end);
  rows.bg.fill(HOST_COLOR_BLACK, at + from, end);
  rows.gr.fill(GR_INTENSIFY, at + from, end);
}

/** @param {State} s @param {Rows} rows @param {number} at @param {number} b */
function copyFromScreen(s, rows, at, b) {
  for (const name of CELL_ARRAYS)
    rows[name].set(s[name].subarray(b, b + s.cols), at);
}

/** @param {State} s @param {Rows} rows @param {number} at @param {number} b */
function copyToScreen(s, rows, at, b) {
  for (const name of CELL_ARRAYS)
    s[name].set(rows[name].subarray(at, at + s.cols), b);
}

/** scroll_buf_init(): (re)sizes the save area, as a multiple of the screen height. @param {State} s */
export function scrollBufInit(s) {
  const sc = s.scroll;
  let max = s.options.saveLines;
  // Unlike b3270, which keeps at least five screens, 0 turns the scrollback off.
  if (max === 0) {
    sc.max = 0;
    scrollReset(s);
    return;
  }
  if (max % s.maxRows) max = Math.ceil(max / s.maxRows) * s.maxRows;
  if (max < s.maxRows * 5) max = s.maxRows * 5;
  sc.max = max;
  scrollReset(s);
}

/** scroll_reset() @param {State} s */
export function scrollReset(s) {
  const sc = s.scroll;
  sc.ring = null;
  sc.capacity = 0;
  sc.image = null;
  sc.next = 0;
  sc.saved = 0;
  sc.back = 0;
  sc.top = sc.topBase = 0;
  sc.shown = 1;
  sc.needSaving = true;
  setThumb(s);
  ctlrEnableCursor(s, true, EC_SCROLL);
}

/** @param {State} s @param {(rows: Rows, at: number) => void} fill */
function push(s, fill) {
  const sc = s.scroll;
  fill(/** @type {Rows} */ (ensureRows(s, sc.next + 1)), sc.next * s.maxCols);
  sc.next = (sc.next + 1) % sc.max;
  if (sc.saved < sc.max) sc.saved++;
}

/** scroll_save(): saves n lines from the top of the screen. @param {State} s @param {number} n */
export function scrollSave(s, n) {
  const sc = s.scroll;
  if (!sc.max) return;
  if (sc.back) syncScroll(s, 0);
  for (let row = 0; row < n; row++) {
    if (row < s.rows)
      push(s, (rows, at) => {
        copyFromScreen(s, rows, at, row * s.cols);
        if (s.cols < s.maxCols) fillDefaults(s, rows, at, s.cols);
      });
    else push(s, (rows, at) => fillDefaults(s, rows, at, 0));
  }
  // x3270 advances only once here, however many rows it means to pad.
  if (n === s.rows && n < s.maxRows)
    push(s, (rows, at) => fillDefaults(s, rows, at, 0));

  // A whole screen that ended off a screenful boundary was scrolled NVT data.
  if (n !== 1 && sc.next % s.maxRows) {
    for (let pad = s.maxRows - (sc.next % s.maxRows); pad; pad--)
      push(s, (rows, at) => fillDefaults(s, rows, at, 0));
  }

  sc.topBase = sc.top = Math.fround(sc.saved / (sc.max + s.maxRows));
  sc.shown = Math.fround(1 - sc.top);
  setThumb(s);
}

/** scroll_to_bottom(): output or a reset shows the live screen again. @param {State} s */
export function scrollToBottom(s) {
  if (s.scroll.back) syncScroll(s, 0);
  s.scroll.needSaving = true;
}

/** save_image(): keeps the live screen while scrolled back. @param {State} s */
function saveImage(s) {
  const sc = s.scroll;
  if (!sc.needSaving) return;
  sc.image ??= allocate(s, s.maxRows);
  for (let i = 0; i < s.maxRows; i++)
    copyFromScreen(s, sc.image, i * s.maxCols, i * s.cols);
  sc.needSaving = false;
}

/** sync_scroll(): redraws the screen starting sb lines back. @param {State} s @param {number} sb */
function syncScroll(s, sb) {
  const sc = s.scroll;
  if (sc.has3270) {
    const slop = sb % s.maxRows;
    if (slop) sb += slop <= s.maxRows / 2 ? -slop : s.maxRows - slop;
    if (in3270(s)) {
      if (sb) s.kybdlock |= KL_SCROLLED;
      else s.kybdlock &= ~KL_SCROLLED;
    }
  }
  statusScrolled(s, sc.has3270 ? sb / s.maxRows : 0);

  if (sb && !sc.back && (s.cols < s.maxCols || s.rows < s.maxRows)) {
    s.cols = s.maxCols;
    s.rows = s.maxRows;
    sc.swapped = true;
  } else if (!sb && sc.back && sc.swapped) {
    shrink(s);
    s.cols = 80;
    s.rows = 24;
    sc.swapped = false;
  }

  // Rounding to whole screens can reach past the rows saved so far; those read as zeros.
  const ring = /** @type {Rows} */ (sb ? ensureRows(s, sc.max) : sc.ring);
  const image = (sc.image ??= allocate(s, s.maxRows));
  const first = (sc.next + sc.max - sb) % sc.max;
  for (let i = 0; i < s.maxRows; i++) {
    if (i < sb)
      copyToScreen(s, ring, ((first + i) % sc.max) * s.maxCols, i * s.cols);
    else copyToScreen(s, image, (i - sb) * s.maxCols, i * s.cols);
  }

  ctlrEnableCursor(s, sb === 0, EC_SCROLL);
  sc.back = sb;
  s.changed = true;

  const tt0 = Math.fround(sc.saved / (sc.max + s.maxRows));
  sc.shown = Math.fround(1 - tt0);
  sc.top = Math.fround((sc.saved - sb) / (sc.max + s.maxRows));
  setThumb(s);
}

/** ctlr_shrink(): blanks the screen outside of fields before it goes back to its default size. @param {State} s */
function shrink(s) {
  const size = s.rows * s.cols;
  const blank = s.options.visibleControl ? 0x40 : 0;
  for (let b = 0; b < size; b++) if (!s.fa[b]) s.ec[b] = blank;
  s.changed = true;
  screenDisp(s);
}

/** scroll_n(): scrolls nss lines forward (direction > 0) or back. @param {State} s @param {number} nss @param {number} direction */
function scrollN(s, nss, direction) {
  const sc = s.scroll;
  if (!sc.saved) return;
  if (!nss) nss = 1;
  saveImage(s);
  if (direction > 0) {
    if (nss > sc.back) syncScroll(s, 0);
    else {
      let nsr = sc.back - nss;
      if (sc.has3270 && nsr % s.maxRows) nsr -= nsr % s.maxRows;
      syncScroll(s, nsr);
    }
  } else if (sc.back + nss > sc.saved) {
    syncScroll(s, sc.saved);
  } else {
    let nsr = sc.back + nss;
    if (sc.has3270 && nsr % s.maxRows) nsr += s.maxRows - (nsr % s.maxRows);
    syncScroll(s, nsr);
  }
  setThumb(s, Math.fround((sc.saved - sc.back) / (sc.max + s.maxRows)));
}

/** Scroll(Forward|Backward|Reset|Set,n) @param {State} s @param {string[]} args */
export function scrollAction(s, ...args) {
  args = args.map(String);
  const sc = s.scroll;
  if (args.length < 1 || args.length > 2) {
    s.log.warn(`N3103 Scroll: ${args.length} arguments`);
    popupError(s, "Scroll() requires 1 or 2 arguments");
    return false;
  }
  const kw = args[0]?.toLowerCase();
  if (args.length === 1 && kw === "forward") scrollN(s, s.maxRows, +1);
  else if (args.length === 1 && kw === "backward") scrollN(s, s.maxRows, -1);
  else if (args.length === 1 && kw === "reset") scrollReset(s);
  else if (args.length === 2 && kw === "set") {
    const m = /^\s*([+-]?)(\d+)$/.exec(args[1]);
    let n = m ? Number(m[1] + m[2]) : -1;
    if (n < 0) {
      s.log.warn(`N3101 Scroll: invalid set value ${JSON.stringify(args[1])}`);
      popupError(s, "Scroll(): Invalid set,n value");
      return false;
    }
    if (n > sc.saved) n = sc.saved;
    if (n > sc.back) scrollN(s, n - sc.back, -1);
    else if (n < sc.back) scrollN(s, sc.back - n, +1);
  } else {
    s.log.warn(`N3102 Scroll: bad arguments ${JSON.stringify(args)}`);
    popupError(
      s,
      "Scroll(): Parameter must be forward, backward, reset or set",
    );
    return false;
  }
  return true;
}

/** scroll_connect(): remembers 3270 mode across disconnects and UNBINDs. @param {State} s */
export function scrollConnect(s) {
  if (isConnected(s))
    s.scroll.has3270 =
      in3270(s) || (s.scroll.has3270 && s.cstate === CONNECTED_UNBOUND);
}
