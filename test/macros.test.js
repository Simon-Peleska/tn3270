import test from "node:test";
import assert from "node:assert/strict";
import { Macros } from "../public/macros.js";
import { Keymap } from "../public/keymap.js";

function fixture() {
  const calls = {
    /** @type {import('../server/protocol.js').ClientMessage[]} */ dispatched:
      [],
    /** @type {import('../public/macros.js').Macro[][]} */ saved: [],
    /** @type {number} */ unlockWaits: 0,
  };
  /** @type {(() => void)[]} */
  const pendingUnlocks = [];
  // The real keymap, since that is where a macro's key is kept.
  const keymap = new Keymap(() => {});
  const macros = new Macros({
    dispatch: (message) => calls.dispatched.push(message),
    paste: (text) =>
      calls.dispatched.push({ type: "paste", text, segments: [] }),
    waitForUnlock: () => {
      calls.unlockWaits += 1;
      return new Promise((resolve) => pendingUnlocks.push(resolve));
    },
    persist: (values) => calls.saved.push(structuredClone(values)),
    keymap,
    redraw: () => {},
  });
  return { macros, calls, pendingUnlocks, keymap };
}

test("recording keeps text and actions as separate steps", () => {
  const { macros } = fixture();
  macros.record({ type: "text", value: "not recording" });
  macros.startRecording();
  macros.record({ type: "text", value: "log" });
  macros.record({ type: "paste", text: "on", segments: [] });
  macros.record({ type: "action", action: "Enter", args: [] });
  macros.record({ type: "refresh" });
  macros.record({ type: "text", value: "tso" });
  macros.stopRecording();
  assert.equal(macros.recording, null);
  assert.deepEqual(macros.pending, [
    ...[..."logon"].map((text) => ({ text, action: "", args: [] })),
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

test("playing a macro sends each step and waits for the keyboard to unlock between actions", async () => {
  const { macros, calls, pendingUnlocks } = fixture();
  const macro = {
    name: "Two steps",
    steps: [
      { text: "hello", action: "Enter", args: [] },
      { text: "world", action: "Tab", args: [] },
    ],
  };
  const played = macros.play(macro);
  assert.equal(macros.playing?.macro, macro);
  assert.deepEqual(calls.dispatched, [
    { type: "paste", text: "hello", segments: [] },
    { type: "action", action: "Enter", args: [] },
  ]);
  assert.equal(calls.unlockWaits, 1);

  pendingUnlocks[0]?.();
  await Promise.resolve();
  assert.equal(calls.dispatched.length, 4);

  pendingUnlocks[1]?.();
  await played;
  assert.equal(macros.playing, null);
});

test("playback batches neighbouring character steps before the next action", async () => {
  const { macros, calls, pendingUnlocks } = fixture();
  const played = macros.play({
    name: "Typed",
    steps: [
      { text: "a", action: "", args: [] },
      { text: "b", action: "", args: [] },
      { text: "", action: "Enter", args: [] },
    ],
  });
  assert.deepEqual(calls.dispatched, [
    { type: "paste", text: "ab", segments: [] },
    { type: "action", action: "Enter", args: [] },
  ]);
  pendingUnlocks[0]?.();
  await played;
});

test("stopping playback ends it before the remaining steps go out", async () => {
  const { macros, calls, pendingUnlocks } = fixture();
  const played = macros.play({
    name: "Stoppable",
    steps: [
      { text: "", action: "Enter", args: [] },
      { text: "", action: "PF", args: ["3"] },
    ],
  });
  macros.stopPlayback();
  pendingUnlocks[0]?.();
  await played;
  assert.deepEqual(calls.dispatched, [
    { type: "action", action: "Enter", args: [] },
  ]);
  assert.equal(macros.playing, null);
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
