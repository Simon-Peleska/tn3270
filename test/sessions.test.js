import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SESSIONS,
  paneBox,
  paneShares,
  parseSessionHash,
  sessionHash,
  sessionKey,
} from "../public/sessions.js";
import { key } from "./keyevent.js";

test("Ctrl and a digit puts the keyboard on that session", () => {
  assert.deepEqual(
    sessionKey(key({ key: "1", code: "Digit1", ctrlKey: true })),
    {
      action: "switch",
      index: 0,
    },
  );
  assert.deepEqual(
    sessionKey(key({ key: "4", code: "Digit4", ctrlKey: true })),
    {
      action: "switch",
      index: 3,
    },
  );
});

test("Ctrl+Shift and a digit splits the page into that many panes", () => {
  assert.deepEqual(
    sessionKey(
      key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }),
    ),
    { action: "layout", panes: 1 },
  );
  // Shift-2 prints " on a German keyboard and @ on a US one, so the digit comes from the code.
  assert.deepEqual(
    sessionKey(
      key({ key: '"', code: "Digit2", ctrlKey: true, shiftKey: true }),
    ),
    { action: "layout", panes: 2 },
  );
  assert.deepEqual(
    sessionKey(
      key({ key: "$", code: "Digit4", ctrlKey: true, shiftKey: true }),
    ),
    { action: "layout", panes: 4 },
  );
});

test("anything else is left to the keymap", () => {
  for (const pressed of [
    { key: "1", code: "Digit1" },
    { key: "1", code: "Digit1", ctrlKey: true, altKey: true },
    { key: "1", code: "Digit1", ctrlKey: true, metaKey: true },
    { key: "0", code: "Digit0", ctrlKey: true },
    {
      key: String(MAX_SESSIONS + 1),
      code: `Digit${MAX_SESSIONS + 1}`,
      ctrlKey: true,
    },
    { key: "1", code: "Numpad1", ctrlKey: true },
    { key: "b", code: "KeyB", ctrlKey: true },
  ])
    assert.equal(sessionKey(key(pressed)), null, JSON.stringify(pressed));
});

test("each layout covers the whole page and no pane overlaps another", () => {
  for (let count = 1; count <= 4; count++) {
    const shares = paneShares(count);
    assert.equal(shares.length, count);

    const area = shares.reduce((sum, s) => sum + s.width * s.height, 0);
    assert.equal(area, 1, `${count} panes should tile the page exactly`);

    for (const [index, a] of shares.entries())
      for (const b of shares.slice(index + 1))
        assert.ok(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
          `${count} panes: ${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`,
        );
  }

  assert.deepEqual([...paneShares(1)], [{ x: 0, y: 0, width: 1, height: 1 }]);

  // Three is one full-height pane on the left and two stacked on the right.
  const three = paneShares(3);
  assert.deepEqual(three[0], { x: 0, y: 0, width: 0.5, height: 1 });
  assert.deepEqual(three[1], { x: 0.5, y: 0, width: 0.5, height: 0.5 });
  assert.deepEqual(three[2], { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });

  // Four is quarters: 1 and 2 on the left, 3 and 4 on the right.
  const four = paneShares(4);
  assert.deepEqual(
    four.map((s) => [s.x, s.y]),
    [
      [0, 0],
      [0, 0.5],
      [0.5, 0],
      [0.5, 0.5],
    ],
  );
});

test("a pane's box is its share of the page in whole pixels", () => {
  assert.deepEqual(paneBox(paneShares(4)[3], { width: 1001, height: 601 }), {
    x: 501,
    y: 301,
    width: 501,
    height: 301,
  });
});

test("the fragment keeps every session in the slot its digit points at", () => {
  assert.deepEqual(parseSessionHash("#one,,three"), [
    "one",
    null,
    "three",
    null,
  ]);
  assert.deepEqual(parseSessionHash("one"), ["one", null, null, null]);
  assert.deepEqual(parseSessionHash(""), [null, null, null, null]);

  assert.equal(sessionHash(["one", null, "three", null]), "one,,three");
  assert.equal(sessionHash(["one", null, null, null]), "one");
  assert.equal(sessionHash([null, null, null, null]), "");

  // An empty slot has to survive the round trip, or the panes shift left.
  const ids = ["a", null, "c", null];
  assert.deepEqual(parseSessionHash(sessionHash(ids)), ids);
});
