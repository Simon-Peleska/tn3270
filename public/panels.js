/**
 * The panels — menu, settings, macros, recorder, keys — as a host application
 * behind a `LocalHost`: screens of protected text and input fields, answered on
 * an AID key. A screen is picked by its id on the menu's option line; a list
 * line is worked on by a letter typed in the one-cell field before it:
 * S selects, E edits, D deletes, R resets.
 */

import { LocalHost } from "./local-host.js";
import { Grid } from "./grid.js";
import { computeHints } from "./hints.js";
import { sizeMode } from "./settings.js";
import { comboLabel } from "./keymap.js";
import { settingsLayout } from "./panel-settings.js";
import { themeLayout } from "./panel-theme.js";
import { fontLayout } from "./panel-font.js";
import { sizeLayout } from "./panel-size.js";
import {
  macrosLayout,
  macroEditLayout,
  macroCursorLayout,
} from "./panel-macros.js";
import {
  recordingsLayout,
  createMacroLayout,
  playbackScreen,
  schedulePlayback,
  playbackKey,
  playbackClick,
} from "./panel-recordings.js";
import { keysLayout, bindingsLayout } from "./panel-keys.js";
import { adminLayout } from "./panel-admin.js";
import { charsLayout, printableCharacter } from "./panel-chars.js";

/**
 * @typedef {object} PanelsDeps
 * @property {import('./settings.js').Settings} settings
 * @property {() => string} codePage
 * @property {import('./keymap.js').Keymap} keymap
 * @property {import('./macros.js').Macros} macros
 * @property {import('./recorder.js').Recorder} recorder
 * @property {() => void} redraw
 * @property {(theme: import('./settings.js').Theme) => void} applyTheme
 * @property {(font: { name: string, family: string }) => void} applyFont
 * @property {(enabled: boolean) => void} applyFieldBackground
 * @property {(model: number) => void} applyModel
 * @property {(value: string) => void} applyOversize
 * @property {(fontSize: number) => { cols: number, rows: number } | null} windowFit
 * @property {(host: string | null) => void} connect null reopens the server's host
 * @property {() => void} importRecording
 * @property {() => Promise<{ id: string, startedBy: string, startedAt: string }[]>} listSessions
 * @property {(id: string, requestEdit?: boolean) => void} joinSession
 * @property {(id: string) => boolean} ownsSession
 * @property {(id: string) => Promise<void>} terminateSession
 * @property {(character: string) => void} insertCharacter
 *
 * @typedef {object} Edit an input field in place of the line's value
 * @property {string} value what it starts with
 * @property {(text: string) => string | null} commit an error, or null when taken
 * @property {boolean} [open] open without an E, for as long as the line is there
 *
 * @typedef {object} Item one line of a list
 * @property {string} key names the line's fields, so it must not change while
 *   the line is on screen
 * @property {string} label
 * @property {string} [value]
 * @property {boolean} [current] the choice in force
 * @property {() => void} [s]
 * @property {() => void} [a]
 * @property {() => void} [c]
 * @property {() => void} [e] when the line is changed on a screen of its own
 * @property {Edit} [edit] when the line is changed in place
 * @property {'a' | 'e' | 'r'} [editOn] letter that opens the in-place edit
 * @property {() => void} [d]
 * @property {() => void} [r]
 * @property {() => void} [p]
 * @property {() => void} [m]
 * @property {() => void | Promise<void>} [k]
 * @property {() => void} [j]
 *
 * @typedef {{ id: string, top: number, insertAt?: number }} Frame a screen, and how far it is scrolled
 * @typedef {{ recording: import('./recorder.js').Recorder['recordings'][number], index: number, speed: number, direction: 1 | -1, paused: boolean, overlay: boolean, jumpDraft: string | null, jumpCaret: number, timer: ReturnType<typeof setTimeout> | null }} Playback
 * @typedef {object} PanelView
 * @property {number} rows
 * @property {number} cols
 * @property {(row: number, col: number, text: string, fg: string, gr?: string) => void} say
 * @property {(name: string, row: number, col: number, width: number, value: string, fgByPosition?: string[]) => void} field
 * @typedef {object} PanelLayout
 * @property {string | ((panel: Panels, id: string) => string)} [title]
 * @property {number} [listTop]
 * @property {number} [valueCol]
 * @property {number} [bottomReserve]
 * @property {number} [messageBottomOffset]
 * @property {boolean | ((panel: Panels) => boolean)} [lineCommands]
 * @property {(panel: Panels, view: PanelView) => void} [render]
 * @property {(panel: Panels, id: string) => Item[]} [items]
 * @property {(panel: Panels, values: Record<string, string>) => void} [input]
 * @property {(panel: Panels, command: string, id: string) => boolean} [command]
 */

/** @type {Readonly<Record<string, PanelLayout>>} */
const LAYOUTS = {
  menu: settingsLayout,
  settings: settingsLayout,
  theme: themeLayout,
  font: fontLayout,
  size: sizeLayout,
  macros: macrosLayout,
  recorder: recordingsLayout,
  keymap: keysLayout,
  admin: adminLayout,
  chars: charsLayout,
};

/** @param {string} id @returns {PanelLayout} */
function layoutFor(id) {
  if (id.startsWith("keys:")) return bindingsLayout;
  if (id.startsWith("macro-cursor:")) return macroCursorLayout;
  if (id.startsWith("macro:")) return macroEditLayout;
  if (id.startsWith("recording:")) return createMacroLayout;
  return LAYOUTS[id] ?? settingsLayout;
}

const BODY_TOP = 4;
const LABEL_COL = 3;

/**
 * @param {string} code
 * @param {string} text
 * @returns {string} what the message line shows
 */
function problem(code, text) {
  console.warn(`[${code}] ${text}`);
  return `[${code}] ${text}`;
}

/**
 * @param {number} count
 * @returns {string}
 */
export class Panels {
  /** @param {PanelsDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this.host = new LocalHost(this);
    /** @type {Frame[]} the screens walked through, the one on show last */
    this.stack = [];
    /** @type {string} */
    this.message = "";
    /** @type {Set<string>} the lines an E opened */
    this.editing = new Set();
    /** @type {Map<string, string>} what an edit said when it was refused */
    this.drafts = new Map();
    /** @type {string | null} the field the cursor goes back to */
    this.focus = null;
    this.macroCapture = false;
    /** @type {number | null} */
    this.macroInsertAt = null;
    /** @type {Playback | null} */
    this.playback = null;
    /** @type {{ id: string, startedBy: string, startedAt: string }[]} */
    this.adminSessions = [];
    this.adminLoading = false;
    /** @type {{ typed: Map<string, string[]>, cursor: { row: number, col: number }, fresh: boolean } | null} */
    this.pickerReturn = null;
  }

  /** @returns {boolean} */
  isOpen() {
    return this.stack.length > 0;
  }

  /**
   * From the session, so F3 goes straight back to it.
   *
   * @param {string} id menu, settings, macros, recorder or keymap
   * @returns {void}
   */
  open(id) {
    console.info("panel opened", { id });
    this.show([{ id, top: 0 }]);
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  toggle(id) {
    if (this.stack.at(-1)?.id === id) this.close();
    else this.open(id);
  }

  /** @returns {void} */
  close() {
    if (!this.isOpen()) return;
    console.info("panels closed");
    this.show([]);
  }

  /**
   * @param {Frame[]} stack
   * @returns {void}
   */
  show(stack) {
    if (stack.at(-1)?.id !== "chars") this.pickerReturn = null;
    if (!stack.at(-1)?.id.startsWith("playback:")) {
      if (this.playback !== null && this.playback.timer !== null)
        clearTimeout(this.playback.timer);
      this.playback = null;
    }
    this.stack = stack;
    this.message = "";
    this.editing.clear();
    this.drafts.clear();
    this.focus = null;
    this.macroCapture = false;
    this.macroInsertAt = null;
    this.host.restart();
    this.deps.redraw();
    if (stack.at(-1)?.id === "admin") void this.refreshAdmin();
  }

  /** @returns {Promise<void>} */
  async refreshAdmin() {
    this.adminLoading = true;
    this.deps.redraw();
    try {
      this.adminSessions = await this.deps.listSessions();
    } catch (cause) {
      console.error("[E5032] session list failed", cause);
      this.message = problem("E5032", "Open sessions could not be loaded");
    } finally {
      this.adminLoading = false;
      this.deps.redraw();
    }
  }

  /** @param {string} id @returns {Promise<void>} */
  async terminateSession(id) {
    try {
      await this.deps.terminateSession(id);
      this.message = `Session ${id.slice(0, 8)} terminated`;
      await this.refreshAdmin();
    } catch (cause) {
      console.error("[E5039] session termination failed", cause);
      this.message = problem("E5039", "The session could not be terminated");
      this.deps.redraw();
    }
  }

  /**
   * @param {string} id
   * @param {number} [insertAt]
   * @returns {void}
   */
  push(id, insertAt) {
    this.show([...this.stack, { id, top: 0, insertAt }]);
  }

  /** @returns {void} */
  back() {
    const current = this.stack.at(-1);

    // A disconnected session has nowhere useful to go.
    // Keep Settings open until the session reconnects.
    if (
      this.stack.length === 1 &&
      current?.id === "settings" &&
      !this.deps.settings.connected
    ) {
      return;
    }

    const returning = current?.id === "chars" ? this.pickerReturn : null;

    this.show(this.stack.slice(0, -1));

    if (returning !== null) {
      this.host.typed = returning.typed;
      this.host.cursor = returning.cursor;
      this.host.fresh = returning.fresh;
    }

    this.pickerReturn = null;
  }

  /** @returns {void} */
  openChars() {
    if (this.isCharacterPicker()) return;
    this.pickerReturn = this.isOpen()
      ? {
          typed: new Map(
            [...this.host.typed].map(([key, chars]) => [key, [...chars]]),
          ),
          cursor: { ...this.host.cursor },
          fresh: this.host.fresh,
        }
      : null;
    this.push("chars");
  }

  /** @returns {boolean} */
  isCharacterPicker() {
    return this.stack.at(-1)?.id === "chars";
  }

  /** @param {number} row @param {number} col @returns {boolean} */
  chooseCharacterAt(row, col) {
    if (
      !this.isCharacterPicker() ||
      row < 4 ||
      row > 15 ||
      col < 36 ||
      col > 67
    )
      return false;
    const byte = 0x40 + (row - 4) * 16 + Math.floor((col - 36) / 2);
    return this.chooseCharacterByte(byte);
  }

  /** @param {number} byte @returns {boolean} */
  chooseCharacterByte(byte) {
    const character = printableCharacter(this.deps.codePage(), byte);
    if (character === null) {
      this.message = problem(
        "E5035",
        "That byte has no printable character on this code page",
      );
      this.deps.redraw();
      return false;
    }
    this.back();
    this.deps.insertCharacter(character);
    return true;
  }

  /** @param {import('./recorder.js').Recorder['recordings'][number]} recording */
  openPlayback(recording) {
    console.info("recording playback opened", {
      name: recording.name,
      steps: recording.steps.length,
    });
    this.playback = {
      recording,
      index: 0,
      speed: 5,
      direction: 1,
      paused: recording.steps.length < 2,
      overlay: true,
      jumpDraft: null,
      jumpCaret: 0,
      timer: null,
    };
    this.push(`playback:${recording.recordedAt}`);
    this.schedulePlayback();
  }

  /** @returns {boolean} */
  isRecordingPlayback() {
    return (
      this.playback !== null &&
      (this.stack.at(-1)?.id.startsWith("playback:") ?? false)
    );
  }

  /** @returns {void} */
  schedulePlayback() {
    schedulePlayback(this);
  }

  /** @param {string} key @returns {boolean} */
  playbackKey(key) {
    return playbackKey(this, key);
  }

  /** @param {number} row @param {number} col */
  playbackClick(row, col) {
    playbackClick(this, row, col);
  }

  /**
   * @param {import('../server/protocol.js').ClientMessage} message
   * @returns {void}
   */
  receive(message) {
    this.host.receive(message);
    this.deps.redraw();
  }

  /** @returns {boolean} whether the cursor is in a key field, where a key pressed writes its name */
  capturing() {
    if (!this.stack.at(-1)?.id.startsWith("keys:")) return false;
    const field = this.host.fieldAtCursor(this.host.layout().fields);
    return field?.name.startsWith("edit:") ?? false;
  }

  /** @returns {boolean} */
  capturingMacro() {
    if (!this.macroCapture || !this.stack.at(-1)?.id.startsWith("macro:"))
      return false;
    const field = this.host.fieldAtCursor(this.host.layout().fields);
    return field?.name.startsWith("edit:") ?? false;
  }

  /** @returns {boolean} */
  isMacroEditor() {
    return this.stack.at(-1)?.id.startsWith("macro:") ?? false;
  }

  /** @returns {void} */
  exitMacroCapture() {
    this.macroCapture = false;
    this.macroInsertAt = null;
    this.editing.clear();
    this.focus = "command";
    this.host.restart();
    this.deps.redraw();
  }

  /** @param {number} index @param {boolean} [replace] @returns {void} */
  startMacroCapture(index, replace = false) {
    this.macroCapture = true;
    this.macroInsertAt = replace ? null : index;
    const frame = this.stack.at(-1);
    if (frame !== undefined)
      frame.top = Math.max(frame.top, index - this.height(frame) + 1);
    this.focus = replace ? `edit:${index}` : "edit:insert";
    this.host.restart();
    this.deps.redraw();
  }

  /** @param {{ kind: 'text', value: string } | { kind: 'action', action: string, args: string[] }} input */
  captureMacro(input) {
    const frame = this.stack.at(-1);
    if (frame === undefined || !frame.id.startsWith("macro:")) return;
    const field = this.host.fieldAtCursor(this.host.layout().fields);
    if (field === undefined || !field.name.startsWith("edit:")) return;
    const macro = this.deps.macros.macros.find(
      (entry) => entry.name === frame.id.slice(6),
    );
    if (macro === undefined) return;

    const key = field.name.slice(5);
    const index = key === "insert" ? this.macroInsertAt : Number(key);
    if (index === null || !Number.isInteger(index)) return;
    const step =
      input.kind === "text"
        ? { text: input.value, action: "", args: [] }
        : { text: "", action: input.action, args: input.args };
    if (key === "insert") macro.steps.splice(index, 0, step);
    else macro.steps[index] = step;
    this.deps.macros.deps.persist(this.deps.macros.macros);

    const next = index + 1;
    this.macroInsertAt = next;
    frame.top = Math.max(frame.top, next - this.height(frame) + 1);
    this.focus = "edit:insert";
    this.host.restart();
    this.deps.redraw();
  }

  /** @returns {boolean} */
  pickingMacroCursor() {
    return this.stack.at(-1)?.id.startsWith("macro-cursor:") ?? false;
  }

  /** @param {number} index */
  openMacroCursor(index) {
    const frame = this.stack.at(-1);
    if (frame === undefined || !frame.id.startsWith("macro:")) return;
    this.push(`macro-cursor:${frame.id.slice(6)}`, index);
  }

  /** @param {number} row 0-based @param {number} col 0-based */
  addMacroCursorMove(row, col) {
    const frame = this.stack.at(-1);
    if (frame === undefined || !frame.id.startsWith("macro-cursor:")) return;
    const macro = this.deps.macros.macros.find(
      (entry) => entry.name === frame.id.slice(13),
    );
    if (macro === undefined) return;
    const index = Math.min(
      frame.insertAt ?? macro.steps.length,
      macro.steps.length,
    );
    macro.steps.splice(index, 0, {
      text: "",
      action: "MoveCursor1",
      args: [String(row + 1), String(col + 1)],
    });
    this.deps.macros.deps.persist(this.deps.macros.macros);
    this.back();
    const editor = this.stack.at(-1);
    if (editor?.id.startsWith("macro:")) {
      editor.top = Math.max(editor.top, index - this.height(editor) + 1);
      this.focus = `line:${index}`;
      this.host.restart();
      this.deps.redraw();
    }
  }

  /**
   * @param {import('./keymap.js').Combo} combo
   * @returns {void}
   */
  capture(combo) {
    console.info("key captured", { key: comboLabel(combo) });
    this.host.fill(comboLabel(combo));
    this.deps.redraw();
  }

  /**
   * @param {number} rows
   * @param {number} cols
   * @returns {import('../server/protocol.js').PaintMessage}
   */
  paint(rows, cols) {
    const painted = this.host.paint(rows, cols);
    const playback = this.playback;
    if (this.isRecordingPlayback() && playback !== null) {
      const step = playback.recording.steps[playback.index];
      const cursor = step?.cursor;
      const valid =
        cursor !== undefined &&
        cursor.row >= 0 &&
        cursor.row < rows &&
        cursor.col >= 0 &&
        cursor.col < cols;
      if (playback.overlay && valid) {
        const colors = this.deps.settings.theme().colors;
        const ch = Array.from(step.screen[cursor.row] ?? "")[cursor.col] ?? " ";
        painted.rows[cursor.row]?.runs.push({
          col: cursor.col,
          text: ch,
          fg: colors.cursorAccent ?? "#000000",
          bg: colors.cursor ?? "#ffffff",
        });
        const jump = this.host
          .layout()
          .fields.find((field) => field.name === "jump");
        painted.cursor = jump
          ? {
              row: jump.row,
              col:
                jump.col +
                Math.min(
                  playback.jumpDraft === null
                    ? jump.value.length
                    : playback.jumpCaret,
                  jump.width - 1,
                ),
              on: true,
            }
          : { row: cursor.row, col: cursor.col, on: true };
      } else {
        painted.cursor = {
          row: cursor?.row ?? 0,
          col: cursor?.col ?? 0,
          on: valid,
        };
      }
    }
    return painted;
  }

  /** @param {number} rows @param {number} cols @returns {{ row: number, col: number, letter: string }[]} */
  hints(rows, cols) {
    const grid = new Grid(rows, cols, null);
    grid.applyPaint(this.paint(rows, cols));
    return computeHints(grid.cells, grid.cols);
  }

  /** @returns {number} list lines that fit between the message and the keys */
  height(frame = this.stack.at(-1)) {
    const layout = layoutFor(frame?.id ?? "settings");
    return (
      this.host.rows -
      (layout.listTop ?? BODY_TOP) -
      (layout.bottomReserve ?? 3)
    );
  }

  /**
   * @param {number} rows
   * @param {number} cols
   * @returns {import('./local-host.js').HostScreen}
   */
  screen(rows, cols) {
    const frame = this.stack.at(-1) ?? { id: "menu", top: 0 };
    if (this.isRecordingPlayback()) return playbackScreen(this, rows, cols);
    /** @type {import('./local-host.js').Text[]} */
    const texts = [];
    /** @type {import('./local-host.js').Field[]} */
    const fields = [];
    /**
     * @param {number} row
     * @param {number} col
     * @param {string} text
     * @param {string} fg
     * @param {string} [gr]
     */
    const say = (row, col, text, fg, gr) => {
      const cut = text.slice(0, Math.max(0, cols - col));
      if (cut !== "") texts.push({ row, col, text: cut, fg, gr });
    };

    const layout = layoutFor(frame.id);
    const title =
      typeof layout.title === "function"
        ? layout.title(this, frame.id)
        : (layout.title ?? "TN3270");
    say(
      0,
      Math.max(0, Math.floor((cols - title.length) / 2)),
      title,
      "neutralWhite",
      "highlight",
    );
    /** @type {PanelView['field']} */
    const field = (name, row, col, width, value, fgByPosition) => {
      if (width > 0 && col < cols)
        fields.push({
          name,
          row,
          col,
          width: Math.min(width, cols - col),
          value,
          fgByPosition,
        });
    };
    layout.render?.(this, { rows, cols, say, field });
    say(
      rows - (layout.messageBottomOffset ?? 3),
      2,
      this.message,
      "red",
      "highlight",
    );

    const keys = [`${this.deps.keymap.labelFor("PF3")}=Exit`];
    const items = layout.items?.(this, frame.id) ?? [];
    const listTop = layout.listTop ?? BODY_TOP;
    const capacity = Math.max(0, rows - listTop - (layout.bottomReserve ?? 3));
    const labelWidth = frame.id.startsWith("keys:")
      ? 0
      : Math.max(0, ...items.map((item) => item.label.length)) + 1;
    const valueCol = layout.valueCol ?? LABEL_COL + labelWidth;
    const lineCommands =
      typeof layout.lineCommands === "function"
        ? layout.lineCommands(this)
        : layout.lineCommands !== false;
    items.slice(frame.top, frame.top + capacity).forEach((item, index) => {
      const row = listTop + index;
      if (lineCommands) field(`line:${item.key}`, row, 1, 1, "");
      say(row, LABEL_COL, item.label, item.current ? "yellow" : "green");
      const edit = item.edit;
      if (edit !== undefined && (edit.open || this.editing.has(item.key))) {
        field(
          `edit:${item.key}`,
          row,
          valueCol,
          cols - valueCol - 1,
          this.drafts.get(item.key) ?? edit.value,
        );
      } else if (item.value !== undefined) {
        say(row, valueCol, item.value, item.current ? "yellow" : "turquoise");
      }
    });
    if (frame.top > 0) keys.push(`${this.deps.keymap.labelFor("PF7")}=Up`);
    if (frame.top + capacity < items.length)
      keys.push(`${this.deps.keymap.labelFor("PF8")}=Down`);
    say(
      rows - 1,
      1,
      keys.filter((key) => !key.startsWith("=")).join("  "),
      "turquoise",
    );

    const names = fields.map((field) => field.name);
    const focused =
      this.focus !== null && names.includes(this.focus) ? this.focus : null;
    const firstEdit = names.find((name) => name.startsWith("edit:"));
    const cursor =
      (frame.id.startsWith("macro:")
        ? (focused ?? firstEdit)
        : (firstEdit ?? focused)) ??
      names.find((name) => name.startsWith("line:")) ??
      "command";
    return { texts, fields, cursor };
  }

  /** @param {string} code @param {string} text @returns {string} */
  problem(code, text) {
    return problem(code, text);
  }

  /** @param {Frame} frame @returns {Item[]} */
  items(frame) {
    return layoutFor(frame.id).items?.(this, frame.id) ?? [];
  }

  /**
   * @param {string} host
   * @returns {boolean} whether it was asked for
   */
  connect(host) {
    if (host === "") {
      this.message = problem("E5019", "Type a host as name:port first");
      return false;
    }
    this.deps.connect(host);
    return true;
  }

  /**
   * @param {number} model
   * @returns {string} the oversize a fit comes to in this window, '' when it
   *   cannot be measured
   */
  fitOversize(model) {
    const { settings } = this.deps;
    const fit = this.deps.windowFit(settings.values.fitFontSize);
    return fit === null ? "" : settings.fitSize(fit, model);
  }

  /** @returns {void} a new text size is a new fit */
  refit() {
    const { settings } = this.deps;
    if (!settings.fitsWindow()) return;
    const oversize = this.fitOversize(settings.model);
    if (oversize !== "" && oversize !== settings.oversize)
      this.deps.applyOversize(oversize);
  }

  /**
   * Only a size actually changed is a choice worth keeping over the server's.
   *
   * @param {number} model
   * @param {string} oversize
   * @returns {void}
   */
  applySize(model, oversize) {
    const { settings } = this.deps;
    console.info("screen size chosen", { model, oversize });
    if (model !== settings.model) {
      this.deps.applyModel(model);
      settings.values.model = model;
    }
    if (oversize !== settings.oversize) {
      this.deps.applyOversize(oversize);
      settings.values.screenSize = sizeMode(oversize);
    }
    settings.save();
  }

  /**
   * @param {string} aid
   * @param {Record<string, string>} values
   * @returns {void}
   */
  aid(aid, values) {
    const frame = this.stack.at(-1);
    if (frame === undefined) return;
    console.info("panel aid", { screen: frame.id, aid });
    this.message = "";

    if (aid === "Attn") this.close();
    else if (aid === "PF3" || aid === "PF12") this.back();
    else if (aid === "PF4") this.show([{ id: "menu", top: 0 }]);
    else if (aid === "PF7" || aid === "PF8") {
      const count = this.items(frame).length;
      const step = aid === "PF7" ? -this.height(frame) : this.height(frame);
      frame.top = Math.max(
        0,
        Math.min(frame.top + step, count - this.height(frame)),
      );
      this.editing.clear();
      this.drafts.clear();
    } else if (aid === "Enter") this.enter(frame, values);
  }

  /**
   * The open edits are taken first, then the command line; with nothing on
   * it, the line commands run top to bottom until one leaves the screen.
   *
   * @param {Frame} frame
   * @param {Record<string, string>} values
   * @returns {void}
   */
  enter(frame, values) {
    const items = this.items(frame);
    const letterOf = (/** @type {Item} */ item) =>
      (values[`line:${item.key}`] ?? "").trim().toLowerCase();

    layoutFor(frame.id).input?.(this, values);

    for (const item of items) {
      const text = values[`edit:${item.key}`];
      // A letter on the line is what was meant, D on an unsaved macro above all.
      if (
        text === undefined ||
        item.edit === undefined ||
        letterOf(item) !== ""
      )
        continue;
      const error = item.edit.commit(text);
      if (error === null) {
        this.editing.delete(item.key);
        this.drafts.delete(item.key);
      } else {
        this.drafts.set(item.key, text);
        this.message = error;
      }
    }
    if (this.stack.at(-1) !== frame) return;

    const command = (values["command"] ?? "").trim().toUpperCase();
    if (command !== "") {
      this.command(frame, command);
      return;
    }

    for (const item of items) {
      const letter = letterOf(item);
      if (letter === "") continue;
      this.focus = `line:${item.key}`;
      if (
        letter === (item.editOn ?? "e") &&
        item.edit !== undefined &&
        item[letter] === undefined
      ) {
        this.editing.add(item.key);
        this.drafts.delete(item.key);
        continue;
      }
      const run =
        letter === "a" ||
        letter === "c" ||
        letter === "s" ||
        letter === "e" ||
        letter === "d" ||
        letter === "r" ||
        letter === "p" ||
        letter === "m" ||
        letter === "k" ||
        letter === "j"
          ? item[letter]
          : undefined;
      if (run === undefined) {
        this.message = problem(
          "E5016",
          `${letter.toUpperCase()} does nothing on ${item.label || item.value || "this line"}`,
        );
        continue;
      }
      console.info("line command", {
        screen: frame.id,
        line: item.key,
        letter,
      });
      run();
      if (this.stack.at(-1) !== frame) return;
    }
  }

  /**
   * @param {Frame} frame
   * @param {string} command upper case
   * @returns {void}
   */
  command(frame, command) {
    console.info("panel command", { screen: frame.id, command });
    const jump = command.startsWith("=") ? command.slice(1).trim() : null;
    if (jump !== null && settingsLayout.command(this, jump)) return;
    if (layoutFor(frame.id).command?.(this, command, frame.id)) return;
    if (["END", "EXIT", "CANCEL", "CAN"].includes(command)) {
      this.back();
      return;
    }
    if (command === "RETURN" || command === "MENU") {
      this.show([{ id: "menu", top: 0 }]);
      return;
    }
    this.message = problem("E5015", `${command} is not a command here`);
  }
}
