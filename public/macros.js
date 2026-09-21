/**
 * The macros panel: record, play back and trade keystroke sequences as Host
 * On-Demand XML. An ISPF list panel, so the lines are numbered and the work is
 * done with line commands typed on the command line.
 */

import { Panel, typeKey } from "./panel.js";
import { macrosToXml, parseMacrosXml } from "./macro-xml.js";

/** @typedef {import('./macro-xml.js').Macro} Macro */
/** @typedef {import('./macro-xml.js').MacroStep} MacroStep */

const NAME_WIDTH = 24;

/**
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return (
    name
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "macro"
  );
}

/**
 * @typedef {import('./panel.js').PanelDeps & {
 *   dispatch: (message: import('../server/protocol.js').ClientMessage) => void,
 *   waitForUnlock: () => Promise<void>,
 *   persist: (macros: Macro[]) => void,
 *   exportFile: (filename: string, content: string) => void,
 *   importFiles: () => Promise<string[]>,
 *   error: (code: string, message: string) => void,
 * }} MacrosDeps
 *
 * `dispatch` bypasses app.js's recording tap, so playback is never recorded
 * into itself, and `waitForUnlock` paces playback by the host, not a timer.
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
    /** @type {Set<number>} indices marked for a batch export */
    this.marked = new Set();
  }

  /**
   * @param {Macro[]} macros
   * @returns {void}
   */
  setMacros(macros) {
    this.macros = macros;
    if (this.open) this.draw();
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
      if (step.text !== "")
        this.deps.dispatch({ type: "paste", text: step.text });
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
    this.macros.splice(index, 1);
    this.marked = new Set(
      [...this.marked]
        .filter((i) => i !== index)
        .map((i) => (i > index ? i - 1 : i)),
    );
    this.persist();
    this.selected = Math.min(this.selected, this.lines().length - 1);
    this.draw();
  }

  /**
   * @returns {void}
   */
  exportSelection() {
    let indices = [...this.marked];
    if (indices.length === 0) {
      const index = this.macroIndexAt(this.selected);
      if (index !== null) indices = [index];
    }
    const chosen = indices
      .map((index) => this.macros[index])
      .filter((macro) => macro !== undefined);
    if (chosen.length === 0) return;
    const filename =
      chosen.length === 1
        ? `${sanitizeFilename(chosen[0].name)}.xml`
        : "macros.xml";
    this.deps.exportFile(filename, macrosToXml(chosen));
    this.marked.clear();
    this.draw();
  }

  /** @returns {Promise<void>} */
  async importMacros() {
    const texts = await this.deps.importFiles();
    /** @type {Macro[]} */
    const imported = [];
    for (const text of texts) {
      try {
        imported.push(...parseMacrosXml(text));
      } catch (cause) {
        this.deps.error(
          "E5010",
          `A macro file could not be read: ${String(cause)}`,
        );
      }
    }
    for (const macro of imported) {
      macro.name = this.uniqueName(macro.name);
      this.macros.push(macro);
    }
    if (imported.length > 0) this.persist();
    if (this.open) this.draw();
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
      if (macro) macro.name = this.uniqueName(name, this.naming.index);
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
        value: `${count} step${count === 1 ? "" : "s"} - Enter stops`,
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
        value: "Enter stops",
      });
    } else {
      lines.push({ text: "Record a new macro", value: "Enter starts" });
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
      lines.push({
        option: String(index + 1),
        text: `${this.marked.has(index) ? "/" : " "} ${macro.name}`,
        value: `${count} step${count === 1 ? "" : "s"}`,
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
    if (this.naming !== null)
      return ["Type a name and press Enter. F12 leaves it unsaved."];
    return [
      "Enter records, stops or plays the line the cursor is on. / marks a macro.",
      "Commands: RENAME, DELETE, EXPORT, IMPORT, MARK.",
    ];
  }

  /**
   * @override
   * @returns {string[]}
   */
  keys() {
    return ["F1=Help", "F3=Exit", "F4=Menu", "F7=Bkwd", "F8=Fwd", "Enter=Play"];
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
    if (word === "EXPORT" || word === "EXP") {
      this.exportSelection();
      return true;
    }
    if (word === "IMPORT" || word === "IMP") {
      this.importMacros();
      return true;
    }
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
      word !== "MARK"
    )
      return false;
    if (index === null) {
      this.say("Put the cursor on a macro first");
      return true;
    }
    if (word === "RENAME" || word === "REN") this.rename(index);
    else if (word === "DELETE" || word === "DEL") this.removeMacro(index);
    else this.mark(index);
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
  mark(index) {
    if (this.marked.has(index)) this.marked.delete(index);
    else this.marked.add(index);
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
    if (this.naming === null) return false;
    if (event.ctrlKey || event.metaKey) return false;
    if (event.key === "Escape" || event.key === "F12") {
      this.naming = null;
      this.nameBuffer = "";
      this.draw();
      return true;
    }
    if (event.key === "Enter") {
      this.confirmName();
      this.draw();
      return true;
    }
    const typed = typeKey(this.nameBuffer, event);
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
    if (event.key === "/") {
      this.mark(index);
      return true;
    }
    if (event.key === "Delete") {
      this.removeMacro(index);
      return true;
    }
    return false;
  }
}
