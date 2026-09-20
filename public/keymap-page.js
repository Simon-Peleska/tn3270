/** The keymap dialog, drawn as VT bytes into the terminal like settings.js. */

import { cycle, drawListPanel } from './settings.js';
import { COMMANDS, DEFAULT_BINDINGS, buildLookup, comboFromEvent, comboLabel, serializeCombo, withDefaults } from './keymap.js';
import { keymapToText, parseKeymapText } from './keymap-format.js';

/** @typedef {import('./keymap.js').Bindings} Bindings */
/** @typedef {import('./keymap.js').Combo} Combo */

const LABEL_WIDTH = 22;
const FIELD_WIDTH = 32;
const VISIBLE_ROWS = 12;

/**
 * @param {Bindings} bindings
 * @returns {Bindings}
 */
function cloneBindings(bindings) {
  /** @type {Bindings} */
  const copy = {};
  for (const [commandId, combos] of Object.entries(bindings)) copy[commandId] = combos.map((combo) => ({ ...combo }));
  return copy;
}

/**
 * @typedef {object} KeymapDeps
 * @property {(bytes: string) => void} write
 * @property {() => { cols: number, rows: number }} geometry
 * @property {() => import('./settings.js').Theme} theme
 * @property {() => void} restore
 * @property {(bindings: Bindings) => void} persist
 * @property {(filename: string, content: string) => void} exportFile
 * @property {() => Promise<string[]>} importFiles empty when the picker was cancelled
 * @property {(code: string, message: string) => void} error
 */

export class KeymapPage {
  /** @param {KeymapDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {string} the Alt+key code that toggles this page */
    this.toggleKey = 'KeyK';
    /** @type {boolean} */
    this.open = false;
    /** @type {Bindings} */
    this.bindings = cloneBindings(DEFAULT_BINDINGS);
    /** @type {Map<string, string>} */
    this.lookupCache = buildLookup(this.bindings);
    /** @type {'commands' | 'combos' | 'listening'} */
    this.mode = 'commands';
    /** @type {number} index into COMMANDS */
    this.commandIndex = 0;
    /** @type {number} index into the command's combos; one past the end is "Add binding" */
    this.comboIndex = 0;
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
    this.deps.persist(this.bindings);
  }

  /**
   * @param {string} commandId
   * @returns {Combo[]}
   */
  combosFor(commandId) {
    return this.bindings[commandId] ?? [];
  }

  /**
   * A combo bound elsewhere is taken from its old command: one keystroke, one command.
   *
   * @param {string} commandId
   * @param {Combo} combo
   * @returns {void}
   */
  addCombo(commandId, combo) {
    const key = serializeCombo(combo);
    for (const [otherId, combos] of Object.entries(this.bindings)) {
      if (otherId === commandId) continue;
      const kept = combos.filter((existing) => serializeCombo(existing) !== key);
      if (kept.length !== combos.length) this.bindings[otherId] = kept;
    }
    const current = this.combosFor(commandId);
    if (!current.some((existing) => serializeCombo(existing) === key)) {
      this.bindings[commandId] = [...current, combo];
    }
    this.persist();
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

  /** @returns {void} */
  resetToDefaults() {
    this.bindings = cloneBindings(DEFAULT_BINDINGS);
    this.commandIndex = 0;
    this.mode = 'commands';
    this.persist();
  }

  /**
   * @returns {{ label: string, value: string }[]}
   */
  commandRows() {
    return COMMANDS.map((command) => ({
      label: command.label,
      value: this.combosFor(command.id).map(comboLabel).join(', ') || '(unbound)',
    }));
  }

  /**
   * @returns {{ label: string, value: string }[]}
   */
  comboRows() {
    const command = COMMANDS[this.commandIndex];
    const combos = command ? this.combosFor(command.id) : [];
    return [...combos.map((combo) => ({ label: comboLabel(combo), value: '' })), { label: '+ Add binding', value: '' }];
  }

  /** @returns {void} */
  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  /** @returns {void} */
  show() {
    this.open = true;
    this.mode = 'commands';
    this.commandIndex = 0;
    this.draw();
  }

  /** @returns {void} */
  close() {
    if (!this.open) return;
    this.open = false;
    this.mode = 'commands';
    this.deps.restore();
  }

  /**
   * @returns {void}
   */
  exportKeymap() {
    this.deps.exportFile('keymap.kmp', keymapToText(this.bindings));
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
        this.deps.error('E5012', `A keymap file could not be read: ${String(cause)}`);
        continue;
      }
      for (const [commandId, combos] of Object.entries(imported)) merged[commandId] = combos;
    }
    this.bindings = merged;
    this.commandIndex = 0;
    this.mode = 'commands';
    this.persist();
    if (this.open) this.draw();
  }

  /**
   * @param {KeyboardEvent} event
   * @returns {boolean} true when the page consumed the key
   */
  handleKey(event) {
    if (event.altKey && event.code === this.toggleKey) {
      this.toggle();
      return true;
    }
    if (!this.open) return false;

    if (this.mode === 'listening') {
      // A modifier key alone is a valid binding, so this mode sees everything.
      if (event.key === 'Escape') {
        this.mode = 'combos';
        this.draw();
        return true;
      }
      if (event.metaKey) return true;
      const command = COMMANDS[this.commandIndex];
      if (command) this.addCombo(command.id, comboFromEvent(event));
      this.mode = 'combos';
      this.comboIndex = 0;
      this.draw();
      return true;
    }

    // Reload, devtools and the rest belong to the browser even here.
    if (event.ctrlKey || event.metaKey) return false;

    if (event.key === 'Escape') {
      if (this.mode === 'combos') {
        this.mode = 'commands';
        this.draw();
        return true;
      }
      this.close();
      return true;
    }

    if (this.mode === 'commands') {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        this.commandIndex = cycle(this.commandIndex, event.key === 'ArrowUp' ? -1 : 1, COMMANDS.length);
        this.draw();
        return true;
      }
      if (event.key === 'Enter') {
        this.mode = 'combos';
        this.comboIndex = 0;
        this.draw();
        return true;
      }
      if (event.key === 'e' || event.key === 'E') {
        this.exportKeymap();
        return true;
      }
      if (event.key === 'i' || event.key === 'I') {
        this.importKeymap();
        return true;
      }
      if (event.key === 'r' || event.key === 'R') {
        this.resetToDefaults();
        this.draw();
        return true;
      }
      return true;
    }

    const command = COMMANDS[this.commandIndex];
    const rows = this.comboRows();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      this.comboIndex = cycle(this.comboIndex, event.key === 'ArrowUp' ? -1 : 1, rows.length);
      this.draw();
      return true;
    }
    if (event.key === 'Enter') {
      if (command && this.comboIndex === rows.length - 1) this.mode = 'listening';
      this.draw();
      return true;
    }
    if (event.key === 'Delete') {
      if (command && this.comboIndex < rows.length - 1) {
        this.removeCombo(command.id, this.comboIndex);
        this.comboIndex = Math.min(this.comboIndex, this.comboRows().length - 1);
      }
      this.draw();
      return true;
    }
    return true;
  }

  /** @returns {void} */
  draw() {
    const command = COMMANDS[this.commandIndex];
    const title = this.mode === 'commands' ? 'TN3270 KEYMAP' : `TN3270 KEYMAP - ${command?.label ?? ''}`;
    const allRows = this.mode === 'commands' ? this.commandRows() : this.comboRows();
    const selected = this.mode === 'commands' ? this.commandIndex : this.comboIndex;

    const scrollStart = Math.max(0, Math.min(selected - Math.floor(VISIBLE_ROWS / 2), allRows.length - VISIBLE_ROWS));
    const start = Math.max(0, scrollStart);
    const fields = allRows.slice(start, start + VISIBLE_ROWS);

    /** @type {string[]} */
    const helpLines = this.mode === 'listening'
      ? ['Press any key combination to bind it - Esc cancels']
      : this.mode === 'combos'
        ? ['Up/Down select   Enter add binding   Del remove   Esc back']
        : [
          'Up/Down select   Enter open   E export   I import   R reset to defaults',
          `${selected + 1}/${allRows.length}   Esc close`,
        ];

    drawListPanel({
      write: this.deps.write,
      geometry: this.deps.geometry,
      theme: this.deps.theme(),
      title,
      fields,
      selected: selected - start,
      labelWidth: LABEL_WIDTH,
      fieldWidth: FIELD_WIDTH,
      heightBase: 16,
      helpLines,
    });
  }
}
