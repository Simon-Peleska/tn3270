import test from "node:test";
import assert from "node:assert/strict";
import {
  mapKey,
  buildLookup,
  withDefaults,
  DEFAULT_BINDINGS,
} from "../public/keymap.js";
import { key } from "./keyevent.js";

const lookup = buildLookup(DEFAULT_BINDINGS);

test("the 3270 key positions are kept: right Ctrl is Enter, Enter is New line", () => {
  assert.deepEqual(
    mapKey(
      key({ key: "Control", code: "ControlRight", ctrlKey: true }),
      lookup,
    ),
    {
      kind: "action",
      action: "Enter",
      args: [],
    },
  );
  assert.deepEqual(mapKey(key({ key: "Enter", code: "Enter" }), lookup), {
    kind: "action",
    action: "Newline",
    args: [],
  });
});

test("Ctrl-Enter and Fn-Enter, which arrives as the keypad Enter, are Enter too", () => {
  const enter = { kind: "action", action: "Enter", args: [] };
  assert.deepEqual(
    mapKey(key({ key: "Enter", code: "Enter", ctrlKey: true }), lookup),
    enter,
  );
  assert.deepEqual(
    mapKey(key({ key: "Enter", code: "NumpadEnter" }), lookup),
    enter,
  );
});

test("holding the Enter key down does not machine-gun the host", () => {
  assert.equal(
    mapKey(
      key({
        key: "Control",
        code: "ControlRight",
        ctrlKey: true,
        repeat: true,
      }),
      lookup,
    ),
    null,
  );
});

test("a held-down PF or PA key pages on, marked as a repeat for the server to pace", () => {
  assert.deepEqual(
    mapKey(key({ key: "F8", code: "F8", repeat: true }), lookup),
    { kind: "action", action: "PF", args: ["8"], repeat: true },
  );
  assert.deepEqual(
    mapKey(
      key({ key: "Insert", code: "Insert", altKey: true, repeat: true }),
      lookup,
    ),
    { kind: "action", action: "PA", args: ["1"], repeat: true },
  );
});

test("holding down Attn or Clear is dropped the same way, but ordinary keys still repeat", () => {
  assert.equal(
    mapKey(key({ key: "Escape", code: "Escape", repeat: true }), lookup),
    null,
  );
  assert.equal(
    mapKey(key({ key: "Pause", code: "Pause", repeat: true }), lookup),
    null,
  );

  assert.deepEqual(mapKey(key({ key: "Escape", code: "Escape" }), lookup), {
    kind: "action",
    action: "Attn",
    args: [],
  });

  // Movement and editing keys are not AIDs, so key repeat must keep working.
  assert.deepEqual(
    mapKey(
      key({ key: "ArrowRight", code: "ArrowRight", repeat: true }),
      lookup,
    ),
    {
      kind: "action",
      action: "Right",
      args: [],
    },
  );
});

test("plain Ctrl combinations nothing binds are left to the browser", () => {
  assert.equal(
    mapKey(key({ key: "a", code: "KeyA", ctrlKey: true }), lookup),
    null,
  );
});

test("Ctrl-C and Ctrl-Insert are the Copy command, not a 3270 action", () => {
  assert.deepEqual(
    mapKey(key({ key: "c", code: "KeyC", ctrlKey: true }), lookup),
    { kind: "client", command: "Copy" },
  );
  assert.deepEqual(
    mapKey(key({ key: "Insert", code: "Insert", ctrlKey: true }), lookup),
    { kind: "client", command: "Copy" },
  );
});

test("a binding follows the character printed on the key, not its place on the board", () => {
  // QWERTZ: the key marked Z sits where a US layout keeps Y, so it reports KeyY.
  assert.deepEqual(
    mapKey(key({ key: "z", code: "KeyY", ctrlKey: true }), lookup),
    { kind: "action", action: "Undo", args: [] },
  );
  // And the key marked Y, in the US Z position, is not it.
  assert.equal(
    mapKey(key({ key: "y", code: "KeyZ", ctrlKey: true }), lookup),
    null,
  );
});

test("a key with no character of its own is known by its place, which every layout shares", () => {
  const board = buildLookup({
    ...DEFAULT_BINDINGS,
    Dup: [{ key: "F13", shift: false, ctrl: false, alt: false }],
  });
  assert.deepEqual(mapKey(key({ key: "F13", code: "F13" }), board), {
    kind: "action",
    action: "Dup",
    args: [],
  });
  // A Cyrillic layout prints no Latin letter anywhere, so Ctrl+Z stays put.
  assert.equal(
    mapKey(key({ key: "я", code: "KeyZ", ctrlKey: true }), lookup),
    null,
  );
});

test("a punctuation binding is the key that prints it, wherever the layout puts it", () => {
  // ? is Shift+ß on a German board and Shift+/ on a US one; both are the ? key.
  const bound = buildLookup({
    ...DEFAULT_BINDINGS,
    Dup: [{ key: "?", shift: true, ctrl: true, alt: false }],
    FieldMark: [{ key: "*", shift: false, ctrl: true, alt: false }],
  });
  const dup = { kind: "action", action: "Dup", args: [] };
  assert.deepEqual(
    mapKey(
      key({ key: "?", code: "Minus", shiftKey: true, ctrlKey: true }),
      bound,
    ),
    dup,
    "German: Shift+ß",
  );
  assert.deepEqual(
    mapKey(
      key({ key: "?", code: "Slash", shiftKey: true, ctrlKey: true }),
      bound,
    ),
    dup,
    "US: Shift+/",
  );
  // The numeric keypad prints * without Shift, wherever it is.
  assert.deepEqual(
    mapKey(key({ key: "*", code: "NumpadMultiply", ctrlKey: true }), bound),
    { kind: "action", action: "FieldMark", args: [] },
  );
});

test("function keys are PF keys, shifted ones are the high twelve", () => {
  assert.deepEqual(mapKey(key({ key: "F3", code: "F3" }), lookup), {
    kind: "action",
    action: "PF",
    args: ["3"],
  });
  assert.deepEqual(
    mapKey(key({ key: "F3", code: "F3", shiftKey: true }), lookup),
    {
      kind: "action",
      action: "PF",
      args: ["15"],
    },
  );
});

test("Escape is Attn, Shift-Escape is SysReq, PCOMM-style", () => {
  assert.deepEqual(mapKey(key({ key: "Escape", code: "Escape" }), lookup), {
    kind: "action",
    action: "Attn",
    args: [],
  });
  assert.deepEqual(
    mapKey(key({ key: "Escape", code: "Escape", shiftKey: true }), lookup),
    {
      kind: "action",
      action: "SysReq",
      args: [],
    },
  );
});

test("Pause is Clear and Caps Lock is Reset, PCOMM-style", () => {
  assert.deepEqual(mapKey(key({ key: "Pause", code: "Pause" }), lookup), {
    kind: "action",
    action: "Clear",
    args: [],
  });
  assert.deepEqual(mapKey(key({ key: "CapsLock", code: "CapsLock" }), lookup), {
    kind: "action",
    action: "Reset",
    args: [],
  });
});

test("End is EraseEOF, Alt-End is EraseInput", () => {
  assert.deepEqual(mapKey(key({ key: "End", code: "End" }), lookup), {
    kind: "action",
    action: "EraseEOF",
    args: [],
  });
  assert.deepEqual(
    mapKey(key({ key: "End", code: "End", altKey: true }), lookup),
    {
      kind: "action",
      action: "EraseInput",
      args: [],
    },
  );
});

test("Insert and Home carry PA1/PA2 on Alt, and Shift-Insert pastes instead of Dup", () => {
  assert.deepEqual(mapKey(key({ key: "Insert", code: "Insert" }), lookup), {
    kind: "action",
    action: "ToggleInsert",
    args: [],
  });
  assert.deepEqual(
    mapKey(key({ key: "Insert", code: "Insert", shiftKey: true }), lookup),
    { kind: "client", command: "Paste" },
  );
  assert.deepEqual(
    mapKey(key({ key: "Insert", code: "Insert", altKey: true }), lookup),
    { kind: "action", action: "PA", args: ["1"] },
  );

  assert.deepEqual(mapKey(key({ key: "Home", code: "Home" }), lookup), {
    kind: "action",
    action: "Home",
    args: [],
  });
  assert.deepEqual(
    mapKey(key({ key: "Home", code: "Home", shiftKey: true }), lookup),
    {
      kind: "action",
      action: "FieldMark",
      args: [],
    },
  );
  assert.deepEqual(
    mapKey(key({ key: "Home", code: "Home", altKey: true }), lookup),
    { kind: "action", action: "PA", args: ["2"] },
  );
});

test("Shift-PageUp is PA3, plain PageUp is unbound", () => {
  assert.deepEqual(
    mapKey(key({ key: "PageUp", code: "PageUp", shiftKey: true }), lookup),
    { kind: "action", action: "PA", args: ["3"] },
  );
  assert.equal(mapKey(key({ key: "PageUp", code: "PageUp" }), lookup), null);
});

test("a printable key is text and Alt is otherwise left to the page", () => {
  assert.deepEqual(mapKey(key({ key: "x", code: "KeyX" }), lookup), {
    kind: "text",
    value: "x",
  });
  // Opening a panel is a command like any other, so the keymap claims it.
  assert.deepEqual(
    mapKey(key({ key: " ", code: "Space", altKey: true }), lookup),
    { kind: "client", command: "Menu" },
  );
  // An Alt combo nothing binds still belongs to the browser.
  assert.equal(
    mapKey(key({ key: "x", code: "KeyX", altKey: true }), lookup),
    null,
  );
});

test("AltGr characters are text on Windows, which reports AltGr as Ctrl+Alt", () => {
  for (const [character, code] of [
    ["\\", "Minus"],
    ["{", "Digit7"],
    ["[", "Digit8"],
    ["]", "Digit9"],
    ["}", "Digit0"],
    ["@", "KeyQ"],
    ["~", "BracketRight"],
    ["|", "IntlBackslash"],
  ]) {
    const altGr = key({
      key: character,
      code,
      ctrlKey: true,
      altKey: true,
      altGraph: true,
    });
    assert.deepEqual(mapKey(altGr, lookup), { kind: "text", value: character });
  }
  // A real Ctrl+Alt combo, with no AltGr about it, is still the browser's.
  assert.equal(
    mapKey(
      key({ key: "x", code: "KeyX", ctrlKey: true, altKey: true }),
      lookup,
    ),
    null,
  );
});

test("a binding can be removed even with none left for its command", () => {
  const empty = buildLookup({ ...DEFAULT_BINDINGS, Attn: [] });
  assert.equal(mapKey(key({ key: "Escape", code: "Escape" }), empty), null);
});

test("a keymap saved before a command existed still gets that command's default binding", () => {
  // A saved keymap is the whole map, so a command added later is missing from it.
  const { BackNewline: _omitted, ...older } = DEFAULT_BINDINGS;
  const filled = buildLookup(withDefaults(older));
  assert.deepEqual(
    mapKey(key({ key: "Enter", code: "Enter", shiftKey: true }), filled),
    {
      kind: "action",
      action: "BackNewline",
      args: [],
    },
  );
});

test("filling in defaults leaves a deliberate unbinding, and a key the operator gave to something else, alone", () => {
  const { BackNewline: _omitted, ...older } = DEFAULT_BINDINGS;

  // An empty list is an unbinding, not an absence: it must survive.
  const unbound = buildLookup(withDefaults({ ...older, Attn: [] }));
  assert.equal(mapKey(key({ key: "Escape", code: "Escape" }), unbound), null);

  // Shift-Enter already belongs to Clear, so BackNewline's default cannot take it back.
  const rebound = buildLookup(
    withDefaults({
      ...older,
      Clear: [
        ...DEFAULT_BINDINGS.Clear,
        { key: "Enter", shift: true, ctrl: false, alt: false },
      ],
    }),
  );
  assert.deepEqual(
    mapKey(key({ key: "Enter", code: "Enter", shiftKey: true }), rebound),
    {
      kind: "action",
      action: "Clear",
      args: [],
    },
  );
});

test("an empty saved keymap is simply the defaults", () => {
  assert.deepEqual(withDefaults({}), DEFAULT_BINDINGS);
});

test("a keymap saved when keys went by position still works: letters, digits and Space carry over", () => {
  const stored = /** @type {any} */ ({
    Dup: [{ code: "KeyD", shift: false, ctrl: true, alt: false }],
    FieldMark: [{ code: "Digit7", shift: false, ctrl: true, alt: false }],
    DeleteWord: [{ code: "Space", shift: false, ctrl: true, alt: false }],
    Attn: [{ code: "Escape", shift: false, ctrl: false, alt: false }],
  });
  const filled = withDefaults(stored);
  assert.deepEqual(filled.Dup, [
    { key: "D", shift: false, ctrl: true, alt: false },
  ]);
  assert.deepEqual(filled.FieldMark, [
    { key: "7", shift: false, ctrl: true, alt: false },
  ]);
  assert.deepEqual(filled.DeleteWord, [
    { key: " ", shift: false, ctrl: true, alt: false },
  ]);
  // A key that never had a character keeps its name, so it keeps working.
  assert.deepEqual(filled.Attn, [
    { key: "Escape", shift: false, ctrl: false, alt: false },
  ]);

  const board = buildLookup(filled);
  assert.deepEqual(
    mapKey(key({ key: "d", code: "KeyD", ctrlKey: true }), board),
    {
      kind: "action",
      action: "Dup",
      args: [],
    },
  );
});

test("rebinding a combo to a new command steals it from whatever had it, at the lookup level", () => {
  // Removing a combo from its old command is the keymap page's job, not buildLookup's.
  const moved = buildLookup({
    ...DEFAULT_BINDINGS,
    Attn: [],
    Clear: [
      ...DEFAULT_BINDINGS.Clear,
      { key: "Escape", shift: false, ctrl: false, alt: false },
    ],
  });
  assert.deepEqual(mapKey(key({ key: "Escape", code: "Escape" }), moved), {
    kind: "action",
    action: "Clear",
    args: [],
  });
});
