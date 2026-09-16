/**
 * The recorder page: capture the whole screen and every keystroke aimed at a
 * session, redacting a password field down to a single marker, and export the
 * result as JSON shaped for a later s3270 script to replay. Drawn as VT bytes
 * into the terminal, exactly like settings.js and macros.js.
 */

import { cycle, drawListPanel } from './settings.js';

/** @typedef {import('../server/protocol.js').RecorderStep} RecorderStep */

const LABEL_WIDTH = 26;
const FIELD_WIDTH = 28;

/**
 * @typedef {object} RecorderDeps
 * @property {(bytes: string) => void} write
 * @property {() => { cols: number, rows: number }} geometry
 * @property {() => import('./settings.js').Theme} theme
 * @property {(message: import('../server/protocol.js').ClientMessage) => void} dispatch
 *   tells the server to start or stop recording this session
 * @property {() => void} restore called when the page closes, to get the host
 *   screen back
 * @property {(filename: string, content: string) => void} exportFile
 */

export class RecorderPage {
  /** @param {RecorderDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {string} the Alt+key KeyboardEvent.code that toggles this page */
    this.toggleKey = 'KeyR';
    /** @type {boolean} */
    this.open = false;
    /** @type {number} Index into rows(). */
    this.selected = 0;
    /** @type {boolean} */
    this.active = false;
    /** @type {{ recordedAt: string, steps: RecorderStep[] } | null} the most
     *  recent recording, live or finished — there is only ever one. */
    this.current = null;
  }

  /** @returns {boolean} */
  isRecording() {
    return this.active;
  }

  /** @returns {void} */
  start() {
    this.active = true;
    this.current = { recordedAt: new Date().toISOString(), steps: [] };
    this.deps.dispatch({ type: 'recorder', action: 'start' });
    this.close();
  }

  /** @returns {void} */
  stop() {
    if (!this.active) return;
    this.active = false;
    this.deps.dispatch({ type: 'recorder', action: 'stop' });
  }

  /**
   * Called from app.js's handleServerMessage for every step the server sends
   * while this session is being recorded.
   *
   * @param {RecorderStep} step
   * @returns {void}
   */
  record(step) {
    if (this.current === null) return;
    this.current.steps.push(step);
    if (this.open) this.draw();
  }

  /** @returns {void} */
  exportRecording() {
    if (this.current === null) return;
    const filename = `recording-${this.current.recordedAt.replace(/[:.]/g, '-')}.json`;
    const content = JSON.stringify(this.current, null, 2);
    this.deps.exportFile(filename, content);
  }

  /**
   * @returns {{ label: string, value: string }[]}
   */
  rows() {
    /** @type {{ label: string, value: string }[]} */
    const rows = [];
    if (this.active) {
      const count = this.current?.steps.length ?? 0;
      rows.push({ label: 'Recording...', value: `${count} step${count === 1 ? '' : 's'} - Enter stops` });
    } else {
      rows.push({ label: 'Record screen and keystrokes', value: 'Enter starts' });
    }
    if (this.current !== null && !this.active) {
      const count = this.current.steps.length;
      rows.push({ label: 'Export as JSON', value: `${count} step${count === 1 ? '' : 's'} - Enter exports` });
    }
    return rows;
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
      if (this.active) this.stop();
      else this.start();
      this.draw();
      return;
    }
    if (this.selected === 1) this.exportRecording();
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
    // Reload, devtools and the rest belong to the browser even here.
    if (event.ctrlKey || event.metaKey) return false;

    if (event.key === 'Escape') {
      this.close();
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
      title: 'TN3270 RECORDER',
      fields: this.rows(),
      selected: this.selected,
      labelWidth: LABEL_WIDTH,
      fieldWidth: FIELD_WIDTH,
      heightBase: 10,
      helpLines: [
        'Up/Down select   Enter start/stop/export   Esc close',
        'A password field is never recorded, only noted.',
      ],
    });
  }
}
