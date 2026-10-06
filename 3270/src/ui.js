import { ALIASES, CODE_PAGES } from "./codepages.js";
import { scrollBufInit } from "./scroll.js";
import {
  CS_APL,
  CS_GE,
  CS_MASK,
  aplUnderlined,
  ebcdicToUnicode,
} from "./charset.js";
import {
  CELL_ARRAYS,
  FA_INTENSITY,
  FA_MODIFY,
  FA_PROTECT,
  erase,
  faAt,
  findFieldAttribute,
  isZero,
  newCells,
  EBC_DUP,
  EBC_FM,
  EBC_NULL,
  EBC_SI,
  EBC_SO,
  FA_INT_HIGH_SEL,
  FA_INT_NORM_SEL,
  GR_BLINK,
  GR_INTENSIFY,
  GR_REVERSE,
  GR_UNDERLINE,
  GR_WRAP,
} from "./ctlr.js";
import {
  KL_AWAITING_FIRST,
  KL_BID,
  KL_DEFERRED_UNLOCK,
  KL_ENTER_INHIBIT,
  KL_FT,
} from "./kybd.js";
import { NOT_CONNECTED, in3270 } from "./session.js";
import { initialSettings } from "./toggles.js";

// Port of b3270's screen.c and status.c, plus the connection report from b3270.c:
// the indications `b3270 -json` writes, handed out as (kind, body) pairs. A State
// without s.ui skips all of it, so sessions that don't stream pay nothing. Only what
// the app uses is here: the screen's contents are just the rows that changed, with
// the render left in ui.saved. test/b3270.js plugs in the rest of b3270's output.

/** @typedef {import("./session.js").State} State */
/** @typedef {(kind: string, body: any) => void} Out */

const XX_UNDERLINE = 0x0001,
  XX_BLINK = 0x0002,
  XX_HIGHLIGHT = 0x0004,
  XX_SELECTABLE = 0x0008,
  XX_REVERSE = 0x0010;
const XX_ORDER = 0x0040,
  XX_PUA = 0x0080,
  XX_NO_COPY = 0x0100,
  XX_WRAP = 0x0200;
const GR_NAMES = [
  "underline",
  "blink",
  "highlight",
  "selectable",
  "reverse",
  "wide",
  "order",
  "private-use",
  "no-copy",
  "wrap",
  "left-half",
  "right-half",
];

export const COLOR_NAMES = [
  "neutralBlack",
  "blue",
  "red",
  "pink",
  "green",
  "turquoise",
  "yellow",
  "neutralWhite",
  "black",
  "deepBlue",
  "orange",
  "purple",
  "paleGreen",
  "paleTurquoise",
  "grey",
  "white",
];
export const BLUE = 1,
  RED = 2,
  GREEN = 4,
  NEUTRAL_WHITE = 7,
  NEUTRAL_BLACK = 0;

export const CSTATE_NAMES = [
  "not-connected",
  "reconnecting",
  "tls-password-pending",
  "resolving",
  "tcp-pending",
  "tls-pending",
  "proxy-pending",
  "telnet-pending",
  "connected-nvt",
  "connected-nvt-charmode",
  "connected-3270",
  "connected-unbound",
  "connected-e-nvt",
  "connected-sscp",
  "connected-tn3270e",
];

/** A rendered screen: what b3270 calls screen_t, as parallel arrays. @param {number} size */
export function createRendered(size) {
  return {
    cc: new Uint32Array(size),
    fg: new Uint8Array(size),
    bg: new Uint8Array(size),
    gr: new Uint16Array(size),
  };
}
/** @typedef {ReturnType<typeof createRendered>} Rendered */

/**
 * test/b3270.js, which the conformance tests plug in: it draws the screen in place of the
 * emulator's own row reports below, and adds the indications only b3270 writes.
 * @typedef {object} B3270Hooks
 * @property {(s: State) => void} reset a new screen size, or a new model
 * @property {(s: State, always: boolean) => void} disp
 * @property {(s: State) => void} scroll before the cells move up a row
 * @property {(s: State, top: number) => void} thumb the scrollback moved
 * @property {(s: State) => void} terminalName the terminal name may have changed
 * @property {(s: State) => void} statsPoke the byte and record counters moved
 * @property {(s: State) => void} connection after a connect, or before a disconnect is reported
 */

/** @param {Out} out @param {B3270Hooks | null} b3270 */
export function createUi(out, b3270) {
  return {
    out,
    b3270,
    // screen.c
    lastRows: 0,
    lastCols: 0,
    /** The cells as last drawn, to find the rows that changed since. */
    savedEa: newCells(0),
    /** The last render, laid out at the largest screen size; the web server reads it. */
    saved: createRendered(0),
    savedFormatted: false,
    redrawAll: true,
    drawnBlank: false,
    sentBaddr: 0,
    cursorEnabled: true,
    // status.c
    /** @type {string} */
    lockKind: "none",
    /** @type {string | null} */
    savedLock: null,
    scrolled: 0,
    insert: false,
    reverse: false,
    typeahead: false,
    script: false,
    undera: true,
    /** @type {string | null} */
    lu: null,
    // b3270.c
    oldCstate: NOT_CONNECTED,
    /** @type {NodeJS.Timeout | null} */
    ncTimer: null,
  };
}
/** @typedef {ReturnType<typeof createUi>} Ui */

/**
 * b3270's initialize block, less what only b3270 says, which test/b3270.js adds.
 * @param {State} s @returns {{kind: string, body: any}[]}
 */
export function initializeIndications(s) {
  /** @type {Record<string, string[]>} */
  const aliases = {};
  for (const [alias, name] of Object.entries(ALIASES))
    (aliases[name] ??= []).push(alias);
  const codePages = Object.keys(CODE_PAGES).map((name) =>
    aliases[name] ? { name, aliases: aliases[name] } : { name },
  );
  const models = [
    [2, 24, 80],
    [3, 32, 80],
    [4, 43, 80],
    [5, 27, 132],
  ].map(([model, rows, columns]) => ({
    model,
    rows,
    columns,
  }));
  /** @type {{kind: string, body: any}[]} */
  const list = [];
  const ui = /** @type {Ui} */ (s.ui);
  const out = ui.out;
  ui.out = (kind, body) => list.push({ kind, body });
  ui.out("code-pages", codePages);
  ui.out("models", models);
  statusReset(s);
  screenInit(s);
  scrollBufInit(s);
  list.push(...initialSettings(s));
  ui.out = out;
  return list;
}

// ---- screen.c

/** @param {State} s @param {Rendered} r */
export function blank(s, r) {
  r.cc.fill(0x20);
  r.fg.fill(s.mode3279 ? BLUE : NEUTRAL_WHITE);
  r.bg.fill(NEUTRAL_BLACK);
  r.gr.fill(0);
}

/** @param {State} s @param {number} rows @param {number} cols */
export function emitErase(s, rows, cols) {
  /** @type {Record<string, any>} */
  const body = {};
  if (rows > 0 && cols > 0) {
    body["logical-rows"] = rows;
    body["logical-columns"] = cols;
  }
  if (s.mode3279) {
    body.fg = "blue";
    body.bg = "neutralBlack";
  }
  /** @type {Ui} */ (s.ui).out("erase", body);
}

/** screen_change_model(): a new maximum screen size, so new buffers. @param {State} s */
export function screenChangeModel(s) {
  if (s.ui) screenInit(s);
}

/** internal_screen_init() @param {State} s */
function screenInit(s) {
  const ui = /** @type {Ui} */ (s.ui);
  ui.out("screen-mode", {
    model: s.model,
    rows: s.maxRows,
    columns: s.maxCols,
    color: s.mode3279,
    oversize: s.oversized,
    extended: s.options.extendedDataStream,
  });
  emitErase(s, s.maxRows, s.maxCols);
  ui.lastRows = s.maxRows;
  ui.lastCols = s.maxCols;
  if (ui.b3270) {
    ui.b3270.reset(s);
    return;
  }
  const size = s.maxRows * s.maxCols;
  ui.savedEa = newCells(size);
  ui.saved = createRendered(size);
  blank(s, ui.saved);
  ui.redrawAll = true;
}

/** @param {State} s @param {number} fa */
function colorFromFa(s, fa) {
  if (!s.mode3279) return NEUTRAL_WHITE;
  return [GREEN, RED, BLUE, NEUTRAL_WHITE][
    ((fa & FA_PROTECT) >> 4) | ((fa & FA_INT_HIGH_SEL) >> 3)
  ];
}

/** @param {number} fa */
const isHigh = (fa) => (fa & FA_INTENSITY) === FA_INT_HIGH_SEL;
/** @param {number} fa */
const isSelectable = (fa) =>
  (fa & FA_INTENSITY) === FA_INT_NORM_SEL ||
  (fa & FA_INTENSITY) === FA_INT_HIGH_SEL;

const VISIBLE_FA = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
/** visible_fa(): protect, numeric, intensity and modify as one digit. @param {number} fa */
const visibleFaIndex = (fa) => ((fa & 0x3c) >> 1) | (fa & 0x01);

/** render_screen(), for the rows flagged in `dirty` (all when null); the others keep what `r` holds. @param {State} s @param {Rendered} r @param {Uint8Array | null} dirty */
export function render(s, r, dirty) {
  if (!dirty) blank(s, r);
  let fa = 0,
    faFg = 0,
    faBg = 0,
    faHigh = false,
    faGr = 0,
    faCs = 0;
  let fieldKnown = false;

  for (let i = 0; i < s.rows * s.cols; i++) {
    const row = (i / s.cols) | 0;
    if (dirty && !dirty[row]) {
      i += s.cols - 1;
      fieldKnown = false;
      continue;
    }
    if (!fieldKnown) {
      const faAddr = findFieldAttribute(s, i);
      fa = faAt(s, faAddr);
      const at = (/** @type {Uint8Array} */ arr) =>
        faAddr < 0 ? 0 : arr[faAddr];
      faFg = at(s.fg) ? at(s.fg) & 0x0f : colorFromFa(s, fa);
      faBg = at(s.bg) ? at(s.bg) & 0x0f : NEUTRAL_BLACK;
      faHigh = at(s.gr) & GR_INTENSIFY ? true : isHigh(fa);
      faGr = at(s.gr);
      faCs = at(s.cs);
      fieldKnown = true;
    }
    let uc;
    let cs;
    let order = false,
      extraUnderline = false,
      pua = false;
    let noCopy = false;
    if (s.fa[i]) {
      uc = 0x20;
      fa = s.fa[i];
      faFg = s.fg[i] ? s.fg[i] & 0x0f : colorFromFa(s, fa);
      faBg = s.bg[i] ? s.bg[i] & 0x0f : NEUTRAL_BLACK;
      faHigh = s.gr[i] & GR_INTENSIFY ? true : isHigh(fa);
      faGr = s.gr[i];
      faCs = s.cs[i];
    } else if (isZero(fa)) {
      uc = 0x20;
    } else {
      cs = s.cs[i] || faCs;
      const ec = s.ec[i];
      if (ec === EBC_NULL || ec === EBC_SO || ec === EBC_SI) {
        uc = 0x20;
        if (s.options.visibleControl) {
          uc = ec === EBC_NULL ? 0x2e : ec === EBC_SO ? 0x3c : 0x3e;
          order = true;
          noCopy = ec !== EBC_NULL;
        }
      } else if (ec === EBC_DUP) {
        uc = 0x2a;
        pua = order = true;
      } else if (ec === EBC_FM) {
        uc = 0x3b;
        pua = order = true;
      } else {
        uc = ebcdicToUnicode(s.codePage, ec, cs);
        if ((cs & CS_GE || (cs & CS_MASK) === CS_APL) && aplUnderlined(ec))
          extraUnderline = pua = true;
        if (uc === 0) uc = 0x20;
      }
    }

    let fgColor = s.fg[i] ? s.fg[i] & 0x0f : faFg;
    let bgColor = s.bg[i] ? s.bg[i] & 0x0f : faBg;
    const gr = faGr | s.gr[i];
    if (!s.fa[i] && gr & GR_REVERSE) [fgColor, bgColor] = [bgColor, fgColor];
    const high = gr & GR_INTENSIFY ? true : faHigh;

    const si = row * s.maxCols + (i % s.cols);
    const visibleFa = s.options.visibleControl && s.fa[i] !== 0;
    r.cc[si] = visibleFa ? VISIBLE_FA.charCodeAt(visibleFaIndex(s.fa[i])) : uc;
    r.fg[si] = s.mode3279 ? fgColor : NEUTRAL_WHITE;
    r.bg[si] = s.mode3279 ? bgColor : NEUTRAL_BLACK;
    let xx = 0;
    if (!s.fa[i] && !isZero(fa) && gr & GR_UNDERLINE) xx |= XX_UNDERLINE;
    if (gr & GR_BLINK) xx |= XX_BLINK;
    if (high) xx |= XX_HIGHLIGHT;
    if (isSelectable(fa)) xx |= XX_SELECTABLE;
    if (!s.mode3279 && gr & GR_REVERSE) xx |= XX_REVERSE;
    if (order || visibleFa) xx |= XX_ORDER;
    if (!s.fa[i] && !isZero(fa) && extraUnderline) xx |= XX_UNDERLINE;
    if (pua) xx |= XX_PUA;
    if (noCopy) xx |= XX_NO_COPY;
    if (s.gr[i] & GR_WRAP) xx |= XX_WRAP;
    r.gr[si] = xx;
  }
}

/** @type {string[]} */
const GR_TEXT = [];

/** @param {number} gr */
export function seeGr(gr) {
  if (!gr) return "default";
  return (GR_TEXT[gr] ??= GR_NAMES.filter((_, bit) => gr & (1 << bit)).join(
    ",",
  ));
}

/** emit_cursor_cond(false): the cursor part of a screen indication, or null. @param {Ui} ui @param {State} s */
export function cursorChange(ui, s) {
  if (!ui.cursorEnabled || ui.sentBaddr === s.savedBaddr) return null;
  ui.sentBaddr = s.savedBaddr;
  return {
    enabled: true,
    row: ((s.savedBaddr / s.cols) | 0) + 1,
    column: (s.savedBaddr % s.cols) + 1,
  };
}

/** emit_cursor_cond(true) @param {Ui} ui @param {State} s */
export function emitCursor(ui, s) {
  const cursor = cursorChange(ui, s);
  if (cursor) ui.out("screen", { cursor });
}

/** @param {State} s */
export function eaEmpty(s) {
  const n = s.rows * s.cols;
  for (const name of CELL_ARRAYS) {
    const a = s[name];
    for (let i = 0; i < n; i++) if (a[i]) return false;
  }
  return true;
}

/** @param {Uint8Array} a */
const asWords = (a) =>
  new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);

/**
 * The rows whose cells differ from the last draw, or null when a field attribute's looks
 * changed, which carry over to every cell up to the next one, whatever row that is on.
 * @param {State} s @param {Ui} ui
 */
function changedRows(s, ui) {
  const rows = new Uint8Array(s.rows);
  const bytes = s.rows * s.cols;
  const savedFa = ui.savedEa.fa;
  for (const name of CELL_ARRAYS) {
    const now = s[name];
    const was = ui.savedEa[name];
    const nowBytes = Buffer.from(now.buffer, now.byteOffset, bytes);
    if (nowBytes.equals(Buffer.from(was.buffer, was.byteOffset, bytes)))
      continue;
    // Compared a word at a time where a row is whole words: one keystroke is the common case.
    const wide = s.cols % 4 === 0;
    const a = wide ? asWords(now) : now;
    const b = wide ? asWords(was) : was;
    const perRow = wide ? s.cols / 4 : s.cols;
    const fieldLooks =
      name === "fa" ||
      name === "fg" ||
      name === "bg" ||
      name === "gr" ||
      name === "cs";
    for (let row = 0; row < s.rows; row++) {
      if (rows[row] && !fieldLooks) continue;
      let differs = false;
      for (let w = row * perRow; w < (row + 1) * perRow; w++) {
        if (a[w] === b[w]) continue;
        differs = true;
        break;
      }
      if (!differs) continue;
      rows[row] = 1;
      if (!fieldLooks) continue;
      for (let i = row * s.cols; i < (row + 1) * s.cols; i++) {
        if (now[i] === was[i] || (!s.fa[i] && !savedFa[i])) continue;
        const onlyMdt =
          name === "fa" &&
          now[i] &&
          was[i] &&
          !((now[i] ^ was[i]) & ~FA_MODIFY);
        if (!onlyMdt) return null;
      }
    }
  }
  return rows;
}

/**
 * screen_disp_cond(), cut down to what the web server needs: the rows that changed since the
 * last call are drawn into ui.saved and reported by number, 1-based like b3270's. `always`
 * redraws even an unchanged buffer.
 * @param {State} s @param {boolean} [always]
 */
export function screenDisp(s, always = false) {
  const ui = s.ui;
  if (!ui) return;
  if (ui.b3270) {
    ui.b3270.disp(s, always);
    return;
  }
  if (s.rows !== ui.lastRows || s.cols !== ui.lastCols) {
    emitErase(s, s.rows, s.cols);
    ui.lastRows = s.rows;
    ui.lastCols = s.cols;
    ui.redrawAll = true;
  }

  // s.changed is set by every cell write and only cleared by Session.flush() after this has drawn.
  if (!always && !s.changed && !ui.redrawAll) {
    emitCursor(ui, s);
    return;
  }

  const changed = ui.redrawAll ? null : changedRows(s, ui);
  if (!always && changed && !changed.includes(1)) {
    emitCursor(ui, s);
    return;
  }

  const size = s.rows * s.cols;
  for (const name of CELL_ARRAYS)
    ui.savedEa[name].set(s[name].subarray(0, size));
  ui.redrawAll = false;
  /** @type {{rows: number[], cursor?: {enabled: boolean, row: number, column: number}}} */
  const body = { rows: [] };

  if (eaEmpty(s)) {
    if (ui.drawnBlank) {
      emitCursor(ui, s);
      return;
    }
    // Not what render() draws for an unformatted screen: there the colour comes from field attribute 0.
    blank(s, ui.saved);
    ui.drawnBlank = true;
    for (let row = 0; row < s.rows; row++) body.rows.push(row + 1);
  } else {
    const dirty =
      always || ui.drawnBlank || ui.savedFormatted !== s.formatted
        ? null
        : changed;
    render(s, ui.saved, dirty);
    ui.drawnBlank = false;
    ui.savedFormatted = s.formatted;
    for (let row = 0; row < s.rows; row++)
      if (!dirty || dirty[row]) body.rows.push(row + 1);
  }
  const cursor = cursorChange(ui, s);
  if (cursor) body.cursor = cursor;
  ui.out("screen", body);
}

/** enable_cursor() @param {State} s @param {boolean} on */
export function enableCursor(s, on) {
  const ui = s.ui;
  if (!ui || on === ui.cursorEnabled) return;
  ui.cursorEnabled = on;
  if (on) return;
  ui.out("screen", { cursor: { enabled: false } });
  ui.sentBaddr = -1;
}

// ---- status.c

/** @param {Ui} ui @param {string} field @param {any} value */
function oia(ui, field, value) {
  ui.out(
    "oia",
    value === null || value === undefined ? { field } : { field, value },
  );
}

/** @param {Ui} ui @param {string | null} msg */
function statusLock(ui, msg) {
  ui.savedLock = msg;
  if (!ui.scrolled) oia(ui, "lock", msg);
}

/** status_scrolled(): n screens back shows in place of the lock message. @param {State} s @param {number} n */
export function statusScrolled(s, n) {
  const ui = s.ui;
  if (!ui || ui.scrolled === n) return;
  ui.scrolled = n;
  oia(ui, "lock", n ? `scrolled ${n}` : ui.savedLock);
}

/** @param {Ui} ui @param {string} kind @param {string | null} msg */
function lockAs(ui, kind, msg) {
  if (ui.lockKind === kind) return;
  ui.lockKind = kind;
  statusLock(ui, msg);
}

/** status_reset(): the lock message that goes with the current keyboard lock. @param {State} s */
export function statusReset(s) {
  const ui = s.ui;
  if (!ui) return;
  if (!in3270(s)) lockAs(ui, "not-connected", "not-connected");
  else if (s.kybdlock & KL_ENTER_INHIBIT) lockAs(ui, "twait", "twait");
  else if (s.kybdlock & KL_DEFERRED_UNLOCK) lockAs(ui, "deferred", "deferred");
  else if (s.kybdlock & KL_FT) lockAs(ui, "file-transfer", "file-transfer");
  else if (s.kybdlock & KL_AWAITING_FIRST) lockAs(ui, "field", "field");
  else if (s.kybdlock & KL_BID) lockAs(ui, "twait", "twait");
  else lockAs(ui, "none", null);
}

/** @param {State} s */
export function statusMinus(s) {
  if (s.ui) lockAs(s.ui, "minus", "minus");
}

/** @param {State} s */
export function statusSyswait(s) {
  if (s.ui) lockAs(s.ui, "syswait", "syswait");
}

/** @param {State} s @param {number} type */
export function statusOerr(s, type) {
  const ui = s.ui;
  if (!ui) return;
  ui.lockKind = "oerr";
  statusLock(
    ui,
    `oerr ${["protected", "numeric", "overflow", "dbcs"][type - 1] ?? type}`,
  );
}

/** @param {State} s */
export function statusTwait(s) {
  const ui = s.ui;
  if (!ui || ui.lockKind === "twait") return;
  ui.lockKind = "twait";
  ui.undera = false;
  oia(ui, "not-undera", true);
  statusLock(ui, "twait");
}

/** @param {State} s */
export function statusCtlrDone(s) {
  const ui = s.ui;
  if (!ui || ui.undera) return;
  ui.undera = true;
  oia(ui, "not-undera", false);
}

/** @param {State} s @param {"insert" | "reverse-input" | "typeahead" | "script"} field @param {boolean} on */
export function statusFlag(s, field, on) {
  const ui = s.ui;
  if (!ui) return;
  const key = field === "reverse-input" ? "reverse" : field;
  if (ui[key] === on) return;
  ui[key] = on;
  oia(ui, field, on);
}

/** @param {State} s @param {string | null} lu */
export function statusLu(s, lu) {
  const ui = s.ui;
  if (!ui || ui.lu === lu) return;
  ui.lu = lu;
  oia(ui, "lu", lu);
}

// ---- b3270.c

/**
 * popup_an_error(): inside Session.run() the message becomes run-result text, a line
 * per line, otherwise a popup.
 * @param {State} s @param {string} text
 */
export function popupError(s, text) {
  if (!s.runText) {
    s.ui?.out("popup", { type: "error", text, retrying: false });
    return;
  }
  for (const line of text.replace(/\n$/, "").split("\n")) {
    s.runText.text.push(line);
    s.runText.err.push(true);
  }
}

/** action_output(): a line of an action's successful result. @param {State} s @param {string} line */
export function actionOutput(s, line) {
  s.runText?.text.push(line);
  s.runText?.err.push(false);
}

/**
 * b3270_connect(): reports a new connection state. A drop to not-connected is held back
 * for 50 ms, since a reconnect may follow at once.
 * @param {State} s
 */
export function uiConnect(s) {
  const ui = s.ui;
  if (!ui) return;
  if (s.cstate === NOT_CONNECTED && ui.oldCstate !== NOT_CONNECTED) {
    if (!ui.ncTimer) {
      ui.ncTimer = setTimeout(() => {
        ui.ncTimer = null;
        ui.oldCstate = NOT_CONNECTED;
        ui.b3270?.connection(s);
        ui.out("connection", { state: CSTATE_NAMES[NOT_CONNECTED] });
      }, 50);
      ui.ncTimer.unref();
    }
    return;
  }
  if (s.cstate !== NOT_CONNECTED && ui.ncTimer) {
    clearTimeout(ui.ncTimer);
    ui.ncTimer = null;
  }
  if (s.cstate === ui.oldCstate) return;
  statusReset(s);
  ui.out("connection", {
    state: CSTATE_NAMES[s.cstate],
    host: s.connHost,
    cause: "ui",
  });
  if (ui.oldCstate === NOT_CONNECTED) erase(s, true);
  ui.b3270?.connection(s);
  ui.oldCstate = s.cstate;
}
