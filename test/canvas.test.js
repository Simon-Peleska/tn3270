import test from "node:test";
import assert from "node:assert/strict";
import { paneShares } from "../public/sessions.js";
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

/**
 * @param {number} count how many panes share the page
 * @returns {{ screen: Screen, panes: Pane[] }} laid out, with text on each
 */
function pageOf(count) {
  const screen = new Screen({
    canvas: fakeCanvas(),
    theme: THEME,
    fieldBackground: true,
  });
  const panes = [];
  for (let index = 0; index < count; index++) {
    const pane = new Pane(80, 24);
    pane.host.put(2, 0, `PANE ${index} TEXT`, { fg: null, bg: null, gr: null });
    panes.push(pane);
  }
  screen.layout(panes, paneShares(count), PAGE, "monospace");
  screen.render();
  return { screen, panes };
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
  screen.layout([pane], paneShares(1), PAGE, "monospace");
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
      screen.layout([pane], paneShares(1), PAGE, "monospace");
      screen.render();
      assertOnDeviceGrid(screen, 1.4);
    }
  } finally {
    window.devicePixelRatio = 1;
  }
});

test("every pane gets a share of the one canvas, and none overlaps another", () => {
  const { screen, panes } = pageOf(4);

  assert.equal(screen.canvas.width, PAGE.width);
  assert.equal(screen.canvas.height, PAGE.height);

  for (const pane of panes) {
    assert.ok(pane.metrics.width > 0, "each pane is measured and fitted");
    assert.ok(pane.rect.x >= pane.box.x, "cells sit inside the pane's share");
    assert.ok(pane.rect.y >= pane.box.y);
    assert.ok(pane.rect.x + pane.rect.width <= pane.box.x + pane.box.width);
    assert.ok(pane.rect.y + pane.rect.height <= pane.box.y + pane.box.height);
  }

  // Two panes side by side are half as wide, so their text is smaller.
  const wide = pageOf(1).panes[0];
  assert.ok(wide.fontSize > panes[0].fontSize);
});

test("one frame clears the whole page before drawing any pane", () => {
  const { screen } = pageOf(4);
  const fills = /** @type {FakeContext} */ (/** @type {unknown} */ (screen.ctx))
    .fills;

  const frameStart = fills.findLastIndex((fill) => fill.w === PAGE.width);
  assert.notEqual(frameStart, -1, "the page is cleared edge to edge");
  assert.equal(fills[frameStart].x, 0);
  assert.equal(fills[frameStart].y, 0);
  assert.equal(fills[frameStart].h, PAGE.height);
  assert.equal(fills[frameStart].style, THEME.background);
});

test("a click routes to the pane it landed in, whichever that is", () => {
  const { screen, panes } = pageOf(4);
  for (const pane of panes) {
    const at = {
      clientX: pane.rect.x + 3 * pane.metrics.width + 1,
      clientY: pane.rect.y + 2 * pane.metrics.height + 1,
    };
    const hit = screen.paneAt(at.clientX, at.clientY);
    assert.equal(hit?.pane, pane);
    assert.deepEqual({ row: hit?.row, col: hit?.col }, { row: 2, col: 3 });
  }
});

test("a click on a character leaves no selection behind", () => {
  const { screen, panes } = pageOf(1);

  mouse(screen, "mousedown", panes[0], 2, 3);
  assert.equal(
    selectedCells(screen, panes[0]),
    0,
    "a press is not a selection yet, so nothing is highlighted",
  );

  mouse(screen, "mouseup", panes[0], 2, 3);
  assert.equal(selectedCells(screen, panes[0]), 0);
  assert.equal(panes[0].hasSelection(), false);
  assert.equal(panes[0].getSelection(), "");
});

test("a click on a blank cell leaves no selection behind", () => {
  const { screen, panes } = pageOf(1);

  mouse(screen, "mousedown", panes[0], 10, 40);
  assert.equal(selectedCells(screen, panes[0]), 0);

  mouse(screen, "mouseup", panes[0], 10, 40);
  assert.equal(panes[0].hasSelection(), false);
});

test("a drag of more than one cell is a selection, blank or not", () => {
  const { screen, panes } = pageOf(1);

  mouse(screen, "mousedown", panes[0], 2, 0);
  mouse(screen, "mousemove", panes[0], 2, 3);
  mouse(screen, "mouseup", panes[0], 2, 3);

  assert.equal(panes[0].hasSelection(), true);
  assert.equal(panes[0].getSelection(), "PANE");
  assert.equal(selectedCells(screen, panes[0]), 4);

  const blank = pageOf(1);
  mouse(blank.screen, "mousedown", blank.panes[0], 10, 0);
  mouse(blank.screen, "mousemove", blank.panes[0], 12, 5);
  mouse(blank.screen, "mouseup", blank.panes[0], 12, 5);
  assert.equal(
    blank.panes[0].hasSelection(),
    true,
    "blank cells are still a selection",
  );
});

test("a new press takes the previous selection off the screen", () => {
  const { screen, panes } = pageOf(1);

  mouse(screen, "mousedown", panes[0], 2, 0);
  mouse(screen, "mousemove", panes[0], 2, 3);
  mouse(screen, "mouseup", panes[0], 2, 3);
  assert.equal(selectedCells(screen, panes[0]), 4);

  mouse(screen, "mousedown", panes[0], 8, 8);
  assert.equal(selectedCells(screen, panes[0]), 0);
});

test("shift and the arrows select a rectangle from the cursor", () => {
  const { screen, panes } = pageOf(1);
  const pane = panes[0];
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
  const { screen, panes } = pageOf(1);
  const pane = panes[0];
  mouse(screen, "mousedown", pane, 10, 10);
  mouse(screen, "mouseup", pane, 10, 10);
  pane.host.cursor = { row: 2, col: 5, visible: true };

  pane.stepSelection(0, 1);
  assert.equal(pane.getSelection(), "0");
});

test("a keyboard selection starts over once the cursor has moved away from it", () => {
  const { panes } = pageOf(1);
  const pane = panes[0];
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
  const { panes } = pageOf(1);
  const pane = panes[0];
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

test("a selection belongs to one pane, and a press in another clears it", () => {
  const { screen, panes } = pageOf(2);

  mouse(screen, "mousedown", panes[0], 2, 0);
  mouse(screen, "mousemove", panes[0], 2, 3);
  mouse(screen, "mouseup", panes[0], 2, 3);
  assert.equal(panes[0].hasSelection(), true);
  assert.equal(panes[1].hasSelection(), false);

  mouse(screen, "mousedown", panes[1], 2, 0);
  assert.equal(
    panes[0].hasSelection(),
    false,
    "the other pane's selection came off",
  );
  assert.equal(selectedCells(screen, panes[0]), 0);
});

test("a pane too big for its share is cut off at it, not at its neighbour", () => {
  const screen = new Screen({
    canvas: fakeCanvas(),
    theme: THEME,
    fieldBackground: true,
  });
  // 60 rows into a quarter of the page: below MIN_FONT_SIZE the fit gives up
  // and the pane is drawn larger than the box it was given.
  const pane = new Pane(80, 60);
  for (let row = 0; row < 60; row++)
    pane.host.put(row, 0, "X".repeat(80), { fg: "red", bg: "blue", gr: null });
  const share = { x: 0, y: 0, width: 0.5, height: 0.5 };
  screen.layout([pane], [share], PAGE, "monospace");
  screen.render();

  const box = pane.box;
  assert.ok(
    pane.rect.height > box.height,
    "the pane really does overflow, or this asserts nothing",
  );

  for (const fill of lastFrame(screen).slice(1)) {
    assert.ok(fill.x >= box.x && fill.x + fill.w <= box.x + box.width);
    assert.ok(fill.y >= box.y && fill.y + fill.h <= box.y + box.height);
  }
});

test("a drag that leaves its pane stays clamped inside it", () => {
  const { screen, panes } = pageOf(2);

  mouse(screen, "mousedown", panes[0], 2, 0);
  // Well into the second pane, and past the bottom of the first.
  mouse(screen, "mousemove", panes[0], 400, 400);
  mouse(screen, "mouseup", panes[0], 400, 400);

  const box = panes[0].selectionBox();
  assert.deepEqual(box, { top: 2, left: 0, bottom: 24, right: 79 });
  assert.equal(panes[1].hasSelection(), false);
});
