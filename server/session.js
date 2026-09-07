import { randomUUID } from 'node:crypto';
import { B3270 } from './b3270.js';
import { ScreenModel } from './screen.js';
import { OiaModel } from './oia.js';
import { fullRepaint, delta } from './vt.js';
import { AppError, describeError } from './errors.js';
import { isHostAllowed } from './protocol.js';
import { logger } from './log.js';

/**
 * A viewer is anything that can be sent screen bytes and control messages.
 * Keeping it to this two-method shape is what lets the tests attach a plain
 * collector object instead of a real WebSocket.
 *
 * @typedef {object} Viewer
 * @property {string} id
 * @property {'controller' | 'observer'} role
 * @property {boolean} hostColors Off paints every cell in this viewer's own
 *   theme instead of the mainframe's explicit colours; a purely personal
 *   display preference, not something the other viewers or the host see.
 * @property {(bytes: string) => void} sendScreen
 * @property {(message: import('./protocol.js').ServerMessage) => void} sendMessage
 */

/**
 * One host session: a b3270 process, the authoritative screen, and the set of
 * viewers watching it.
 *
 * The session deliberately outlives its viewers. A browser reload, a dropped
 * connection or a second person opening the same URL are all just attach and
 * detach; the host connection is never disturbed.
 */
export class Session {
  /**
   * @param {import('./config.js').Config} config
   * @param {string} [id]
   */
  constructor(config, id = randomUUID()) {
    /** @type {string} */
    this.id = id;
    /** @type {import('./config.js').Config} */
    this.config = config;
    this.log = logger(`session/${id.slice(0, 8)}`);

    /** @type {ScreenModel} */
    this.screen = new ScreenModel();
    /** @type {OiaModel} */
    this.oia = new OiaModel();
    /** @type {number} The 3270 model in force; b3270 confirms it in screen-mode. */
    this.model = config.b3270.model;
    /** @type {import('./b3270.js').ModelInfo[]} The models this b3270 offers. */
    this.models = [];
    /** @type {Set<Viewer>} */
    this.viewers = new Set();

    /** @type {string | null} The host string as typed, kept for reconnecting. */
    this.lastHost = null;
    /** @type {number | null} A model waiting for the connection to go away. */
    this.pendingModel = null;

    /** @type {string} */
    this.oiaText = '';
    /** @type {boolean} */
    this.oiaDirty = true;
    /** @type {boolean} */
    this.flushScheduled = false;
    /** @type {boolean} */
    this.closed = false;
    /** @type {NodeJS.Timeout | null} */
    this.idleTimer = null;
    /** @type {(() => void) | null} Called when the session tears itself down. */
    this.onClosed = null;

    /** @type {() => void} */
    let announce = () => {};
    /**
     * b3270 reports its real geometry and its model list a few milliseconds
     * after it is spawned. Anything that describes the session to a browser has
     * to wait for that, or it hands out the placeholder 24x80 and an empty model
     * picker.
     * @type {Promise<void>}
     */
    this.ready = new Promise((resolve) => {
      announce = resolve;
    });
    this.markReady = announce;

    this.b3270 = new B3270({
      path: config.b3270.path,
      model: config.b3270.model,
      settings: config.b3270.settings,
      extraArgs: config.b3270.extraArgs,
      sessionId: this.id,
      handlers: {
        onIndication: (indication) => this.handleIndication(indication),
        onExit: () => this.close(),
        onError: (err) => this.reportError(err),
      },
    });

    // Nothing may wait forever on an emulator that never speaks.
    const readyTimer = setTimeout(() => this.markReady(), 5000);
    readyTimer.unref();

    this.startIdleTimer();
  }

  /**
   * @param {string} host
   * @returns {void}
   */
  connect(host) {
    if (!isHostAllowed(host, this.config.security.allowedHosts)) {
      this.reportError(new AppError('E3005', host));
      return;
    }
    this.log.info('connecting', { host });
    // b3270 reports the host back without its port, so reopening from what it
    // says would silently land on telnet 23. Remember what was actually asked
    // for instead.
    this.lastHost = host;
    this.b3270.open(host);
  }

  /** @returns {void} */
  disconnect() {
    this.log.info('disconnecting');
    this.b3270.runActions([{ action: 'Disconnect' }]);
  }

  /**
   * Change the grid size. The 3270 model is negotiated with the host when the
   * connection is made, so b3270 refuses this outright while a connection is
   * open ("Cannot change model or oversize while connected"). The connection is
   * therefore dropped, the model set, and the same host reopened — which is the
   * restart the browser warns about before asking for this.
   *
   * @param {number} model
   * @returns {void}
   */
  setModel(model) {
    if (model === this.model) return;

    if (this.oia.connectionState !== 'not-connected') {
      this.log.info('restarting the connection to change the model', { model, host: this.lastHost ?? '' });
      this.pendingModel = model;
      this.b3270.runActions([{ action: 'Disconnect' }]);
      return;
    }

    this.log.info('changing model', { model, from: this.model });
    this.b3270.runActions([{ action: 'Set', args: ['model', String(model)] }]);
  }

  /**
   * @param {import('./b3270.js').Indication} indication
   * @returns {void}
   */
  handleIndication(indication) {
    const { kind, body } = indication;

    if (kind === 'screen') {
      this.screen.applyScreen(/** @type {import('./b3270.js').ScreenIndication} */ (body));
      this.scheduleFlush();
      return;
    }
    if (kind === 'erase') {
      this.screen.applyErase(/** @type {import('./b3270.js').EraseIndication} */ (body));
      this.scheduleFlush();
      return;
    }
    if (kind === 'screen-mode') {
      const mode = /** @type {import('./b3270.js').ScreenModeIndication} */ (body);
      const before = `${this.screen.rows}x${this.screen.cols}`;
      this.model = mode.model;
      this.screen.applyScreenMode(mode);
      if (`${this.screen.rows}x${this.screen.cols}` !== before) {
        this.log.info('screen mode changed', { model: this.model, rows: this.screen.rows, cols: this.screen.cols });
        this.sendToAll({ type: 'screen', model: this.model, rows: this.screen.rows, cols: this.screen.cols });
        this.repaintAll();
      }
      this.markReady();
      this.scheduleFlush();
      return;
    }
    if (kind === 'models') {
      // b3270 lists what it supports at startup, so the browser's picker is the
      // emulator's own answer rather than a second copy of the table.
      if (Array.isArray(body)) {
        this.models = /** @type {import('./b3270.js').ModelInfo[]} */ (body);
      }
      return;
    }
    if (kind === 'oia') {
      this.oia.applyOia(/** @type {import('./b3270.js').OiaIndication} */ (body));
      this.scheduleFlush();
      return;
    }
    if (kind === 'connection') {
      const connection = /** @type {import('./b3270.js').ConnectionIndication} */ (body);
      this.log.info('connection state', { state: connection.state, host: connection.host ?? '' });
      this.oia.applyConnection(connection);
      this.broadcastStatus();
      this.scheduleFlush();
      if (connection.state === 'not-connected' && this.pendingModel !== null) {
        const model = this.pendingModel;
        this.pendingModel = null;
        /** @type {Array<{ action: string, args?: string[] }>} */
        const actions = [{ action: 'Set', args: ['model', String(model)] }];
        if (this.lastHost !== null) actions.push({ action: 'Open', args: [this.lastHost] });
        this.log.info('applying the model the restart was for', { model, host: this.lastHost ?? '' });
        this.b3270.runActions(actions);
      }
      return;
    }
    if (kind === 'popup') {
      const popup = /** @type {import('./b3270.js').PopupIndication} */ (body);
      const text = popup.text ?? popup.error ?? '';
      this.log.warn('popup from emulator', { type: popup.type ?? '', text });
      this.sendToAll({ type: 'error', code: 'E2004', message: text });
      return;
    }
    if (kind === 'ui-error') {
      const uiError = /** @type {import('./b3270.js').UiErrorIndication} */ (body);
      this.reportError(new AppError('E2004', uiError.text ?? 'protocol error'));
      return;
    }
    if (kind === 'run-result') {
      const result = /** @type {import('./b3270.js').RunResultIndication} */ (body);
      if (!result.success) {
        const text = (result.text ?? []).join(' ');
        this.log.warn('action failed', { tag: result['r-tag'] ?? '', text });
        this.sendToAll({ type: 'error', code: 'E2005', message: text || 'action failed' });
      }
      return;
    }
  }

  /**
   * Indications arrive in bursts. Coalescing a burst into a single frame keeps
   * the wire quiet and means viewers never see a half-applied screen.
   * @returns {void}
   */
  scheduleFlush() {
    if (this.flushScheduled || this.closed) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  /** @returns {void} */
  flush() {
    if (this.closed) return;

    const nextOia = this.oia.render(this.screen.cols, this.screen.cursor);
    const oiaChanged = nextOia !== this.oiaText;
    this.oiaText = nextOia;

    const dirtyRows = this.screen.takeDirtyRows();
    if (dirtyRows.length === 0 && !oiaChanged) return;

    // Viewers may not agree on whether host colours should show, so the delta
    // is encoded once per preference actually in use rather than once overall.
    /** @type {string | null} */
    let withColors = null;
    /** @type {string | null} */
    let withoutColors = null;
    for (const viewer of this.viewers) {
      if (viewer.hostColors) {
        withColors ??= delta(this.screen, dirtyRows, this.oiaText, oiaChanged, true);
        if (withColors !== '') viewer.sendScreen(withColors);
      } else {
        withoutColors ??= delta(this.screen, dirtyRows, this.oiaText, oiaChanged, false);
        if (withoutColors !== '') viewer.sendScreen(withoutColors);
      }
    }
  }

  /**
   * Send every viewer a complete picture. Used when the screen is resized, when
   * there is no sensible delta to compute.
   * @returns {void}
   */
  repaintAll() {
    this.oiaText = this.oia.render(this.screen.cols, this.screen.cursor);
    this.screen.takeDirtyRows();
    for (const viewer of this.viewers) this.repaint(viewer);
  }

  /**
   * Send one viewer a complete picture, without disturbing the others.
   * @param {Viewer} viewer
   * @returns {void}
   */
  repaint(viewer) {
    this.oiaText = this.oia.render(this.screen.cols, this.screen.cursor);
    viewer.sendScreen(fullRepaint(this.screen, this.oiaText, viewer.hostColors));
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  attach(viewer) {
    if (this.viewers.size >= this.config.sessions.maxViewersPerSession) {
      throw new AppError('E3003', `session ${this.id} already has ${this.viewers.size} viewers`);
    }

    const hasController = [...this.viewers].some((other) => other.role === 'controller');
    viewer.role =
      this.config.sessions.allowMultipleControllers || !hasController ? 'controller' : 'observer';

    this.viewers.add(viewer);
    this.stopIdleTimer();
    this.log.info('viewer attached', { viewer: viewer.id, role: viewer.role, total: this.viewers.size });

    viewer.sendMessage({
      type: 'hello',
      sessionId: this.id,
      rows: this.screen.rows,
      cols: this.screen.cols,
      model: this.model,
      models: this.models,
      hostLocked: this.config.b3270.defaultHost !== null,
      role: viewer.role,
      viewers: this.viewers.size,
    });

    // The whole point of holding the screen on the server: a viewer that joins
    // an hour late is immediately correct.
    this.repaint(viewer);
    this.broadcastStatus();
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  detach(viewer) {
    if (!this.viewers.delete(viewer)) return;
    this.log.info('viewer detached', { viewer: viewer.id, total: this.viewers.size });

    // Promote someone so the session does not become permanently read-only.
    if (viewer.role === 'controller' && !this.config.sessions.allowMultipleControllers) {
      const next = this.viewers.values().next();
      if (!next.done) {
        next.value.role = 'controller';
        this.log.info('promoted viewer to controller', { viewer: next.value.id });
      }
    }

    this.broadcastStatus();
    if (this.viewers.size === 0) this.startIdleTimer();
  }

  /**
   * @param {Viewer} viewer
   * @param {import('./protocol.js').ClientMessage} message
   * @returns {void}
   */
  handleClientMessage(viewer, message) {
    // Asking for your own screen back changes nothing for anyone else, so an
    // observer may do it — otherwise closing the settings page would leave an
    // observer staring at it.
    if (message.type === 'refresh') {
      this.repaint(viewer);
      return;
    }

    // Whether to show host colours is this viewer's own preference, not
    // something that touches the host or the other viewers, so it needs no
    // controller role either.
    if (message.type === 'hostColors') {
      viewer.hostColors = message.enabled;
      this.repaint(viewer);
      return;
    }

    if (viewer.role !== 'controller') {
      viewer.sendMessage({
        type: 'error',
        code: 'E4003',
        message: 'This session is being controlled by someone else.',
      });
      return;
    }

    switch (message.type) {
      case 'action':
        this.b3270.runActions([{ action: message.action, args: message.args ?? [] }]);
        return;
      case 'text':
        if (message.value !== '') {
          this.b3270.runActions([{ action: 'String', args: [message.value] }]);
        }
        return;
      case 'connect':
        // A configured host is never sent to the browser, so a page that cannot
        // see it asks to connect without naming one.
        this.connect(message.host ?? this.lastHost ?? '');
        return;
      case 'disconnect':
        this.disconnect();
        return;
      case 'model':
        this.setModel(message.model);
        return;
    }
  }

  /** @returns {void} */
  broadcastStatus() {
    for (const viewer of this.viewers) {
      viewer.sendMessage({
        type: 'status',
        connection: this.oia.connectionState,
        host: this.oia.host,
        locked: this.oia.keyboardLocked,
        role: viewer.role,
        viewers: this.viewers.size,
      });
    }
  }

  /**
   * @param {import('./protocol.js').ServerMessage} message
   * @returns {void}
   */
  sendToAll(message) {
    for (const viewer of this.viewers) viewer.sendMessage(message);
  }

  /**
   * @param {unknown} err
   * @returns {void}
   */
  reportError(err) {
    this.log.error(err, { session: this.id });
    const { code, summary } = describeError(err);
    this.sendToAll({ type: 'error', code, message: summary });
  }

  /** @returns {void} */
  startIdleTimer() {
    this.stopIdleTimer();
    const timeout = this.config.sessions.idleTimeoutMs;
    if (timeout <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.log.info('idle timeout reached, closing');
      this.close();
    }, timeout);
    this.idleTimer.unref();
  }

  /** @returns {void} */
  stopIdleTimer() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** @returns {void} */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.markReady();
    this.stopIdleTimer();
    this.log.info('closing', { viewers: this.viewers.size });
    this.b3270.stop();
    this.viewers.clear();
    if (this.onClosed) this.onClosed();
  }
}

/**
 * Owns every live session and enforces the configured ceiling.
 */
export class SessionRegistry {
  /** @param {import('./config.js').Config} config */
  constructor(config) {
    this.config = config;
    this.log = logger('registry');
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
  }

  /** @returns {Session} */
  create() {
    if (this.sessions.size >= this.config.sessions.maxSessions) {
      throw new AppError('E3002', `${this.sessions.size} sessions are already open`);
    }
    const session = new Session(this.config);
    session.onClosed = () => {
      this.sessions.delete(session.id);
      this.log.info('session removed', { session: session.id, remaining: this.sessions.size });
    };
    this.sessions.set(session.id, session);
    this.log.info('session created', { session: session.id, total: this.sessions.size });

    if (this.config.b3270.defaultHost !== null) session.connect(this.config.b3270.defaultHost);
    return session;
  }

  /**
   * @param {string} id
   * @returns {Session}
   */
  get(id) {
    const session = this.sessions.get(id);
    if (session === undefined) throw new AppError('E3001', id);
    return session;
  }

  /** @returns {Array<{ id: string, viewers: number, connection: string, host: string | null }>} */
  list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      viewers: session.viewers.size,
      connection: session.oia.connectionState,
      host: session.oia.host,
    }));
  }

  /** @returns {void} */
  closeAll() {
    for (const session of [...this.sessions.values()]) session.close();
  }
}
