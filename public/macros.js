/**
 * Recorded keystroke sequences: recording one, naming it, playing it back. The
 * Macros panel shows and drives this; a macro's key lives in the keymap.
 */

import { macroCommand } from "./keymap.js";

/**
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
 * @property {(text: string) => void} paste
 * @property {() => Promise<void>} waitForUnlock
 * @property {(macros: Macro[]) => void} persist
 * @property {import('./keymap.js').Keymap} keymap
 * @property {() => void} redraw
 *
 * `dispatch` and `paste` bypass app.js's recording tap, so playback is never
 * recorded into itself, and `waitForUnlock` paces playback by the host, not a
 * timer.
 */

export class Macros {
  /** @param {MacrosDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {Macro[]} */
    this.macros = [];
    /** @type {{ steps: MacroStep[], pendingText: string } | null} */
    this.recording = null;
    /** @type {{ macro: Macro, active: boolean } | null} */
    this.playing = null;
    /** @type {MacroStep[] | null} recorded and stopped, waiting for a name */
    this.pending = null;
  }

  /** @param {Macro[]} saved */
  load(saved) {
    this.macros = saved.map((macro) => ({
      ...macro,
      steps: macro.steps.flatMap((step) => [
        ...textSteps(step.text),
        ...(step.action === "String" || step.action === "PasteString"
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
    if (message.type === "text") this.recording.pendingText += message.value;
    else if (message.type === "paste")
      this.recording.pendingText += message.text;
    else if (message.type === "action") {
      if (this.recording.pendingText !== "")
        this.recording.steps.push({
          text: this.recording.pendingText,
          action: "",
          args: [],
        });
      this.recording.steps.push({
        text: "",
        action: message.action,
        args: message.args ?? [],
      });
      this.recording.pendingText = "";
    }
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
   * @returns {boolean}
   */
  playRecording(recording) {
    const macro = {
      name: recording.name,
      steps: recording.steps.flatMap((step) => {
        if (step.password || step.final || step.action === undefined) return [];
        if (step.action === "String" || step.action === "PasteString") {
          const text = step.args?.[0] ?? "";
          return text === "" ? [] : [{ text, action: "", args: [] }];
        }
        return [{ text: "", action: step.action, args: step.args ?? [] }];
      }),
    };
    if (macro.steps.length === 0) return false;
    void this.play(macro);
    return true;
  }

  /** @returns {void} */
  discard() {
    this.pending = null;
    console.info("macro discarded");
  }

  /**
   * @param {Macro} macro
   * @returns {Promise<void>}
   */
  async play(macro) {
    console.info("macro playing", { name: macro.name });
    const state = { macro, active: true };
    this.playing = state;
    let text = "";
    for (const step of macro.steps) {
      if (!state.active) break;
      text += step.text;
      if (step.action !== "") {
        if (text !== "") this.deps.paste(text);
        text = "";
        this.deps.dispatch({
          type: "action",
          action: step.action,
          args: step.args,
        });
        await this.deps.waitForUnlock();
      }
    }
    if (state.active && text !== "") this.deps.paste(text);
    if (this.playing === state) this.playing = null;
    this.deps.redraw();
  }

  /** @returns {void} */
  stopPlayback() {
    if (this.playing !== null) this.playing.active = false;
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
