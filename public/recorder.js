/**
 * The recorder panel: capture screens and keystrokes (password fields redacted)
 * and export them as JSON for an s3270 script to replay.
 */

import { Panel } from './panel.js';

/** @typedef {import('../server/protocol.js').RecorderStep} RecorderStep */

/**
 * @typedef {import('./panel.js').PanelDeps & {
 *   dispatch: (message: import('../server/protocol.js').ClientMessage) => void,
 *   exportFile: (filename: string, content: string) => void,
 * }} RecorderDeps
 */

/** @extends {Panel<RecorderDeps>} */
export class RecorderPage extends Panel {
  /** @param {RecorderDeps} deps */
  constructor(deps) {
    super('recorder', deps);
    this.toggleKey = 'KeyR';
    /** @type {boolean} */
    this.active = false;
    /** @type {{ recordedAt: string, steps: RecorderStep[] } | null} */
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
   * @override
   * @returns {import('./panel.js').PanelLine[]}
   */
  lines() {
    /** @type {import('./panel.js').PanelLine[]} */
    const lines = [];
    if (this.active) {
      const count = this.current?.steps.length ?? 0;
      lines.push({ option: '1', text: 'Recording', value: `${count} step${count === 1 ? '' : 's'} - Enter stops` });
    } else {
      lines.push({ option: '1', text: 'Record screen and keys', value: 'Enter starts' });
    }
    if (this.current !== null && !this.active) {
      const count = this.current.steps.length;
      lines.push({ option: '2', text: 'Export as JSON', value: `${count} step${count === 1 ? '' : 's'} - Enter exports` });
    }
    return lines;
  }

  /**
   * @override
   * @returns {string}
   */
  title() {
    return 'TN3270 Recorder';
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
    return [
      'A password field is never recorded, only noted.',
      'Commands: RECORD, STOP, EXPORT.',
    ];
  }

  /**
   * @override
   * @returns {string[]}
   */
  keys() {
    return ['F1=Help', 'F3=Exit', 'F4=Menu', 'F12=Cancel', 'Enter=Start/Stop'];
  }

  /**
   * @override
   * @returns {void}
   */
  show() {
    super.show();
    this.selected = 0;
  }

  /**
   * @override
   * @returns {void}
   */
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
   * @override
   * @param {string} word
   * @returns {boolean}
   */
  word(word) {
    if (word === 'RECORD' || word === 'REC') {
      if (!this.active) this.start();
      return true;
    }
    if (word === 'STOP') {
      this.stop();
      this.draw();
      return true;
    }
    if (word === 'EXPORT' || word === 'EXP') {
      this.exportRecording();
      return true;
    }
    return false;
  }
}
