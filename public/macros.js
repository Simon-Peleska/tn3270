/**
 * The macros page: record a sequence of keystrokes, save it, play it back, and
 * trade it with other Host On-Demand users as XML. Drawn as VT bytes into the
 * terminal, exactly like settings.js, and for the same reason — there is
 * already a renderer and a keyboard aimed at it here.
 */

import { cycle, drawListPanel } from './settings.js';
import { macrosToXml, parseMacrosXml } from './macro-xml.js';

/** @typedef {import('./macro-xml.js').Macro} Macro */
/** @typedef {import('./macro-xml.js').MacroStep} MacroStep */

const LABEL_WIDTH = 22;
const FIELD_WIDTH = 32;

/**
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'macro';
}

/**
 * @typedef {object} MacrosDeps
 * @property {(bytes: string) => void} write
 * @property {() => { cols: number, rows: number }} geometry
 * @property {() => import('./settings.js').Theme} theme drawn in the app's
 *   current theme, which this page does not otherwise know about
 * @property {(message: import('../server/protocol.js').ClientMessage) => void} dispatch
 *   sends a step during playback, bypassing the recording tap in app.js's own
 *   `send()` so played-back keystrokes are never recorded into themselves
 * @property {() => Promise<void>} waitForUnlock resolves once the keyboard
 *   unlocks, so playback is paced by the host rather than by a timer
 * @property {() => void} restore called when the page closes, to get the host
 *   screen back
 * @property {(macros: Macro[]) => void} persist
 * @property {(filename: string, content: string) => void} exportFile
 * @property {() => Promise<string[]>} importFiles the text of every XML file
 *   picked, or [] if the picker was cancelled
 * @property {(code: string, message: string) => void} error
 */

export class MacrosPage {
  /** @param {MacrosDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {boolean} */
    this.open = false;
    /** @type {number} Index into rows(). */
    this.selected = 0;
    /** @type {Macro[]} */
    this.macros = [];
    /** @type {{ steps: MacroStep[], pendingText: string } | null} */
    this.recording = null;
    /** @type {{ macro: Macro, active: boolean } | null} */
    this.playing = null;
    /** @type {{ kind: 'save', steps: MacroStep[] } | { kind: 'rename', index: number } | null}
     * a finished recording awaiting a name, or an existing macro being renamed */
    this.naming = null;
    /** @type {string} text being typed for this.naming */
    this.nameBuffer = '';
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
   * Called from app.js's `send()` for every message a real keystroke or paste
   * produces, while a recording is running. Anything that is not typed text,
   * pasted text, or a 3270 action (a host switch, a model change, a copy
   * request...) is simply not a macro step and is ignored here.
   *
   * @param {import('../server/protocol.js').ClientMessage} message
   * @returns {void}
   */
  record(message) {
    if (this.recording === null) return;
    if (message.type === 'text') this.recording.pendingText += message.value;
    else if (message.type === 'paste') this.recording.pendingText += message.text;
    else if (message.type === 'action') {
      this.recording.steps.push({ text: this.recording.pendingText, action: message.action, args: message.args ?? [] });
      this.recording.pendingText = '';
    }
    if (this.open) this.draw();
  }

  /**
   * @param {string} name
   * @param {number} [excluding] an index in this.macros to leave out of the
   *   collision check, when the name belongs to the macro being renamed
   * @returns {string}
   */
  uniqueName(name, excluding = -1) {
    const taken = new Set(this.macros.filter((_, index) => index !== excluding).map((macro) => macro.name));
    if (!taken.has(name)) return name;
    let n = 2;
    while (taken.has(`${name} (${n})`)) n += 1;
    return `${name} (${n})`;
  }

  /** @returns {void} */
  startRecording() {
    this.recording = { steps: [], pendingText: '' };
    this.close();
  }

  /** @returns {void} */
  stopRecording() {
    if (this.recording === null) return;
    const steps = this.recording.steps.slice();
    if (this.recording.pendingText !== '') steps.push({ text: this.recording.pendingText, action: '', args: [] });
    this.recording = null;
    this.naming = { kind: 'save', steps };
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
      if (step.text !== '') this.deps.dispatch({ type: 'paste', text: step.text });
      if (step.action !== '') {
        this.deps.dispatch({ type: 'action', action: step.action, args: step.args });
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
    this.marked = new Set([...this.marked].filter((i) => i !== index).map((i) => (i > index ? i - 1 : i)));
    this.persist();
    this.selected = Math.min(this.selected, this.rows().length - 1);
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
    const chosen = indices.map((index) => this.macros[index]).filter((macro) => macro !== undefined);
    if (chosen.length === 0) return;
    const filename = chosen.length === 1 ? `${sanitizeFilename(chosen[0].name)}.xml` : 'macros.xml';
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
        this.deps.error('E5010', `A macro file could not be read: ${String(cause)}`);
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
    if (name === '' || this.naming === null) return;
    if (this.naming.kind === 'save') {
      this.macros.push({ name: this.uniqueName(name), steps: this.naming.steps });
    } else {
      const macro = this.macros[this.naming.index];
      if (macro) macro.name = this.uniqueName(name, this.naming.index);
    }
    this.naming = null;
    this.persist();
    this.nameBuffer = '';
  }

  /**
   * The rows of the page, top to bottom. The first is always the transport
   * control; one follows for every saved macro.
   *
   * @returns {{ key: string, label: string, value: string }[]}
   */
  rows() {
    /** @type {{ key: string, label: string, value: string }[]} */
    const rows = [];
    if (this.recording !== null) {
      const count = this.recording.steps.length;
      rows.push({ key: 'control', label: 'Recording...', value: `${count} step${count === 1 ? '' : 's'} - Enter stops` });
    } else if (this.naming?.kind === 'save') {
      rows.push({ key: 'name', label: 'Save as', value: `${this.nameBuffer}_` });
    } else if (this.playing !== null) {
      rows.push({ key: 'control', label: `Playing "${this.playing.macro.name}"`, value: 'Enter stops' });
    } else {
      rows.push({ key: 'new', label: 'Record new macro', value: 'Enter starts' });
    }
    this.macros.forEach((macro, index) => {
      if (this.naming?.kind === 'rename' && this.naming.index === index) {
        rows.push({ key: 'name', label: 'Rename', value: `${this.nameBuffer}_` });
        return;
      }
      const mark = this.marked.has(index) ? '[x] ' : '[ ] ';
      const count = macro.steps.length;
      rows.push({ key: 'macro', label: mark + macro.name, value: `${count} step${count === 1 ? '' : 's'}` });
    });
    return rows;
  }

  /**
   * @param {number} rowIndex
   * @returns {number | null} the index into this.macros the row shows, or
   *   null for the transport control row
   */
  macroIndexAt(rowIndex) {
    if (rowIndex < 1) return null;
    const index = rowIndex - 1;
    return index < this.macros.length ? index : null;
  }

  /** @returns {void} */
  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  /** @returns {void} */
  show() {
    this.open = true;
    this.selected = 0;
    this.draw();
  }

  /** @returns {void} */
  close() {
    if (!this.open) return;
    this.open = false;
    this.deps.restore();
  }

  /** @returns {void} */
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
   * @param {KeyboardEvent} event
   * @returns {boolean} true when the page consumed the key
   */
  handleKey(event) {
    if (event.altKey && event.code === 'KeyM') {
      this.toggle();
      return true;
    }
    if (!this.open) return false;
    // Reload, devtools and the rest belong to the browser even here.
    if (event.ctrlKey || event.metaKey) return false;

    if (event.key === 'Escape') {
      if (this.naming !== null) {
        this.naming = null;
        this.nameBuffer = '';
        this.draw();
        return true;
      }
      this.close();
      return true;
    }

    // A name field, not a value to cycle, so it takes its own keys first.
    if (this.naming !== null) {
      if (event.key === 'Backspace') {
        this.nameBuffer = this.nameBuffer.slice(0, -1);
        this.draw();
        return true;
      }
      if (event.key === 'Enter') {
        this.confirmName();
        this.draw();
        return true;
      }
      if (event.key.length === 1 && !event.altKey) {
        this.nameBuffer += event.key;
        this.draw();
        return true;
      }
      return true;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const step = event.key === 'ArrowUp' ? -1 : 1;
      this.selected = cycle(this.selected, step, this.rows().length);
      this.draw();
      return true;
    }
    if (event.key === 'Enter') {
      this.activate();
      return true;
    }
    if (event.key === ' ') {
      const index = this.macroIndexAt(this.selected);
      if (index !== null) {
        if (this.marked.has(index)) this.marked.delete(index);
        else this.marked.add(index);
        this.draw();
      }
      return true;
    }
    if (event.key === 'r' || event.key === 'R') {
      const index = this.macroIndexAt(this.selected);
      if (index !== null) {
        this.naming = { kind: 'rename', index };
        this.nameBuffer = this.macros[index]?.name ?? '';
        this.draw();
      }
      return true;
    }
    if (event.key === 'Delete') {
      const index = this.macroIndexAt(this.selected);
      if (index !== null) this.removeMacro(index);
      return true;
    }
    if (event.key === 'e' || event.key === 'E') {
      this.exportSelection();
      return true;
    }
    if (event.key === 'i' || event.key === 'I') {
      this.importMacros();
      return true;
    }
    // Everything else is swallowed: the host must not see keystrokes aimed at
    // a page it cannot see.
    return true;
  }

  /** @returns {void} */
  draw() {
    drawListPanel({
      write: this.deps.write,
      geometry: this.deps.geometry,
      theme: this.deps.theme(),
      title: 'TN3270 MACROS',
      fields: this.rows(),
      selected: this.selected,
      labelWidth: LABEL_WIDTH,
      fieldWidth: FIELD_WIDTH,
      heightBase: 16,
      helpLines: [
        'Up/Down select   Enter start/stop/play   Space mark',
        'R rename   Del remove   E export   I import   Esc close',
      ],
    });
  }
}
