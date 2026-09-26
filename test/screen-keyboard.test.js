import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY_ROWS,
  keyAt,
  keyFace,
  keyboardTop,
  placeKeys,
} from "../public/screen-keyboard.js";

test("keyboard rows fit four lines with Chars between Enter and Clear", () => {
  const keys = placeKeys(80, 19);
  assert.equal(keys.length, KEY_ROWS.flat().length);
  for (const [row, width] of [
    [19, 70],
    [20, 63],
    [21, 72],
    [22, 72],
  ]) {
    const inRow = keys.filter((key) => key.row === row);
    const left = Math.floor((80 - width) / 2);
    assert.equal(inRow[0]?.col, left, `row ${row} starts off centre`);
    const last = inRow.at(-1);
    assert.equal(
      last && last.col + last.width,
      left + width,
      `row ${row} has the wrong width`,
    );
  }
  const chars = keys.find((key) => key.label === "Chars");
  assert.equal(chars?.row, 19);
  assert.equal(chars?.col, 5);
  assert.equal(chars?.action, "OpenChars");
  assert.equal(chars && keyFace(chars, "a-c"), "[Chars a-c] ");
  assert.equal(chars && keyFace(chars, "ctrl-shift-c"), "[Chars]     ");
  assert.deepEqual(
    keys
      .filter((key) => key.row === 19)
      .slice(0, 3)
      .map((key) => key.label),
    ["Chars", "Enter", "Clear"],
  );
  assert.deepEqual(
    keys
      .filter((key) => key.row === 19 && key.action === "PA")
      .map((key) => key.label),
    ["PA1", "PA2", "PA3"],
  );
  for (const key of keys) {
    assert.equal(keyFace(key), `[${key.label}]`.padEnd(key.width));
    assert.ok(keyFace(key).length <= key.width, `${key.label} is cut`);
  }
});

test("a click anywhere in a key's cells finds that key, and one beside the keyboard none", () => {
  const keys = placeKeys(80, 19);
  const pf13 = keys.find((key) => key.label === "PF13");
  const pf1 = keys.find((key) => key.label === "PF1");
  assert.ok(pf13 && pf1);
  assert.equal(pf13.row, 22);
  assert.equal(pf13.col, pf1.col, "PF13 sits under PF1");
  assert.equal(pf13.action, "PF");
  assert.deepEqual(pf13.args, ["13"]);

  assert.deepEqual(keyAt(keys, pf13.row, pf13.col + pf13.width - 1), pf13);
  assert.equal(keyAt(keys, pf13.row, pf13.col + pf13.width)?.label, "PF14");
  assert.equal(keyAt(keys, pf13.row, 0), null);
  assert.equal(keyAt(keys, 18, 10), null, "the row above is the host's");
  assert.equal(keyAt(keys, 19, 5)?.label, "Chars");
  assert.equal(keyAt(keys, 19, 41)?.label, "PA1");
  assert.equal(keyAt(keys, 23, 41), null, "the panel's key hints stay visible");
});

test("the keyboard sits at the bottom, and moves to the top when the cursor is under it", () => {
  assert.equal(keyboardTop(24, 0), 19);
  assert.equal(keyboardTop(24, 18), 19);
  assert.equal(keyboardTop(24, 19), 0);
  assert.equal(keyboardTop(24, 23), 0);
});
