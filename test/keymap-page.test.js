import test from "node:test";
import assert from "node:assert/strict";
import { KeymapPage } from "../public/keymap-page.js";
import { COMMANDS, DEFAULT_BINDINGS, withDefaults } from "../public/keymap.js";
import { defaultKeymapDeps, typeCommand } from "./keyevent.js";

function fixture() {
  /** @type {import('../public/keymap.js').Bindings[]} */
  const saved = [];
  const page = new KeymapPage({
    ...defaultKeymapDeps,
    redraw: () => {},
    end: () => {},
    go: () => {},
    persist: (bindings) => saved.push(bindings),
    exportFile: () => {},
    importFiles: async () => [],
    error: () => {},
    macroNames: () => [],
  });
  return { page, saved };
}

const F2 = { key: "F2", shift: false, ctrl: false, alt: false };
const ESCAPE = { key: "Escape", shift: false, ctrl: false, alt: false };

test("only the commands that were changed are saved, so a new default reaches the rest", () => {
  const { page, saved } = fixture();
  page.addCombo("Clear", F2);
  assert.deepEqual(saved.at(-1), {
    Clear: [...DEFAULT_BINDINGS.Clear, F2],
    PF2: [],
  });

  page.removeCombo("Clear", 1);
  assert.deepEqual(
    saved.at(-1),
    { PF2: [] },
    "Clear is its default again, so it is not saved",
  );
});

test("a key taken from its default command stays taken after a reload", () => {
  const { page, saved } = fixture();
  page.addCombo("Clear", ESCAPE);

  const { page: reloaded } = fixture();
  reloaded.setBindings(saved.at(-1) ?? {});
  assert.deepEqual(reloaded.combosFor("Attn"), []);
  assert.deepEqual(reloaded.combosFor("Clear"), [
    ...DEFAULT_BINDINGS.Clear,
    ESCAPE,
  ]);
});

test("RESET inside a command puts its default keys back, taking them from wherever they went", () => {
  const { page, saved } = fixture();
  page.setBindings({ Attn: [F2], Clear: [ESCAPE] });
  page.show();
  page.commandIndex = COMMANDS.findIndex((command) => command.id === "Attn");
  page.mode = "combos";
  assert.equal(page.title(), "TN3270 Keys - Attn");

  typeCommand(page, "reset");
  assert.deepEqual(page.combosFor("Attn"), DEFAULT_BINDINGS.Attn);
  assert.deepEqual(page.combosFor("Clear"), [], "Escape is Attn's again");
  assert.deepEqual(saved.at(-1), { Clear: [], PF2: [] });
  assert.match(page.message, /Attn is back to its default keys/);
});

test("RESET with a number or a name puts one command back, and RESET alone all of them", () => {
  const { page, saved } = fixture();
  page.setBindings({ Enter: [F2], PF3: [ESCAPE], Attn: [] });
  page.show();

  typeCommand(page, "reset 1");
  assert.deepEqual(page.combosFor("Enter"), DEFAULT_BINDINGS.Enter);
  assert.deepEqual(page.combosFor("PF3"), [ESCAPE], "the others are left");

  typeCommand(page, "reset pf3");
  assert.deepEqual(page.combosFor("PF3"), DEFAULT_BINDINGS.PF3);

  typeCommand(page, "reset nothing");
  assert.match(page.message, /No command is called NOTHING/);

  page.setBindings({ Enter: [F2], Attn: [] });
  typeCommand(page, "reset");
  assert.deepEqual(saved.at(-1), {});
  assert.deepEqual(page.bindings, withDefaults({}));
});

test("a keymap saved whole by an older version still loads, and slims down on the next save", () => {
  const { page, saved } = fixture();
  page.setBindings({
    ...DEFAULT_BINDINGS,
    Enter: DEFAULT_BINDINGS.Enter.slice(0, 1),
  });
  page.addCombo("Clear", F2);
  assert.deepEqual(Object.keys(saved.at(-1) ?? {}).sort(), [
    "Clear",
    "Enter",
    "PF2",
  ]);
});
