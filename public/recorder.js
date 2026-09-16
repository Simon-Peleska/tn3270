/**
 * The recorder page: capture the whole screen and every keystroke aimed at a
 * session, redacting a password field down to a single marker, and export the
 * result as JSON shaped for a later s3270 script to replay. Drawn as VT bytes
 * into the terminal, exactly like settings.js and macros.js.
 */

import { ESC, at, mix, paint } from './settings.js';

/** @typedef {import('../server/protocol.js').RecorderStep} RecorderStep */

const LABEL_WIDTH = 26;
const FIELD_WIDTH = 28;
const PANEL_WIDTH = 62;

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
    if (event.altKey && event.code === 'KeyR') {
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
      const count = this.rows().length;
      const step = event.key === 'ArrowUp' ? -1 : 1;
      this.selected = (this.selected + step + count) % count;
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
    const { cols, rows } = this.deps.geometry();
    const colors = this.deps.theme().colors;
    const background = colors['background'] ?? '#000000';
    const foreground = colors['foreground'] ?? '#00ff00';
    const dim = mix(background, foreground, 0.55);
    const field = colors['field'] ?? mix(background, foreground, 0.12);
    const chosen = mix(field, foreground, 0.3);

    const fields = this.rows();
    const left = Math.max(1, Math.floor((cols - PANEL_WIDTH) / 2) + 1);
    const top = Math.max(1, Math.floor((rows - (10 + fields.length * 2)) / 2) + 1);

    /** @type {string[]} */
    const out = [`${ESC}[?25l`, paint(foreground, background), `${ESC}[2J`];

    out.push(at(top, left), paint(foreground, background, true), 'TN3270 RECORDER');
    out.push(at(top + 1, left), paint(dim, background), '='.repeat(PANEL_WIDTH));

    for (let index = 0; index < fields.length; index++) {
      const entry = fields[index];
      const row = top + 3 + index * 2;
      const active = index === this.selected;
      out.push(at(row, left), paint(active ? foreground : dim, background, active));
      out.push(`${active ? '>' : ' '} ${(entry?.label ?? '').slice(0, LABEL_WIDTH).padEnd(LABEL_WIDTH)}`);
      out.push(paint(foreground, active ? chosen : field));
      out.push(` ${(entry?.value ?? '').slice(0, FIELD_WIDTH - 2).padEnd(FIELD_WIDTH - 2)} `);
    }

    const helpRow = top + 3 + fields.length * 2 + 1;
    out.push(at(helpRow, left), paint(dim, background));
    out.push('Up/Down select   Enter start/stop/export   Esc close');
    out.push(at(helpRow + 1, left), paint(dim, background));
    out.push('A password field is never recorded, only noted.');

    this.deps.write(out.join(''));
  }
}
