import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY_ROWS,
  keyAt,
  keyFace,
  keyboardTop,
  placeKeys,
} from "../public/screen-keyboard.js";

test("every key fits on an 80-column screen with its label whole", () => {
  const keys = placeKeys(80, 20);
  assert.equal(keys.length, KEY_ROWS.flat().length);
  for (const key of keys) {
    assert.ok(key.col + key.width <= 80, `${key.label} runs off the screen`);
    assert.ok(key.label.length <= key.width, `${key.label} is cut`);
    assert.equal(keyFace(key).length, key.width);
  }
});

test("a click on a key finds that key, and one on the gap between two finds none", () => {
  const keys = placeKeys(80, 20);
  const pf13 = keys.find((key) => key.label === "PF13");
  assert.ok(pf13);
  assert.equal(pf13.row, 23);
  assert.deepEqual(keyAt(keys, pf13.row, pf13.col + 1), pf13);
  assert.equal(pf13.action, "PF");
  assert.deepEqual(pf13.args, ["13"]);

  assert.equal(keyAt(keys, pf13.row, pf13.col + pf13.width), null);
  assert.equal(keyAt(keys, 19, 0), null, "the row above is the host's");
});

test("the keyboard sits at the bottom, and moves to the top when the cursor is under it", () => {
  assert.equal(keyboardTop(24, 0), 20);
  assert.equal(keyboardTop(24, 19), 20);
  assert.equal(keyboardTop(24, 20), 0);
  assert.equal(keyboardTop(24, 23), 0);
});

test("every row reaches the right edge, so the keyboard is one even block", () => {
  for (const cols of [80, 132, 97]) {
    const keys = placeKeys(cols, 0);
    for (const row of [0, 1, 2, 3]) {
      const last = keys.filter((key) => key.row === row).at(-1);
      assert.equal(
        last && last.col + last.width,
        cols,
        `row ${row} at ${cols}`,
      );
    }
  }
});
