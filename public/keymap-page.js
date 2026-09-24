/** The keys panel: an ISPF list of commands, each opening its own list of keystrokes. */

import { Panel, keyLegend } from "./panel.js";
import {
  COMMANDS,
  DEFAULT_BINDINGS,
  buildLookup,
  macroCommand,
  changedBindings,
  comboFromEvent,
  comboLabel,
  serializeCombo,
  withDefaults,
} from "./keymap.js";
import { keymapToText, parseKeymapText } from "./keymap-format.js";

/** @typedef {import('./keymap.js').Bindings} Bindings */
/** @typedef {import('./keymap.js').Combo} Combo */

/**
 * @param {Bindings} bindings
 * @returns {Bindings}
 */
function cloneBindings(bindings) {
  /** @type {Bindings} */
  const copy = {};
  for (const [commandId, combos] of Object.entries(bindings))
    copy[commandId] = combos.map((combo) => ({ ...combo }));
  return copy;
}

/**
 * @typedef {import('./panel.js').PanelDeps & {
 *   persist: (bindings: Bindings) => void,
 *   exportFile: (filename: string, content: string) => void,
 *   importFiles: () => Promise<string[]>,
 *   error: (code: string, message: string) => void,
 *   macroNames: () => string[],
 * }} KeymapDeps
 *
 * `importFiles` resolves empty when the picker was cancelled.
 */

/** @extends {Panel<KeymapDeps>} */
export class KeymapPage extends Panel {
  /** @param {KeymapDeps} deps */
  constructor(deps) {
    super("keymap", deps);
    /** @type {Bindings} */
    this.bindings = cloneBindings(DEFAULT_BINDINGS);
    /** @type {Map<string, string>} */
    this.lookupCache = buildLookup(this.bindings);
    /** @type {'commands' | 'combos' | 'listening'} */
    this.mode = "commands";
    /** @type {number} index into commands(), the command the combos list belongs to */
    this.commandIndex = 0;
  }

  /**
   * @param {Bindings} bindings
   * @returns {void}
   */
  setBindings(bindings) {
    this.bindings = cloneBindings(withDefaults(bindings));
    this.rebuildLookup();
    if (this.open) this.draw();
  }

  /**
   * The fixed commands, then one per macro.
   *
   * @returns {import('./keymap.js').Command[]}
   */
  commands() {
    return [
      ...COMMANDS,
      ...this.deps
        .macroNames()
        .map((name) => ({ id: macroCommand(name), label: `Macro ${name}` })),
    ];
  }

  /** @returns {void} */
  rebuildLookup() {
    this.lookupCache = buildLookup(this.bindings);
  }

  /** @returns {Map<string, string>} */
  lookup() {
    return this.lookupCache;
  }

  /** @returns {void} */
  persist() {
    this.rebuildLookup();
    this.deps.persist(changedBindings(this.bindings));
  }

  /**
   * @param {string} commandId
   * @returns {Combo[]}
   */
  combosFor(commandId) {
    return this.bindings[commandId] ?? [];
  }

  /**
   * @param {string} commandId
   * @returns {string} the first key bound to it, '' when nothing is
   */
  labelFor(commandId) {
    const first = this.combosFor(commandId)[0];
    return first === undefined ? "" : comboLabel(first);
  }

  /**
   * A combo bound elsewhere is taken from its old command: one keystroke, one command.
   *
   * @param {string} commandId
   * @param {Combo} combo
   * @returns {void}
   */
  addCombo(commandId, combo) {
    this.takeFromOthers(commandId, combo);
    const key = serializeCombo(combo);
    const current = this.combosFor(commandId);
    if (!current.some((existing) => serializeCombo(existing) === key)) {
      this.bindings[commandId] = [...current, combo];
    }
    this.persist();
  }

  /**
   * The Macros panel's KEY: the key replaces the command's others. Null unbinds it.
   *
   * @param {string} commandId
   * @param {Combo | null} combo
   * @returns {void}
   */
  setKey(commandId, combo) {
    if (combo === null) {
      delete this.bindings[commandId];
    } else {
      this.takeFromOthers(commandId, combo);
      this.bindings[commandId] = [combo];
    }
    this.persist();
  }

  /**
   * A renamed macro keeps its keys.
   *
   * @param {string} from
   * @param {string} to
   * @returns {void}
   */
  renameCommand(from, to) {
    const combos = this.bindings[from];
    if (combos === undefined) return;
    delete this.bindings[from];
    this.bindings[to] = combos;
    this.persist();
  }

  /**
   * @param {string} commandId
   * @param {Combo} combo
   * @returns {void}
   */
  takeFromOthers(commandId, combo) {
    const key = serializeCombo(combo);
    for (const [otherId, combos] of Object.entries(this.bindings)) {
      if (otherId === commandId) continue;
      const kept = combos.filter(
        (existing) => serializeCombo(existing) !== key,
      );
      if (kept.length !== combos.length) this.bindings[otherId] = kept;
    }
  }

  /**
   * @param {string} commandId
   * @param {number} index
   * @returns {void}
   */
  removeCombo(commandId, index) {
    const combos = this.combosFor(commandId).slice();
    if (index < 0 || index >= combos.length) return;
    combos.splice(index, 1);
    this.bindings[commandId] = combos;
    this.persist();
  }

  /**
   * Its default keys are taken back from whatever they were given to since.
   *
   * @param {string} commandId
   * @returns {void}
   */
  resetCommand(commandId) {
    const defaults = DEFAULT_BINDINGS[commandId] ?? [];
    for (const combo of defaults) this.takeFromOthers(commandId, combo);
    this.bindings[commandId] = defaults.map((combo) => ({ ...combo }));
    this.persist();
  }

  /**
   * @returns {void}
   */
  exportKeymap() {
    this.deps.exportFile("keymap.kmp", keymapToText(this.bindings));
  }

  /** @returns {Promise<void>} */
  async importKeymap() {
    const texts = await this.deps.importFiles();
    if (texts.length === 0) return;
    /** @type {Bindings} */
    const merged = cloneBindings(this.bindings);
    for (const text of texts) {
      let imported;
      try {
        imported = parseKeymapText(text);
      } catch (cause) {
        this.deps.error(
          "E5012",
          `A keymap file could not be read: ${String(cause)}`,
        );
        continue;
      }
      for (const [commandId, combos] of Object.entries(imported))
        merged[commandId] = combos;
    }
    this.bindings = merged;
    this.commandIndex = 0;
    this.mode = "commands";
    this.persist();
    if (this.open) this.draw();
  }

  /**
   * @override
   * @returns {import('./panel.js').PanelLine[]}
   */
  lines() {
    if (this.mode === "commands") {
      return this.commands().map((command, index) => ({
        option: String(index + 1),
        text: command.label,
        dots: true,
        value:
          this.combosFor(command.id).map(comboLabel).join(", ") || "(unbound)",
      }));
    }
    const command = this.commands()[this.commandIndex];
    const combos = command ? this.combosFor(command.id) : [];
    return [
      ...combos.map((combo, index) => ({
        option: String(index + 1),
        text: comboLabel(combo),
      })),
      {
        option: "A",
        text: "Add a binding",
        value: `${this.deps.keyName("Enter")} listens for a keystroke`,
      },
    ];
  }

  /**
   * @override
   * @returns {string}
   */
  title() {
    if (this.mode === "commands") return "TN3270 Keys";
    return `TN3270 Keys - ${this.commands()[this.commandIndex]?.label ?? ""}`;
  }

  /**
   * @override
   * @returns {number}
   */
  labelWidth() {
    return 26;
  }

  /**
   * @override
   * @returns {string[]}
   */
  notes() {
    if (this.mode === "listening")
      return ["Press the key combination to bind. F12 or Escape cancels."];
    if (this.mode === "combos")
      return [
        `${this.deps.keyName("Enter")} opens a line, DELETE removes a binding, ${this.deps.keyName("PF3")} goes back to the list.`,
        "RESET puts this command's default keys back.",
      ];
    return [
      `${this.deps.keyName("Enter")} opens a command. Commands: EXPORT, IMPORT, RESET.`,
      "RESET n, or RESET PF3, puts one command back; RESET alone puts them all.",
    ];
  }

  /**
   * @override
   * @returns {string[]}
   */
  keys() {
    return keyLegend(this.deps, [
      ["PF1", "Help"],
      ["PF3", this.mode === "combos" ? "Back" : "Exit"],
      ["PF4", "Menu"],
      ["PF7", "Bkwd"],
      ["PF8", "Fwd"],
      ["Enter", "Open"],
    ]);
  }

  /**
   * @override
   * @returns {void}
   */
  show() {
    this.reset();
    this.mode = "commands";
    this.selected = this.commandIndex;
    this.draw();
  }

  /**
   * @override
   * @returns {void} F3 in the combos list is one level back, not out of the panel.
   */
  close() {
    if (this.open && this.mode === "combos") {
      this.mode = "commands";
      this.selected = this.commandIndex;
      this.draw();
      return;
    }
    this.mode = "commands";
    super.close();
  }

  /**
   * @override
   * @returns {void}
   */
  activate() {
    if (this.mode === "commands") {
      this.commandIndex = this.selected;
      this.mode = "combos";
      this.selected = 0;
      this.draw();
      return;
    }
    if (this.selected === this.lines().length - 1) this.mode = "listening";
    this.draw();
  }

  /**
   * @override
   * @param {string} word
   * @returns {boolean}
   */
  word(word) {
    if (word === "EXPORT" || word === "EXP") {
      this.exportKeymap();
      return true;
    }
    if (word === "IMPORT" || word === "IMP") {
      this.importKeymap();
      return true;
    }
    if (word === "RESET" || word === "DEFAULTS") {
      const open = this.commands()[this.commandIndex];
      if (this.mode === "combos" && open !== undefined) {
        this.resetCommand(open.id);
        this.say(`${open.label} is back to its default keys`);
        return true;
      }
      this.resetAll();
      return true;
    }
    if (word.startsWith("RESET ")) {
      this.resetNamed(word.slice("RESET ".length).trim());
      return true;
    }
    if (word === "DELETE" || word === "DEL") {
      this.removeSelectedCombo();
      return true;
    }
    return false;
  }

  /** @returns {void} */
  resetAll() {
    this.bindings = cloneBindings(DEFAULT_BINDINGS);
    this.commandIndex = 0;
    this.mode = "commands";
    this.persist();
    this.selected = 0;
    this.say("Every key is back to its default");
  }

  /**
   * @param {string} name `ALL`, a line number, or a command's id or label
   * @returns {void}
   */
  resetNamed(name) {
    if (name === "ALL") {
      this.resetAll();
      return;
    }
    const command = this.commands().find(
      (entry, index) =>
        String(index + 1) === name ||
        entry.id.toUpperCase() === name ||
        entry.label.toUpperCase() === name,
    );
    if (command === undefined) {
      this.say(`No command is called ${name}`);
      return;
    }
    this.resetCommand(command.id);
    this.say(`${command.label} is back to its default keys`);
  }

  /** @returns {void} */
  removeSelectedCombo() {
    const command = this.commands()[this.commandIndex];
    if (this.mode !== "combos" || command === undefined) {
      this.say("Open a command first");
      return;
    }
    if (this.selected >= this.lines().length - 1) return;
    this.removeCombo(command.id, this.selected);
    this.selected = Math.min(this.selected, this.lines().length - 1);
    this.draw();
  }

  /**
   * Listening takes every key, modifiers included: a modifier on its own is a
   * binding someone may want. The two keys out are the only ones in the app
   * that go by their own name rather than the keymap — the keymap is what is
   * being edited, so the way out of the edit cannot depend on it.
   *
   * @override
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  override(event) {
    if (this.mode !== "listening") return false;
    if (event.key === "Escape" || event.key === "F12") {
      this.mode = "combos";
      this.draw();
      return true;
    }
    if (event.metaKey) return true;
    const command = this.commands()[this.commandIndex];
    if (command) this.addCombo(command.id, comboFromEvent(event));
    this.mode = "combos";
    this.selected = 0;
    this.draw();
    return true;
  }

  /**
   * @override
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  typed(event) {
    if (this.mode !== "combos" || this.deps.keyCommand(event) !== "Delete")
      return false;
    this.removeSelectedCombo();
    return true;
  }
}
