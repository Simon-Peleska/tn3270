import test from "node:test";
import assert from "node:assert/strict";
import { HintPrefix, computeHints } from "../public/hints.js";
import { key } from "./keyevent.js";

/**
 * '_' is an editable blank; anything else is protected content.
 *
 * @param {string} picture
 * @returns {{ ch: string, editable: boolean }[]}
 */
function row(picture) {
  return [...picture].map((ch) =>
    ch === "_" ? { ch: " ", editable: true } : { ch, editable: false },
  );
}

/**
 * @param {readonly string[]} pictures one per row, all the same length
 * @returns {{ cells: { ch: string, editable: boolean }[], cols: number }}
 */
function screen(pictures) {
  return { cells: pictures.flatMap(row), cols: pictures[0].length };
}

test("a labelled field is hinted with the label's own first letter", () => {
  const { cells, cols } = screen(["name:  ____________"]);
  const hints = computeHints(cells, cols);
  assert.deepEqual(hints, [{ row: 0, col: 7, letter: "n" }]);
});

test("a field with no label before it takes the first letter of the qwertz sequence", () => {
  const { cells, cols } = screen([" _________"]);
  const hints = computeHints(cells, cols);
  assert.deepEqual(hints, [{ row: 0, col: 1, letter: "q" }]);
});

test("a second field wanting the same first letter falls back to its next letter by keyboard order", () => {
  // Both labelled "name": the second cannot reuse 'n', and 'e' comes first in the qwertz row.
  const { cells, cols } = screen(["name:  ____  name:  ____"]);
  const hints = computeHints(cells, cols);
  assert.deepEqual(hints, [
    { row: 0, col: 7, letter: "n" },
    { row: 0, col: 20, letter: "e" },
  ]);
});

test("a field whose entire label is already claimed falls back to normal qwertz labeling", () => {
  // The first field takes "a"'s only letter, so the second falls back to the sequence.
  const { cells, cols } = screen(["a: __  a: __"]);
  const hints = computeHints(cells, cols);
  assert.deepEqual(hints, [
    { row: 0, col: 3, letter: "a" },
    { row: 0, col: 10, letter: "q" },
  ]);
});

test("a label only counts on the same row, and stops at the field before it", () => {
  const { cells, cols } = screen([
    "name:  ______________",
    "age:  _______________",
  ]);
  const hints = computeHints(cells, cols);
  assert.deepEqual(hints, [
    { row: 0, col: 7, letter: "n" },
    { row: 1, col: 6, letter: "a" },
  ]);
});

test("running past 52 fields leaves the rest without a hint rather than reusing a letter", () => {
  const pictures = [];
  for (let i = 0; i < 53; i++) pictures.push("_ ");
  const { cells, cols } = screen(pictures);
  const hints = computeHints(cells, cols);
  assert.equal(hints.length, 52);
});

test("an unformatted screen with nothing editable has no hints at all", () => {
  const { cells, cols } = screen(["no fields here at all"]);
  assert.deepEqual(computeHints(cells, cols), []);
});

test("Ctrl-B and a hint letter picks that hint", () => {
  const prefix = new HintPrefix();

  assert.deepEqual(prefix.handleKey(key({ key: "b", ctrlKey: true })), {
    action: "arm",
  });
  assert.equal(prefix.armed, true);
  // Ctrl going down on the way to the letter is a keystroke of its own.
  assert.deepEqual(prefix.handleKey(key({ key: "Control", ctrlKey: true })), {
    action: "ignore",
  });
  assert.deepEqual(prefix.handleKey(key({ key: "n" }), ["n", "e"]), {
    action: "hint",
    letter: "n",
  });
  assert.equal(prefix.armed, false);

  assert.deepEqual(prefix.handleKey(key({ key: "n" }), ["n"]), {
    action: "ignore",
  });
});

test("anything that is not an offered hint cancels instead of reaching the host", () => {
  const prefix = new HintPrefix();

  for (const pressed of ["x", "Escape", "1", "Enter"]) {
    prefix.handleKey(key({ key: "b", ctrlKey: true }));
    assert.deepEqual(
      prefix.handleKey(key({ key: pressed }), ["n"]),
      { action: "cancel" },
      pressed,
    );
    assert.equal(prefix.armed, false, pressed);
  }
});

test("the prefix is Ctrl-B alone", () => {
  const prefix = new HintPrefix();

  assert.deepEqual(prefix.handleKey(key({ key: "b" })), { action: "ignore" });
  assert.deepEqual(
    prefix.handleKey(key({ key: "b", ctrlKey: true, altKey: true })),
    { action: "ignore" },
  );
  assert.deepEqual(prefix.handleKey(key({ key: "a", ctrlKey: true })), {
    action: "ignore",
  });
  assert.equal(prefix.armed, false);
  assert.deepEqual(prefix.handleKey(key({ key: "B", ctrlKey: true })), {
    action: "arm",
  });
});
