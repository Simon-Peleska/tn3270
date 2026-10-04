/**
 * Recorded keystroke sequences: recording one, naming it, playing it back. The
 * Macros panel shows and drives this; a macro's key lives in the keymap.
 */

import { macroCommand } from "./keymap.js";

/**
 * A step types its text as keys, or runs its action; a paste is the action
 * PasteString, so it still lands as a paste does.
 *
 * @typedef {{ text: string, action: string, args: string[] }} MacroStep
 * @typedef {{ name: string, steps: MacroStep[] }} Macro
 */

/** @param {string} text @returns {MacroStep[]} */
export function textSteps(text) {
  return [...text].map((character) => ({
    text: character,
    action: "",
    args: [],
  }));
}

/**
 * @typedef {object} MacrosDeps
 * @property {(message: import('../server/protocol.js').ClientMessage) => void} dispatch
 *   bypasses app.js's recording tap, so playback is never recorded into itself
 * @property {(macros: Macro[]) => void} persist
 * @property {import('./keymap.js').Keymap} keymap
 */

export class Macros {
  /** @param {MacrosDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {Macro[]} */
    this.macros = [];
    /** @type {{ steps: MacroStep[], pendingText: string } | null} */
    this.recording = null;
    /** @type {MacroStep[] | null} recorded and stopped, waiting for a name */
    this.pending = null;
  }

  /** @param {Macro[]} saved */
  load(saved) {
    this.macros = saved.map((macro) => ({
      ...macro,
      steps: macro.steps.flatMap((step) => [
        ...textSteps(step.text),
        ...(step.action === "String"
          ? textSteps(step.args[0] ?? "")
          : step.action
            ? [{ text: "", action: step.action, args: step.args }]
            : []),
      ]),
    }));
  }

  /**
   * @param {string} commandId
   * @returns {Macro | null}
   */
  macroFor(commandId) {
    return (
      this.macros.find((macro) => macroCommand(macro.name) === commandId) ??
      null
    );
  }

  /**
   * @param {import('../server/protocol.js').ClientMessage} message
   * @returns {void}
   */
  record(message) {
    if (this.recording === null) return;
    if (message.type === "text") {
      this.recording.pendingText += message.value;
      return;
    }
    if (message.type !== "action" && message.type !== "paste") return;
    if (this.recording.pendingText !== "")
      this.recording.steps.push({
        text: this.recording.pendingText,
        action: "",
        args: [],
      });
    this.recording.pendingText = "";
    this.recording.steps.push(
      message.type === "paste"
        ? { text: "", action: "PasteString", args: [message.text] }
        : { text: "", action: message.action, args: message.args ?? [] },
    );
  }

  /**
   * @param {string} name
   * @param {number} [excluding] index left out of the collision check
   * @returns {string}
   */
  uniqueName(name, excluding = -1) {
    const taken = new Set(
      this.macros
        .filter((_, index) => index !== excluding)
        .map((macro) => macro.name),
    );
    if (!taken.has(name)) return name;
    let n = 2;
    while (taken.has(`${name} (${n})`)) n += 1;
    return `${name} (${n})`;
  }

  /** @returns {void} */
  startRecording() {
    console.info("macro recording started");
    this.pending = null;
    this.recording = { steps: [], pendingText: "" };
  }

  /** @returns {void} */
  stopRecording() {
    if (this.recording === null) return;
    const steps = this.recording.steps.flatMap((step) => [
      ...textSteps(step.text),
      ...(step.action
        ? [{ text: "", action: step.action, args: step.args }]
        : []),
    ]);
    steps.push(...textSteps(this.recording.pendingText));
    this.recording = null;
    this.pending = steps;
    console.info("macro recording stopped", { steps: steps.length });
  }

  /** @returns {string} what the name field offers for the pending macro */
  suggestedName() {
    return this.uniqueName(`Macro ${this.macros.length + 1}`);
  }

  /**
   * @param {string} name
   * @returns {void}
   */
  save(name) {
    if (this.pending === null) return;
    const macro = { name: this.uniqueName(name), steps: this.pending };
    this.macros.push(macro);
    this.pending = null;
    console.info("macro saved", { name: macro.name });
    this.deps.persist(this.macros);
  }

  /**
   * @param {import('./recorder.js').Recording} recording
   * @param {boolean} [repeat] from a held-down key
   * @returns {boolean}
   */
  playRecording(recording, repeat = false) {
    const macro = {
      name: recording.name,
      steps: recording.steps.flatMap((step) => {
        if (step.password || step.final || step.action === undefined) return [];
        if (step.action === "String") {
          const text = step.args?.[0] ?? "";
          return text === "" ? [] : [{ text, action: "", args: [] }];
        }
        return [{ text: "", action: step.action, args: step.args ?? [] }];
      }),
    };
    if (macro.steps.length === 0) return false;
    this.play(macro, repeat);
    return true;
  }

  /** @returns {void} */
  discard() {
    this.pending = null;
    console.info("macro discarded");
  }

  /**
   * The server types the whole macro in order, each step against the screen
   * the ones before it left; this page's screen would lag behind them. Typed
   * text stays typing and a paste stays a paste: typing onto a protected cell
   * locks the keyboard, where a paste skips to the next field.
   *
   * @param {Macro} macro
   * @param {boolean} [repeat] from a held-down key: dropped while input waits
   * @returns {void}
   */
  play(macro, repeat = false) {
    /** @type {import('../server/protocol.js').MacroMessage['steps']} */
    const steps = [];
    for (const step of macro.steps) {
      const last = steps.at(-1);
      if (step.text !== "" && last?.type === "text") last.value += step.text;
      else if (step.text !== "") steps.push({ type: "text", value: step.text });
      if (step.action === "PasteString")
        steps.push({ type: "paste", text: step.args[0] ?? "" });
      else if (step.action !== "")
        steps.push({ type: "action", action: step.action, args: step.args });
    }
    console.info("macro playing", { name: macro.name, steps: steps.length });
    this.deps.dispatch(
      repeat
        ? { type: "macro", steps, repeat: true }
        : { type: "macro", steps },
    );
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  remove(index) {
    const [removed] = this.macros.splice(index, 1);
    if (removed === undefined) return;
    console.info("macro deleted", { name: removed.name });
    this.deps.keymap.unbind(macroCommand(removed.name));
    this.deps.persist(this.macros);
  }

  /**
   * @param {number} index
   * @param {string} name
   * @returns {void}
   */
  rename(index, name) {
    const macro = this.macros[index];
    if (macro === undefined) return;
    const renamed = this.uniqueName(name, index);
    console.info("macro renamed", { from: macro.name, to: renamed });
    this.deps.keymap.renameCommand(
      macroCommand(macro.name),
      macroCommand(renamed),
    );
    macro.name = renamed;
    this.deps.persist(this.macros);
  }
}
