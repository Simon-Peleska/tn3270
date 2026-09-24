import test from "node:test";
import assert from "node:assert/strict";
import { MacrosPage } from "../public/macros.js";
import { KeymapPage } from "../public/keymap-page.js";
import { commandForEvent, mapKey } from "../public/keymap.js";
import { THEMES } from "../public/settings.js";
import { key, enterKey, defaultKeymapDeps, typeCommand } from "./keyevent.js";

/** @typedef {import('../public/macro-xml.js').Macro} Macro */

/** @param {string[]} [files] */
function fixture(files = []) {
  const calls = {
    /** @type {number} */ redraws: 0,
    /** @type {import('../server/protocol.js').ClientMessage[]} */ dispatched:
      [],
    /** @type {number} */ ends: 0,
    /** @type {string[]} */ went: [],
    /** @type {import('../public/macro-xml.js').Macro[][]} */ saved: [],
    /** @type {{ filename: string, content: string }[]} */ exported: [],
    /** @type {{ code: string, message: string }[]} */ errors: [],
    /** @type {number} */ unlockWaits: 0,
    /** @type {import('../public/keymap.js').Bindings[]} */ keymaps: [],
  };
  /** @type {Macro[]} */
  const macroList = [];
  // The real keymap, since that is where a macro's key is kept.
  const keymap = new KeymapPage({
    ...defaultKeymapDeps,
    redraw: () => {},
    end: () => {},
    go: () => {},
    persist: (bindings) => calls.keymaps.push(bindings),
    exportFile: () => {},
    importFiles: async () => [],
    error: () => {},
    macroNames: () => macroList.map((macro) => macro.name),
  });
  /** @type {(() => void)[]} */
  const pendingUnlocks = [];
  const page = new MacrosPage({
    ...defaultKeymapDeps,
    redraw: () => {
      calls.redraws += 1;
    },
    theme: () => THEMES[0],
    dispatch: (message) => calls.dispatched.push(message),
    paste: (text) =>
      calls.dispatched.push({ type: "paste", text, segments: [] }),
    waitForUnlock: () => {
      calls.unlockWaits += 1;
      return new Promise((resolve) => pendingUnlocks.push(resolve));
    },
    end: () => {
      calls.ends += 1;
    },
    go: (id) => calls.went.push(id),
    persist: (values) => calls.saved.push(values),
    exportFile: (filename, content) =>
      calls.exported.push({ filename, content }),
    importFiles: () => Promise.resolve(files),
    error: (code, message) => calls.errors.push({ code, message }),
    keyCommand: (event) => commandForEvent(event, keymap.lookup()),
    keyName: (commandId) => keymap.labelFor(commandId),
    setKey: (commandId, combo) => keymap.setKey(commandId, combo),
    renameKey: (from, to) => keymap.renameCommand(from, to),
  });
  page.macros = macroList;
  return { page, calls, pendingUnlocks, keymap };
}

test("opening draws the panel, and F3 closes it and asks for the screen back", () => {
  const { page, calls } = fixture();

  page.show();
  assert.equal(page.open, true);
  assert.ok(calls.redraws > 0, "the panel must have asked to be drawn");

  assert.equal(page.handleKey(key({ key: "F3" })), true);
  assert.equal(page.open, false);
  assert.equal(calls.ends, 1);
});

test("a macro is numbered, and typing its number on the command line plays it", () => {
  const { page } = fixture();
  const macro = {
    name: "Second",
    steps: [{ text: "go", action: "Enter", args: [] }],
  };
  page.macros.push({ name: "First", steps: [] }, macro);
  page.show();

  assert.deepEqual(
    page.lines().map((line) => line.option),
    [undefined, "1", "2"],
  );

  for (const char of "2") page.handleKey(key({ key: char }));
  page.handleKey(enterKey());
  assert.equal(page.playing?.macro, macro);
});

test("a closed page consumes nothing", () => {
  const { page } = fixture();
  assert.equal(page.handleKey(key({ key: "a", code: "KeyA" })), false);
});

test("an open page swallows keys so the host is not typed at through it", () => {
  const { page } = fixture();
  page.show();
  assert.equal(page.handleKey(key({ key: "x", code: "KeyX" })), true);
  // ...except the browser's own shortcuts.
  assert.equal(
    page.handleKey(key({ key: "r", code: "KeyR", ctrlKey: true })),
    false,
  );
});

test("recording captures typed text and actions, ignoring anything else sent while it runs", () => {
  const { page } = fixture();
  page.startRecording();
  assert.equal(page.isRecording(), true);
  assert.equal(
    page.open,
    false,
    "starting a recording drops the page so the host is visible",
  );

  page.record({ type: "text", value: "A" });
  page.record({ type: "text", value: "B" });
  page.record({ type: "action", action: "Tab", args: [] });
  page.record({ type: "paste", text: "pasted", segments: [] });
  page.record({ type: "action", action: "Enter", args: [] });
  page.record({ type: "connect", host: null });

  page.stopRecording();
  assert.equal(page.isRecording(), false);
  assert.deepEqual(
    page.naming?.kind === "save" ? page.naming.steps : undefined,
    [
      { text: "AB", action: "Tab", args: [] },
      { text: "pasted", action: "Enter", args: [] },
    ],
  );
});

test("a leftover run of typed text with no trailing action becomes its own final step", () => {
  const { page } = fixture();
  page.startRecording();
  page.record({ type: "text", value: "hi" });
  page.stopRecording();
  assert.deepEqual(
    page.naming?.kind === "save" ? page.naming.steps : undefined,
    [{ text: "hi", action: "", args: [] }],
  );
});

test("stopping a recording asks for a name, and enter saves it", () => {
  const { page, calls } = fixture();
  page.startRecording();
  page.record({ type: "action", action: "Enter", args: [] });
  page.show(); // reopen the page to reach the control row and stop it
  page.handleKey(enterKey()); // stop, via the control row
  assert.equal(page.naming?.kind, "save");

  const defaultLength = page.nameBuffer.length;
  for (let i = 0; i < defaultLength; i++)
    page.handleKey(key({ key: "Backspace" }));
  for (const char of "My Macro") page.handleKey(key({ key: char }));
  page.handleKey(enterKey());

  assert.equal(page.macros.length, 1);
  assert.equal(page.macros[0]?.name, "My Macro");
  assert.deepEqual(calls.saved.at(-1), page.macros);
});

test("escape while naming a fresh recording discards it, not the whole panel", () => {
  const { page } = fixture();
  page.startRecording();
  page.stopRecording();
  page.show();
  page.handleKey(key({ key: "Escape" }));
  assert.equal(page.naming, null);
  assert.equal(page.open, true, "only the naming step was cancelled");
});

test("a blank name is refused, leaving the page waiting for a real one", () => {
  const { page } = fixture();
  page.startRecording();
  page.stopRecording();
  page.nameBuffer = "";
  page.show();
  page.handleKey(enterKey());
  assert.equal(page.naming !== null, true, "nothing was saved");
});

test("a duplicate name is disambiguated automatically", () => {
  const { page } = fixture();
  page.macros.push({ name: "Logon", steps: [] });
  page.startRecording();
  page.stopRecording();
  page.nameBuffer = "Logon";
  page.confirmName();
  assert.equal(page.macros[1]?.name, "Logon (2)");
});

test("renaming an existing macro updates it in place", () => {
  const { page, calls } = fixture();
  page.macros.push({ name: "Old", steps: [] });
  page.show();
  page.selected = 1;
  for (const char of "ren") page.handleKey(key({ key: char }));
  page.handleKey(enterKey());
  assert.deepEqual(page.naming, { kind: "rename", index: 0 });

  page.handleKey(key({ key: "Backspace" }));
  page.handleKey(key({ key: "Backspace" }));
  page.handleKey(key({ key: "Backspace" }));
  for (const char of "New") page.handleKey(key({ key: char }));
  page.handleKey(enterKey());

  assert.equal(page.macros[0]?.name, "New");
  assert.equal(page.naming, null);
  assert.deepEqual(calls.saved.at(-1), page.macros);
});

test("renaming a macro to its own name is not treated as a collision with itself", () => {
  const { page } = fixture();
  page.macros.push({ name: "Keep", steps: [] });
  page.naming = { kind: "rename", index: 0 };
  page.nameBuffer = "Keep";
  page.confirmName();
  assert.equal(page.macros[0]?.name, "Keep");
});

test("deleting a macro removes it and persists, adjusting marks past it", () => {
  const { page, calls } = fixture();
  page.macros.push(
    { name: "A", steps: [] },
    { name: "B", steps: [] },
    { name: "C", steps: [] },
  );
  page.marked.add(2);
  page.show();
  page.onCommand = false;
  page.selected = 1; // "A"
  page.handleKey(key({ key: "Delete" }));

  assert.deepEqual(
    page.macros.map((m) => m.name),
    ["B", "C"],
  );
  assert.deepEqual(
    [...page.marked],
    [1],
    "the mark on the old index 2 moved down with it",
  );
  assert.deepEqual(calls.saved.at(-1), page.macros);
});

test("a slash marks a macro for export without disturbing others", () => {
  const { page } = fixture();
  page.macros.push({ name: "A", steps: [] }, { name: "B", steps: [] });
  page.show();
  page.onCommand = false;
  page.selected = 1;
  page.handleKey(key({ key: "/" }));
  assert.deepEqual([...page.marked], [0]);
  assert.match(
    page.lines()[1]?.text ?? "",
    /^\/ A/,
    "the mark is shown against the line",
  );
  page.handleKey(key({ key: "/" }));
  assert.deepEqual([...page.marked], []);
});

test("exporting with nothing marked exports the macro under the cursor", () => {
  const { page, calls } = fixture();
  page.macros.push({
    name: "Solo",
    steps: [{ text: "x", action: "Enter", args: [] }],
  });
  page.show();
  page.selected = 1;
  for (const char of "export") page.handleKey(key({ key: char }));
  page.handleKey(enterKey());

  assert.equal(calls.exported.length, 1);
  assert.equal(calls.exported[0]?.filename, "Solo.xml");
  assert.match(calls.exported[0]?.content ?? "", /<HAScript name="Solo"/);
});

test("exporting several marked macros produces one file with all of them", () => {
  const { page, calls } = fixture();
  page.macros.push({ name: "A", steps: [] }, { name: "B", steps: [] });
  page.marked.add(0);
  page.marked.add(1);
  page.show();
  for (const char of "export") page.handleKey(key({ key: char }));
  page.handleKey(enterKey());

  assert.equal(calls.exported.length, 1);
  assert.equal(calls.exported[0]?.filename, "macros.xml");
  assert.match(calls.exported[0]?.content ?? "", /<Macros>/);
  assert.equal(page.marked.size, 0, "the marks are cleared once exported");
});

test("importing adds macros from every picked file and renames collisions", async () => {
  const file1 =
    '<HAScript name="Logon"><screen><actions><input value="x[enter]"/></actions></screen></HAScript>';
  const file2 =
    '<HAScript name="Other"><screen><actions></actions></screen></HAScript>';
  const { page, calls } = fixture([file1, file2]);
  page.macros.push({ name: "Logon", steps: [] });
  page.show();

  await page.importMacros();

  assert.deepEqual(
    page.macros.map((m) => m.name),
    ["Logon", "Logon (2)", "Other"],
  );
  assert.deepEqual(calls.saved.at(-1), page.macros);
});

test("importing with the file picker cancelled changes nothing", async () => {
  const { page, calls } = fixture([]);
  await page.importMacros();
  assert.equal(page.macros.length, 0);
  assert.equal(calls.saved.length, 0);
});

test("playing a macro dispatches each step and waits for the keyboard to unlock between actions", async () => {
  const { page, calls, pendingUnlocks } = fixture();
  const macro = {
    name: "Two steps",
    steps: [
      { text: "hello", action: "Enter", args: [] },
      { text: "world", action: "Tab", args: [] },
    ],
  };
  page.macros.push(macro);
  page.show();

  const played = page.play(macro);
  assert.equal(page.playing?.macro, macro);

  await Promise.resolve();
  assert.deepEqual(calls.dispatched, [
    { type: "paste", text: "hello", segments: [] },
    { type: "action", action: "Enter", args: [] },
  ]);
  assert.equal(calls.unlockWaits, 1);

  pendingUnlocks[0]?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.dispatched, [
    { type: "paste", text: "hello", segments: [] },
    { type: "action", action: "Enter", args: [] },
    { type: "paste", text: "world", segments: [] },
    { type: "action", action: "Tab", args: [] },
  ]);

  pendingUnlocks[1]?.();
  await played;
  assert.equal(page.playing, null);
});

test("stopping playback ends it before the remaining steps go out", async () => {
  const { page, calls, pendingUnlocks } = fixture();
  const macro = {
    name: "Stoppable",
    steps: [
      { text: "", action: "Enter", args: [] },
      { text: "", action: "PF", args: ["3"] },
    ],
  };
  const played = page.play(macro);
  await Promise.resolve();

  page.stopPlayback();
  pendingUnlocks[0]?.();
  await played;

  assert.deepEqual(calls.dispatched, [
    { type: "action", action: "Enter", args: [] },
  ]);
  assert.equal(page.playing, null);
});

test("activating the control row while playing stops it instead of starting a recording", async () => {
  const { page, pendingUnlocks } = fixture();
  const macro = {
    name: "M",
    steps: [
      { text: "", action: "Enter", args: [] },
      { text: "", action: "Tab", args: [] },
    ],
  };
  const played = page.play(macro);
  await Promise.resolve();

  page.selected = 0;
  page.activate();
  assert.equal(page.playing?.active, false);

  pendingUnlocks[0]?.();
  await played;
  assert.equal(
    page.isRecording(),
    false,
    "stopping playback must not fall through to starting a recording",
  );
});

test("enter on a macro row closes the page and plays it", async () => {
  const { page, calls } = fixture();
  const macro = {
    name: "Solo",
    steps: [{ text: "go", action: "Enter", args: [] }],
  };
  page.macros.push(macro);
  page.show();
  page.selected = 1;
  page.handleKey(enterKey());

  assert.equal(page.open, false);
  assert.equal(page.playing?.macro, macro);
  await Promise.resolve();
  assert.deepEqual(calls.dispatched[0], {
    type: "paste",
    text: "go",
    segments: [],
  });
});

test("KEY on a macro binds the next key pressed in the keymap, where the screen finds it", () => {
  const { page, calls, keymap } = fixture();
  page.macros.push({ name: "Logon", steps: [] });
  page.show();
  page.selected = 1;

  typeCommand(page, "key");
  assert.match(page.lines()[1]?.value ?? "", /press a key/);
  page.handleKey(key({ key: "Control", code: "ControlLeft", ctrlKey: true }));
  assert.equal(page.listening, 0, "Ctrl alone is only on the way to the key");
  const ctrl1 = key({ key: "1", code: "Digit1", ctrlKey: true });
  page.handleKey(ctrl1);

  assert.deepEqual(
    calls.keymaps.at(-1)?.["Macro:Logon"],
    [{ key: "1", shift: false, ctrl: true, alt: false }],
    "the key is saved with the keymap",
  );
  assert.match(page.lines()[1]?.value ?? "", /Ctrl\+1/);
  assert.match(page.message, /Ctrl\+1 plays Logon/);
  assert.deepEqual(mapKey(ctrl1, keymap.lookup()), {
    kind: "client",
    command: "Macro:Logon",
  });
  assert.ok(
    keymap.lines().some((line) => line.text === "Macro Logon"),
    "the Keys panel lists it with the other commands",
  );
});

test("a macro's key is taken from whatever had it, the way the Keys panel takes one", () => {
  const { page, keymap } = fixture();
  page.macros.push({ name: "First", steps: [] }, { name: "Second", steps: [] });
  page.show();
  const f3 = key({ key: "F3" });

  page.selected = 1;
  typeCommand(page, "key");
  page.handleKey(f3);
  assert.equal(commandForEvent(f3, keymap.lookup()), "Macro:First");
  assert.deepEqual(keymap.combosFor("PF3"), [], "PF3 gave its key up");

  page.selected = 2;
  typeCommand(page, "key");
  page.handleKey(f3);
  assert.equal(commandForEvent(f3, keymap.lookup()), "Macro:Second");

  typeCommand(page, "unkey");
  assert.equal(commandForEvent(f3, keymap.lookup()), null);
});

test("a renamed macro keeps its key, and a deleted one gives it back", () => {
  const { page, keymap } = fixture();
  page.macros.push({ name: "Old", steps: [] });
  page.show();
  const f5 = key({ key: "F5", shiftKey: true });
  page.selected = 1;
  typeCommand(page, "key");
  page.handleKey(f5);

  page.selected = 1;
  typeCommand(page, "ren");
  for (let step = 0; step < 3; step++)
    page.handleKey(key({ key: "Backspace" }));
  for (const char of "New") page.handleKey(key({ key: char }));
  page.handleKey(enterKey());
  assert.equal(commandForEvent(f5, keymap.lookup()), "Macro:New");

  page.selected = 1;
  typeCommand(page, "del");
  assert.equal(commandForEvent(f5, keymap.lookup()), null);
  assert.equal(keymap.bindings["Macro:New"], undefined);
});

test("KEY can give a macro right Ctrl alone, let go without another key", () => {
  const { page, calls } = fixture();
  page.macros.push({ name: "Logon", steps: [] });
  page.show();
  page.selected = 1;

  typeCommand(page, "key");
  page.handleKey(key({ key: "Control", code: "ControlRight", ctrlKey: true }));
  assert.equal(page.listening, 0);
  page.released(key({ key: "Control", code: "ControlRight" }));

  assert.equal(page.listening, null);
  assert.deepEqual(calls.keymaps.at(-1)?.["Macro:Logon"], [
    { key: "ControlRight", shift: false, ctrl: true, alt: false },
  ]);
});

test("Escape while listening for a key binds nothing", () => {
  const { page } = fixture();
  /** @type {Macro} */
  const macro = { name: "Logon", steps: [] };
  page.macros.push(macro);
  page.show();
  page.selected = 1;

  typeCommand(page, "key");
  page.handleKey(key({ key: "Escape" }));
  assert.equal(page.listening, null);
  assert.equal(page.deps.keyName("Macro:Logon"), "");
  assert.equal(page.open, true, "Escape leaves the listening, not the panel");
});
