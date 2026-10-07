import test from "node:test";
import assert from "node:assert/strict";
import { fieldMap } from "../server/fields.js";

/**
 * @param {string[]} rows one string per row: '.' a cell without a field
 *   attribute, a letter one with the attribute the `attributes` table gives it
 * @param {Record<string, number>} attributes
 * @returns {number[]}
 */
function screen(rows, attributes) {
  return [...rows.join("")].map((cell) => attributes[cell] ?? 0);
}

/**
 * @param {Uint8Array} map
 * @param {number} cols
 * @returns {string[]} one string per row, '.' unmarked and '#' marked
 */
function picture(map, cols) {
  const rows = [];
  for (let i = 0; i < map.length; i += cols) {
    rows.push(
      Array.from(map.slice(i, i + cols))
        .map((cell) => (cell ? "#" : "."))
        .join(""),
    );
  }
  return rows;
}

const UNPROTECTED = 0xc0;
const PROTECTED = 0xf0;
const PASSWORD = 0xcd;

test("cells after an unprotected attribute are typeable, and the attribute itself never is", () => {
  const fa = screen(["p....u...p", "p........."], {
    p: PROTECTED,
    u: PASSWORD,
  });
  assert.deepEqual(picture(fieldMap(fa).editable, 10), [
    "......###.",
    "..........",
  ]);
});

test("a field runs past the end of a row and the last field on the screen wraps round to the first", () => {
  const fa = screen([".....", ".p...", "...u."], {
    p: PROTECTED,
    u: UNPROTECTED,
  });
  assert.deepEqual(picture(fieldMap(fa).editable, 5), [
    "#####",
    "#....",
    "....#",
  ]);
});

test("an unformatted screen has no fields, so nothing is marked typeable", () => {
  const map = fieldMap(new Uint8Array(8));
  assert.equal(map.formatted, false);
  assert.equal(map.editable.some(Boolean), false);
  assert.equal(map.hidden.some(Boolean), false);
});

test("a non-display field (the 0x0c intensity bits set) is marked hidden, an ordinary one is not", () => {
  const fa = screen(["h..u.."], { h: PASSWORD, u: UNPROTECTED });
  assert.deepEqual(picture(fieldMap(fa).hidden, 6), [".##..."]);
});
