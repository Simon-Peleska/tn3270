import test from "node:test";
import assert from "node:assert/strict";
import { Macros } from "../public/macros.js";
import { Keymap } from "../public/keymap.js";

function fixture() {
  const calls = {
    /** @type {import('../server/protocol.js').ClientMessage[]} */ dispatched:
      [],
    /** @type {import('../public/macros.js').Macro[][]} */ saved: [],
  };
  // The real keymap, since that is where a macro's key is kept.
  const keymap = new Keymap(() => {});
  const macros = new Macros({
    dispatch: (message) => calls.dispatched.push(message),
    persist: (values) => calls.saved.push(structuredClone(values)),
    keymap,
  });
  return { macros, calls, keymap };
}

test("recording keeps text and actions as separate steps", () => {
  const { macros } = fixture();
  macros.record({ type: "text", value: "not recording" });
  macros.startRecording();
  macros.record({ type: "text", value: "log" });
  macros.record({ type: "paste", text: "on" });
  macros.record({ type: "action", action: "Enter", args: [] });
  macros.record({ type: "refresh" });
  macros.record({ type: "text", value: "tso" });
  macros.stopRecording();
  assert.equal(macros.recording, null);
  assert.deepEqual(macros.pending, [
    ...[..."log"].map((text) => ({ text, action: "", args: [] })),
    { text: "", action: "PasteString", args: ["on"] },
    { text: "", action: "Enter", args: [] },
    ...[..."tso"].map((text) => ({ text, action: "", args: [] })),
  ]);
});

test("older combined steps load as one input per step", () => {
  const { macros } = fixture();
  macros.load([
    {
      name: "Login",
      steps: [{ text: "logon", action: "Enter", args: [] }],
    },
  ]);
  assert.deepEqual(macros.macros[0].steps, [
    ...[..."logon"].map((text) => ({ text, action: "", args: [] })),
    { text: "", action: "Enter", args: [] },
  ]);
});

test("a stopped recording waits for a name, and a taken name gets a number", () => {
  const { macros, calls } = fixture();
  macros.startRecording();
  macros.stopRecording();
  assert.equal(macros.suggestedName(), "Macro 1");
  macros.save("Logon");
  assert.equal(macros.pending, null);

  macros.startRecording();
  macros.stopRecording();
  macros.save("Logon");
  assert.deepEqual(
    calls.saved.at(-1)?.map((macro) => macro.name),
    ["Logon", "Logon (2)"],
  );

  macros.startRecording();
  macros.stopRecording();
  macros.discard();
  assert.equal(macros.pending, null);
  assert.equal(macros.macros.length, 2);
});

test("playing a macro sends it whole, for the server to type in order", () => {
  const { macros, calls } = fixture();
  macros.play({
    name: "Two steps",
    steps: [
      { text: "hello", action: "Enter", args: [] },
      { text: "world", action: "Tab", args: [] },
    ],
  });
  assert.deepEqual(calls.dispatched, [
    {
      type: "macro",
      steps: [
        { type: "text", value: "hello" },
        { type: "action", action: "Enter", args: [] },
        { type: "text", value: "world" },
        { type: "action", action: "Tab", args: [] },
      ],
    },
  ]);
});

test("repeating a recording turns its input into a macro and skips password and screen steps", () => {
  const { macros, calls } = fixture();
  const started = macros.playRecording(
    {
      name: "Recorded login",
      recordedAt: "2026-09-26T00:00:00.000Z",
      steps: [
        {
          screen: [],
          cursor: { row: 0, col: 0 },
          action: "String",
          args: ["USER"],
        },
        { screen: [], cursor: { row: 0, col: 0 }, action: "Enter", args: [] },
        { screen: [], cursor: { row: 0, col: 0 }, password: true },
        { screen: [], cursor: { row: 0, col: 0 }, action: "Tab", args: [] },
        { screen: [], cursor: { row: 0, col: 0 }, final: true },
      ],
    },
    true,
  );

  assert.equal(started, true);
  assert.deepEqual(calls.dispatched, [
    {
      type: "macro",
      steps: [
        { type: "text", value: "USER" },
        { type: "action", action: "Enter", args: [] },
        { type: "action", action: "Tab", args: [] },
      ],
      repeat: true,
    },
  ]);
});

test("playback types neighbouring characters together, and a paste stays a paste", () => {
  const { macros, calls } = fixture();
  macros.play({
    name: "Typed",
    steps: [
      { text: "a", action: "", args: [] },
      { text: "b", action: "", args: [] },
      { text: "", action: "PasteString", args: ["x\ny"] },
      { text: "", action: "Enter", args: [] },
      { text: "c", action: "", args: [] },
    ],
  });
  assert.deepEqual(calls.dispatched, [
    {
      type: "macro",
      steps: [
        { type: "text", value: "ab" },
        { type: "paste", text: "x\ny" },
        { type: "action", action: "Enter", args: [] },
        { type: "text", value: "c" },
      ],
    },
  ]);
});

test("a renamed macro keeps its key, and a deleted one frees it", () => {
  const { macros, keymap } = fixture();
  macros.macros.push({ name: "Logon", steps: [] });
  keymap.setCombo("Macro:Logon", 0, {
    key: "L",
    ctrl: true,
    shift: false,
    alt: false,
  });

  macros.rename(0, "Login");
  assert.equal(keymap.lookup().get("C:L"), "Macro:Login");
  assert.equal(macros.macroFor("Macro:Login")?.name, "Login");

  macros.rename(0, "Login");
  assert.equal(macros.macros[0]?.name, "Login", "not a clash with itself");

  macros.remove(0);
  assert.deepEqual(macros.macros, []);
  assert.equal(keymap.lookup().get("C:L"), undefined);
});
