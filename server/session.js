import { randomUUID } from "node:crypto";
import { B3270 } from "./b3270.js";
import { editableFieldText, fieldMap } from "./readbuffer.js";
import { pasteSegments } from "./paste.js";
import { editableSnapshot, changedRuns } from "./history.js";
import { computeHints } from "./hints.js";
import { ScreenModel } from "./screen.js";
import { OiaModel } from "./oia.js";
import { fullRepaint, delta } from "./vt.js";
import { AppError, describeError } from "./errors.js";
import { isHostAllowed } from "./protocol.js";
import { reserveRestEndpoint } from "./restproxy.js";
import { logger } from "./log.js";

/**
 * @typedef {object} Viewer
 * @property {string} id
 * @property {'controller' | 'observer'} role
 * @property {boolean} hostColors Per-viewer, not shared with host or others.
 * @property {string | null} fieldColor `#rrggbb` tint for editable fields.
 * @property {string} [ip]
 * @property {string} [user]
 * @property {(bytes: string) => void} sendScreen
 * @property {(message: import('./protocol.js').ServerMessage) => void} sendMessage
 */

/** Deep enough for a screen's worth of typing, shallow enough to forget. */
const HISTORY_LIMIT = 100;

/** The keys that hand the screen to the host. @type {ReadonlySet<string>} */
const AID_ACTIONS = new Set([
  "Enter",
  "PF",
  "PA",
  "Clear",
  "Attn",
  "SysReq",
  "CursorSelect",
]);

export class Session {
  /**
   * @param {import('./config.js').Config} config
   * @param {import('./restproxy.js').RestEndpoint | null} [rest] null leaves
   *   b3270 without an httpd, which only tests want.
   * @param {string} [id]
   */
  constructor(config, rest = null, id = randomUUID()) {
    /** @type {string} */
    this.id = id;
    /** @type {import('./config.js').Config} */
    this.config = config;
    this.log = logger("session", { session: id });

    /** @type {ScreenModel} */
    this.screen = new ScreenModel();
    /** @type {OiaModel} */
    this.oia = new OiaModel();
    /** @type {number} b3270 confirms this in screen-mode. */
    this.model = config.b3270.model;
    /** @type {import('./b3270.js').ModelInfo[]} */
    this.models = [];
    /** @type {Set<Viewer>} */
    this.viewers = new Set();

    /** @type {string | null} */
    this.lastHost = null;
    /** @type {boolean} */
    this.allowSharing = true;
    /** @type {boolean} */
    this.allowSharedEditing = config.sessions.allowMultipleControllers;
    /** @type {boolean} Whether REST calls over the proxy may drive this session. */
    this.allowAutomation = config.sessions.allowAutomation;
    /** @type {boolean} Any viewer's input sets this, and it is never cleared. */
    this.touched = false;
    /** @type {number | null} A model waiting for the connection to go away. */
    this.pendingModel = null;
    /** @type {string} `<cols>x<rows>`, or '' for the model's own size. */
    this.oversize =
      config.b3270.settings["oversize"] ??
      config.b3270.settings["b3270.oversize"] ??
      config.b3270.settings["*oversize"] ??
      "";
    /** @type {boolean} Whether an oversize is waiting for the connection to go
     * away. The size itself is already in `oversize`. */
    this.pendingOversize = false;
    /** @type {string} What b3270 was told, not always what was asked for. */
    this.b3270Oversize = this.oversize;

    /** @type {string} */
    this.oiaText = "";
    /** @type {boolean} */
    this.oiaDirty = true;
    /** @type {boolean} */
    this.flushScheduled = false;
    /** @type {boolean} */
    this.closed = false;
    /** @type {NodeJS.Timeout | null} */
    this.idleTimer = null;
    /** @type {(() => void) | null} */
    this.onClosed = null;
    /** @type {Map<string, Viewer>} `copyField` requests by r-tag. */
    this.pendingFieldReads = new Map();
    /** @type {boolean} The host redrew since the field map was read. */
    this.fieldsStale = false;
    /** @type {string | null} The r-tag of the field-map read in flight. */
    this.fieldReadTag = null;
    /** @type {boolean} Cursor is in a non-display field; never record typing there. */
    this.passwordField = false;
    /** @type {{ steps: import('./protocol.js').RecorderStep[] } | null} */
    this.recording = null;

    /** @type {import('./history.js').Snapshot | null} What the fields hold now. */
    this.snapshot = null;
    /** @type {import('./history.js').Snapshot[]} States to undo back through. */
    this.undoStack = [];
    /** @type {import('./history.js').Snapshot[]} States undone, to redo forward. */
    this.redoStack = [];
    /** @type {string | null} The r-tag of a restore in flight. Its erases and
     * retypes pass over states that were never the user's, so they are not
     * history. */
    this.historyTag = null;

    /** @type {() => void} */
    this.markReady = () => {};
    /** @type {Promise<void>} b3270 reports its geometry and model list a few ms
     * after spawn; describing the session earlier hands out a placeholder 24x80. */
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });

    this.b3270 = new B3270({
      path: config.b3270.path,
      model: config.b3270.model,
      settings: config.b3270.settings,
      extraArgs: config.b3270.extraArgs,
      rest,
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
      this.reportError(new AppError("E3005", host));
      return;
    }
    this.log.info("connecting", { host });
    // b3270 reports the host back without its port, so reopening from what it
    // says would silently land on telnet 23.
    this.lastHost = host;
    this.b3270.open(host);
  }

  /** @returns {void} */
  disconnect() {
    this.log.info("disconnecting");
    this.b3270.runActions([{ action: "Disconnect" }]);
  }

  /**
   * b3270 refuses to change the model while connected, so drop, set, reopen.
   *
   * @param {number} model
   * @returns {void}
   */
  setModel(model) {
    if (model === this.model) return;

    if (this.oia.connectionState !== "not-connected") {
      this.log.info("restarting the connection to change the model", {
        model,
        host: this.lastHost ?? "",
      });
      this.pendingModel = model;
      this.b3270.runActions([{ action: "Disconnect" }]);
      return;
    }

    this.log.info("changing model", { model, from: this.model });
    this.b3270.runActions(this.sizeActions(model));
  }

  /**
   * An oversize is what makes b3270 negotiate as IBM-DYNAMIC; like the model,
   * it only changes while disconnected.
   *
   * @param {string} value `<cols>x<rows>`, or '' for the model's own size
   * @returns {void}
   */
  setOversize(value) {
    if (value === this.oversize) return;
    this.log.info("changing oversize", {
      oversize: value,
      from: this.oversize,
    });
    this.oversize = value;

    if (this.oia.connectionState !== "not-connected") {
      this.pendingOversize = true;
      this.b3270.runActions([{ action: "Disconnect" }]);
      return;
    }

    this.b3270.runActions(this.sizeActions(this.model));
  }

  /**
   * Model and oversize go in one `Set()`: an oversize is only legal against the
   * model it was measured for. Clearing it asks for the model's own size because
   * b3270 4.5 drops the resource without resizing the screen.
   *
   * @param {number} model
   * @returns {Array<{ action: string, args?: string[] }>}
   */
  sizeActions(model) {
    const info = this.models.find((entry) => entry.model === model);
    const asked = /^(\d+)x(\d+)$/.exec(this.oversize);
    const fits =
      asked !== null &&
      info !== undefined &&
      Number(asked[1]) >= info.columns &&
      Number(asked[2]) >= info.rows;

    let oversize = this.oversize;
    if (!fits) {
      oversize =
        this.b3270Oversize === "" || info === undefined
          ? ""
          : `${info.columns}x${info.rows}`;
      this.oversize = "";
    }

    /** @type {string[]} */
    const args = [];
    if (model !== this.model) args.push("model", String(model));
    if (oversize !== this.b3270Oversize) args.push("oversize", oversize);
    this.b3270Oversize = oversize;

    return args.length > 0 ? [{ action: "Set", args }] : [];
  }

  /**
   * @param {import('./b3270.js').Indication} indication
   * @returns {void}
   */
  handleIndication(indication) {
    const { kind, body } = indication;

    if (kind === "screen") {
      const update = /** @type {import('./b3270.js').ScreenIndication} */ (
        body
      );
      this.screen.applyScreen(update);
      // An indication carrying only a cursor move — an arrow key, Tab, a click —
      // cannot have moved a field boundary, and re-reading the buffer for one is
      // the most expensive thing on the keystroke path.
      if ((update.rows ?? []).length > 0) this.fieldsStale = true;
      this.scheduleFlush();
      return;
    }
    if (kind === "erase") {
      // Erase carries the size for hosts that never use the alternate screen.
      const before = this.screenSize();
      this.screen.applyErase(
        /** @type {import('./b3270.js').EraseIndication} */ (body),
      );
      this.announceResize(before);
      this.fieldsStale = true;
      this.scheduleFlush();
      return;
    }
    if (kind === "screen-mode") {
      const mode = /** @type {import('./b3270.js').ScreenModeIndication} */ (
        body
      );
      const before = this.screenSize();
      this.model = mode.model;
      this.screen.applyScreenMode(mode);
      this.announceResize(before);
      this.markReady();
      this.scheduleFlush();
      return;
    }
    if (kind === "models") {
      if (Array.isArray(body)) {
        this.models = /** @type {import('./b3270.js').ModelInfo[]} */ (body);
      }
      return;
    }
    if (kind === "oia") {
      const wasInsert = this.oia.insert;
      this.oia.applyOia(
        /** @type {import('./b3270.js').OiaIndication} */ (body),
      );
      // Insert mode shows only as a cursor shape, so it needs its own push.
      if (this.oia.insert !== wasInsert) this.broadcastStatus();
      this.scheduleFlush();
      return;
    }
    if (kind === "connection") {
      const connection =
        /** @type {import('./b3270.js').ConnectionIndication} */ (body);
      this.log.info("connection state", {
        state: connection.state,
        host: connection.host ?? "",
      });
      this.oia.applyConnection(connection);
      this.broadcastStatus();
      this.scheduleFlush();
      if (
        connection.state === "not-connected" &&
        (this.pendingModel !== null || this.pendingOversize)
      ) {
        const model = this.pendingModel ?? this.model;
        this.log.info("applying the screen size the restart was for", {
          model,
          oversize: this.oversize,
          host: this.lastHost ?? "",
        });
        this.pendingModel = null;
        this.pendingOversize = false;
        const actions = this.sizeActions(model);
        if (this.lastHost !== null)
          actions.push({ action: "Open", args: [this.lastHost] });
        this.b3270.runActions(actions);
      }
      return;
    }
    if (kind === "popup") {
      const popup = /** @type {import('./b3270.js').PopupIndication} */ (body);
      const text = popup.text ?? popup.error ?? "";
      this.log.warn("popup from emulator", { type: popup.type ?? "", text });
      this.sendToAll({ type: "error", code: "E2004", message: text });
      return;
    }
    if (kind === "ui-error") {
      const uiError = /** @type {import('./b3270.js').UiErrorIndication} */ (
        body
      );
      this.reportError(new AppError("E2004", uiError.text ?? "protocol error"));
      return;
    }
    if (kind === "run-result") {
      const result = /** @type {import('./b3270.js').RunResultIndication} */ (
        body
      );
      const tag = result["r-tag"];

      // The edit has settled, so the state it reached is a step to undo back to.
      if (tag !== undefined && tag === this.historyTag) {
        this.historyTag = null;
        this.scheduleFlush();
      }

      if (tag !== undefined && tag === this.fieldReadTag) {
        this.fieldReadTag = null;
        if (result.success) {
          const { editable, hidden, formatted } = fieldMap(
            result.text ?? [],
            this.screen.rows,
            this.screen.cols,
          );
          this.screen.applyFields(editable, formatted);
          this.updatePasswordField(hidden);
        }
        this.scheduleFlush();
        return;
      }

      const waitingViewer =
        tag !== undefined ? this.pendingFieldReads.get(tag) : undefined;
      if (waitingViewer !== undefined) {
        this.pendingFieldReads.delete(/** @type {string} */ (tag));
        // Nothing to copy is routine — every Ctrl+C outside a field lands here.
        const text = result.success
          ? editableFieldText(result.text ?? [])
          : null;
        if (text !== null)
          waitingViewer.sendMessage({ type: "fieldContent", text });
        return;
      }
      if (!result.success) {
        const text = (result.text ?? []).join(" ");
        this.log.warn("action failed", { tag: result["r-tag"] ?? "", text });
        this.sendToAll({
          type: "error",
          code: "E2005",
          message: text || "action failed",
        });
      }
      return;
    }
  }

  /**
   * One frame per burst of indications, so no viewer sees a half-applied screen.
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

    // Screen indications carry no field boundaries, so the field map is a
    // separate ReadBuffer, one in flight at a time.
    if (this.fieldsStale && this.fieldReadTag === null) {
      this.fieldsStale = false;
      this.fieldReadTag = this.b3270.runActions([
        { action: "ReadBuffer", args: ["Ascii"] },
      ]);
    }

    this.recordHistory();

    const nextOia = this.oia.render(this.screen.cols, this.screen.cursor);
    const oiaChanged = nextOia !== this.oiaText;
    this.oiaText = nextOia;

    const dirtyRows = this.screen.takeDirtyRows();
    if (dirtyRows.length === 0 && !oiaChanged) return;

    /** @type {Map<string, string>} */
    const encoded = new Map();
    for (const viewer of this.viewers) {
      const key = `${viewer.hostColors}|${viewer.fieldColor ?? ""}`;
      let bytes = encoded.get(key);
      if (bytes === undefined) {
        bytes = delta(
          this.screen,
          dirtyRows,
          this.oiaText,
          oiaChanged,
          viewer.hostColors,
          viewer.fieldColor,
        );
        encoded.set(key, bytes);
      }
      viewer.sendScreen(bytes);
    }
  }

  /**
   * Everything that edits the screen goes through here, so that one thing the
   * user did is one undo step: b3270 reports a batch in pieces, and the states
   * in the middle of it were never anyone's.
   *
   * @param {{ action: string, args?: string[] }[]} actions
   * @returns {void}
   */
  runEdit(actions) {
    this.historyTag = this.b3270.runActions(actions);
  }

  /**
   * One undo step per settled edit. A restore sets `snapshot` before it runs, so
   * the state it lands on comes back looking like no change at all.
   *
   * @returns {void}
   */
  recordHistory() {
    if (this.historyTag !== null) return;

    const snapshot = editableSnapshot(
      this.screen.cells,
      this.screen.fieldsFormatted,
      this.screen.cols,
      this.screen.cursor,
    );
    if (snapshot === null) return;

    if (this.snapshot === null) {
      this.snapshot = snapshot;
      return;
    }
    // A new field layout is a new screen: the old states describe fields that
    // are no longer there.
    if (snapshot.layout !== this.snapshot.layout) {
      this.clearHistory("the field layout changed");
      this.snapshot = snapshot;
      return;
    }
    if (snapshot.key === this.snapshot.key) return;

    this.undoStack.push(this.snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.snapshot = snapshot;
  }

  /**
   * @param {string} why for the log; history is cheap to lose but never silently
   * @returns {void}
   */
  clearHistory(why) {
    if (this.undoStack.length === 0 && this.redoStack.length === 0) return;
    this.log.info("history cleared", {
      why,
      undo: this.undoStack.length,
      redo: this.redoStack.length,
    });
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /**
   * Ctrl+Z and Ctrl+R: put the editable fields back the way they were, erasing
   * and retyping only the runs that differ, then returning the cursor.
   *
   * @param {boolean} back true undoes, false redoes
   * @returns {void}
   */
  stepHistory(back) {
    const from = back ? this.undoStack : this.redoStack;
    const to = back ? this.redoStack : this.undoStack;
    const target = from.pop();
    if (target === undefined || this.snapshot === null) {
      this.log.info(back ? "nothing to undo" : "nothing to redo", {});
      return;
    }
    to.push(this.snapshot);

    const runs = changedRuns(target, this.screen.cells, this.screen.cols);
    this.log.info(back ? "undo" : "redo", {
      fields: runs.length,
      undo: this.undoStack.length,
      redo: this.redoStack.length,
    });

    /** @type {{ action: string, args: string[] }[]} */
    const actions = [];
    for (const run of runs) {
      actions.push({
        action: "MoveCursor1",
        args: [String(run.row + 1), String(run.col + 1)],
      });
      actions.push({ action: "EraseEOF", args: [] });
      const text = run.text.replace(/ +$/, "");
      if (text !== "")
        actions.push({
          action: "PasteString",
          args: [Buffer.from(text, "utf8").toString("hex")],
        });
    }
    actions.push({
      action: "MoveCursor1",
      args: [String(target.cursor.row + 1), String(target.cursor.col + 1)],
    });

    this.snapshot = target;
    this.runEdit(actions);
  }

  /** @returns {string} `<rows>x<cols>` */
  screenSize() {
    return `${this.screen.rows}x${this.screen.cols}`;
  }

  /** @returns {string[]} one plain-text line per row */
  screenLines() {
    const lines = [];
    for (let row = 0; row < this.screen.rows; row++)
      lines.push(this.screen.rowText(row));
    return lines;
  }

  /**
   * @param {import('./protocol.js').RecorderStep} step
   * @returns {void}
   */
  pushRecorderStep(step) {
    if (this.recording === null) return;
    this.recording.steps.push(step);
    this.sendToAll({ type: "recorderStep", step });
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
   * One marker per run, so a recording never carries what was typed.
   * @returns {void}
   */
  recordPassword() {
    if (this.recording === null) return;
    const steps = this.recording.steps;
    if (steps.length > 0 && steps[steps.length - 1].password === true) return;
    this.pushRecorderStep({ screen: this.screenLines(), password: true });
  }

  /**
   * @param {boolean[]} hidden row-major
   * @returns {void}
   */
  updatePasswordField(hidden) {
    const at =
      this.screen.cursor.row * this.screen.cols + this.screen.cursor.col;
    this.passwordField = hidden[at] ?? false;
  }

  /**
   * @param {string} before
   * @returns {void}
   */
  announceResize(before) {
    if (this.screenSize() === before) return;
    this.log.info("screen size changed", {
      model: this.model,
      rows: this.screen.rows,
      cols: this.screen.cols,
    });
    this.sendToAll({
      type: "screen",
      model: this.model,
      rows: this.screen.rows,
      cols: this.screen.cols,
      oversize: this.oversize,
    });
    this.repaintAll();
  }

  /** @returns {void} */
  repaintAll() {
    // Pending deltas are about to be painted over, and are against the old size.
    this.screen.takeDirtyRows();
    for (const viewer of this.viewers) this.repaint(viewer);
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  repaint(viewer) {
    this.oiaText = this.oia.render(this.screen.cols, this.screen.cursor);
    viewer.sendScreen(
      fullRepaint(
        this.screen,
        this.oiaText,
        viewer.hostColors,
        viewer.fieldColor,
      ),
    );
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  attach(viewer) {
    if (this.viewers.size >= this.config.sessions.maxViewersPerSession) {
      throw new AppError(
        "E3003",
        `session ${this.id} already has ${this.viewers.size} viewers`,
      );
    }
    if (!this.allowSharing && this.viewers.size > 0) {
      throw new AppError("E3007", `session ${this.id} has sharing turned off`);
    }

    const hasController = [...this.viewers].some(
      (other) => other.role === "controller",
    );
    viewer.role =
      this.allowSharedEditing || !hasController ? "controller" : "observer";

    this.viewers.add(viewer);
    this.stopIdleTimer();
    this.log.info("viewer attached", {
      viewer: viewer.id,
      ip: viewer.ip ?? "",
      user: viewer.user ?? "",
      role: viewer.role,
      total: this.viewers.size,
    });

    viewer.sendMessage({
      type: "hello",
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
      allowAutomation: this.allowAutomation,
      idleTimeoutMs: this.config.sessions.idleTimeoutMs,
    });

    this.repaint(viewer);
    this.broadcastStatus();
    // No field map was read while there were no viewers.
    this.fieldsStale = true;
    this.scheduleFlush();
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  detach(viewer) {
    if (!this.viewers.delete(viewer)) return;
    this.log.info("viewer detached", {
      viewer: viewer.id,
      ip: viewer.ip ?? "",
      user: viewer.user ?? "",
      total: this.viewers.size,
    });

    // Its copy request will never be answered to anyone now.
    for (const [tag, waiting] of this.pendingFieldReads) {
      if (waiting === viewer) this.pendingFieldReads.delete(tag);
    }

    // Or the session would be permanently read-only.
    if (viewer.role === "controller" && !this.allowSharedEditing) {
      const next = this.viewers.values().next();
      if (!next.done) {
        next.value.role = "controller";
        this.log.info("promoted viewer to controller", {
          viewer: next.value.id,
          ip: next.value.ip ?? "",
          user: next.value.user ?? "",
        });
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
    // Observers may send these three: they change only this viewer's own picture.
    if (message.type === "refresh") {
      this.repaint(viewer);
      return;
    }

    if (message.type === "hostColors") {
      viewer.hostColors = message.enabled;
      this.repaint(viewer);
      return;
    }

    if (message.type === "fieldColor") {
      viewer.fieldColor = message.color;
      this.fieldsStale = true;
      this.repaint(viewer);
      this.scheduleFlush();
      return;
    }

    if (viewer.role !== "controller") {
      viewer.sendMessage({
        type: "error",
        code: "E3006",
        message: "This session is being controlled by someone else.",
      });
      return;
    }

    // Browsers watch `touched` to stop resizing a session someone is using.
    if (
      !this.touched &&
      (message.type === "action" ||
        message.type === "text" ||
        message.type === "paste")
    ) {
      this.touched = true;
      this.broadcastStatus();
    }

    switch (message.type) {
      case "action":
        // Ours alone, and not an action a recording could ever replay.
        if (message.action === "Undo" || message.action === "Redo") {
          this.stepHistory(message.action === "Undo");
          return;
        }
        // Past an AID key the screen belongs to the host, so there is nothing
        // left to put back.
        if (AID_ACTIONS.has(message.action)) this.clearHistory(message.action);
        // Control keys carry no field content, so they are always safe to record.
        this.record(message.action, message.args ?? []);
        // b3270's Backspace only moves left, as real 3270 hardware does; a PC
        // keyboard expects a delete, and the field map says if there is room.
        if (message.action === "Backspace") {
          if (this.canBackspace())
            this.runEdit([{ action: "Left" }, { action: "Delete" }]);
          return;
        }
        // b3270 has no upward Newline; the cached field map answers it here.
        if (message.action === "BackNewline") {
          const target = this.backNewlineTarget();
          this.b3270.runActions([
            {
              action: "MoveCursor1",
              args: [String(target.row + 1), String(target.col + 1)],
            },
          ]);
          return;
        }
        this.runEdit([{ action: message.action, args: message.args ?? [] }]);
        return;
      case "text":
        if (message.value !== "") {
          if (this.passwordField) this.recordPassword();
          else this.record("String", [message.value]);
          const nudge = this.typingNudge();
          const actions =
            nudge === null
              ? [{ action: "String", args: [message.value] }]
              : [
                  {
                    action: "MoveCursor1",
                    args: [String(nudge.row + 1), String(nudge.col + 1)],
                  },
                  { action: "String", args: [message.value] },
                ];
          this.runEdit(actions);
        }
        return;
      case "paste": {
        if (message.text !== "") {
          if (this.passwordField) this.recordPassword();
          else this.record("PasteString", [message.text]);

          // Batched, so nothing else can be typed between the segments.
          const segments = pasteSegments(
            this.screen.cells,
            this.screen.fieldsFormatted,
            this.screen.cols,
            this.screen.cursor,
            message.text,
          );
          const actions = segments.flatMap(({ row, col, text }) => [
            { action: "MoveCursor1", args: [String(row + 1), String(col + 1)] },
            {
              action: "PasteString",
              args: [Buffer.from(text, "utf8").toString("hex")],
            },
          ]);
          if (actions.length > 0) this.runEdit(actions);
        }
        return;
      }
      case "connect":
        // A configured host never reaches the browser, so it asks without one.
        this.connect(message.host ?? this.lastHost ?? "");
        return;
      case "disconnect":
        this.disconnect();
        return;
      case "model":
        this.setModel(message.model);
        return;
      case "oversize":
        this.setOversize(message.value);
        return;
      case "copyField": {
        const tag = this.b3270.runActions([
          { action: "ReadBuffer", args: ["Ascii", "Field"] },
        ]);
        this.pendingFieldReads.set(tag, viewer);
        return;
      }
      case "hints": {
        const hints = this.screen.fieldsFormatted
          ? computeHints(this.screen.cells, this.screen.cols)
          : [];
        viewer.sendMessage({ type: "hints", hints });
        return;
      }
      case "sharing":
        this.allowSharing = message.allowView;
        this.allowSharedEditing = message.allowEdit;
        for (const other of this.viewers) {
          if (other !== viewer)
            other.role = this.allowSharedEditing ? "controller" : "observer";
        }
        this.broadcastStatus();
        return;
      case "automation":
        this.log.info("automation over REST", {
          allowed: message.allowed,
          viewer: viewer.id,
        });
        this.allowAutomation = message.allowed;
        this.broadcastStatus();
        return;
      case "recorder":
        this.recording = message.action === "start" ? { steps: [] } : null;
        return;
    }
  }

  /**
   * Deleting onto a field attribute byte or a protected cell locks the keyboard,
   * so Backspace checks the cell to its left first.
   *
   * @returns {boolean}
   */
  canBackspace() {
    if (!this.screen.fieldsFormatted) return true;
    const { cursor, cells, cols } = this.screen;
    const at = cursor.row * cols + cursor.col;
    const left = cells[(at - 1 + cells.length) % cells.length];
    return left?.editable ?? true;
  }

  /**
   * Newline's mirror: first typeable cell of the nearest row above, wrapping
   * past the top exactly as Newline wraps past the bottom.
   *
   * @returns {{ row: number, col: number }}
   */
  backNewlineTarget() {
    const { cursor, cells, rows, cols } = this.screen;
    for (let above = 1; above <= rows; above++) {
      const row = (cursor.row - above + rows) % rows;
      for (let col = 0; col < cols; col++) {
        if (cells[row * cols + col]?.editable) return { row, col };
      }
    }
    return { row: (cursor.row - 1 + rows) % rows, col: 0 };
  }

  /**
   * The cursor may rest on a field's attribute byte, where typing would lock
   * the keyboard, so a character meant for the field after it moves over one.
   *
   * @returns {{ row: number, col: number } | null}
   */
  typingNudge() {
    if (!this.screen.fieldsFormatted) return null;
    const { cursor, cells, cols } = this.screen;
    const at = cursor.row * cols + cursor.col;
    if (cells[at]?.editable ?? true) return null;
    const right = (at + 1) % cells.length;
    if (!(cells[right]?.editable ?? false)) return null;
    return { row: Math.floor(right / cols), col: right % cols };
  }

  /** @returns {void} */
  broadcastStatus() {
    for (const viewer of this.viewers) {
      viewer.sendMessage({
        type: "status",
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
        allowAutomation: this.allowAutomation,
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
    this.log.error(err);
    const { code, summary } = describeError(err);
    this.sendToAll({ type: "error", code, message: summary });
  }

  /** @returns {void} */
  startIdleTimer() {
    this.stopIdleTimer();
    const timeout = this.config.sessions.idleTimeoutMs;
    if (timeout <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.log.info("idle timeout reached, closing");
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
    this.log.info("closing", { viewers: this.viewers.size });
    this.b3270.stop();
    this.viewers.clear();
    if (this.onClosed) this.onClosed();
  }
}

export class SessionRegistry {
  /** @param {import('./config.js').Config} config */
  constructor(config) {
    this.config = config;
    this.log = logger("registry");
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
  }

  /**
   * @param {{ ip: string, user: string }} [client]
   * @returns {Promise<Session>}
   */
  async create(client = { ip: "", user: "" }) {
    if (this.sessions.size >= this.config.sessions.maxSessions) {
      throw new AppError(
        "E3002",
        `${this.sessions.size} sessions are already open`,
      );
    }
    const session = new Session(this.config, await reserveRestEndpoint());
    session.onClosed = () => {
      this.sessions.delete(session.id);
      this.log.info("session removed", {
        session: session.id,
        remaining: this.sessions.size,
      });
    };
    this.sessions.set(session.id, session);
    this.log.info("session created", {
      session: session.id,
      ...client,
      total: this.sessions.size,
    });

    if (this.config.b3270.defaultHost !== null)
      session.connect(this.config.b3270.defaultHost);
    return session;
  }

  /**
   * @param {string} id
   * @returns {Session}
   */
  get(id) {
    const session = this.sessions.get(id);
    if (session === undefined) throw new AppError("E3001", id);
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
