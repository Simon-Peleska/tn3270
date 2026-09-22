import test from "node:test";
import assert from "node:assert/strict";
import { editableSnapshot, changedRuns } from "../server/history.js";

/**
 * '_' is an editable blank; anything else is protected content. Lowercase
 * letters after a '_' stand for what has been typed into that field.
 *
 * @param {string} picture
 * @returns {{ ch: string, editable: boolean }[]}
 */
function row(picture) {
  return [...picture].map((ch) =>
    ch === "_" || /[a-z]/.test(ch)
      ? { ch: ch === "_" ? " " : ch, editable: true }
      : { ch, editable: false },
  );
}

test("a snapshot is one run per field, placed by row and column", () => {
  const cells = row(" abc ___ ___");
  const snapshot = editableSnapshot(cells, true, 12, { row: 0, col: 4 });
  assert.deepEqual(snapshot?.runs, [
    { row: 0, col: 1, text: "abc" },
    { row: 0, col: 5, text: "   " },
    { row: 0, col: 9, text: "   " },
  ]);
  assert.deepEqual(snapshot?.cursor, { row: 0, col: 4 });
});

test("the key follows the text and the layout follows the geometry, so typing is a new state in the same screen", () => {
  const before = editableSnapshot(row(" abc ___"), true, 8, { row: 0, col: 4 });
  const typed = editableSnapshot(row(" abc _x_"), true, 8, { row: 0, col: 6 });
  const moved = editableSnapshot(row(" abc ___"), true, 8, { row: 0, col: 1 });
  const relaid = editableSnapshot(row(" ab ____"), true, 8, { row: 0, col: 4 });

  assert.notEqual(typed?.key, before?.key, "typing changes the key");
  assert.equal(typed?.layout, before?.layout, "typing leaves the layout alone");
  assert.equal(moved?.key, before?.key, "a cursor move is not a new state");
  assert.notEqual(relaid?.layout, before?.layout, "new fields, new layout");
});

test("a field wrapping the end of the screen is one run, taken from where it starts", () => {
  // The last field starts on row 1 and carries on over the end into row 0.
  const cells = [...row("yzP___PP"), ...row("PPPPwx__")];
  const snapshot = editableSnapshot(cells, true, 8, { row: 0, col: 0 });
  assert.deepEqual(snapshot?.runs, [
    { row: 0, col: 3, text: "   " },
    { row: 1, col: 4, text: "wx  yz" },
  ]);
});

test("an unformatted screen has no fields to track", () => {
  assert.equal(
    editableSnapshot(row("abc"), false, 3, { row: 0, col: 0 }),
    null,
  );
});

test("only the runs that differ are put back, and a run whose field is gone is left alone", () => {
  const snapshot = editableSnapshot(row(" abc def ghi"), true, 12, {
    row: 0,
    col: 1,
  });
  assert.notEqual(snapshot, null);
  if (snapshot === null) return;

  const now = row(" abc dxf ghi");
  assert.deepEqual(changedRuns(snapshot, now, 12), [
    { row: 0, col: 5, text: "def" },
  ]);

  const protectedNow = row(" abc DEF ghi");
  assert.deepEqual(
    changedRuns(snapshot, protectedNow, 12),
    [],
    "the field map moved, so that run is not ours to retype",
  );
});
