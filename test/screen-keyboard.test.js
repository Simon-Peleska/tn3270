import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY_ROWS,
  keyAt,
  keyFace,
  keyboardTop,
  placeKeys,
} from "../public/screen-keyboard.js";

test("every row is 72 columns of six-column cells, centred, with every label whole", () => {
  const keys = placeKeys(80, 20);
  assert.equal(keys.length, KEY_ROWS.flat().length);
  for (const row of [20, 21, 22, 23]) {
    const inRow = keys.filter((key) => key.row === row);
    assert.equal(inRow[0]?.col, 4, `row ${row} starts off centre`);
    const last = inRow.at(-1);
    assert.equal(
      last && last.col + last.width,
      76,
      `row ${row} is not 72 wide`,
    );
  }
  for (const key of keys) {
    assert.equal((key.col - 4) % 6, 0, `${key.label} is off the grid`);
    assert.equal(keyFace(key), `[${key.label}]`.padEnd(key.width));
    assert.ok(keyFace(key).length <= key.width, `${key.label} is cut`);
  }
});

test("a click anywhere in a key's cells finds that key, and one beside the keyboard none", () => {
  const keys = placeKeys(80, 20);
  const pf13 = keys.find((key) => key.label === "PF13");
  const pf1 = keys.find((key) => key.label === "PF1");
  assert.ok(pf13 && pf1);
  assert.equal(pf13.row, 23);
  assert.equal(pf13.col, pf1.col, "PF13 sits under PF1");
  assert.equal(pf13.action, "PF");
  assert.deepEqual(pf13.args, ["13"]);

  assert.deepEqual(keyAt(keys, pf13.row, pf13.col + pf13.width - 1), pf13);
  assert.equal(keyAt(keys, pf13.row, pf13.col + pf13.width)?.label, "PF14");
  assert.equal(keyAt(keys, pf13.row, 0), null);
  assert.equal(keyAt(keys, 19, 10), null, "the row above is the host's");
});

test("the keyboard sits at the bottom, and moves to the top when the cursor is under it", () => {
  assert.equal(keyboardTop(24, 0), 20);
  assert.equal(keyboardTop(24, 19), 20);
  assert.equal(keyboardTop(24, 20), 0);
  assert.equal(keyboardTop(24, 23), 0);
});
