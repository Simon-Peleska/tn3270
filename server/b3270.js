import { spawn } from 'node:child_process';
import { AppError } from './errors.js';
import { logger } from './log.js';

/**
 * Indications we act on. b3270 emits many more (setting, thumb, tls-hello,
 * code-pages, ...); they arrive as RawIndication and are ignored by the
 * session, but still logged at debug level.
 *
 * @typedef {object} ScreenChange
 * @property {number} column 1-based.
 * @property {string} [text] Present for character changes.
 * @property {number} [count] Present for attribute-only runs.
 * @property {string} [fg]
 * @property {string} [bg]
 * @property {string} [gr] Comma-separated graphic rendition list.
 *
 * @typedef {object} ScreenRow
 * @property {number} row 1-based.
 * @property {ScreenChange[]} changes
 *
 * @typedef {object} ScreenCursor
 * @property {boolean} [enabled]
 * @property {number} [row] 1-based.
 * @property {number} [column] 1-based.
 *
 * @typedef {object} ScreenIndication
 * @property {ScreenCursor} [cursor]
 * @property {ScreenRow[]} [rows]
 *
 * @typedef {object} EraseIndication
 * @property {number} [logical-rows]
 * @property {number} [logical-columns]
 * @property {string} [fg]
 * @property {string} [bg]
 *
 * @typedef {object} ScreenModeIndication
 * @property {number} model
 * @property {number} rows
 * @property {number} columns
 * @property {boolean} color
 * @property {boolean} [oversize]
 * @property {boolean} [extended]
 *
 * @typedef {object} ModelInfo
 * @property {number} model
 * @property {number} rows
 * @property {number} columns
 *
 * @typedef {object} OiaIndication
 * @property {string} field
 * @property {string | boolean | number} [value]
 * @property {string} [lu]
 *
 * @typedef {object} ConnectionIndication
 * @property {string} state
 * @property {string} [host]
 * @property {string} [cause]
 *
 * @typedef {object} PopupIndication
 * @property {string} [type]
 * @property {string} [text]
 * @property {string} [error]
 *
 * @typedef {object} RunResultIndication
 * @property {string} [r-tag]
 * @property {boolean} success
 * @property {string[]} [text]
 * @property {boolean[]} [text-err]
 *
 * @typedef {object} UiErrorIndication
 * @property {boolean} [fatal]
 * @property {string} [text]
 * @property {string} [operation]
 *
 * @typedef {Record<string, unknown>} RawIndication
 */

/**
 * One decoded top-level indication: b3270 wraps each in a single-key object,
 * e.g. `{"screen": {...}}`. `initialize` is an array of nested indications,
 * which we flatten so the consumer sees one stream.
 *
 * @typedef {object} Indication
 * @property {string} kind
 * @property {unknown} body
 */

/**
 * @typedef {object} B3270Handlers
 * @property {(indication: Indication) => void} onIndication
 * @property {(code: number | null, signal: NodeJS.Signals | null) => void} onExit
 * @property {(err: unknown) => void} onError
 */

/**
 * @typedef {object} B3270Options
 * @property {string} path
 * @property {number} model
 * @property {Record<string, string>} settings b3270 resources, passed as -xrm.
 * @property {string[]} extraArgs
 * @property {string} sessionId
 * @property {B3270Handlers} handlers
 */

/**
 * b3270 accepts any of its resources on the command line as
 * `-xrm "b3270.<name>: <value>"`. A bare name is qualified here; a name that
 * already carries a qualifier (`b3270.oversize`, `*oversize`) is passed as
 * written, because a few resources need a different one.
 *
 * @param {Record<string, string>} settings
 * @returns {string[]}
 */
function resourceArgs(settings) {
  return Object.entries(settings).flatMap(([name, value]) => {
    const qualified = name.includes('.') || name.startsWith('*') ? name : `b3270.${name}`;
    return ['-xrm', `${qualified}: ${value}`];
  });
}

/**
 * Turns b3270's newline-delimited JSON on stdout into a stream of indications,
 * and accepts actions on stdin.
 */
export class B3270 {
  /** @param {B3270Options} options */
  constructor(options) {
    this.log = logger(`b3270/${options.sessionId}`);
    this.handlers = options.handlers;
    /** @type {string} */
    this.stdoutBuffer = '';
    /** @type {number} */
    this.nextTag = 1;
    /** @type {boolean} */
    this.stopped = false;

    const args = ['-json', '-model', String(options.model), ...resourceArgs(options.settings), ...options.extraArgs];
    this.log.info('spawning', { path: options.path, args: args.join(' ') });

    try {
      this.child = spawn(options.path, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // b3270 formats the `time` field of run-result with the C library's
        // locale, so under e.g. de_DE it emits `"time":0,011` — which is not
        // JSON and kills the line. Force the C locale for numbers.
        env: { ...process.env, LC_ALL: 'C', LC_NUMERIC: 'C' },
      });
    } catch (cause) {
      throw new AppError('E2001', options.path, cause);
    }

    this.child.on('error', (cause) => {
      this.handlers.onError(new AppError('E2001', options.path, cause));
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(String(chunk)));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.log.warn('stderr', { text: String(chunk).trimEnd() });
    });

    this.child.on('exit', (code, signal) => {
      this.log.info('exited', { code, signal });
      if (!this.stopped) {
        this.handlers.onError(new AppError('E2002', `code=${code} signal=${signal}`));
      }
      this.handlers.onExit(code, signal);
    });
  }

  /**
   * @param {string} chunk
   * @returns {void}
   */
  consume(chunk) {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  /**
   * @param {string} line
   * @returns {void}
   */
  handleLine(line) {
    this.log.debug('<<', { line: line.length > 400 ? `${line.slice(0, 400)}...` : line });

    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      this.handlers.onError(new AppError('E2003', line.slice(0, 200), cause));
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.handlers.onError(new AppError('E2003', `expected an object, got ${typeof parsed}`));
      return;
    }

    for (const [kind, body] of Object.entries(parsed)) {
      if (kind === 'initialize' && Array.isArray(body)) {
        for (const nested of body) this.dispatchObject(nested);
        continue;
      }
      this.handlers.onIndication({ kind, body });
    }
  }

  /**
   * @param {unknown} nested
   * @returns {void}
   */
  dispatchObject(nested) {
    if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return;
    for (const [kind, body] of Object.entries(nested)) {
      this.handlers.onIndication({ kind, body });
    }
  }

  /**
   * Submit one or more 3270 actions. They run asynchronously and may complete
   * out of order, which is why each batch carries a tag.
   *
   * @param {Array<{ action: string, args?: string[] }>} actions
   * @returns {string} the r-tag echoed back in the matching run-result
   */
  runActions(actions) {
    const tag = `t${this.nextTag++}`;
    const line = JSON.stringify({ run: { 'r-tag': tag, actions } });
    this.log.debug('>>', { line });

    if (this.stopped || !this.child.stdin.writable) {
      this.handlers.onError(new AppError('E2006', tag));
      return tag;
    }
    this.child.stdin.write(line + '\n');
    return tag;
  }

  /**
   * @param {string} host
   * @returns {string}
   */
  open(host) {
    return this.runActions([{ action: 'Open', args: [host] }]);
  }

  /** @returns {void} */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.log.info('stopping');
    // b3270 exits on stdin EOF, which is cleaner than a signal because it lets
    // the emulator close the host connection properly.
    if (this.child.stdin.writable) {
      this.child.stdin.write(JSON.stringify({ run: { actions: [{ action: 'Quit' }] } }) + '\n');
      this.child.stdin.end();
    }
    this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    this.killTimer.unref();
    this.child.once('exit', () => clearTimeout(this.killTimer));
  }
}
