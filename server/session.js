import { randomUUID } from 'node:crypto';
import { B3270 } from './b3270.js';
import { editableFieldText, fieldMap } from './readbuffer.js';
import { ScreenModel } from './screen.js';
import { OiaModel } from './oia.js';
import { fullRepaint, delta } from './vt.js';
import { AppError, describeError } from './errors.js';
import { isHostAllowed } from './protocol.js';
import { logger } from './log.js';

/**
 * Anything that can be sent screen bytes and control messages. Two methods, so
 * a test can attach a plain collector instead of a real WebSocket.
 *
 * @typedef {object} Viewer
 * @property {string} id
 * @property {'controller' | 'observer'} role
 * @property {boolean} hostColors Off paints every cell in this viewer's own
 *   theme instead of the mainframe's colours. Personal: neither the host nor
 *   the other viewers see it.
 * @property {string | null} fieldColor `#rrggbb` tinting the fields this viewer
 *   may type into, or null. Personal in the same way, and comes from its theme.
 * @property {(bytes: string) => void} sendScreen
 * @property {(message: import('./protocol.js').ServerMessage) => void} sendMessage
 */

/**
 * One host session: a b3270 process, the authoritative screen, and the viewers
 * watching it. It outlives them all — a reload, a dropped connection or a
 * second person on the same URL are attach and detach, and never disturb the
 * host connection.
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
    /** @type {number} b3270 confirms this in screen-mode. */
    this.model = config.b3270.model;
    /** @type {import('./b3270.js').ModelInfo[]} The models this b3270 offers. */
    this.models = [];
    /** @type {Set<Viewer>} */
    this.viewers = new Set();

    /** @type {string | null} The host as typed, kept for reconnecting. */
    this.lastHost = null;
    /** @type {boolean} Off refuses every viewer past the first: the controller's
     * own reconnect always gets back in, nobody else does. */
    this.allowSharing = true;
    /** @type {boolean} Whether a second and later viewer may type, not just
     * watch. Defaults from the config, and from then on is this session's own
     * setting, changed only by its controller. */
    this.allowSharedEditing = config.sessions.allowMultipleControllers;
    /** @type {boolean} Whether input has ever been aimed at this session. Set
     * here rather than in a browser because any viewer's typing counts, and
     * never cleared: a session the operator has used stays used. */
    this.touched = false;
    /** @type {number | null} A model waiting for the connection to go away. */
    this.pendingModel = null;
    /** @type {string} `<cols>x<rows>`, or '' for the model's own size. b3270
     * takes it as a resource, which the config may write bare or qualified. */
    this.oversize = config.b3270.settings['oversize']
      ?? config.b3270.settings['b3270.oversize']
      ?? config.b3270.settings['*oversize']
      ?? '';
    /** @type {string | null} An oversize waiting for the connection to go away. */
    this.pendingOversize = null;
    /** @type {string} What b3270 was told, not always what was asked for. */
    this.b3270Oversize = this.oversize;

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
    /** @type {Map<string, Viewer>} `copyField` requests waiting on a
     * `ReadBuffer` result, by the r-tag `runActions` handed back. */
    this.pendingFieldReads = new Map();
    /** @type {boolean} The host redrew since the field map was read. */
    this.fieldsStale = false;
    /** @type {string | null} The r-tag of the field-map read in flight. */
    this.fieldReadTag = null;
    /** @type {boolean} Whether the cursor is presently in a non-display
     * (password) field — kept current so typing into one is never recorded. */
    this.passwordField = false;
    /** @type {{ steps: import('./protocol.js').RecorderStep[] } | null} */
    this.recording = null;

    /** @type {() => void} */
    let announce = () => {};
    /** @type {Promise<void>} b3270 reports its real geometry and model list a
     * few milliseconds after it is spawned; describing the session to a browser
     * before that hands out a placeholder 24x80 and an empty model picker. */
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
    this.readyTimer = setTimeout(() => this.markReady(), 5000);
    this.readyTimer.unref();

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
    // says would silently land on telnet 23.
    this.lastHost = host;
    this.b3270.open(host);
  }

  /** @returns {void} */
  disconnect() {
    this.log.info('disconnecting');
    this.b3270.runActions([{ action: 'Disconnect' }]);
  }

  /**
   * The model is negotiated when the connection is made, so b3270 refuses to
   * change it while one is open. Drop, set, reopen — the restart the browser
   * warns about before asking for this.
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
    this.b3270.runActions(this.sizeActions(model));
  }

  /**
   * A screen bigger than the model's own, which is what makes b3270 negotiate
   * as IBM-DYNAMIC. Settled when the connection is made, like the model, so it
   * changes the same way.
   *
   * @param {string} value `<cols>x<rows>`, or '' for the model's own size
   * @returns {void}
   */
  setOversize(value) {
    if (value === this.oversize) return;
    this.log.info('changing oversize', { oversize: value, from: this.oversize });
    this.oversize = value;

    if (this.oia.connectionState !== 'not-connected') {
      this.pendingOversize = value;
      this.b3270.runActions([{ action: 'Disconnect' }]);
      return;
    }

    this.b3270.runActions(this.sizeActions(this.model));
  }

  /**
   * The one action that puts b3270 on a model at the size asked for. They are a
   * single setting to the emulator — an oversize is only legal against the model
   * it was measured for — so both always go in one `Set()`, which reconciles
   * them before applying either.
   *
   * Turning the oversize off asks for the model's own size rather than nothing:
   * b3270 4.5 clears the resource but forgets to resize the screen (Common/
   * model.c only calls `set_rows_cols()` for a non-empty oversize).
   *
   * @param {number} model
   * @returns {Array<{ action: string, args?: string[] }>}
   */
  sizeActions(model) {
    const info = this.models.find((entry) => entry.model === model);
    const asked = /^(\d+)x(\d+)$/.exec(this.oversize);
    const fits = asked !== null && info !== undefined
      && Number(asked[1]) >= info.columns && Number(asked[2]) >= info.rows;

    let oversize = this.oversize;
    if (!fits) {
      // A screen the new model has outgrown is no screen size at all.
      oversize = this.b3270Oversize === '' || info === undefined ? '' : `${info.columns}x${info.rows}`;
      this.oversize = '';
    }

    /** @type {string[]} */
    const args = [];
    if (model !== this.model) args.push('model', String(model));
    if (oversize !== this.b3270Oversize) args.push('oversize', oversize);
    this.b3270Oversize = oversize;

    return args.length > 0 ? [{ action: 'Set', args }] : [];
  }

  /**
   * @param {import('./b3270.js').Indication} indication
   * @returns {void}
   */
  handleIndication(indication) {
    const { kind, body } = indication;

    if (kind === 'screen') {
      this.screen.applyScreen(/** @type {import('./b3270.js').ScreenIndication} */ (body));
      this.fieldsStale = true;
      this.scheduleFlush();
      return;
    }
    if (kind === 'erase') {
      // A host that never writes to the alternate screen only ever uses the
      // model's default size, reported here rather than in a screen-mode; the
      // browser needs it too, or it shows the full model with dead space in it.
      const before = this.screenSize();
      this.screen.applyErase(/** @type {import('./b3270.js').EraseIndication} */ (body));
      this.announceResize(before);
      this.fieldsStale = true;
      this.scheduleFlush();
      return;
    }
    if (kind === 'screen-mode') {
      const mode = /** @type {import('./b3270.js').ScreenModeIndication} */ (body);
      const before = this.screenSize();
      this.model = mode.model;
      this.screen.applyScreenMode(mode);
      this.announceResize(before);
      this.markReady();
      this.scheduleFlush();
      return;
    }
    if (kind === 'models') {
      // The browser's picker is the emulator's own answer, not a second copy.
      if (Array.isArray(body)) {
        this.models = /** @type {import('./b3270.js').ModelInfo[]} */ (body);
      }
      return;
    }
    if (kind === 'oia') {
      const wasInsert = this.oia.insert;
      this.oia.applyOia(/** @type {import('./b3270.js').OiaIndication} */ (body));
      // The cursor shape is the only sign of insert mode, so it gets its own
      // push rather than waiting for a connection-state change.
      if (this.oia.insert !== wasInsert) this.broadcastStatus();
      this.scheduleFlush();
      return;
    }
    if (kind === 'connection') {
      const connection = /** @type {import('./b3270.js').ConnectionIndication} */ (body);
      this.log.info('connection state', { state: connection.state, host: connection.host ?? '' });
      this.oia.applyConnection(connection);
      this.broadcastStatus();
      this.scheduleFlush();
      if (connection.state === 'not-connected' && (this.pendingModel !== null || this.pendingOversize !== null)) {
        const model = this.pendingModel ?? this.model;
        this.log.info('applying the screen size the restart was for', {
          model,
          oversize: this.oversize,
          host: this.lastHost ?? '',
        });
        this.pendingModel = null;
        this.pendingOversize = null;
        const actions = this.sizeActions(model);
        if (this.lastHost !== null) actions.push({ action: 'Open', args: [this.lastHost] });
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
      const tag = result['r-tag'];

      if (tag !== undefined && tag === this.fieldReadTag) {
        this.fieldReadTag = null;
        if (result.success) {
          const { editable, hidden } = fieldMap(result.text ?? [], this.screen.rows, this.screen.cols);
          this.screen.applyFields(editable);
          this.updatePasswordField(hidden);
        }
        this.scheduleFlush();
        return;
      }

      const waitingViewer = tag !== undefined ? this.pendingFieldReads.get(tag) : undefined;
      if (waitingViewer !== undefined) {
        this.pendingFieldReads.delete(/** @type {string} */ (tag));
        // Nothing to copy is routine — every Ctrl+C outside a field lands here.
        const text = result.success ? editableFieldText(result.text ?? []) : null;
        if (text !== null) waitingViewer.sendMessage({ type: 'fieldContent', text });
        return;
      }
      if (!result.success) {
        const text = (result.text ?? []).join(' ');
        this.log.warn('action failed', { tag: result['r-tag'] ?? '', text });
        this.sendToAll({ type: 'error', code: 'E2005', message: text || 'action failed' });
      }
      return;
    }
  }

  /**
   * Indications arrive in bursts; one frame per burst keeps the wire quiet and
   * means no viewer ever sees a half-applied screen.
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

  /** @returns {boolean} Whether anyone needs the field map: a viewer tinting
   *  fields, or a recording that must know a password field the moment the
   *  host draws one. */
  wantsFieldMap() {
    if (this.recording !== null) return true;
    for (const viewer of this.viewers) {
      if (viewer.fieldColor !== null) return true;
    }
    return false;
  }

  /** @returns {void} */
  flush() {
    if (this.closed) return;

    // b3270's screen indications carry the character, its colour and its
    // highlighting, but not where the fields are, so that is asked for
    // separately — one read at a time, and the next flush picks up the rest.
    if (this.fieldsStale && this.fieldReadTag === null && this.wantsFieldMap()) {
      this.fieldsStale = false;
      this.fieldReadTag = this.b3270.runActions([{ action: 'ReadBuffer', args: ['Ascii'] }]);
    }

    const nextOia = this.oia.render(this.screen.cols, this.screen.cursor);
    const oiaChanged = nextOia !== this.oiaText;
    this.oiaText = nextOia;

    const dirtyRows = this.screen.takeDirtyRows();
    if (dirtyRows.length === 0 && !oiaChanged) return;

    // Encoded once per combination of display preferences in use, not once per
    // viewer: two browsers on the same theme share one.
    /** @type {Map<string, string>} */
    const encoded = new Map();
    for (const viewer of this.viewers) {
      const key = `${viewer.hostColors}|${viewer.fieldColor ?? ''}`;
      let bytes = encoded.get(key);
      if (bytes === undefined) {
        bytes = delta(this.screen, dirtyRows, this.oiaText, oiaChanged, viewer.hostColors, viewer.fieldColor);
        encoded.set(key, bytes);
      }
      if (bytes !== '') viewer.sendScreen(bytes);
    }
  }

  /** @returns {string} `<rows>x<cols>`, for spotting a resize. */
  screenSize() {
    return `${this.screen.rows}x${this.screen.cols}`;
  }

  /** @returns {string[]} The current screen, one plain-text line per row. */
  screenLines() {
    const lines = [];
    for (let row = 0; row < this.screen.rows; row++) lines.push(this.screen.rowText(row));
    return lines;
  }

  /**
   * @param {import('./protocol.js').RecorderStep} step
   * @returns {void}
   */
  pushRecorderStep(step) {
    if (this.recording === null) return;
    this.recording.steps.push(step);
    this.sendToAll({ type: 'recorderStep', step });
  }

  /**
   * @param {string} action
   * @param {string[]} [args]
   * @returns {void}
   */
  record(action, args = []) {
    if (this.recording === null) return;
    this.pushRecorderStep({ screen: this.screenLines(), action, args });
  }

  /**
   * A whole run of keystrokes typed into a password field collapses into this
   * one marker, so the recording never carries what was typed there.
   * @returns {void}
   */
  recordPassword() {
    if (this.recording === null) return;
    const steps = this.recording.steps;
    if (steps.length > 0 && steps[steps.length - 1].password === true) return;
    this.pushRecorderStep({ screen: this.screenLines(), password: true });
  }

  /**
   * @param {boolean[]} hidden row-major, from fieldMap()
   * @returns {void}
   */
  updatePasswordField(hidden) {
    const at = this.screen.cursor.row * this.screen.cols + this.screen.cursor.col;
    this.passwordField = hidden[at] ?? false;
  }

  /**
   * @param {string} before what screenSize() said before the indication
   * @returns {void}
   */
  announceResize(before) {
    if (this.screenSize() === before) return;
    this.log.info('screen size changed', { model: this.model, rows: this.screen.rows, cols: this.screen.cols });
    this.sendToAll({ type: 'screen', model: this.model, rows: this.screen.rows, cols: this.screen.cols, oversize: this.oversize });
    this.repaintAll();
  }

  /** @returns {void} Everyone gets a complete picture; there is no delta. */
  repaintAll() {
    this.oiaText = this.oia.render(this.screen.cols, this.screen.cursor);
    this.screen.takeDirtyRows();
    for (const viewer of this.viewers) {
      viewer.sendScreen(fullRepaint(this.screen, this.oiaText, viewer.hostColors, viewer.fieldColor));
    }
  }

  /**
   * @param {Viewer} viewer
   * @returns {void} One viewer gets a complete picture; the others see nothing.
   */
  repaint(viewer) {
    this.oiaText = this.oia.render(this.screen.cols, this.screen.cursor);
    viewer.sendScreen(fullRepaint(this.screen, this.oiaText, viewer.hostColors, viewer.fieldColor));
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  attach(viewer) {
    if (this.viewers.size >= this.config.sessions.maxViewersPerSession) {
      throw new AppError('E3003', `session ${this.id} already has ${this.viewers.size} viewers`);
    }
    if (!this.allowSharing && this.viewers.size > 0) {
      throw new AppError('E3007', `session ${this.id} has sharing turned off`);
    }

    const hasController = [...this.viewers].some((other) => other.role === 'controller');
    viewer.role = this.allowSharedEditing || !hasController ? 'controller' : 'observer';

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
      oversize: this.oversize,
      hostLocked: this.config.b3270.defaultHost !== null,
      role: viewer.role,
      viewers: this.viewers.size,
      allowSharing: this.allowSharing,
      allowSharedEditing: this.allowSharedEditing,
    });

    // The whole point of holding the screen here: a viewer joining an hour late
    // is immediately correct.
    this.repaint(viewer);
    this.broadcastStatus();
    // Nobody was reading the field map while there were no viewers wanting it.
    this.fieldsStale = true;
    this.scheduleFlush();
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  detach(viewer) {
    if (!this.viewers.delete(viewer)) return;
    this.log.info('viewer detached', { viewer: viewer.id, total: this.viewers.size });

    // Or the session would be permanently read-only.
    if (viewer.role === 'controller' && !this.allowSharedEditing) {
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
    // Your own screen back changes nothing for anyone else, so an observer may
    // ask — or closing the settings page would leave it stuck there.
    if (message.type === 'refresh') {
      this.repaint(viewer);
      return;
    }

    // Also this viewer's own preference, touching neither host nor the others.
    if (message.type === 'hostColors') {
      viewer.hostColors = message.enabled;
      this.repaint(viewer);
      return;
    }

    // Likewise, and the first viewer to ask is what makes the field map worth
    // reading at all.
    if (message.type === 'fieldColor') {
      viewer.fieldColor = message.color;
      this.fieldsStale = true;
      this.repaint(viewer);
      this.scheduleFlush();
      return;
    }

    if (viewer.role !== 'controller') {
      viewer.sendMessage({
        type: 'error',
        code: 'E3006',
        message: 'This session is being controlled by someone else.',
      });
      return;
    }

    // Input, as opposed to connecting or changing a setting. The browsers are
    // told the moment it first happens, because it is what stops them resizing
    // this session out from under the operator.
    if (!this.touched && (message.type === 'action' || message.type === 'text' || message.type === 'paste')) {
      this.touched = true;
      this.broadcastStatus();
    }

    switch (message.type) {
      case 'action':
        // A control key, never the field's own content, so it is always worth
        // recording — including the Enter that submits a password field.
        this.record(message.action, message.args ?? []);
        // b3270's Backspace is a real 3270 keyboard's: a non-destructive move
        // left. A PC keyboard expects a delete, which is these two actions —
        // and Delete already refuses to cross into a protected field.
        if (message.action === 'Backspace') {
          this.b3270.runActions([{ action: 'Left' }, { action: 'Delete' }]);
          return;
        }
        this.b3270.runActions([{ action: message.action, args: message.args ?? [] }]);
        return;
      case 'text':
        if (message.value !== '') {
          if (this.passwordField) this.recordPassword();
          else this.record('String', [message.value]);
          this.b3270.runActions([{ action: 'String', args: [message.value] }]);
        }
        return;
      case 'paste': {
        if (message.text !== '') {
          if (this.passwordField) this.recordPassword();
          else this.record('PasteString', [message.text]);
        }
        // PasteString, not String: a newline moves to the next field instead of
        // sending Enter, and a backslash is a backslash. Hex-encoded.
        const hex = Buffer.from(message.text, 'utf8').toString('hex');
        if (hex !== '') this.b3270.runActions([{ action: 'PasteString', args: [hex] }]);
        return;
      }
      case 'connect':
        // A configured host never reaches the browser, which then asks to
        // connect without naming one.
        this.connect(message.host ?? this.lastHost ?? '');
        return;
      case 'disconnect':
        this.disconnect();
        return;
      case 'model':
        this.setModel(message.model);
        return;
      case 'oversize':
        this.setOversize(message.value);
        return;
      case 'copyField': {
        const tag = this.b3270.runActions([{ action: 'ReadBuffer', args: ['Ascii', 'Field'] }]);
        this.pendingFieldReads.set(tag, viewer);
        return;
      }
      case 'sharing':
        this.allowSharing = message.allowView;
        this.allowSharedEditing = message.allowEdit;
        // Granted or withdrawn for everyone already here, not just the next
        // joiner: flipping the toggle takes effect immediately either way.
        for (const other of this.viewers) {
          if (other !== viewer) other.role = this.allowSharedEditing ? 'controller' : 'observer';
        }
        this.broadcastStatus();
        return;
      case 'recorder':
        this.recording = message.action === 'start' ? { steps: [] } : null;
        // Likewise, starting a recording is what makes the field map worth
        // reading — force a fresh one so a password field isn't missed.
        if (this.recording !== null) {
          this.fieldsStale = true;
          this.scheduleFlush();
        }
        return;
    }
  }

  /** @returns {void} */
  broadcastStatus() {
    for (const viewer of this.viewers) {
      viewer.sendMessage({
        type: 'status',
        connection: this.oia.connectionState,
        connected: this.oia.connected,
        touched: this.touched,
        host: this.oia.host,
        locked: this.oia.keyboardLocked,
        insert: this.oia.insert,
        role: viewer.role,
        viewers: this.viewers.size,
        allowSharing: this.allowSharing,
        allowSharedEditing: this.allowSharedEditing,
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
    clearTimeout(this.readyTimer);
    this.markReady();
    this.stopIdleTimer();
    this.log.info('closing', { viewers: this.viewers.size });
    this.b3270.stop();
    this.viewers.clear();
    if (this.onClosed) this.onClosed();
  }
}

/** Owns every live session and enforces the configured ceiling. */
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
