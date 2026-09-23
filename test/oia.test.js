import test from "node:test";
import assert from "node:assert/strict";
import { renderOia, keyboardLocked } from "../public/oia.js";
import { OiaModel } from "../server/oia.js";

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

test("the browser and the server read a lock word the same way", () => {
  // Macro playback waits on the browser's answer; the session decides what it
  // will accept on the server's. They have to be the same answer.
  const model = new OiaModel();
  for (const lock of [
    "",
    "unlocked",
    "system",
    "not-connected",
    "something-new",
  ]) {
    model.lock = lock;
    assert.equal(keyboardLocked(lock), model.keyboardLocked, lock);
  }
});

test("a width with no room left for a line is no line", () => {
  assert.equal(renderOia(state({}), { row: 0, col: 0 }, 0), "");
});
