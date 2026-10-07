import test from "node:test";
import assert from "node:assert/strict";
import { renderOia, cursorPosition } from "../public/oia.js";

/**
 * @param {Partial<import('../public/oia.js').OiaState>} fields
 * @returns {import('../public/oia.js').OiaState}
 */
function state(fields) {
  return {
    connection: "not-connected",
    connected: false,
    host: null,
    lock: "unlocked",
    insert: false,
    typeahead: false,
    ...fields,
  };
}

test("the OIA line is exactly as wide as it was given and shows the lock", () => {
  const text = renderOia(state({ lock: "system" }), { row: 4, col: 9 }, 80);

  assert.equal(text.length, 80);
  assert.ok(
    text.includes("X SYSTEM"),
    `expected a lock indicator in ${JSON.stringify(text)}`,
  );
  assert.ok(
    text.trimEnd().endsWith("05/010"),
    `expected the cursor position in ${JSON.stringify(text)}`,
  );
});

test("the cursor position can be placed after the buttons", () => {
  const cursor = { row: 4, col: 9 };
  const left = renderOia(state({ insert: true }), null, 24);
  const position = cursorPosition(cursor);
  assert.equal(left.length, 24);
  assert.match(left, /Insert/);
  assert.doesNotMatch(left, /05\/010/);
  assert.equal(position, "05/010");
});

test("a lock b3270 has no wording for still shows as one", () => {
  const text = renderOia(
    state({ lock: "something-new" }),
    { row: 0, col: 0 },
    80,
  );
  assert.ok(text.includes("X something-new"));
});

test("the line stays inside its width however full it is", () => {
  const text = renderOia(
    state({
      connection: "connected-tn3270e",
      connected: true,
      host: "a-very-long-hostname.example.com:992",
      lock: "system",
      insert: true,
      typeahead: true,
    }),
    { row: 23, col: 79 },
    61,
  );

  // The caller deducted the buttons' columns; overrunning would draw over them.
  assert.equal(text.length, 61);
  assert.ok(text.includes("Insert"));
  assert.ok(text.trimEnd().endsWith("24/080"));
});

test("a width with no room left for a line is no line", () => {
  assert.equal(renderOia(state({}), { row: 0, col: 0 }, 0), "");
});
