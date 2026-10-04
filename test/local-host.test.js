import test from "node:test";
import assert from "node:assert/strict";
import { LocalHost } from "../public/local-host.js";
import { Grid } from "../public/grid.js";

/**
 * A two-field form, the way a host application would lay one out.
 *
 * @param {string} [cursor]
 */
function form(cursor) {
  /** @type {{ aid: string, values: Record<string, string> }[]} */
  const aids = [];
  const host = new LocalHost({
    screen: () => ({
      texts: [{ row: 0, col: 0, text: "Name", fg: "green" }],
      fields: [
        { name: "name", row: 0, col: 5, width: 4, value: "" },
        { name: "town", row: 2, col: 5, width: 6, value: "Bonn" },
      ],
      cursor,
    }),
    aid: (aid, values) => aids.push({ aid, values }),
  });
  return { host, aids };
}

/**
 * @param {LocalHost} host
 * @returns {Grid}
 */
function painted(host) {
  const grid = new Grid(24, 80, null);
  grid.applyPaint(host.paint(24, 80));
  return grid;
}

test("typing fills the field the cursor is in, and Enter hands every field's value over", () => {
  const { host, aids } = form();
  host.receive({ type: "text", value: "Ann" });
  host.receive({ type: "action", action: "Enter", args: [] });
  assert.deepEqual(aids, [
    { aid: "Enter", values: { name: "Ann", town: "Bonn" } },
  ]);
});

test("a full field skips on to the next one, as a 3270 does", () => {
  const { host, aids } = form();
  host.receive({ type: "text", value: "AnnaK" });
  host.receive({ type: "action", action: "PF", args: ["3"] });
  assert.deepEqual(aids, [
    { aid: "PF3", values: { name: "Anna", town: "Konn" } },
  ]);
});

test("insert mode pushes the rest along, and refuses a key when the field is full", () => {
  const { host, aids } = form("town");
  host.receive({ type: "action", action: "ToggleInsert", args: [] });
  host.receive({ type: "text", value: "Xy" });
  assert.equal(host.insert, true);
  host.receive({ type: "text", value: "z" });
  host.receive({ type: "action", action: "Enter", args: [] });
  assert.equal(aids[0]?.values["town"], "XyBonn");
});

test("the cursor starts where the screen asks, and goes back there after an AID", () => {
  const { host } = form("town");
  host.paint(24, 80);
  assert.deepEqual(host.cursor, { row: 2, col: 5 });
  host.receive({ type: "action", action: "Tab", args: [] });
  assert.deepEqual(host.cursor, { row: 0, col: 5 });
  host.receive({ type: "action", action: "Enter", args: [] });
  host.paint(24, 80);
  assert.deepEqual(host.cursor, { row: 2, col: 5 });
});

test("Tab and BackTab walk the fields, wrapping round the screen", () => {
  const { host } = form();
  host.paint(24, 80);
  host.receive({ type: "action", action: "Tab", args: [] });
  assert.deepEqual(host.cursor, { row: 2, col: 5 });
  host.receive({ type: "action", action: "Tab", args: [] });
  assert.deepEqual(host.cursor, { row: 0, col: 5 });
  host.receive({ type: "action", action: "BackTab", args: [] });
  assert.deepEqual(host.cursor, { row: 2, col: 5 });
});

test("Tab and BackTab use screen position, not field declaration order", () => {
  const host = new LocalHost({
    screen: () => ({
      texts: [],
      fields: [
        { name: "last", row: 2, col: 5, width: 2, value: "" },
        { name: "right", row: 1, col: 20, width: 2, value: "" },
        { name: "first", row: 0, col: 10, width: 2, value: "" },
        { name: "left", row: 1, col: 5, width: 2, value: "" },
      ],
      cursor: "first",
    }),
    aid: () => {},
  });
  host.paint(24, 80);

  for (const cursor of [
    { row: 1, col: 5 },
    { row: 1, col: 20 },
    { row: 2, col: 5 },
    { row: 0, col: 10 },
  ]) {
    host.receive({ type: "action", action: "Tab", args: [] });
    assert.deepEqual(host.cursor, cursor);
  }
  host.receive({ type: "action", action: "BackTab", args: [] });
  assert.deepEqual(host.cursor, { row: 2, col: 5 });
});

test("the editing keys change only the field under the cursor", () => {
  const { host, aids } = form("town");
  host.receive({ type: "action", action: "Right", args: [] });
  host.receive({ type: "action", action: "Right", args: [] });
  host.receive({ type: "action", action: "EraseEOF", args: [] });
  host.receive({ type: "action", action: "Backspace", args: [] });
  host.receive({ type: "text", value: "x" });
  host.receive({ type: "action", action: "Enter", args: [] });
  assert.deepEqual(aids[0]?.values, { name: "", town: "Bx" });
});

test("the word keys jump between words, and on to the next field past the last one", () => {
  const host = new LocalHost({
    screen: () => ({
      texts: [],
      fields: [
        { name: "words", row: 0, col: 0, width: 10, value: "ab  cd" },
        { name: "next", row: 2, col: 0, width: 4, value: "" },
      ],
      cursor: "words",
    }),
    aid: () => {},
  });
  /** @param {string} action */
  const press = (action) => host.receive({ type: "action", action, args: [] });

  press("NextWord");
  assert.deepEqual(host.cursor, { row: 0, col: 4 });
  press("NextWord");
  assert.deepEqual(host.cursor, { row: 2, col: 0 });
  press("PreviousWord");
  assert.deepEqual(host.cursor, { row: 0, col: 0 });
  press("Right");
  press("Right");
  press("Right");
  press("Right");
  press("Right");
  press("PreviousWord");
  assert.deepEqual(host.cursor, { row: 0, col: 4 });
  press("PreviousWord");
  assert.deepEqual(host.cursor, { row: 0, col: 0 });
});

test("End of field goes just past the last character typed, or to the last cell of a full field", () => {
  const { host } = form("town");
  host.receive({ type: "action", action: "FieldEnd", args: [] });
  assert.deepEqual(host.cursor, { row: 2, col: 9 });
  host.receive({ type: "text", value: "er" });
  host.receive({ type: "action", action: "Home", args: [] });
  host.receive({ type: "action", action: "Tab", args: [] });
  host.receive({ type: "action", action: "FieldEnd", args: [] });
  assert.deepEqual(host.cursor, { row: 2, col: 10 });
  host.receive({ type: "action", action: "FieldStart", args: [] });
  assert.deepEqual(host.cursor, { row: 2, col: 5 });
});

test("Erase input blanks every field and goes to the first", () => {
  const { host, aids } = form("town");
  host.receive({ type: "text", value: "Ann" });
  host.receive({ type: "action", action: "EraseInput", args: [] });
  host.receive({ type: "action", action: "Enter", args: [] });
  assert.deepEqual(aids[0]?.values, { name: "", town: "" });
});

test("a paste is split against the form's fields, a line per row", () => {
  const { host, aids } = form();
  host.receive({ type: "paste", text: "Al\n\nKöln" });
  host.receive({ type: "action", action: "Enter", args: [] });
  assert.deepEqual(aids[0]?.values, { name: "Al", town: "Köln" });
});

test("a click moves the cursor, and typing off any field goes nowhere", () => {
  const { host, aids } = form();
  host.receive({ type: "action", action: "MoveCursor1", args: ["2", "1"] });
  assert.deepEqual(host.cursor, { row: 1, col: 0 });
  host.receive({ type: "text", value: "lost" });
  host.receive({ type: "action", action: "Enter", args: [] });
  assert.deepEqual(aids[0]?.values, { name: "", town: "Bonn" });
});

test("the paint covers every cell, so nothing underneath shows through", () => {
  const { host } = form();
  const grid = painted(host);
  assert.ok(grid.cells.every((cell) => cell.ch !== null));
  assert.equal(grid.rowText(0).slice(0, 9), "Name     ");
  assert.equal(grid.cellAt(0, 5)?.editable, true);
  assert.equal(grid.cellAt(0, 4)?.editable, false);
  assert.equal(grid.fieldText(2, 5), "Bonn");
  assert.deepEqual(grid.cursor, { row: 0, col: 5, visible: true });
});
