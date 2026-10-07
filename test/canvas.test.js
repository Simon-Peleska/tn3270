import test from "node:test";
import assert from "node:assert/strict";
import { Pane, Screen } from "../public/canvas.js";

/**
 * A canvas context that remembers what it was told to fill, so a test can ask
 * what is on screen rather than look at it. Coarse enough to be the whole of
 * the DOM this needs: the renderer touches a 2D context, `devicePixelRatio`
 * and `requestAnimationFrame`, and nothing else.
 *
 * @typedef {{ x: number, y: number, w: number, h: number, style: string }} Fill
 */

/**
 * @param {Fill} a
 * @param {Fill} b
 * @returns {Fill} empty when they do not overlap
 */
function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    w: Math.min(a.x + a.w, b.x + b.w) - x,
    h: Math.min(a.y + a.h, b.y + b.h) - y,
    style: b.style,
  };
}
class FakeContext {
  constructor() {
    /** @type {Fill[]} */
    this.fills = [];
    /** @type {string} */
    this.fillStyle = "";
    /** @type {string} */
    this.font = "";
    /** @type {string} */
    this.textBaseline = "";
    /** @type {Fill | null} The clip in force; null is the whole surface. */
    this.clipRect = null;
    /** @type {Fill | null} */
    this.path = null;
    /** @type {(Fill | null)[]} */
    this.saved = [];
  }

  /** @returns {void} */
  save() {
    this.saved.push(this.clipRect);
  }

  /** @returns {void} */
  restore() {
    this.clipRect = this.saved.pop() ?? null;
  }

  /** @returns {void} */
  beginPath() {
    this.path = null;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @returns {void}
   */
  rect(x, y, w, h) {
    this.path = { x, y, w, h, style: "" };
  }

  /** @returns {void} */
  clip() {
    if (this.path === null) return;
    this.clipRect =
      this.clipRect === null ? this.path : intersect(this.clipRect, this.path);
  }

  /**
   * Monospace, and scaling with the size, so the fit search has something real
   * to search: a cell that never changed would fit every size equally.
   *
   * @param {string} text
   * @returns {{ width: number, fontBoundingBoxAscent: number, fontBoundingBoxDescent: number }}
   */
  measureText(text) {
    const size = Number.parseFloat(this.font) || 16;
    return {
      width: text.length * size * 0.6,
      fontBoundingBoxAscent: size * 0.8,
      fontBoundingBoxDescent: size * 0.25,
    };
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @returns {void}
   */
  fillRect(x, y, w, h) {
    const fill = { x, y, w, h, style: String(this.fillStyle) };
    const clipped =
      this.clipRect === null ? fill : intersect(this.clipRect, fill);
    if (clipped.w > 0 && clipped.h > 0) this.fills.push(clipped);
  }

  /** @returns {void} */
  fillText() {}

  /** @returns {void} */
  setTransform() {}
}

/** @type {Record<string, (event: object) => void>} */
const documentListeners = {};

/** @type {(() => void)[]} Frames asked for but not yet run. */
const pendingFrames = [];

/** @returns {void} Runs what `requestAnimationFrame` was handed, as the browser would. */
function flushFrames() {
  while (pendingFrames.length > 0) pendingFrames.shift()?.();
}

/**
 * The canvas comes out of `index.html` now, so a test hands one in the same way
 * `app.js` does.
 *
 * @returns {HTMLCanvasElement} enough of one for the renderer
 */
function fakeCanvas() {
  const canvas = {
    style: {},
    width: 0,
    height: 0,
    /** @type {Record<string, (event: object) => void>} */
    listeners: {},
    getContext: () => new FakeContext(),
    /** @param {string} type @param {(event: object) => void} fn */
    addEventListener(type, fn) {
      canvas.listeners[type] = fn;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  return /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (canvas));
}

/** @returns {() => void} undoes the stubbing */
function stubDom() {
  const previous = {
    document: Reflect.get(globalThis, "document"),
    window: Reflect.get(globalThis, "window"),
    requestAnimationFrame: Reflect.get(globalThis, "requestAnimationFrame"),
  };

  Object.assign(globalThis, {
    document: {
      /** @param {string} type @param {(event: object) => void} fn */
      addEventListener(type, fn) {
        documentListeners[type] = fn;
      },
    },
    window: { devicePixelRatio: 1 },
    /** @param {() => void} fn */
    requestAnimationFrame(fn) {
      pendingFrames.push(fn);
      return pendingFrames.length;
    },
  });

  return () => Object.assign(globalThis, previous);
}

test.after(stubDom());

const THEME = {
  background: "#111111",
  foreground: "#dddddd",
  cursor: "#ebdbb2",
  cursorAccent: "#111111",
  selectionBackground: "#ebdbb2",
  selectionForeground: "#111111",
  field: "#282828",
};

const PAGE = { width: 1600, height: 900 };

test("screen layout respects a font size cap but shrinks further when needed", () => {
  const screen = new Screen({
    canvas: fakeCanvas(),
    theme: THEME,
    fieldBackground: true,
  });
  const pane = new Pane(80, 24);
  screen.layout(pane, PAGE, "monospace", 16);
  assert.equal(pane.fontSize, 16);
  screen.layout(pane, { width: 700, height: 350 }, "monospace", 16);
  assert.ok(pane.fontSize < 16);
});

/** @returns {{ screen: Screen, pane: Pane }} laid out, with text on it */
function page() {
  const screen = new Screen({
    canvas: fakeCanvas(),
    theme: THEME,
    fieldBackground: true,
  });
  const pane = new Pane(80, 24);
  pane.host.put(2, 0, "PANE 0 TEXT", { fg: null, bg: null, gr: null });
  screen.layout(pane, PAGE, "monospace");
  screen.render();
  return { screen, pane };
}

/**
 * @param {Screen} screen
 * @param {string} type
 * @param {Pane} pane
 * @param {number} row
 * @param {number} col
 * @returns {void}
 */
function mouse(screen, type, pane, row, col) {
  const target =
    type === "mouseup"
      ? documentListeners
      : Reflect.get(screen.canvas, "listeners");
  target[type]({
    button: 0,
    clientX: pane.rect.x + col * pane.metrics.width + 1,
    clientY: pane.rect.y + row * pane.metrics.height + 1,
  });
  flushFrames();
}

/**
 * The frame opens with `render()` clearing the whole page to the theme's
 * background. Nothing else is that rectangle, so it is what "the last frame"
 * starts at — a fill merely as wide as the page is an ordinary row.
 *
 * @param {Screen} screen
 * @returns {Fill[]}
 */
function lastFrame(screen) {
  const fills = fillsOf(screen);
  const start = fills.findLastIndex(
    (fill) =>
      fill.style === THEME.background &&
      fill.x === 0 &&
      fill.y === 0 &&
      fill.w === PAGE.width &&
      fill.h === PAGE.height,
  );
  return fills.slice(start);
}

/**
 * Counted in cells, not in rectangles: neighbours of one colour are filled
 * together, so four selected cells are one fill four cells wide.
 *
 * @param {Screen} screen
 * @param {Pane} pane the selection is inside
 * @returns {number} cells washed in the selection colour on the last frame
 */
function selectedCells(screen, pane) {
  return lastFrame(screen)
    .filter((fill) => fill.style === THEME.selectionBackground)
    .reduce(
      (total, fill) => total + Math.round(fill.w / pane.metrics.width),
      0,
    );
}

/**
 * @param {Screen} screen
 * @returns {Fill[]} everything filled since the screen was made
 */
function fillsOf(screen) {
  const ctx = /** @type {unknown} */ (screen.ctx);
  return /** @type {FakeContext} */ (ctx).fills;
}

/**
 * @param {boolean} fieldBackground
 * @param {number} length how wide the typeable field is
 * @returns {{ screen: Screen, pane: Pane }} one frame drawn
 */
function fieldFrame(fieldBackground, length) {
  const screen = new Screen({
    canvas: fakeCanvas(),
    theme: THEME,
    fieldBackground,
  });
  const pane = new Pane(80, 24);
  pane.host.put(0, 0, "_".repeat(length), {
    fg: null,
    bg: null,
    gr: null,
    editable: true,
  });
  screen.layout(pane, PAGE, "monospace");
  screen.render();
  return { screen, pane };
}

/**
 * @param {Screen} screen
 * @param {number} dpr
 * @returns {void} asserts every fill's four edges land on a device pixel
 */
function assertOnDeviceGrid(screen, dpr) {
  for (const fill of fillsOf(screen))
    for (const edge of [fill.x, fill.y, fill.x + fill.w, fill.y + fill.h]) {
      const device = edge * dpr;
      assert.ok(
        Math.abs(device - Math.round(device)) < 1e-6,
        `a ${fill.style} edge at ${edge} falls between two device pixels`,
      );
    }
}

test("turning the field background off leaves a typeable field untinted", () => {
  const on = fillsOf(fieldFrame(true, 4).screen);
  const off = fillsOf(fieldFrame(false, 4).screen);
  assert.ok(
    on.filter((fill) => fill.style === THEME.field).length > 0,
    "the tint is drawn while it is turned on",
  );
  assert.equal(off.filter((fill) => fill.style === THEME.field).length, 0);
});

test("neighbouring cells of one colour are filled as one rectangle, on the device pixel grid", () => {
  // 1.4 is what 140% display scaling reports, and the ratio the seams show at:
  // a cell edge lands between two device pixels and both sides of it are drawn
  // half-covered. An edge that is never drawn cannot do that, so a run of one
  // colour has to come out as a single fill.
  const window = Reflect.get(globalThis, "window");
  window.devicePixelRatio = 1.4;
  try {
    const { screen, pane } = fieldFrame(true, 20);
    const fills = fillsOf(screen);

    const tint = fills.filter((fill) => fill.style === THEME.field);
    assert.equal(tint.length, 1, "twenty tinted cells, one rectangle");
    assert.ok(
      Math.abs((tint[0]?.w ?? 0) - 20 * pane.metrics.width) < 1,
      "and it spans the whole field",
    );

    assertOnDeviceGrid(screen, 1.4);
  } finally {
    window.devicePixelRatio = 1;
  }
});

test("an underline and a cursor land on the device pixel grid too", () => {
  const window = Reflect.get(globalThis, "window");
  window.devicePixelRatio = 1.4;
  try {
    const screen = new Screen({
      canvas: fakeCanvas(),
      theme: THEME,
      fieldBackground: true,
    });
    const pane = new Pane(80, 24);
    pane.host.put(3, 10, "UNDERLINED", {
      fg: null,
      bg: null,
      gr: "underline",
    });
    pane.host.cursor = { row: 3, col: 10, visible: true };

    for (const style of ["block", "underline"]) {
      pane.cursorStyle = /** @type {'block' | 'underline'} */ (style);
      screen.layout(pane, PAGE, "monospace");
      screen.render();
      assertOnDeviceGrid(screen, 1.4);
    }
  } finally {
    window.devicePixelRatio = 1;
  }
});

test("host URLs are underlined, clickable by cell, and updated with the host paint", () => {
  const pane = new Pane(80, 24);
  const url = "https://example.org/a";
  pane.applyHostPaint({
    type: "paint",
    full: true,
    color: true,
    fieldsFormatted: false,
    rows: [
      { row: 0, runs: [{ col: 0, text: `Visit ${url}, then.` }] },
      { row: 1, runs: [{ col: 0, text: "(http://example.net)" }] },
    ],
    cursor: { row: 0, col: 0, on: false },
  });
  assert.equal(pane.linkAt(0, 6), url);
  assert.equal(pane.linkAt(0, 6 + url.length - 1), url);
  assert.equal(pane.linkAt(0, 6 + url.length), null);
  assert.equal(pane.linkAt(1, 1), "http://example.net");
  assert.equal(pane.linkAt(1, 19), null);

  const screen = new Screen({
    canvas: fakeCanvas(),
    theme: THEME,
    fieldBackground: true,
  });
  screen.layout(pane, PAGE, "monospace");
  screen.render();
  const underlines = () =>
    lastFrame(screen).filter((fill) => fill.h < pane.metrics.height / 4).length;
  assert.equal(underlines(), url.length + "http://example.net".length);

  pane.overlay.put(0, 6, "X");
  screen.render();
  assert.equal(underlines(), url.length + "http://example.net".length - 1);

  pane.applyHostPaint({
    type: "paint",
    full: false,
    color: true,
    fieldsFormatted: false,
    rows: [{ row: 0, runs: [{ col: 0, text: " ".repeat(80) }] }],
    cursor: { row: 0, col: 0, on: false },
  });
  assert.equal(pane.linkAt(0, 6), null);
  assert.equal(pane.linkAt(1, 1), "http://example.net");
});

test("the screen is fitted to the one canvas and centred on it", () => {
  const { screen, pane } = page();

  assert.equal(screen.canvas.width, PAGE.width);
  assert.equal(screen.canvas.height, PAGE.height);
  assert.ok(pane.metrics.width > 0, "the pane is measured and fitted");
  assert.ok(pane.rect.x >= 0 && pane.rect.y >= 0, "cells sit on the page");
  assert.ok(pane.rect.x + pane.rect.width <= PAGE.width);
  assert.ok(pane.rect.y + pane.rect.height <= PAGE.height);
  const left = pane.rect.x;
  const right = PAGE.width - pane.rect.x - pane.rect.width;
  assert.ok(Math.abs(left - right) <= 1, `centred: ${left} and ${right}`);
});

test("a canvas with no screen yet is still the size of the page", () => {
  const screen = new Screen({
    canvas: fakeCanvas(),
    theme: THEME,
    fieldBackground: true,
  });
  screen.layout(null, PAGE, "monospace");
  screen.render();
  assert.equal(screen.canvas.width, PAGE.width);
  assert.equal(screen.cellAt(10, 10), null);
});

test("one frame clears the whole page before drawing the screen", () => {
  const { screen } = page();
  const fills = /** @type {FakeContext} */ (/** @type {unknown} */ (screen.ctx))
    .fills;
  fills.length = 0;
  screen.render();

  assert.deepEqual(fills[0], {
    ...fills[0],
    x: 0,
    y: 0,
    w: PAGE.width,
    h: PAGE.height,
    style: THEME.background,
  });
});

test("a click lands on the cell under it", () => {
  const { screen, pane } = page();
  const hit = screen.cellAt(
    pane.rect.x + 3 * pane.metrics.width + 1,
    pane.rect.y + 2 * pane.metrics.height + 1,
  );
  assert.deepEqual(hit, { row: 2, col: 3 });
});

test("a click on a character leaves no selection behind", () => {
  const { screen, pane } = page();

  mouse(screen, "mousedown", pane, 2, 3);
  assert.equal(
    selectedCells(screen, pane),
    0,
    "a press is not a selection yet, so nothing is highlighted",
  );

  mouse(screen, "mouseup", pane, 2, 3);
  assert.equal(selectedCells(screen, pane), 0);
  assert.equal(pane.hasSelection(), false);
  assert.equal(pane.getSelection(), "");
});

test("a click on a blank cell leaves no selection behind", () => {
  const { screen, pane } = page();

  mouse(screen, "mousedown", pane, 10, 40);
  assert.equal(selectedCells(screen, pane), 0);

  mouse(screen, "mouseup", pane, 10, 40);
  assert.equal(pane.hasSelection(), false);
});

test("a drag of more than one cell is a selection, blank or not", () => {
  const { screen, pane } = page();

  mouse(screen, "mousedown", pane, 2, 0);
  mouse(screen, "mousemove", pane, 2, 3);
  mouse(screen, "mouseup", pane, 2, 3);

  assert.equal(pane.hasSelection(), true);
  assert.equal(pane.getSelection(), "PANE");
  assert.equal(selectedCells(screen, pane), 4);

  const blank = page();
  mouse(blank.screen, "mousedown", blank.pane, 10, 0);
  mouse(blank.screen, "mousemove", blank.pane, 12, 5);
  mouse(blank.screen, "mouseup", blank.pane, 12, 5);
  assert.equal(
    blank.pane.hasSelection(),
    true,
    "blank cells are still a selection",
  );
});

test("a selection copies what is on screen, a panel over the host included", () => {
  const { screen, pane } = page();
  pane.overlay.put(2, 0, "PA", { fg: "red", bg: "blue", gr: null });

  mouse(screen, "mousedown", pane, 2, 0);
  mouse(screen, "mousemove", pane, 2, 3);
  mouse(screen, "mouseup", pane, 2, 3);

  assert.equal(pane.getSelection(), "PANE");
  pane.overlay.put(2, 0, "XY", { fg: "red", bg: "blue", gr: null });
  assert.equal(pane.getSelection(), "XYNE");
});

test("a new press takes the previous selection off the screen", () => {
  const { screen, pane } = page();

  mouse(screen, "mousedown", pane, 2, 0);
  mouse(screen, "mousemove", pane, 2, 3);
  mouse(screen, "mouseup", pane, 2, 3);
  assert.equal(selectedCells(screen, pane), 4);

  mouse(screen, "mousedown", pane, 8, 8);
  assert.equal(selectedCells(screen, pane), 0);
});

test("shift and the arrows select a rectangle from the cursor", () => {
  const { screen, pane } = page();
  pane.host.cursor = { row: 2, col: 0, visible: false };

  for (let step = 0; step < 3; step++) pane.stepSelection(0, 1);
  pane.stepSelection(1, 0);
  screen.render();

  assert.equal(pane.getSelection(), "PANE\n");
  assert.equal(selectedCells(screen, pane), 8);

  pane.stepSelection(-1, 0);
  for (let step = 0; step < 3; step++) pane.stepSelection(0, -1);
  assert.equal(
    pane.hasSelection(),
    false,
    "back at the cursor is no selection",
  );
});

test("a keyboard selection starts at the cursor, not at the last click", () => {
  const { screen, pane } = page();
  mouse(screen, "mousedown", pane, 10, 10);
  mouse(screen, "mouseup", pane, 10, 10);
  pane.host.cursor = { row: 2, col: 5, visible: true };

  pane.stepSelection(0, 1);
  assert.equal(pane.getSelection(), "0");
});

test("a keyboard selection starts over once the cursor has moved away from it", () => {
  const { pane } = page();
  pane.host.cursor = { row: 2, col: 0, visible: false };
  pane.stepSelection(0, 3);

  pane.host.cursor = { row: 10, col: 20, visible: false };
  pane.stepSelection(0, 1);
  assert.deepEqual(pane.selectionBox(), {
    top: 10,
    left: 20,
    bottom: 10,
    right: 21,
  });
});

test("a keyboard selection stops at the edge of the host's screen", () => {
  const { pane } = page();
  pane.host.cursor = { row: 23, col: 79, visible: true };

  pane.stepSelection(1, 0);
  pane.stepSelection(0, 1);
  assert.equal(pane.hasSelection(), false);

  pane.stepSelection(0, -1);
  pane.stepSelection(1, 0);
  assert.deepEqual(pane.selectionBox(), {
    top: 23,
    left: 78,
    bottom: 23,
    right: 79,
  });
});

test("a drag that leaves the screen stays clamped inside it", () => {
  const { screen, pane } = page();

  mouse(screen, "mousedown", pane, 2, 0);
  mouse(screen, "mousemove", pane, 400, 400);
  mouse(screen, "mouseup", pane, 400, 400);

  assert.deepEqual(pane.selectionBox(), {
    top: 2,
    left: 0,
    bottom: 24,
    right: 79,
  });
});
