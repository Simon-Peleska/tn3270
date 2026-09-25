/**
 * The macros panel: record and play back keystroke sequences. An ISPF list panel, so the lines are numbered and the work is
 * done with line commands typed on the command line.
 */

import { Panel, typeKey, keyLegend } from "./panel.js";
import {
  ComboCapture,
  comboLabel,
  heldModifiers,
  macroCommand,
} from "./keymap.js";

/**
 * @typedef {{ text: string, action: string, args: string[] }} MacroStep
 * @typedef {{ name: string, steps: MacroStep[] }} Macro
 */

const NAME_WIDTH = 24;

/**
 * @typedef {import('./panel.js').PanelDeps & {
 *   dispatch: (message: import('../server/protocol.js').ClientMessage) => void,
 *   paste: (text: string) => void,
 *   waitForUnlock: () => Promise<void>,
 *   persist: (macros: Macro[]) => void,
 *   setKey: (commandId: string, combo: import('./keymap.js').Combo | null) => void,
 *   renameKey: (from: string, to: string) => void,
 * }} MacrosDeps
 *
 * `dispatch` and `paste` bypass app.js's recording tap, so playback is never recorded
 * into itself, and `waitForUnlock` paces playback by the host, not a timer. A
 * macro's key lives in the keymap, which `setKey` and `renameKey` reach.
 */

/** @extends {Panel<MacrosDeps>} */
export class MacrosPage extends Panel {
  /** @param {MacrosDeps} deps */
  constructor(deps) {
    super("macros", deps);
    /** @type {Macro[]} */
    this.macros = [];
    /** @type {{ steps: MacroStep[], pendingText: string } | null} */
    this.recording = null;
    /** @type {{ macro: Macro, active: boolean } | null} */
    this.playing = null;
    /** @type {{ kind: 'save', steps: MacroStep[] } | { kind: 'rename', index: number } | null} */
    this.naming = null;
    /** @type {string} text being typed for this.naming */
    this.nameBuffer = "";
    /** @type {number | null} the macro waiting for its key to be pressed */
    this.listening = null;
    /** @type {ComboCapture} the key being picked, while listening */
    this.capture = new ComboCapture();
  }

  /**
   * @param {Macro[]} macros
   * @returns {void}
   */
  setMacros(macros) {
    this.macros = macros;
    if (this.open) this.draw();
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
   * @param {number} index
   * @param {import('./keymap.js').Combo} combo
   * @returns {void}
   */
  bindKey(index, combo) {
    const macro = this.macros[index];
    if (macro === undefined) return;
    this.deps.setKey(macroCommand(macro.name), combo);
    this.say(`${comboLabel(combo)} plays ${macro.name}`);
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  unbindKey(index) {
    const macro = this.macros[index];
    if (macro === undefined) return;
    this.deps.setKey(macroCommand(macro.name), null);
    this.say(`${macro.name} has no key now`);
  }

  /** @returns {boolean} */
  isRecording() {
    return this.recording !== null;
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
      this.recording.steps.push({
        text: this.recording.pendingText,
        action: message.action,
        args: message.args ?? [],
      });
      this.recording.pendingText = "";
    }
    if (this.open) this.draw();
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
    this.recording = { steps: [], pendingText: "" };
    this.close();
  }

  /** @returns {void} */
  stopRecording() {
    if (this.recording === null) return;
    const steps = this.recording.steps.slice();
    if (this.recording.pendingText !== "")
      steps.push({ text: this.recording.pendingText, action: "", args: [] });
    this.recording = null;
    this.naming = { kind: "save", steps };
    this.nameBuffer = this.uniqueName(`Macro ${this.macros.length + 1}`);
    this.selected = 0;
  }

  /**
   * @param {Macro} macro
   * @returns {Promise<void>}
   */
  async play(macro) {
    const state = { macro, active: true };
    this.playing = state;
    for (const step of macro.steps) {
      if (!state.active) break;
      if (step.text !== "") this.deps.paste(step.text);
      if (step.action !== "") {
        this.deps.dispatch({
          type: "action",
          action: step.action,
          args: step.args,
        });
        await this.deps.waitForUnlock();
      }
    }
    if (this.playing === state) this.playing = null;
    if (this.open) this.draw();
  }

  /** @returns {void} */
  stopPlayback() {
    if (this.playing !== null) this.playing.active = false;
  }

  /** @returns {void} */
  persist() {
    this.deps.persist(this.macros);
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  removeMacro(index) {
    const [removed] = this.macros.splice(index, 1);
    if (removed !== undefined)
      this.deps.setKey(macroCommand(removed.name), null);
    this.persist();
    this.selected = Math.min(this.selected, this.lines().length - 1);
    this.draw();
  }

  /** @returns {void} */
  confirmName() {
    const name = this.nameBuffer.trim();
    if (name === "" || this.naming === null) return;
    if (this.naming.kind === "save") {
      this.macros.push({
        name: this.uniqueName(name),
        steps: this.naming.steps,
      });
    } else {
      const macro = this.macros[this.naming.index];
      if (macro) {
        const renamed = this.uniqueName(name, this.naming.index);
        this.deps.renameKey(macroCommand(macro.name), macroCommand(renamed));
        macro.name = renamed;
      }
    }
    this.naming = null;
    this.persist();
    this.nameBuffer = "";
  }

  /**
   * Line 0 is the transport control; one numbered line follows per saved macro.
   *
   * @override
   * @returns {import('./panel.js').PanelLine[]}
   */
  lines() {
    /** @type {import('./panel.js').PanelLine[]} */
    const lines = [];
    if (this.recording !== null) {
      const count = this.recording.steps.length;
      lines.push({
        text: "Recording",
        value: `${count} step${count === 1 ? "" : "s"} - ${this.deps.keyName("Enter")} stops`,
      });
    } else if (this.naming?.kind === "save") {
      lines.push({
        text: "Save as",
        value: this.nameBuffer.padEnd(NAME_WIDTH),
        field: true,
        cursor: this.nameBuffer.length,
      });
    } else if (this.playing !== null) {
      lines.push({
        text: `Playing "${this.playing.macro.name}"`,
        value: `${this.deps.keyName("Enter")} stops`,
      });
    } else {
      lines.push({
        text: "Record a new macro",
        value: `${this.deps.keyName("Enter")} starts`,
      });
    }
    this.macros.forEach((macro, index) => {
      if (this.naming?.kind === "rename" && this.naming.index === index) {
        lines.push({
          option: String(index + 1),
          text: "Rename",
          value: this.nameBuffer.padEnd(NAME_WIDTH),
          field: true,
          cursor: this.nameBuffer.length,
        });
        return;
      }
      const count = macro.steps.length;
      const steps = `${count} step${count === 1 ? "" : "s"}`;
      const key = this.deps.keyName(macroCommand(macro.name));
      let bound = "";
      if (this.listening === index) bound = " - press a key";
      else if (key !== "") bound = ` - ${key}`;
      lines.push({
        option: String(index + 1),
        text: macro.name,
        value: steps + bound,
      });
    });
    return lines;
  }

  /**
   * @override
   * @returns {number}
   */
  labelWidth() {
    return 30;
  }

  /**
   * @override
   * @returns {string}
   */
  title() {
    return "TN3270 Macros";
  }

  /**
   * @override
   * @returns {string[]}
   */
  notes() {
    if (this.listening !== null)
      return [
        "Press the key that should play this macro. F12 or Escape cancels.",
      ];
    if (this.naming !== null)
      return [
        `Type a name and press ${this.deps.keyName("Enter")}. ${this.deps.keyName("PF12")} leaves it unsaved.`,
      ];
    return [
      `${this.deps.keyName("Enter")} records, stops or plays the line the cursor is on.`,
      "Commands: RENAME, DELETE, KEY, UNKEY.",
    ];
  }

  /**
   * @override
   * @returns {string[]}
   */
  keys() {
    return keyLegend(this.deps, [
      ["PF1", "Help"],
      ["PF3", "Exit"],
      ["PF4", "Menu"],
      ["PF7", "Bkwd"],
      ["PF8", "Fwd"],
      ["Enter", "Play"],
    ]);
  }

  /**
   * @param {number} rowIndex
   * @returns {number | null} null for the transport control row
   */
  macroIndexAt(rowIndex) {
    if (rowIndex < 1) return null;
    const index = rowIndex - 1;
    return index < this.macros.length ? index : null;
  }

  /**
   * @override
   * @returns {void}
   */
  show() {
    this.reset();
    this.listening = null;
    if (this.naming !== null) {
      this.selected = this.lines().findIndex((line) => line.field === true);
      this.onCommand = false;
    }
    this.draw();
  }

  /**
   * @override
   * @returns {void}
   */
  activate() {
    if (this.selected === 0) {
      if (this.recording !== null) {
        this.stopRecording();
        this.draw();
      } else if (this.playing !== null) {
        this.stopPlayback();
      } else {
        this.startRecording();
      }
      return;
    }
    if (this.recording !== null || this.playing !== null) return;
    const index = this.macroIndexAt(this.selected);
    const macro = index === null ? undefined : this.macros[index];
    if (macro === undefined) return;
    this.close();
    this.play(macro);
  }

  /**
   * @override
   * @param {string} word
   * @returns {boolean}
   */
  word(word) {
    const index = this.macroIndexAt(this.selected);
    if (word === "RECORD" || word === "REC") {
      if (this.recording === null && this.playing === null)
        this.startRecording();
      return true;
    }
    if (word === "STOP") {
      if (this.recording !== null) this.stopRecording();
      else this.stopPlayback();
      this.draw();
      return true;
    }
    if (
      word !== "RENAME" &&
      word !== "REN" &&
      word !== "DELETE" &&
      word !== "DEL" &&
      word !== "KEY" &&
      word !== "UNKEY"
    )
      return false;
    if (index === null) {
      this.say("Put the cursor on a macro first");
      return true;
    }
    if (word === "RENAME" || word === "REN") this.rename(index);
    else if (word === "DELETE" || word === "DEL") this.removeMacro(index);
    else if (word === "KEY") this.listenForKey(index);
    else this.unbindKey(index);
    return true;
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  rename(index) {
    this.naming = { kind: "rename", index };
    this.nameBuffer = this.macros[index]?.name ?? "";
    this.onCommand = false;
    this.selected = index + 1;
    this.draw();
  }

  /**
   * @param {number} index
   * @returns {void}
   */
  listenForKey(index) {
    this.listening = index;
    this.capture = new ComboCapture();
    this.onCommand = false;
    this.selected = index + 1;
    this.draw();
  }

  /** @override */
  capturing() {
    return this.listening !== null;
  }

  /**
   * @override
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  released(event) {
    if (this.listening === null) return false;
    const picked = this.capture.keyup(event);
    if (picked !== null) this.bindListened(picked);
    return true;
  }

  /**
   * @param {import('./keymap.js').Combo} picked
   * @returns {void}
   */
  bindListened(picked) {
    if (this.listening !== null) this.bindKey(this.listening, picked);
    this.listening = null;
    this.draw();
  }

  /**
   * Naming takes the whole panel, the way ISPF's own pop-ups do: until the name
   * is in, every key belongs to the field.
   *
   * @override
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  override(event) {
    if (this.listening !== null) {
      // By name, not the keymap, like the Keys panel: the key being picked may be
      // one the keymap uses.
      if (event.key === "Escape" || event.key === "F12") {
        this.listening = null;
        this.draw();
        return true;
      }
      if (event.metaKey) return true;
      const picked = this.capture.keydown(event);
      if (picked !== null) this.bindListened(picked);
      return true;
    }
    if (this.naming === null) return false;
    const command = this.deps.keyCommand(event);
    if (command === "Attn" || command === "PF12") {
      this.naming = null;
      this.nameBuffer = "";
      this.draw();
      return true;
    }
    if (command === "Enter") {
      this.confirmName();
      this.draw();
      return true;
    }
    if (heldModifiers(event).ctrl || event.metaKey) return false;
    const typed = typeKey(this.nameBuffer, event, command);
    if (typed !== null) {
      this.nameBuffer = typed;
      this.draw();
    }
    return true;
  }

  /**
   * @override
   * @param {string} text
   * @returns {boolean}
   */
  insert(text) {
    if (this.naming === null) return false;
    this.nameBuffer += text;
    return true;
  }

  /**
   * @override
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  typed(event) {
    const index = this.macroIndexAt(this.selected);
    if (index === null) return false;
    if (this.deps.keyCommand(event) === "Delete") {
      this.removeMacro(index);
      return true;
    }
    return false;
  }
}
