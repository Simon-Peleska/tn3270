import test from "node:test";
import assert from "node:assert/strict";
import { Panels } from "../public/panels.js";
import { Settings } from "../public/settings.js";
import { Macros } from "../public/macros.js";
import { Recorder } from "../public/recorder.js";
import { Grid } from "../public/grid.js";
import { Keymap } from "../public/keymap.js";
import { keyAt, placeKeys } from "../public/screen-keyboard.js";
import { adminLayout } from "../public/panel-admin.js";

/**
 * The real panels over the real state, with only the page's side recorded:
 * what would reach the canvas, the server and the browser's storage.
 */
function fixture() {
  let codePage = "bracket";
  const calls = {
    /** @type {string[]} */ themes: [],
    /** @type {string[]} */ fonts: [],
    /** @type {boolean[]} */ fieldBackgrounds: [],
    /** @type {number[]} */ models: [],
    /** @type {string[]} */ oversizes: [],
    /** @type {(string | null)[]} */ hosts: [],
    /** @type {Partial<import('../public/store.js').StoredSettings>[]} */ saved:
      [],
    /** @type {import('../server/protocol.js').ClientMessage[]} */ sent: [],
    /** @type {string[]} */ exported: [],
    imports: 0,
    /** @type {string[]} */ joined: [],
    /** @type {string[]} */ joinedForEdit: [],
    /** @type {Set<string>} */ owners: new Set(),
    /** @type {string[]} */ terminated: [],
    /** @type {string[]} */ characters: [],
    /** @type {import('../public/recorder.js').Recording[][]} */ savedRecordings:
      [],
  };
  const settings = new Settings((values) => calls.saved.push(values));
  settings.models = [
    { model: 2, rows: 24, columns: 80 },
    { model: 3, rows: 32, columns: 80 },
    { model: 4, rows: 43, columns: 80 },
    { model: 5, rows: 27, columns: 132 },
  ];
  settings.connected = true;
  const keymap = new Keymap(() => {});
  const macros = new Macros({
    dispatch: (message) => calls.sent.push(message),
    paste: (text) => calls.sent.push({ type: "paste", text, segments: [] }),
    waitForUnlock: () => Promise.resolve(),
    persist: () => {},
    keymap,
    redraw: () => {},
  });
  const recorder = new Recorder({
    dispatch: (message) => calls.sent.push(message),
    exportFile: (filename) => calls.exported.push(filename),
    persist: (values) => calls.savedRecordings.push(structuredClone(values)),
  });
  /** @type {Panels | null} */
  let panelInstance = null;
  const panels = new Panels({
    settings,
    codePage: () => codePage,
    keymap,
    macros,
    recorder,
    redraw: () => {},
    applyTheme: (theme) => calls.themes.push(theme.name),
    applyFont: (font) => calls.fonts.push(font.name),
    applyFieldBackground: (on) => calls.fieldBackgrounds.push(on),
    applyModel: (model) => calls.models.push(model),
    applyOversize: (value) => calls.oversizes.push(value),
    windowFit: (fontSize) => ({
      cols: Math.floor(1600 / (fontSize * 0.6)),
      rows: Math.floor(1000 / (fontSize * 1.2)) - 1,
    }),
    connect: (host) => calls.hosts.push(host),
    importRecording: () => {
      calls.imports += 1;
    },
    listSessions: async () => [
      {
        id: "12345678-0000-0000-0000-000000000000",
        startedBy: "alice",
        startedAt: "2026-09-26T10:00:00.000Z",
      },
    ],
    joinSession: (id, requestEdit = false) =>
      (requestEdit ? calls.joinedForEdit : calls.joined).push(id),
    ownsSession: (id) => calls.owners.has(id),
    terminateSession: async (id) => {
      calls.terminated.push(id);
    },
    insertCharacter: (character) => {
      calls.characters.push(character);
      if (panelInstance?.isOpen())
        panelInstance.receive({ type: "text", value: character });
    },
  });
  panelInstance = panels;
  return {
    panels,
    calls,
    settings,
    keymap,
    macros,
    recorder,
    setCodePage: (/** @type {string} */ value) => {
      codePage = value;
    },
  };
}

/**
 * What the operator sees: the paint, applied to an overlay the way app.js does.
 *
 * @param {Panels} panels
 * @returns {string[]} one string per row
 */
function screenOf(panels) {
  const grid = new Grid(24, 80, null);
  grid.applyPaint(panels.paint(24, 80));
  return Array.from({ length: 24 }, (_, row) => grid.rowText(row));
}

/**
 * @param {Panels} panels
 * @param {string} action
 * @param {string[]} [args]
 */
function press(panels, action, args = []) {
  panels.receive({ type: "action", action, args });
}

/**
 * @param {Panels} panels
 * @param {string} text
 */
function type(panels, text) {
  panels.receive({ type: "text", value: text });
}

/**
 * @param {Panels} panels
 * @param {string} text
 */
function command(panels, text) {
  press(panels, "MoveCursor1", ["2", "14"]);
  press(panels, "Home");
  type(panels, text);
  press(panels, "Enter");
}

/**
 * Type a letter in the one-cell field before the line that starts with `label`.
 *
 * @param {Panels} panels
 * @param {string} label
 * @param {string} letter
 */
function onLine(panels, label, letter) {
  const row = screenOf(panels).findIndex(
    (line, index) => index > 2 && line.slice(3).startsWith(label),
  );
  assert.notEqual(row, -1, `no line reads ${label}`);
  press(panels, "MoveCursor1", [String(row + 1), "2"]);
  type(panels, letter);
}

test("settings renders its commands and opens each dialog", () => {
  const { panels, macros } = fixture();
  macros.macros.push({
    name: "Hello",
    steps: [{ text: "h", action: "", args: [] }],
  });
  panels.open("settings");
  const shown = screenOf(panels);
  assert.match(shown[0], /TN3270 Settings/);
  assert.match(shown[1], /Command ===>/);
  assert.match(shown[3], /1\. Theme/);
  assert.match(shown[4], /2\. Screen size/);
  assert.match(shown[5], /3\. Font/);
  assert.match(shown[6], /4\. Keys/);
  assert.match(shown[7], /5\. Macros/);
  assert.match(shown[8], /6\. Recordings/);
  assert.match(shown[9], /7\. Sessions/);
  for (const [number, title] of [
    ["1", "Theme"],
    ["2", "Screen size"],
    ["3", "Font"],
    ["4", "Keys"],
    ["5", "Macros"],
    ["6", "Recordings"],
    ["7", "Sessions"],
  ]) {
    command(panels, number);
    assert.match(screenOf(panels)[0], new RegExp(`TN3270 ${title}`));
    press(panels, "PF", ["3"]);
  }
  press(panels, "PF", ["3"]);
  assert.equal(panels.isOpen(), false);
});

test("the on-screen keyboard's PF3 can leave a menu panel", () => {
  const { panels } = fixture();
  panels.open("menu");
  const key = placeKeys(80, 19).find((each) => each.label === "PF3");
  assert.ok(key);
  const clicked = keyAt(placeKeys(80, 19), key.row, key.col);
  assert.ok(clicked);
  panels.receive({
    type: "action",
    action: clicked.action,
    args: clicked.args,
  });
  assert.equal(panels.isOpen(), false);
});

test("the character picker uses the Font code-page chart and accepts a hex byte", () => {
  const { panels, calls } = fixture();
  panels.openChars();
  const shown = screenOf(panels);
  assert.match(shown[0], /TN3270 Characters/);
  assert.match(shown[1], /Code page: EBCDIC 037 \(bracket\)/);
  assert.equal(shown[12]?.[38], "A");
  press(panels, "MoveCursor1", ["2", "17"]);
  type(panels, "C1");
  press(panels, "Enter");
  assert.deepEqual(calls.characters, ["A"]);
  assert.equal(panels.isOpen(), false);
});

test("the character picker colors the second hex digit differently", () => {
  const { panels } = fixture();
  panels.openChars();
  const texts = panels.host.layout().texts;
  const colorAt = (/** @type {number} */ row, /** @type {number} */ col) =>
    texts.find((text) => text.row === row && text.col === col)?.fg;

  assert.equal(colorAt(7, 2), "turquoise");
  assert.equal(colorAt(7, 3), "yellow");
  assert.equal(colorAt(7, 4), "turquoise");
  assert.equal(colorAt(7, 6), "yellow");
  assert.equal(colorAt(4, 34), "turquoise");
  assert.equal(colorAt(3, 36), "yellow");

  press(panels, "MoveCursor1", ["2", "17"]);
  type(panels, "C1");
  const grid = new Grid(24, 80, null);
  grid.applyPaint(panels.paint(24, 80));
  assert.equal(grid.cellAt(1, 16)?.ch, "C");
  assert.equal(grid.cellAt(1, 16)?.fg, "turquoise");
  assert.equal(grid.cellAt(1, 17)?.ch, "1");
  assert.equal(grid.cellAt(1, 17)?.fg, "yellow");
  assert.equal(grid.cellAt(1, 17)?.editable, true);

  panels.open("font");
  assert.equal(
    panels.host.layout().texts.find((text) => text.row === 3 && text.col === 36)
      ?.fg,
    "turquoise",
  );
});

test("the character picker accepts cursor/Enter and direct mouse selection", () => {
  const { panels, calls } = fixture();
  panels.openChars();
  press(panels, "MoveCursor1", ["13", "39"]);
  press(panels, "Enter");
  assert.deepEqual(calls.characters, ["A"]);
  panels.openChars();
  assert.equal(panels.chooseCharacterAt(12, 40), true);
  assert.deepEqual(calls.characters, ["A", "B"]);
});

test("the character picker rejects invalid codes and keeps panel typing on return", () => {
  const { panels, calls } = fixture();
  panels.open("font");
  press(panels, "MoveCursor1", ["2", "12"]);
  type(panels, "Q");
  panels.openChars();
  type(panels, "ZZ");
  press(panels, "Enter");
  assert.match(screenOf(panels).join("\n"), /\[E5034\]/);
  assert.equal(panels.isCharacterPicker(), true);
  assert.equal(panels.chooseCharacterByte(0x3f), false);
  assert.match(screenOf(panels).join("\n"), /\[E5035\]/);
  assert.equal(panels.chooseCharacterAt(12, 38), true);
  assert.deepEqual(calls.characters, ["A"]);
  assert.equal(panels.stack.at(-1)?.id, "font");
  assert.equal(panels.host.typed.get("fontSize")?.join("").trim(), "QA");
});

test("the character picker rejects an unavailable code page and permits hex 40 space", () => {
  const { panels, calls, setCodePage } = fixture();
  setCodePage("cp999");
  panels.openChars();
  assert.match(screenOf(panels).join("\n"), /No single-byte chart/);
  assert.equal(panels.chooseCharacterByte(0xc1), false);
  assert.equal(panels.isCharacterPicker(), true);
  setCodePage("bracket");
  assert.equal(panels.chooseCharacterByte(0x40), true);
  assert.deepEqual(calls.characters, [" "]);
});

test("open sessions lists creator and start time, and J or E joins the selected session", async () => {
  const { panels, calls } = fixture();
  panels.open("menu");
  command(panels, "7");
  await panels.refreshAdmin();
  const shown = screenOf(panels);
  assert.match(shown[0], /TN3270 Sessions/);
  assert.match(shown[6], /alice \(12345678\)/);
  assert.match(shown[6], /2026/);
  onLine(panels, "alice", "j");
  press(panels, "Enter");
  assert.deepEqual(calls.joined, ["12345678-0000-0000-0000-000000000000"]);
  onLine(panels, "alice", "e");
  press(panels, "Enter");
  assert.deepEqual(calls.joinedForEdit, [
    "12345678-0000-0000-0000-000000000000",
  ]);
});

test("only the owner sees K=Kill, and it refreshes the session list", async () => {
  const { panels, calls } = fixture();
  const id = "12345678-0000-0000-0000-000000000000";
  panels.open("admin");
  await panels.refreshAdmin();

  const otherUser = adminLayout.items?.(panels, "admin")?.[0];
  assert.equal(otherUser?.k, undefined);
  assert.doesNotMatch(screenOf(panels)[3], /K=Kill/);

  calls.owners.add(id);
  const owner = adminLayout.items?.(panels, "admin")?.[0];
  const kill = owner?.k;
  assert.equal(typeof kill, "function");
  assert.match(screenOf(panels)[3], /K=Kill/);
  if (kill !== undefined) await kill();
  assert.deepEqual(calls.terminated, [id]);
  assert.match(screenOf(panels).join("\n"), /Session 12345678 terminated/);
});

test("a refused session termination shows its stable error code in the panel", async () => {
  const { panels } = fixture();
  panels.deps.terminateSession = async () => {
    throw new Error("[E3014] Only the session owner may terminate it");
  };
  panels.open("admin");
  await panels.terminateSession("12345678-0000-0000-0000-000000000000");
  assert.match(
    screenOf(panels).join("\n"),
    /\[E5039\] The session could not be terminated/,
  );
  assert.equal(panels.isOpen(), true);
});

test("R and an empty Host Enter refresh open sessions", async () => {
  const { panels } = fixture();
  let loads = 0;
  panels.deps.listSessions = async () => {
    loads += 1;
    return [];
  };
  panels.open("admin");
  const initial = loads;
  assert.match(screenOf(panels)[3], /R\/Enter=Refresh/);

  command(panels, "R");
  assert.equal(loads, initial + 1);
  const afterR = loads;

  press(panels, "Enter");
  assert.equal(loads, afterR + 1);
});

test("refreshing sessions does not draw the loading message over a session", async () => {
  const { panels } = fixture();
  panels.adminSessions = [
    {
      id: "12345678-0000-0000-0000-000000000000",
      startedBy: "alice",
      startedAt: "2026-09-26T10:00:00.000Z",
    },
  ];
  /** @type {(sessions: typeof panels.adminSessions) => void} */
  let finish = () => {};
  panels.deps.listSessions = () =>
    new Promise((resolve) => {
      finish = resolve;
    });

  panels.open("admin");

  assert.match(screenOf(panels)[6], /alice \(12345678\)/);
  assert.doesNotMatch(screenOf(panels)[6], /Loading sessions/);
  finish([]);
  await Promise.resolve();
});

test("open sessions shows a coded error in place when the list fails", async () => {
  const { panels } = fixture();
  panels.deps.listSessions = async () => {
    throw new Error("server offline");
  };
  panels.open("admin");
  await panels.refreshAdmin();
  assert.match(
    screenOf(panels).join("\n"),
    /\[E5032\] Open sessions could not be loaded/,
  );
  assert.equal(panels.isOpen(), true);
});

test("theme and font selections apply without leaving their lists", () => {
  const { panels, settings, calls } = fixture();
  panels.open("theme");
  assert.match(screenOf(panels)[1], /Field background/);
  assert.match(screenOf(panels)[5], /Host On-Demand \(Default\)/);
  onLine(panels, "Amber", "s");
  press(panels, "Enter");
  assert.equal(settings.values.theme, "Amber");
  assert.deepEqual(calls.themes, ["Amber"]);
  assert.match(screenOf(panels)[0], /TN3270 Theme/);
  panels.open("font");
  assert.match(screenOf(panels)[6], /Fira Mono \(Default\)/);
  onLine(panels, "IBM 3270", "s");
  press(panels, "Enter");
  assert.equal(settings.values.font, "IBM 3270");
  assert.deepEqual(calls.fonts, ["IBM 3270"]);
  assert.match(screenOf(panels)[0], /TN3270 Font/);
});

test("field hints point to the open panel's editable fields", () => {
  const { panels } = fixture();
  panels.open("theme");
  const hints = panels.hints(24, 80);
  const fields = panels
    .screen(24, 80)
    .fields.sort((a, b) => a.row - b.row || a.col - b.col);
  assert.equal(hints.length, fields.length);
  assert.deepEqual(
    hints.map(({ row, col }) => [row, col]),
    fields.map(({ row, col }) => [row, col]),
  );

  const target = hints.at(-1);
  assert.ok(target);
  panels.receive({
    type: "action",
    action: "MoveCursor1",
    args: [String(target.row + 1), String(target.col + 1)],
  });
  assert.deepEqual(panels.host.cursor, { row: target.row, col: target.col });
});

test("theme preview shows real host colors and graphic renditions", () => {
  const { panels } = fixture();
  panels.open("theme");
  const grid = new Grid(24, 80, null);
  grid.applyPaint(panels.paint(24, 80));

  /** @type {[number, number, string, string | null][]} */
  const renditions = [
    [6, 35, "Normal", null],
    [6, 42, "Intensified", "highlight"],
    [6, 54, "Underlined", "underline"],
    [6, 65, "Reverse", "reverse"],
  ];
  for (const [row, col, label, gr] of renditions) {
    assert.match(grid.rowText(row).slice(col), new RegExp(label));
    assert.equal(grid.cellAt(row, col)?.gr, gr);
  }
  assert.equal(grid.cellAt(8, 35)?.fg, "black");
  assert.equal(grid.cellAt(8, 46)?.fg, "red");
  assert.equal(grid.cellAt(7, 35)?.editable, true);
  assert.match(grid.rowText(5).slice(3, 30), /Host On-Demand/);
});

test("theme Tab moves from field background to the first theme", () => {
  const { panels } = fixture();
  panels.open("theme");
  panels.paint(24, 80);
  press(panels, "MoveCursor1", ["2", "19"]);
  press(panels, "Tab");
  assert.deepEqual(panels.host.cursor, { row: 5, col: 1 });
  for (let row = 6; row <= 7; row += 1) {
    press(panels, "Tab");
    assert.deepEqual(panels.host.cursor, { row, col: 1 });
  }
  press(panels, "Tab");
  assert.deepEqual(panels.host.cursor, { row: 7, col: 35 });
  press(panels, "Tab");
  assert.deepEqual(panels.host.cursor, { row: 8, col: 1 });
});

test("theme Enter moves from field background to the next editable row", () => {
  const { panels } = fixture();
  panels.open("theme");
  panels.paint(24, 80);
  press(panels, "MoveCursor1", ["2", "19"]);
  press(panels, "Newline");
  assert.deepEqual(panels.host.cursor, { row: 5, col: 1 });
  press(panels, "Newline");
  assert.deepEqual(panels.host.cursor, { row: 6, col: 1 });
  press(panels, "BackNewline");
  assert.deepEqual(panels.host.cursor, { row: 5, col: 1 });
});

test("font chart follows the active code page and marks unsupported pages", () => {
  const { panels, setCodePage } = fixture();
  panels.open("font");
  const glyphAt = (/** @type {number} */ row, /** @type {number} */ col) => {
    const grid = new Grid(24, 80, null);
    grid.applyPaint(panels.paint(24, 80));
    return grid.cellAt(row, col)?.ch;
  };

  assert.match(screenOf(panels)[1], /Code page: EBCDIC 037 \(bracket\)/);
  assert.equal(glyphAt(10, 62), "[");
  setCodePage("cp037");
  assert.equal(glyphAt(4, 42), "ä");
  setCodePage("cp273");
  assert.match(screenOf(panels)[1], /Code page: EBCDIC 273/);
  assert.equal(glyphAt(4, 42), "{");
  setCodePage("cp930");
  assert.match(screenOf(panels)[4], /No single-byte chart/);
});

test("font page toggles the maximum font size cap and rejects other answers", () => {
  const { panels, settings, calls } = fixture();
  panels.open("font");
  assert.match(screenOf(panels)[2], /Force max font size/);

  press(panels, "MoveCursor1", ["3", "22"]);
  type(panels, "Y");
  press(panels, "Enter");
  assert.equal(settings.values.forceMaxFontSize, true);
  assert.deepEqual(calls.saved.at(-1), { forceMaxFontSize: true });
  assert.deepEqual(calls.fonts, ["Fira Mono"]);

  press(panels, "MoveCursor1", ["3", "22"]);
  type(panels, "X");
  press(panels, "Enter");
  assert.equal(settings.values.forceMaxFontSize, true);
  assert.match(screenOf(panels)[21], /E5022/);
});

test("screen size selection applies and stays on its list", () => {
  const { panels, settings, calls } = fixture();
  panels.open("size");
  assert.match(screenOf(panels)[3], /Model 2 - 24x80/);
  onLine(panels, "Model 4", "s");
  press(panels, "Enter");
  assert.deepEqual(calls.models, [4]);
  assert.equal(settings.values.model, 4);
  assert.match(screenOf(panels)[0], /TN3270 Screen size/);
});

test("keys screen shows reset and can edit a command's bindings", () => {
  const { panels, keymap } = fixture();
  panels.open("keymap");
  assert.match(screenOf(panels)[3], /Reset all/);
  assert.match(screenOf(panels)[4], /Enter \(AID\)/);
  assert.match(
    screenOf(panels)[21] ?? "",
    /\w/,
    "the list runs on to the last row",
  );
  panels.message = "test message";
  assert.match(screenOf(panels)[22], /test message/);
  onLine(panels, "Enter (AID)", "e");
  press(panels, "Enter");
  assert.match(screenOf(panels)[0], /TN3270 Keys - Enter \(AID\)/);
  assert.match(screenOf(panels)[1], /A=Add E=Edit D=Delete/);
  assert.match(screenOf(panels)[6], /New keybind/);
  assert.equal(panels.height(), 18);
  onLine(panels, "NumEnter", "d");
  press(panels, "Enter");
  assert.equal(keymap.combosFor("Enter").length, 2);
});

test("the New keybind line opens a capture field", () => {
  const { panels, keymap } = fixture();
  panels.open("keys:Enter");
  onLine(panels, "New keybind", "a");
  press(panels, "Enter");
  assert.equal(panels.capturing(), true);
  panels.capture({ key: "F6", ctrl: true, shift: false, alt: false });
  press(panels, "Enter");
  assert.equal(keymap.lookup().get("C:F6"), "Enter");
});

test("A on a key command opens an empty binding ready for capture", () => {
  const { panels, keymap } = fixture();
  panels.open("keymap");
  onLine(panels, "Enter (AID)", "a");
  press(panels, "Enter");
  assert.equal(panels.capturing(), true);
  panels.capture({ key: "F5", ctrl: true, shift: false, alt: false });
  press(panels, "Enter");
  assert.equal(keymap.lookup().get("C:F5"), "Enter");
});

test("with no macros or steps yet, Macros opens straight into capturing the first step", () => {
  const { panels, macros } = fixture();
  panels.open("settings");
  command(panels, "5");
  assert.equal(panels.isMacroEditor(), true);
  assert.deepEqual(macros.macros, [{ name: "Macro 1", steps: [] }]);
  assert.equal(panels.capturingMacro(), true);

  panels.captureMacro({ kind: "text", value: "x" });
  panels.exitMacroCapture();
  press(panels, "PF", ["3"]);
  assert.match(screenOf(panels)[0], /TN3270 Macros/);
  assert.match(screenOf(panels)[4], /Macro 1.*X/);

  command(panels, "N");
  assert.equal(panels.capturingMacro(), true);
  assert.equal(macros.macros.length, 2);
});

test("S or a macro's number closes the panels and plays it", async () => {
  const { panels, macros, calls } = fixture();
  macros.macros.push(
    { name: "One", steps: [{ text: "a", action: "Enter", args: [] }] },
    { name: "Two", steps: [{ text: "b", action: "", args: [] }] },
  );
  panels.open("macros");
  assert.equal(
    panels.host.fieldAtCursor(panels.host.layout().fields)?.name,
    "command",
  );
  command(panels, "3");
  assert.match(screenOf(panels)[21], /E5041/);
  assert.equal(panels.isOpen(), true);

  command(panels, "2");
  assert.equal(panels.isOpen(), false);
  await Promise.resolve();
  assert.deepEqual(calls.sent, [{ type: "paste", text: "b", segments: [] }]);

  panels.open("macros");
  onLine(panels, "1. One", "s");
  press(panels, "Enter");
  assert.equal(panels.isOpen(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.sent.slice(1), [
    { type: "paste", text: "a", segments: [] },
    { type: "action", action: "Enter", args: [] },
  ]);
});

test("a macro is not run while another is still playing", () => {
  const { panels, macros } = fixture();
  macros.macros.push({
    name: "One",
    steps: [{ text: "a", action: "", args: [] }],
  });
  macros.playing = { macro: macros.macros[0], active: true };
  panels.open("macros");
  command(panels, "1");
  assert.equal(panels.isOpen(), true);
  assert.match(screenOf(panels)[21], /E5042/);
});

test("macros and recordings have separate list actions", () => {
  const { panels, macros, recorder, calls } = fixture();
  macros.macros.push({
    name: "Hello",
    steps: [{ text: "hi", action: "Enter", args: [] }],
  });
  panels.open("macros");
  assert.match(
    screenOf(panels)[2],
    /S=Run N=New R=Rename E=Edit K=Edit Keybind D=Delete/,
  );
  assert.match(screenOf(panels)[4], /1\. Hello.*H, I, ENTER/);
  onLine(panels, "1. Hello", "r");
  press(panels, "Enter");
  assert.match(screenOf(panels)[4], /1\. Hello.*Hello/);
  recorder.start();
  recorder.record({
    screen: [],
    cursor: { row: 0, col: 0 },
    action: "Enter",
    args: [],
  });
  recorder.stop();
  panels.open("recorder");
  assert.match(
    screenOf(panels)[2],
    /P=Play E=Export I=Import R=Rename M=Create Macro D=Delete/,
  );
  assert.match(screenOf(panels)[4], /Recording 1.*1 Steps/);
  onLine(panels, "Recording 1", "e");
  press(panels, "Enter");
  assert.equal(calls.exported.length, 1);
});

test("renaming and deleting recordings persist the changed list", () => {
  const { panels, recorder, calls } = fixture();
  recorder.recordings.push({
    name: "Saved",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: [],
  });
  panels.open("recorder");
  onLine(panels, "Saved", "r");
  press(panels, "Enter");
  const field = panels
    .screen(24, 80)
    .fields.find((item) => item.name.startsWith("edit:"));
  assert.ok(field);
  press(panels, "MoveCursor1", [String(field.row + 1), String(field.col + 1)]);
  press(panels, "DeleteField");
  type(panels, "Renamed");
  press(panels, "Enter");
  assert.equal(calls.savedRecordings.at(-1)?.[0]?.name, "Renamed");

  onLine(panels, "Renamed", "d");
  press(panels, "Enter");
  assert.deepEqual(calls.savedRecordings.at(-1), []);
});

test("the Recordings panel opens the Import file picker with I", () => {
  const { panels, calls } = fixture();
  panels.open("recorder");
  assert.match(screenOf(panels)[2], /E=Export I=Import/);
  command(panels, "I");
  assert.equal(calls.imports, 1);
});

test("a recording becomes one macro step per typed character or host action", () => {
  const { panels, recorder, macros } = fixture();
  recorder.recordings.push({
    name: "Typed",
    recordedAt: "2026-09-26T00:00:00.000Z",
    steps: [
      {
        screen: [],
        cursor: { row: 0, col: 0 },
        action: "String",
        args: ["ab"],
      },
      {
        screen: [],
        cursor: { row: 0, col: 2 },
        action: "MoveCursor1",
        args: ["5", "12"],
      },
    ],
  });
  panels.open("recorder");
  onLine(panels, "Typed", "m");
  press(panels, "Enter");
  assert.deepEqual(macros.pending, [
    { text: "a", action: "", args: [] },
    { text: "b", action: "", args: [] },
    { text: "", action: "MoveCursor1", args: ["5", "12"] },
  ]);
});

test("macro steps are protected until a side selection starts capture", () => {
  const { panels, macros } = fixture();
  macros.macros.push({
    name: "Login",
    steps: [
      { text: "l", action: "", args: [] },
      { text: "", action: "PF", args: ["3"] },
    ],
  });
  panels.open("macro:Login");
  assert.deepEqual(
    panels.screen(24, 80).fields.map((field) => field.name),
    ["command", "line:0", "line:1", "line:new"],
  );
  assert.match(screenOf(panels)[4], /Step 1.*l/);
  assert.match(screenOf(panels)[5], /Step 2.*PF3/);
  onLine(panels, "Step 1", "e");
  press(panels, "Enter");
  assert.equal(panels.capturingMacro(), true);
  const fields = panels.screen(24, 80).fields;
  assert.deepEqual(
    fields.map((field) => [field.name, field.row, field.value]),
    [
      ["edit:0", 4, "l"],
      ["edit:1", 5, "PF3"],
    ],
  );
  assert.equal(
    panels.screen(24, 80).fields.filter((field) => field.row === 4).length,
    1,
  );
  assert.equal(
    panels.screen(24, 80).fields.filter((field) => field.row === 5).length,
    1,
  );
  panels.exitMacroCapture();
  assert.deepEqual(
    panels.screen(24, 80).fields.map((field) => field.name),
    ["command", "line:0", "line:1", "line:new"],
  );
  onLine(panels, "New step", "e");
  press(panels, "Enter");
  assert.equal(panels.capturingMacro(), false);
  assert.equal(
    panels.screen(24, 80).fields.some((field) => field.name === "edit:new"),
    false,
  );
});

test("macro capture records one key per step and advances to the next field", () => {
  const { panels, macros } = fixture();
  macros.macros.push({ name: "Keys", steps: [] });
  panels.open("macro:Keys");
  panels.paint(24, 80);
  assert.equal(panels.capturingMacro(), true);
  assert.equal(macros.macros[0].steps.length, 0);

  panels.captureMacro({ kind: "text", value: "c" });
  assert.deepEqual(macros.macros[0].steps, [
    { text: "c", action: "", args: [] },
  ]);
  assert.equal(
    panels.host.fieldAtCursor(panels.host.layout().fields)?.name,
    "edit:insert",
  );

  panels.captureMacro({ kind: "action", action: "Tab", args: [] });
  assert.deepEqual(macros.macros[0].steps[1], {
    text: "",
    action: "Tab",
    args: [],
  });

  panels.exitMacroCapture();
  assert.equal(panels.capturingMacro(), false);
  assert.equal(
    panels.host.fieldAtCursor(panels.host.layout().fields)?.name,
    "command",
  );
  type(panels, "C");
  press(panels, "Enter");
  assert.equal(panels.pickingMacroCursor(), true);
  press(panels, "Enter");
  assert.match(screenOf(panels)[21], /E5023/);

  type(panels, "12");
  press(panels, "Tab");
  type(panels, "5");
  press(panels, "Enter");
  assert.equal(panels.isMacroEditor(), true);
  assert.deepEqual(macros.macros[0].steps[2], {
    text: "",
    action: "MoveCursor1",
    args: ["5", "12"],
  });
  assert.equal(panels.capturingMacro(), false);
  assert.deepEqual(
    panels.screen(24, 80).fields.map((field) => field.name),
    ["command", "line:0", "line:1", "line:2", "line:new"],
  );
  command(panels, "C");
  panels.addMacroCursorMove(7, 9);
  assert.deepEqual(macros.macros[0].steps[3], {
    text: "",
    action: "MoveCursor1",
    args: ["8", "10"],
  });
});

test("editing a macro step inserts later keys before the following steps", () => {
  const { panels, macros } = fixture();
  macros.macros.push({
    name: "Middle",
    steps: [..."abc"].map((text) => ({ text, action: "", args: [] })),
  });
  panels.open("macro:Middle");
  onLine(panels, "Step 1", "e");
  press(panels, "Enter");

  panels.captureMacro({ kind: "text", value: "X" });
  assert.deepEqual(
    macros.macros[0].steps.map((step) => step.text),
    ["X", "b", "c"],
  );
  assert.equal(
    panels.host.fieldAtCursor(panels.host.layout().fields)?.name,
    "edit:insert",
  );
  panels.captureMacro({ kind: "text", value: "Y" });
  assert.deepEqual(
    macros.macros[0].steps.map((step) => step.text),
    ["X", "Y", "b", "c"],
  );

  panels.exitMacroCapture();
  onLine(panels, "Step 3", "a");
  press(panels, "Enter");
  assert.equal(panels.capturingMacro(), true);
  panels.captureMacro({ kind: "text", value: "Q" });
  assert.deepEqual(
    macros.macros[0].steps.map((step) => step.text),
    ["X", "Y", "b", "Q", "c"],
  );

  panels.exitMacroCapture();
  onLine(panels, "Step 3", "c");
  press(panels, "Enter");
  assert.equal(panels.pickingMacroCursor(), true);
  panels.addMacroCursorMove(4, 8);
  assert.deepEqual(
    macros.macros[0].steps.map((step) => [step.text, step.action, step.args]),
    [
      ["X", "", []],
      ["Y", "", []],
      ["b", "", []],
      ["", "MoveCursor1", ["5", "9"]],
      ["Q", "", []],
      ["c", "", []],
    ],
  );
});

test("D deletes a macro step without changing the other steps", () => {
  const { panels, macros } = fixture();
  macros.macros.push({
    name: "Delete step",
    steps: [..."abc"].map((text) => ({ text, action: "", args: [] })),
  });
  panels.open("macro:Delete step");

  onLine(panels, "Step 2", "d");
  press(panels, "Enter");
  assert.deepEqual(
    macros.macros[0].steps.map((step) => step.text),
    ["a", "c"],
  );
  assert.equal(
    panels.host.fieldAtCursor(panels.host.layout().fields)?.name,
    "line:1",
  );

  onLine(panels, "Step 2", "d");
  press(panels, "Enter");
  assert.deepEqual(
    macros.macros[0].steps.map((step) => step.text),
    ["a"],
  );
});

test("recording playback shows one recorded screen per timed step and never sends actions", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { panels, recorder, calls } = fixture();
  recorder.recordings.push({
    name: "Demo",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: ["first", "second", "third"].map((line, row) => ({
      screen: [line],
      cursor: { row: 0, col: row },
      action: "Enter",
      args: [],
    })),
  });
  panels.open("recorder");
  onLine(panels, "Demo", "p");
  press(panels, "Enter");
  assert.equal(panels.isRecordingPlayback(), true);
  assert.match(screenOf(panels)[19], /Demo {2}Playing {2}5\.00 steps\/s/);
  assert.match(screenOf(panels)[20], /^Enter/);
  assert.match(screenOf(panels)[21], /Enter=Pause\/Play/);
  panels.playbackKey("F2");
  assert.match(screenOf(panels)[0], /^first/);
  assert.deepEqual(panels.paint(24, 80).cursor, { row: 0, col: 0, on: true });

  t.mock.timers.tick(1000);
  assert.match(screenOf(panels)[0], /^second/);
  assert.deepEqual(panels.paint(24, 80).cursor, { row: 0, col: 1, on: true });
  t.mock.timers.tick(1000);
  assert.match(screenOf(panels)[0], /^third/);
  assert.equal(panels.playback?.paused, true);
  t.mock.timers.tick(5000);
  assert.match(screenOf(panels)[0], /^third/);
  assert.deepEqual(calls.sent, []);
  panels.playbackKey("F3");
  assert.equal(panels.isRecordingPlayback(), false);
});

test("recording playback uses the saved wire-format colours when available", () => {
  const { panels, recorder } = fixture();
  recorder.recordings.push({
    name: "Colour",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: [
      {
        screen: ["AB"],
        paint: {
          type: "paint",
          full: true,
          color: true,
          fieldsFormatted: true,
          size: { rows: 24, cols: 80 },
          defaultFg: "neutralWhite",
          defaultBg: "black",
          rows: [
            {
              row: 0,
              runs: [
                {
                  col: 0,
                  text: "A",
                  fg: "red",
                  bg: "deepBlue",
                  gr: "reverse,underscore",
                  editable: true,
                },
                { col: 1, text: "B" },
              ],
            },
          ],
          cursor: { row: 0, col: 0, on: true },
        },
        cursor: { row: 0, col: 0 },
        action: "Tab",
        args: [],
      },
    ],
  });
  panels.openPlayback(recorder.recordings[0]);
  panels.playbackKey("F2");
  const grid = new Grid(24, 80);
  grid.applyPaint(panels.paint(24, 80));
  assert.equal(grid.color, true);
  assert.equal(grid.defaultFg, "neutralWhite");
  assert.equal(grid.defaultBg, "black");
  assert.deepEqual(grid.cellAt(0, 0), {
    ch: "A",
    fg: "red",
    bg: "deepBlue",
    gr: "reverse,underscore",
    editable: true,
  });
  assert.equal(grid.cellAt(0, 1)?.ch, "B");
  assert.equal(grid.cellAt(0, 1)?.fg, null);
  panels.playbackKey("F3");
});

test("recording playback controls speed, pause, single-step, and jump", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { panels, recorder } = fixture();
  recorder.recordings.push({
    name: "Controls",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: ["one", "two", "three"].map((line) => ({
      screen: [line],
      cursor: { row: 0, col: 0 },
    })),
  });
  panels.openPlayback(recorder.recordings[0]);
  assert.equal(panels.playbackKey("Enter"), false);
  assert.equal(panels.playback?.paused, false);
  panels.playbackKey("HostEnter");
  assert.equal(panels.playback?.paused, true);
  t.mock.timers.tick(5000);
  assert.equal(panels.playback?.index, 0);
  panels.playbackKey("F11");
  assert.equal(panels.playback?.index, 1);
  panels.playbackKey("F10");
  assert.equal(panels.playback?.index, 0);

  for (let i = 0; i < 3; i++) panels.playbackKey("F8");
  assert.equal(panels.playback?.speed, 2);
  panels.playbackKey("F8");
  assert.equal(panels.playback?.speed, 1.5);
  panels.playbackKey("F7");
  assert.equal(panels.playback?.speed, 2);
  panels.playbackKey("F7");
  assert.equal(panels.playback?.speed, 3);

  panels.playbackKey("3");
  assert.equal(
    panels.screen(24, 80).fields.find((field) => field.name === "jump")?.value,
    "3",
  );
  panels.playbackKey("HostEnter");
  assert.equal(panels.playback?.index, 2);
  assert.equal(panels.playback?.paused, true);
  panels.playbackKey("9");
  panels.playbackKey("HostEnter");
  assert.match(screenOf(panels)[23], /E5026/);
  assert.equal(panels.playback?.index, 2);
  panels.playbackKey("Backspace");
  assert.equal(panels.screen(24, 80).fields[0]?.value, "");
  panels.playbackKey("1");
  panels.playbackKey("HostEnter");
  assert.equal(panels.playback?.index, 0);
  panels.playbackKey("HostEnter");
  assert.equal(panels.playback?.paused, false);
  t.mock.timers.tick(2000);
  assert.equal(panels.playback?.index, 1);
  panels.playbackKey("F3");
  t.mock.timers.tick(5000);
  assert.equal(panels.playback, null);
});

test("recording playback uses the chosen speed ladder and starts at five steps per second", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { panels, recorder } = fixture();
  recorder.recordings.push({
    name: "Speed",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: ["one", "two"].map((line) => ({
      screen: [line],
      cursor: { row: 0, col: 0 },
    })),
  });
  panels.openPlayback(recorder.recordings[0]);
  panels.playbackKey("HostEnter");
  const speeds = [0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 30];
  assert.equal(panels.playback?.speed, 5);
  for (let index = 6; index >= 0; index--) {
    panels.playbackKey("F8");
    assert.equal(panels.playback?.speed, speeds[index]);
  }
  panels.playbackKey("F8");
  assert.equal(panels.playback?.speed, 0.5);
  for (let index = 1; index < speeds.length; index++) {
    panels.playbackKey("F7");
    assert.equal(panels.playback?.speed, speeds[index]);
  }
  panels.playbackKey("F7");
  assert.equal(panels.playback?.speed, 30);
  panels.playbackKey("F3");
});

test("F9 reverses playback from the current step", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { panels, recorder } = fixture();
  recorder.recordings.push({
    name: "Reverse",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: ["one", "two", "three"].map((line) => ({
      screen: [line],
      cursor: { row: 0, col: 0 },
    })),
  });
  panels.openPlayback(recorder.recordings[0]);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  assert.equal(panels.playback?.index, 2);
  assert.equal(panels.playback?.paused, true);
  panels.playbackKey("F9");
  assert.equal(panels.playback?.direction, -1);
  assert.match(screenOf(panels)[21], /F9=Forward/);
  panels.playbackKey("HostEnter");
  t.mock.timers.tick(1000);
  assert.equal(panels.playback?.index, 1);
  t.mock.timers.tick(1000);
  assert.equal(panels.playback?.index, 0);
  assert.equal(panels.playback?.paused, true);
  panels.playbackKey("F3");
});

test("empty recording cannot start playback", () => {
  const { panels, recorder } = fixture();
  recorder.recordings.push({
    name: "Empty",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: [],
  });
  panels.openPlayback(recorder.recordings[0]);
  assert.equal(panels.playback?.paused, true);
  panels.playbackKey("HostEnter");
  assert.equal(panels.playback?.paused, true);
  assert.match(screenOf(panels)[23], /E5027/);
  panels.playbackKey("F3");
});

test("the jump field moves its cursor while typing and deleting", () => {
  const { panels, recorder } = fixture();
  recorder.recordings.push({
    name: "Jump",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: ["one", "two", "three"].map((line) => ({
      screen: [line],
      cursor: { row: 0, col: 0 },
    })),
  });
  panels.openPlayback(recorder.recordings[0]);
  panels.playbackKey("HostEnter");
  assert.deepEqual(panels.paint(24, 80).cursor, { row: 22, col: 14, on: true });
  panels.playbackKey("Backspace");
  assert.equal(panels.screen(24, 80).fields[0]?.value, "");
  assert.deepEqual(panels.paint(24, 80).cursor, { row: 22, col: 13, on: true });

  panels.playbackKey("1");
  panels.playbackKey("2");
  assert.equal(panels.screen(24, 80).fields[0]?.value, "12");
  assert.deepEqual(panels.paint(24, 80).cursor, { row: 22, col: 15, on: true });
  panels.playbackKey("ArrowLeft");
  assert.deepEqual(panels.paint(24, 80).cursor, { row: 22, col: 14, on: true });
  panels.playbackKey("Delete");
  assert.equal(panels.screen(24, 80).fields[0]?.value, "1");
  assert.deepEqual(panels.paint(24, 80).cursor, { row: 22, col: 14, on: true });
  panels.playbackKey("Backspace");
  assert.equal(panels.screen(24, 80).fields[0]?.value, "");
  assert.deepEqual(panels.paint(24, 80).cursor, { row: 22, col: 13, on: true });
  panels.playbackKey("1");
  panels.playbackKey("2");
  panels.playbackClick(22, 13);
  assert.deepEqual(panels.paint(24, 80).cursor, { row: 22, col: 13, on: true });
  panels.playbackKey("Delete");
  assert.equal(panels.screen(24, 80).fields[0]?.value, "2");
  panels.playbackKey("F3");
});

test("playback keeps the recorded cursor visible and moves its info away from it", () => {
  const { panels, recorder } = fixture();
  recorder.recordings.push({
    name: "Cursor",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: [
      {
        screen: Array.from({ length: 24 }, (_, row) => `row ${row}`),
        cursor: { row: 0, col: 4 },
        action: "String",
        args: ["hi"],
      },
      {
        screen: Array.from({ length: 24 }, (_, row) => `row ${row}`),
        cursor: { row: 23, col: 4 },
        action: "MoveCursor1",
        args: ["24", "5"],
      },
      {
        screen: Array.from({ length: 24 }, (_, row) => `row ${row}`),
        cursor: { row: 23, col: 4 },
        password: true,
      },
    ],
  });
  panels.openPlayback(recorder.recordings[0]);
  panels.playbackKey("HostEnter");
  let paint = panels.paint(24, 80);
  assert.deepEqual(paint.cursor, { row: 22, col: 14, on: true });
  const marked = new Grid(24, 80);
  marked.applyPaint(paint);
  assert.equal(
    marked.cellAt(0, 4)?.bg,
    panels.deps.settings.theme().colors.cursor,
  );
  assert.match(screenOf(panels)[20], /Keys: "hi"/);
  assert.match(screenOf(panels)[0], /^row 0/);

  panels.playbackKey("F11");
  paint = panels.paint(24, 80);
  assert.deepEqual(paint.cursor, { row: 3, col: 14, on: true });
  marked.applyPaint(paint);
  assert.equal(
    marked.cellAt(23, 4)?.bg,
    panels.deps.settings.theme().colors.cursor,
  );
  assert.match(screenOf(panels)[1], /CursorMove X=5 Y=24/);
  assert.match(screenOf(panels)[23], /^row 23/);

  panels.playbackKey("F11");
  assert.match(screenOf(panels)[1], /Secret/);
  assert.doesNotMatch(screenOf(panels)[1], /hi/);
  panels.playbackKey("F3");
});

test("macro capture scrolls to keep the next step ready", () => {
  const { panels, macros } = fixture();
  macros.macros.push({ name: "Long", steps: [] });
  panels.open("macro:Long");
  panels.paint(24, 80);
  for (let index = 0; index < 20; index++)
    panels.captureMacro({ kind: "text", value: String(index % 10) });
  assert.equal(macros.macros[0].steps.length, 20);
  assert.equal(panels.capturingMacro(), true);
  assert.equal(
    panels.host.fieldAtCursor(panels.host.layout().fields)?.name,
    "edit:insert",
  );
  assert.ok((panels.stack.at(-1)?.top ?? 0) > 0);
});

test("a macro step rejects pasted multi-character input", () => {
  const { panels, macros } = fixture();
  macros.macros.push({ name: "Single", steps: [] });
  panels.open("macro:Single");
  panels.aid("Enter", { "edit:insert": "ab" });
  assert.deepEqual(macros.macros[0].steps, []);
  assert.match(screenOf(panels)[21], /E5025/);
});

test("layout output stays within the terminal grid", () => {
  const { panels } = fixture();
  for (const id of [
    "settings",
    "theme",
    "font",
    "size",
    "macros",
    "recorder",
    "keymap",
    "keys:Enter",
  ]) {
    panels.open(id);
    const { texts, fields } = panels.screen(24, 80);
    for (const item of texts) assert.ok(item.col + item.text.length <= 80, id);
    for (const item of fields) assert.ok(item.col + item.width <= 80, id);
  }
});
