import test from "node:test";
import assert from "node:assert/strict";
import { fieldMap } from "../server/readbuffer.js";

/**
 * @param {boolean[]} map
 * @param {number} cols
 * @returns {string[]} one string per row, '.' unmarked and '#' marked
 */
function picture(map, cols) {
  const rows = [];
  for (let i = 0; i < map.length; i += cols) {
    rows.push(
      map
        .slice(i, i + cols)
        .map((cell) => (cell ? "#" : "."))
        .join(""),
    );
  }
  return rows;
}

test("cells after an unprotected attribute are typeable, and the attribute itself never is", () => {
  const lines = [
    "SF(c0=f0) 55 73 65 72 SF(c0=cd,41=f4) 00 00 00 SF(c0=f0)",
    "SF(c0=f0) 4f 4b 20 20 20 20 20 20 20",
  ];
  assert.deepEqual(picture(fieldMap(lines, 2, 10).editable, 10), [
    "......###.",
    "..........",
  ]);
});

test("a field runs past the end of a row and the last field on the screen wraps round to the first", () => {
  const lines = [
    "00 00 00 00 00",
    "00 SF(c0=f0) 41 42 43",
    "00 00 00 SF(c0=cc) 00",
  ];
  assert.deepEqual(picture(fieldMap(lines, 3, 5).editable, 5), [
    "#####",
    "#....",
    "....#",
  ]);
});

test("SA tokens carry an attribute for the next cell and take up no column of their own", () => {
  const lines = ["SF(c0=cd,41=f4) SA(42=f4) 41 SA(41=f2) 42 43"];
  assert.deepEqual(picture(fieldMap(lines, 1, 4).editable, 4), [".###"]);
});

test("an unformatted screen has no fields, so nothing is marked typeable", () => {
  const lines = ["41 42 43 44", "45 46 47 48"];
  const map = fieldMap(lines, 2, 4);
  assert.deepEqual(map.editable.some(Boolean), false);
  assert.deepEqual(map.hidden.some(Boolean), false);
});

test("rows b3270 did not return stay with whatever protection was in force", () => {
  const lines = ["SF(c0=cd) 00 00 00"];
  assert.deepEqual(picture(fieldMap(lines, 2, 4).editable, 4), [
    ".###",
    "####",
  ]);
});

test("a non-display field (the 0x0c intensity bits set) is marked hidden, an ordinary one is not", () => {
  // c0=cd is unprotected non-display (a password field); c0=c0 is an ordinary one.
  const lines = ["SF(c0=cd) 41 42 SF(c0=c0) 43 44"];
  assert.deepEqual(picture(fieldMap(lines, 1, 6).hidden, 6), [".##..."]);
});
