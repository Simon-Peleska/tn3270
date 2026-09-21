import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  chooseFontSize,
} from "../public/fitfont.js";

/**
 * IBM 3270's own ratios, measured in Chrome. A cell is a whole number of
 * pixels, and that rounding is the whole difficulty.
 *
 * @param {number} size
 * @returns {{ width: number, height: number }}
 */
function cell(size) {
  return { width: Math.ceil(size * 0.547), height: Math.ceil(size * 1.06) + 2 };
}

/**
 * The oracle: every size tried in turn.
 *
 * @param {number} cols
 * @param {number} rows
 * @param {{ width: number, height: number }} box
 * @returns {number}
 */
function largestThatFits(cols, rows, box) {
  let best = MIN_FONT_SIZE;
  for (let size = MIN_FONT_SIZE; size <= MAX_FONT_SIZE; size++) {
    const measured = cell(size);
    if (
      measured.width * cols <= box.width &&
      measured.height * rows <= box.height
    )
      best = size;
  }
  return best;
}

test("the grid is fitted as large as the pane allows, from any starting size", () => {
  const cols = 80;
  const rows = 44;
  for (let width = 600; width <= 2400; width += 37) {
    const box = { width, height: Math.round(width * 1.15) };
    const wanted = largestThatFits(cols, rows, box);
    for (const start of [MIN_FONT_SIZE, 15, wanted, MAX_FONT_SIZE]) {
      const chosen = chooseFontSize({ measure: cell, cols, rows, box, start });
      assert.equal(
        chosen,
        wanted,
        `box ${width}x${box.height} starting at ${start}`,
      );
    }
  }
});

test("fitting twice changes nothing the second time", () => {
  const cols = 80;
  const rows = 44;
  const box = { width: 1152, height: 1297 };
  const once = chooseFontSize({ measure: cell, cols, rows, box, start: 15 });
  const twice = chooseFontSize({ measure: cell, cols, rows, box, start: once });
  assert.equal(twice, once);
});

test("a pane too small for the smallest text still gets an answer", () => {
  const chosen = chooseFontSize({
    measure: cell,
    cols: 80,
    rows: 44,
    box: { width: 40, height: 20 },
    start: 15,
  });
  assert.equal(chosen, MIN_FONT_SIZE);
});

test("a pane with room to spare stops at the largest size on offer", () => {
  const chosen = chooseFontSize({
    measure: cell,
    cols: 80,
    rows: 44,
    box: { width: 100000, height: 100000 },
    start: 15,
  });
  assert.equal(chosen, MAX_FONT_SIZE);
});
