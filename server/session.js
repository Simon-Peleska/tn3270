import { randomUUID } from "node:crypto";
import { SessionPool } from "../3270/src/index.js";
import { fieldMap } from "./readbuffer.js";
import { editableSnapshot, changedRuns } from "./history.js";
import { ScreenModel } from "./screen.js";
import { OiaModel } from "./oia.js";
import { fullPaint, paintDelta } from "./paint.js";
import { AppError, describeError } from "./errors.js";
import { isHostAllowed } from "./protocol.js";
import { logger, logsDebug } from "./log.js";

/**
 * @typedef {object} Viewer
 * @property {string} id
 * @property {'controller' | 'observer'} role
 * @property {string} [ip]
 * @property {string} [user]
 * @property {string} [pass] what the browser came back with, from an earlier hello
 * @property {boolean} [owner] set on attach
 * @property {boolean} [wantsEdit] an observer waiting for the owner's answer
 * @property {(message: import('./protocol.js').ServerMessage) => void} sendMessage
 * @property {(code?: number, reason?: string) => void} close ends the connection for good: the browser must not retry
 */

/**
 * What the owner is shown: the name the proxy vouched for, else the address.
 *
 * @param {Viewer} viewer
 * @returns {string}
 */
function nameOf(viewer) {
  return viewer.user || viewer.ip || "Someone";
}

/** Deep enough for a screen's worth of typing, shallow enough to forget. */
const HISTORY_LIMIT = 100;
const INPUT_QUEUE_LIMIT = 256;

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

/** Every session's emulator, spread over worker threads. @type {SessionPool | null} */
let pool = null;

/** How a user gets out of a wait for the host, so they never wait in line. */
const INTERRUPT_ACTIONS = new Set(["Reset", "Attn", "SysReq"]);

export class Session {
  /** @param {import('./config.js').Config} config */
  constructor(config) {
    /** @type {string} */
    this.id = randomUUID();
    this.startedAt = new Date().toISOString();
    this.startedBy = "";
    /** @type {import('./config.js').Config} */
    this.config = config;
    this.log = logger("session", { session: this.id });

    /** @type {ScreenModel} */
    this.screen = new ScreenModel();
    /** @type {OiaModel} */
    this.oia = new OiaModel();
    /** @type {number} the emulator confirms this in screen-mode. */
    this.model = config.emulator.model;
    /** @type {string} */
    this.codePage = "bracket";
    /** @type {Map<string, string>} */
    this.codePageNames = new Map();
    /** @type {import('./indications.js').ModelInfo[]} */
    this.models = [];
    /** @type {Set<Viewer>} */
    this.viewers = new Set();

    /** @type {string | null} */
    this.lastHost = null;
    /** @type {Set<Viewer>} Asked to watch, and waiting for an owner's answer. */
    this.waiting = new Set();
    /** @type {string} Handed to the owner in hello, so a reload is the owner again. */
    this.ownerPass = randomUUID();
    /** @type {Set<string>} Handed to each guest let in, so a reload need not ask again. */
    this.guestPasses = new Set();
    /** @type {boolean} Whether REST calls over the proxy may drive this session. */
    /** @type {boolean} Any viewer's input sets this, and it is never cleared. */
    this.touched = false;
    /** @type {number | null} A model waiting for the connection to go away. */
    this.pendingModel = null;
    /** @type {string} `<cols>x<rows>`, or '' for the model's own size. */
    this.oversize = String(config.emulator.settings["oversize"] ?? "");
    /** @type {boolean} Whether an oversize is waiting for the connection to go
     * away. The size itself is already in `oversize`. */
    this.pendingOversize = false;
    /** @type {string} What the emulator was told, not always what was asked for. */
    this.emulatorOversize = this.oversize;

    /** @type {boolean} */
    this.flushScheduled = false;
    /** @type {boolean} */
    this.closed = false;
    /** @type {NodeJS.Timeout | null} */
    this.idleTimer = null;
    /** @type {(() => void) | null} */
    this.onClosed = null;
    /** @type {boolean} The host redrew since the field map was read. */
    this.fieldsStale = false;
    /** @type {string | null} The r-tag of the field-map read in flight. */
    this.fieldReadTag = null;
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

    /** @type {import('./protocol.js').ClientMessage[]} Input not sent to the emulator yet. */
    this.inputQueue = [];
    /** @type {string | null} The r-tag of the input the emulator is working on. */
    this.inputTag = null;

    /** @type {() => void} */
    this.markReady = () => {};
    /** @type {Promise<void>} the emulator reports its geometry and model list a few ms
     * after it starts; describing the session earlier hands out a placeholder 24x80. */
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });

    const options = {
      model: String(config.emulator.model),
      ...config.emulator.settings,
    };
    this.log.info("starting emulator", { options: JSON.stringify(options) });
    pool ??= new SessionPool({ workers: config.emulator.workers });
    this.emulator = pool.session(options, {
      /** @param {string} m */
      warn: (m) => this.log.warn(m),
      /** @param {string} m */
      info: (m) => this.log.info(m),
      // Debug lines would all cross from the thread just to be dropped.
      debug: logsDebug() ? (m) => this.log.debug(m) : undefined,
    });
    this.emulator.on("quit", () => this.close());
    this.emulator.on("died", (cause) => {
      this.reportError(new AppError("E2007", "", cause));
      this.close();
    });
    /** @type {number} */
    this.nextTag = 1;
    this.emulator.indications((indication) =>
      this.handleIndication(indication),
    );

    // Nothing may wait forever on an emulator that never speaks.
    this.readyTimer = setTimeout(() => this.markReady(), 5000);
    this.readyTimer.unref();

    this.startIdleTimer();
  }

  /**
   * @param {Array<{ action: string, args?: string[] }>} actions
   * @returns {string} the r-tag its run-result indication comes back with
   */
  runActions(actions) {
    const tag = `t${this.nextTag++}`;
    if (logsDebug())
      this.log.debug("run", { tag, actions: JSON.stringify(actions) });
    this.emulator.run(actions, tag).catch(
      /** @param {unknown} cause */
      (cause) => this.reportError(new AppError("E2005", tag, cause)),
    );
    return tag;
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
    this.runActions([{ action: "Open", args: [this.openTarget(host)] }]);
  }

  /**
   * @param {string} host
   * @returns {string}
   */
  openTarget(host) {
    if (!this.config.emulator.tls || /^(?:[A-Z]:)*L:/i.test(host)) return host;
    return `L:${host}`;
  }

  /** @returns {void} */
  disconnect() {
    this.log.info("disconnecting");
    this.runActions([{ action: "Disconnect" }]);
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
      this.runActions([{ action: "Disconnect" }]);
      return;
    }

    this.log.info("changing model", { model, from: this.model });
    this.runActions(this.sizeActions(model));
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
      this.runActions([{ action: "Disconnect" }]);
      return;
    }

    this.runActions(this.sizeActions(this.model));
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
        this.emulatorOversize === "" || info === undefined
          ? ""
          : `${info.columns}x${info.rows}`;
      this.oversize = "";
    }

    /** @type {string[]} */
    const args = [];
    if (model !== this.model) args.push("model", String(model));
    if (oversize !== this.emulatorOversize) args.push("oversize", oversize);
    this.emulatorOversize = oversize;

    return args.length > 0 ? [{ action: "Set", args }] : [];
  }

  /**
   * @param {import('./indications.js').Indication} indication
   * @returns {void}
   */
  handleIndication(indication) {
    const { kind, body } = indication;

    if (kind === "code-pages" && Array.isArray(body)) {
      for (const entry of body) {
        if (typeof entry?.name !== "string") continue;
        this.codePageNames.set(entry.name, entry.name);
        if (Array.isArray(entry.aliases)) {
          for (const alias of entry.aliases) {
            if (typeof alias === "string")
              this.codePageNames.set(alias, entry.name);
          }
        }
      }
      return;
    }
    if (kind === "setting") {
      const setting = /** @type {{ name?: string, value?: unknown }} */ (body);
      if (setting.name === "codePage" && typeof setting.value === "string") {
        this.codePage = this.codePageNames.get(setting.value) ?? setting.value;
        this.log.info("code page changed", { codePage: this.codePage });
        this.sendToAll({ type: "codePage", name: this.codePage });
      }
      return;
    }

    if (kind === "screen") {
      const update =
        /** @type {import('./indications.js').ScreenIndication} */ (body);
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
        /** @type {import('./indications.js').EraseIndication} */ (body),
      );
      this.announceResize(before);
      this.fieldsStale = true;
      this.scheduleFlush();
      return;
    }
    if (kind === "screen-mode") {
      const mode =
        /** @type {import('./indications.js').ScreenModeIndication} */ (body);
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
        this.models = /** @type {import('./indications.js').ModelInfo[]} */ (
          body
        );
      }
      return;
    }
    if (kind === "oia") {
      const { insert, lock, typeahead } = this.oia;
      this.oia.applyOia(
        /** @type {import('./indications.js').OiaIndication} */ (body),
      );
      // None of these reach a browser any other way: the lock is what macro
      // playback waits on, and insert mode shows only as a cursor shape.
      if (
        this.oia.insert !== insert ||
        this.oia.lock !== lock ||
        this.oia.typeahead !== typeahead
      )
        this.broadcastStatus();
      this.scheduleFlush();
      return;
    }
    if (kind === "connection") {
      const connection =
        /** @type {import('./indications.js').ConnectionIndication} */ (body);
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
          actions.push({
            action: "Open",
            args: [this.openTarget(this.lastHost)],
          });
        this.runActions(actions);
      }
      return;
    }
    if (kind === "popup") {
      const popup = /** @type {import('./indications.js').PopupIndication} */ (
        body
      );
      const text = popup.text ?? popup.error ?? "";
      this.log.warn("popup from emulator", { type: popup.type ?? "", text });
      this.sendToAll({ type: "error", code: "E2004", message: text });
      return;
    }
    if (kind === "ui-error") {
      const uiError =
        /** @type {import('./indications.js').UiErrorIndication} */ (body);
      this.reportError(new AppError("E2004", uiError.text ?? "protocol error"));
      return;
    }
    if (kind === "run-result") {
      const result =
        /** @type {import('./indications.js').RunResultIndication} */ (body);
      const tag = result["r-tag"];

      // The edit has settled, so the state it reached is a step to undo back to.
      if (tag !== undefined && tag === this.historyTag) {
        this.historyTag = null;
        this.scheduleFlush();
      }

      if (tag !== undefined && tag === this.inputTag) {
        this.inputTag = null;
        this.runQueuedInput();
      }

      if (tag !== undefined && tag === this.fieldReadTag) {
        this.fieldReadTag = null;
        if (result.success) {
          const { editable, hidden, formatted } = fieldMap(
            result.text ?? [],
            this.screen.rows,
            this.screen.cols,
          );
          this.screen.applyFields(editable, hidden, formatted);
        }
        this.scheduleFlush();
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
      this.fieldReadTag = this.runActions([
        { action: "ReadBuffer", args: ["Ascii"] },
      ]);
    }

    this.recordHistory();

    const dirtyRows = this.screen.takeDirtyRows();
    // A cursor move touches no row, and it is the whole of what a Left or a Tab
    // does, so it has to be asked about separately.
    const cursorMoved = this.screen.takeCursorMoved();
    if (dirtyRows.length === 0 && !cursorMoved) return;

    this.sendToAll(paintDelta(this.screen, dirtyRows));
  }

  /**
   * Every edit the user makes goes through here, so that one thing the
   * user did is one undo step: b3270 reports a batch in pieces, and the states
   * in the middle of it were never anyone's.
   *
   * @param {{ action: string, args?: string[] }[]} actions
   * @returns {string} the r-tag
   */
  runEdit(actions) {
    // The state the edit starts from is the step to undo back to, even when no
    // flush has recorded it yet.
    this.recordHistory();
    this.historyTag = this.runActions(actions);
    return this.historyTag;
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
   * @returns {string | null} the r-tag, or null for nothing to step to
   */
  stepHistory(back) {
    this.recordHistory();
    const from = back ? this.undoStack : this.redoStack;
    const to = back ? this.redoStack : this.undoStack;
    const target = from.pop();
    if (target === undefined || this.snapshot === null) {
      this.log.info(back ? "nothing to undo" : "nothing to redo", {});
      return null;
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

    // Not runEdit: the restore must not record the state it is leaving as a step.
    this.snapshot = target;
    this.historyTag = this.runActions(actions);
    return this.historyTag;
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
   * @param {Omit<import('./protocol.js').RecorderStep, 'cursor' | 'paint'>} step
   * @returns {void}
   */
  pushRecorderStep(step) {
    if (this.recording === null) return;
    const recorded = {
      ...step,
      paint: fullPaint(this.screen),
      cursor: { row: this.screen.cursor.row, col: this.screen.cursor.col },
    };
    this.recording.steps.push(recorded);
    this.sendToAll({ type: "recorderStep", step: recorded });
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
    this.screen.takeCursorMoved();
    for (const viewer of this.viewers) this.repaint(viewer);
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  repaint(viewer) {
    viewer.sendMessage(fullPaint(this.screen));
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  attach(viewer) {
    if (
      this.viewers.size + this.waiting.size >=
      this.config.sessions.maxViewersPerSession
    ) {
      throw new AppError(
        "E3003",
        `session ${this.id} already has ${this.viewers.size} viewers`,
      );
    }

    const isGuest =
      viewer.pass !== undefined && this.guestPasses.has(viewer.pass);
    // Nobody here to ask, so whoever opens an empty session owns it.
    const empty = this.viewers.size === 0 && this.waiting.size === 0;
    viewer.owner = viewer.pass === this.ownerPass || (empty && !isGuest);
    viewer.role = viewer.owner ? "controller" : "observer";
    viewer.wantsEdit = false;
    if (viewer.owner) viewer.pass = this.ownerPass;
    if (viewer.owner || isGuest) {
      this.admit(viewer);
      return;
    }

    viewer.pass = undefined;
    this.waiting.add(viewer);
    this.log.info("viewer asks to watch", {
      viewer: viewer.id,
      ip: viewer.ip ?? "",
      user: viewer.user ?? "",
      waiting: this.waiting.size,
    });
    viewer.sendMessage({ type: "waiting" });
    this.broadcastStatus();
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  admit(viewer) {
    if (viewer.pass === undefined) {
      viewer.pass = randomUUID();
      this.guestPasses.add(viewer.pass);
    }
    this.viewers.add(viewer);
    this.stopIdleTimer();
    this.log.info("viewer attached", {
      viewer: viewer.id,
      ip: viewer.ip ?? "",
      user: viewer.user ?? "",
      role: viewer.role,
      owner: viewer.owner === true,
      total: this.viewers.size,
    });

    viewer.sendMessage({
      type: "hello",
      sessionId: this.id,
      rows: this.screen.rows,
      cols: this.screen.cols,
      model: this.model,
      codePage: this.codePage,
      models: this.models,
      oversize: this.oversize,
      hostLocked: this.config.emulator.defaultHost !== null,
      role: viewer.role,
      owner: viewer.owner === true,
      pass: viewer.pass,
      viewers: this.viewers.size,
      idleTimeoutMs: this.config.sessions.idleTimeoutMs,
    });

    this.repaint(viewer);
    this.broadcastStatus();
    // No field map was read while there were no viewers.
    this.fieldsStale = true;
    this.scheduleFlush();
  }

  /**
   * Sends a viewer away for good, with the reason on its screen.
   *
   * @param {Viewer} viewer
   * @param {string} code
   * @param {string} message
   * @returns {void}
   */
  refuse(viewer, code, message) {
    this.waiting.delete(viewer);
    this.viewers.delete(viewer);
    this.log.info("viewer sent away", {
      viewer: viewer.id,
      ip: viewer.ip ?? "",
      user: viewer.user ?? "",
      code,
    });
    viewer.sendMessage({ type: "refused", code, message });
    viewer.close();
  }

  /** @param {string} pass @returns {void} */
  terminate(pass) {
    if (pass !== this.ownerPass) throw new AppError("E3014", this.id);
    this.log.info("session terminated by its owner");
    for (const viewer of [...this.viewers, ...this.waiting])
      viewer.close(4001, "E3015");
    this.close();
  }

  /**
   * @param {Viewer} viewer
   * @returns {void}
   */
  detach(viewer) {
    if (this.waiting.delete(viewer)) {
      this.log.info("viewer stopped asking", { viewer: viewer.id });
      this.broadcastStatus();
      return;
    }
    if (!this.viewers.delete(viewer)) return;
    this.log.info("viewer detached", {
      viewer: viewer.id,
      ip: viewer.ip ?? "",
      user: viewer.user ?? "",
      total: this.viewers.size,
    });

    this.broadcastStatus();
    if (this.viewers.size === 0) this.startIdleTimer();
  }

  /**
   * @param {Viewer} viewer
   * @param {import('./protocol.js').ClientMessage} message
   * @returns {void}
   */
  handleClientMessage(viewer, message) {
    // Not let in yet: it may not even ask for a repaint of what it cannot see.
    if (!this.viewers.has(viewer)) {
      this.log.debug("message from a viewer not let in", {
        viewer: viewer.id,
        type: message.type,
      });
      return;
    }

    // An observer may ask for this one: it changes only this viewer's own picture.
    if (message.type === "refresh") {
      this.repaint(viewer);
      return;
    }

    if (message.type === "askEdit") {
      if (viewer.role === "controller") return;
      viewer.wantsEdit = true;
      this.log.info("viewer asks to edit", {
        viewer: viewer.id,
        ip: viewer.ip ?? "",
        user: viewer.user ?? "",
      });
      this.broadcastStatus();
      return;
    }

    if (
      message.type === "answer" ||
      message.type === "stopSharing" ||
      message.type === "stopEditing"
    ) {
      if (viewer.owner !== true) {
        viewer.sendMessage({
          type: "error",
          code: "E3010",
          message: "Only the session's owner decides who may watch or edit.",
        });
        return;
      }
      this.decideSharing(viewer, message);
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
      case "text":
      case "paste":
        this.queueInput(viewer, message);
        return;
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
      case "recorder":
        this.queueInput(viewer, message);
        return;
    }
  }

  /**
   * The owner letting someone in, letting them edit, or taking either back.
   * One guest edits at a time: letting a second one edit takes it from the first.
   *
   * @param {Viewer} owner
   * @param {import('./protocol.js').AnswerMessage | import('./protocol.js').StopSharingMessage | import('./protocol.js').StopEditingMessage} message
   * @returns {void}
   */
  decideSharing(owner, message) {
    const ownerName = nameOf(owner);

    if (message.type === "stopSharing") {
      this.log.info("owner stopped sharing", { viewer: owner.id });
      this.guestPasses.clear();
      for (const guest of [...this.waiting, ...this.viewers]) {
        if (guest.owner === true) continue;
        this.refuse(
          guest,
          "E3009",
          `${ownerName} stopped sharing this session.`,
        );
      }
      this.broadcastStatus();
      return;
    }

    if (message.type === "stopEditing") {
      this.takeEditingBack(ownerName);
      this.broadcastStatus();
      return;
    }

    const asking = [...this.waiting, ...this.viewers].find(
      (candidate) => candidate.id === message.viewer,
    );
    // Gone, or already answered from the owner's other tab.
    if (asking === undefined) return;

    if (this.waiting.has(asking)) {
      this.log.info("owner answered a request to watch", {
        viewer: asking.id,
        allow: message.allow,
      });
      if (!message.allow) {
        this.refuse(asking, "E3008", `${ownerName} did not let you in.`);
        this.broadcastStatus();
        return;
      }
      this.waiting.delete(asking);
      this.admit(asking);
      return;
    }

    if (asking.wantsEdit !== true) return;
    asking.wantsEdit = false;
    this.log.info("owner answered a request to edit", {
      viewer: asking.id,
      allow: message.allow,
    });
    if (!message.allow) {
      asking.sendMessage({
        type: "error",
        code: "E3011",
        message: `${ownerName} did not let you edit.`,
      });
      this.broadcastStatus();
      return;
    }
    this.takeEditingBack(ownerName);
    asking.role = "controller";
    this.broadcastStatus();
  }

  /**
   * @param {string} ownerName
   * @returns {void}
   */
  takeEditingBack(ownerName) {
    for (const guest of this.viewers) {
      if (guest.owner === true || guest.role !== "controller") continue;
      guest.role = "observer";
      this.log.info("editing taken back", { viewer: guest.id });
      guest.sendMessage({
        type: "error",
        code: "E3012",
        message: `${ownerName} took editing back.`,
      });
    }
  }

  /**
   * Input goes to b3270 one message at a time, each once b3270 has finished the
   * last. b3270 already holds an action back while the host has the keyboard,
   * but several held at once come out of that wait in the wrong order, and
   * Backspace and the typing nudge read a screen the last input must have
   * settled. Reset, Attn and SysReq are how a user gets out of a wait, so they
   * skip the line, and Reset throws away what was typed ahead, as a 3270 does.
   * A held-down PF key only repeats into an empty line, so letting go of it
   * stops the paging at once.
   *
   * @param {Viewer} viewer
   * @param {import('./protocol.js').ClientMessage} message
   * @returns {void}
   */
  queueInput(viewer, message) {
    if (message.type === "recorder") {
      this.runInput(message);
      return;
    }
    if (message.type === "action" && INTERRUPT_ACTIONS.has(message.action)) {
      if (message.action === "Reset") {
        const recorderCommands = this.inputQueue.filter(
          (queued) => queued.type === "recorder",
        );
        const dropped = this.inputQueue.length - recorderCommands.length;
        if (dropped > 0)
          this.log.info("reset drops typed-ahead input", {
            dropped,
          });
        this.inputQueue = recorderCommands;
        this.inputTag = null;
      }
      this.runInput(message);
      return;
    }
    if (
      message.type === "action" &&
      message.repeat === true &&
      (this.inputTag !== null || this.inputQueue.length > 0)
    ) {
      this.log.debug("held key repeats faster than the host answers", {
        action: message.action,
      });
      return;
    }
    if (this.inputQueue.length >= INPUT_QUEUE_LIMIT) {
      this.log.warn("input queue full", {
        viewer: viewer.id,
        queued: this.inputQueue.length,
      });
      viewer.sendMessage({
        type: "error",
        code: "E3013",
        message: "Input is arriving faster than the host can process it.",
      });
      return;
    }
    this.inputQueue.push(message);
    if (this.inputTag !== null)
      this.log.debug("input waits for the one before", {
        queued: this.inputQueue.length,
      });
    this.runQueuedInput();
  }

  /** @returns {void} */
  runQueuedInput() {
    while (this.inputTag === null) {
      const next = this.inputQueue.shift();
      if (next === undefined) return;
      this.inputTag = this.runInput(next);
    }
  }

  /**
   * @param {import('./protocol.js').ClientMessage} message
   * @returns {string | null} the r-tag, or null when there was nothing to send
   */
  runInput(message) {
    switch (message.type) {
      case "recorder":
        if (message.action === "start") this.recording = { steps: [] };
        else {
          if (this.recording !== null)
            this.pushRecorderStep({ screen: this.screenLines(), final: true });
          this.recording = null;
          this.sendToAll({ type: "recorderStopped" });
        }
        return null;
      case "action":
        // Ours alone, and not an action a recording could ever replay.
        if (message.action === "Undo" || message.action === "Redo")
          return this.stepHistory(message.action === "Undo");
        // Past an AID key the screen belongs to the host, so there is nothing
        // left to put back.
        if (AID_ACTIONS.has(message.action)) this.clearHistory(message.action);
        // Control keys carry no field content, so they are always safe to record.
        this.record(message.action, message.args ?? []);
        // b3270's Backspace only moves left, as real 3270 hardware does; a PC
        // keyboard expects a delete, and the field map says if there is room.
        if (message.action === "Backspace") {
          if (!this.canBackspace()) return null;
          return this.runEdit([{ action: "Left" }, { action: "Delete" }]);
        }
        // b3270 has no upward Newline and no start-of-field move; the cached
        // field map answers both here.
        if (
          message.action === "BackNewline" ||
          message.action === "FieldStart"
        ) {
          const target =
            message.action === "BackNewline"
              ? this.backNewlineTarget()
              : this.fieldStartTarget();
          return this.runActions([
            {
              action: "MoveCursor1",
              args: [String(target.row + 1), String(target.col + 1)],
            },
          ]);
        }
        return this.runEdit([
          { action: message.action, args: message.args ?? [] },
        ]);
      case "text": {
        if (message.value === "") return null;
        if (this.screen.cursorHidden()) this.recordPassword();
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
        return this.runEdit(actions);
      }
      case "paste": {
        if (message.text === "") return null;
        if (this.screen.cursorHidden()) this.recordPassword();
        else this.record("PasteString", [message.text]);

        // Batched, so nothing else can be typed between the segments.
        const actions = message.segments.flatMap(({ row, col, text }) => [
          { action: "MoveCursor1", args: [String(row + 1), String(col + 1)] },
          {
            action: "PasteString",
            args: [Buffer.from(text, "utf8").toString("hex")],
          },
        ]);
        if (actions.length === 0) return null;
        return this.runEdit(actions);
      }
      default:
        return null;
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
   * The first cell of the input field under the cursor. Off any field it stays
   * put; a screen with no fields has only rows, so it is the start of the row.
   *
   * @returns {{ row: number, col: number }}
   */
  fieldStartTarget() {
    const { cursor, cells, cols } = this.screen;
    if (!this.screen.fieldsFormatted) return { row: cursor.row, col: 0 };
    let at = cursor.row * cols + cursor.col;
    if (!cells[at]?.editable) return { row: cursor.row, col: cursor.col };
    // A field can wrap past the last cell of the screen back to the first.
    for (let steps = 1; steps < cells.length; steps++) {
      const left = (at - 1 + cells.length) % cells.length;
      if (!cells[left]?.editable) break;
      at = left;
    }
    return { row: Math.floor(at / cols), col: at % cols };
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
    const everyone = [...this.viewers];
    const requests = [
      ...[...this.waiting].map((guest) => ({
        viewer: guest.id,
        name: nameOf(guest),
        kind: /** @type {const} */ ("watch"),
      })),
      ...everyone
        .filter((guest) => guest.wantsEdit === true)
        .map((guest) => ({
          viewer: guest.id,
          name: nameOf(guest),
          kind: /** @type {const} */ ("edit"),
        })),
    ];
    const guests = everyone.filter((guest) => guest.owner !== true).length;
    const editor = everyone.find(
      (guest) => guest.owner !== true && guest.role === "controller",
    );
    for (const viewer of this.viewers) {
      viewer.sendMessage({
        type: "status",
        connection: this.oia.connectionState,
        connected: this.oia.connected,
        touched: this.touched,
        host: this.oia.host,
        lock: this.oia.lock,
        insert: this.oia.insert,
        typeahead: this.oia.typeahead,
        role: viewer.role,
        viewers: this.viewers.size,
        owner: viewer.owner === true,
        guests,
        editor: editor === undefined ? null : nameOf(editor),
        requests: viewer.owner === true ? requests : [],
        editRequested: viewer.wantsEdit === true,
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
    this.inputQueue = [];
    this.emulator.close();
    this.viewers.clear();
    this.waiting.clear();
    if (this.onClosed) this.onClosed();
  }
}
