import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SESSIONS,
  SessionPrefix,
  paneShares,
  parseSessionHash,
  sessionHash,
  switcherText,
} from "../public/sessions.js";
import { key } from "./keyevent.js";

test("Ctrl-B and a digit picks a session", () => {
  const prefix = new SessionPrefix();

  assert.deepEqual(prefix.handleKey(key({ key: "b", ctrlKey: true })), {
    action: "arm",
  });
  assert.equal(prefix.armed, true);
  assert.deepEqual(prefix.handleKey(key({ key: "2" })), {
    action: "switch",
    index: 1,
  });
  assert.equal(prefix.armed, false);

  assert.deepEqual(prefix.handleKey(key({ key: "2" })), { action: "ignore" });
});

test("the digit counts whether or not Ctrl is still held", () => {
  const prefix = new SessionPrefix();
  prefix.handleKey(key({ key: "b", ctrlKey: true }));

  // Ctrl going down on the way to the digit is a keystroke of its own.
  assert.deepEqual(prefix.handleKey(key({ key: "Control", ctrlKey: true })), {
    action: "ignore",
  });
  assert.equal(prefix.armed, true);
  assert.deepEqual(prefix.handleKey(key({ key: "1", ctrlKey: true })), {
    action: "switch",
    index: 0,
  });
});

test("anything that is not a session number cancels instead of reaching the host", () => {
  const prefix = new SessionPrefix();

  for (const pressed of [
    "x",
    "Escape",
    "0",
    String(MAX_SESSIONS + 1),
    "Enter",
  ]) {
    prefix.handleKey(key({ key: "b", ctrlKey: true }));
    assert.deepEqual(
      prefix.handleKey(key({ key: pressed })),
      { action: "cancel" },
      pressed,
    );
    assert.equal(prefix.armed, false, pressed);
  }
});

test("a letter matching an offered hint picks it instead of cancelling", () => {
  const prefix = new SessionPrefix();
  prefix.handleKey(key({ key: "b", ctrlKey: true }));
  assert.deepEqual(prefix.handleKey(key({ key: "n" }), ["n", "e"]), {
    action: "hint",
    letter: "n",
  });

  prefix.handleKey(key({ key: "b", ctrlKey: true }));
  assert.deepEqual(prefix.handleKey(key({ key: "n" })), { action: "cancel" });
});

test("the prefix is Ctrl-B alone", () => {
  const prefix = new SessionPrefix();

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

test("a shifted digit lays the screen out instead of switching to a session", () => {
  const prefix = new SessionPrefix();

  prefix.handleKey(key({ key: "b", ctrlKey: true }));
  assert.deepEqual(
    prefix.handleKey(key({ key: "!", code: "Digit1", shiftKey: true })),
    { action: "layout", panes: 1 },
  );
  prefix.handleKey(key({ key: "b", ctrlKey: true }));
  assert.deepEqual(
    prefix.handleKey(key({ key: "$", code: "Digit4", shiftKey: true })),
    { action: "layout", panes: 4 },
  );

  // Shift-2 prints " on a German keyboard and @ on a US one, so the digit comes from the code.
  prefix.handleKey(key({ key: "b", ctrlKey: true }));
  assert.deepEqual(
    prefix.handleKey(key({ key: '"', code: "Digit2", shiftKey: true })),
    { action: "layout", panes: 2 },
  );

  prefix.handleKey(key({ key: "b", ctrlKey: true }));
  assert.deepEqual(
    prefix.handleKey(key({ key: "X", code: "KeyX", shiftKey: true })),
    { action: "cancel" },
  );
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

test("the switcher shows which session is on screen and which digits are free", () => {
  const text = switcherText(["a", null, "c", null], 2);
  assert.match(text, /Ctrl-B/);
  assert.match(text, / 1 /);
  assert.match(text, / 2\+/);
  assert.match(text, /\[3\]/);
  assert.match(text, / 4\+/);
});
