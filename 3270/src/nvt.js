import { VERASE, VKILL, VWERASE } from "./linemode.js";
import { scrollSave, scrollToBottom } from "./scroll.js";
import { CS_BASE, CS_DBCS, CS_LINEDRAW } from "./charset.js";
import {
  DBCS_LEFT,
  DBCS_LEFT_WRAP,
  DBCS_NONE,
  DBCS_RIGHT,
  DBCS_RIGHT_WRAP,
  EC_NVT,
  addBg,
  addFg,
  addGr,
  addNvt,
  altBuffer,
  taskHostOutput,
  clear,
  clearCells,
  copyCells,
  ctlrEnableCursor,
  cursorMove,
  dbcsState,
  dec,
  inc,
  scroll,
  GR_BLINK,
  GR_INTENSIFY,
  GR_REVERSE,
  GR_UNDERLINE,
  GR_WRAP,
} from "./ctlr.js";
import { netSends } from "./telnet.js";

// Port of x3270's Common/nvt.c: the ANSI/VT100/xterm emulation used in NVT mode,
// plus the keys an NVT session sends. Host bytes are taken as UTF-8, as x3270
// does in a UTF-8 locale.

/** @typedef {import("./session.js").State} State */

const BLACK = 0,
  BLUE = 1,
  RED = 2,
  PINK = 3,
  GREEN = 4,
  TURQUOISE = 5,
  YELLOW = 6,
  WHITE = 7;
/** SGR 30-37 in ANSI order, as 3270 colors. */
const SGR_COLORS = [BLACK, RED, GREEN, YELLOW, BLUE, PINK, TURQUOISE, WHITE];
const CSD_LD = 0,
  CSD_UK = 1,
  CSD_US = 2;
const NN = 20,
  NT = 256,
  MB_MAX = 16;

// Parser states.
const DATA = 0,
  ESC = 1,
  CSDES = 2,
  N1 = 3,
  DECP = 4,
  TEXT = 5,
  TEXT2 = 6,
  MBPEND = 7,
  ESCGT = 8;

// Actions, numbered as in nvt.c's nvt_fn[]; 0 drops the byte and returns to DATA.
const SC = 1,
  RC = 2,
  NL = 3,
  UP = 4,
  E2 = 5,
  RS = 6,
  IC = 7,
  DN = 8,
  RT = 9,
  LT = 10,
  CM = 11,
  ED = 12,
  EL = 13,
  IL = 14,
  DL = 15,
  DC = 16,
  SG = 17,
  BL = 18,
  NP = 19,
  BS = 20,
  CR = 21,
  LF = 22,
  HT = 23,
  E1 = 24,
  XX = 25,
  PC = 26,
  SEMI = 27,
  DG = 28,
  RI = 29,
  DA = 30,
  SM = 31,
  RM = 32,
  SR = 34,
  CS = 35,
  E3 = 36,
  DS = 37,
  DR = 38,
  DV = 39,
  DT = 40,
  SS = 41,
  TM = 42,
  T2 = 43,
  TX = 44,
  TB = 45,
  TS = 46,
  TC = 47,
  C2 = 48,
  G0 = 49,
  G1 = 50,
  G2 = 51,
  G3 = 52,
  S2 = 53,
  S3 = 54,
  MB = 55,
  CH = 56,
  VP = 57,
  GT = 58,
  D2 = 59;

/** @param {number} fill @param {Record<string, number>} [actions] keyed by the character @param {[number, number, number][]} [ranges] */
function table(fill, actions = {}, ranges = []) {
  const t = new Uint8Array(256).fill(fill);
  for (const [from, to, action] of ranges) t.fill(action, from, to + 1);
  for (const [c, action] of Object.entries(actions))
    t[c.charCodeAt(0)] = action;
  return t;
}

const DIGITS = /** @type {[number, number, number]} */ ([0x30, 0x39, DG]);

/** nvt.c's st[][]: the action for every state and byte. */
const ST = [
  table(
    XX,
    {
      "\x07": BL,
      "\b": BS,
      "\t": HT,
      "\n": LF,
      "\v": LF,
      "\f": NP,
      "\r": CR,
      "\x0e": G1,
      "\x0f": G0,
      "\x1b": E1,
    },
    [
      [0x20, 0x7e, PC],
      [0xa0, 0xff, PC],
    ],
  ),
  table(0, {
    "(": CS,
    ")": CS,
    "*": CS,
    "+": CS,
    7: SC,
    8: RC,
    E: NL,
    H: TS,
    M: RI,
    N: S2,
    O: S3,
    "[": E2,
    "]": TM,
    c: RS,
    n: G2,
    o: G3,
  }),
  table(0, { 0: C2, A: C2, B: C2 }),
  table(
    0,
    {
      ";": SEMI,
      ">": GT,
      "?": E3,
      "@": IC,
      A: UP,
      B: DN,
      C: RT,
      D: LT,
      G: CH,
      H: CM,
      J: ED,
      K: EL,
      L: IL,
      M: DL,
      P: DC,
      c: DA,
      d: VP,
      f: CM,
      g: TC,
      h: SM,
      l: RM,
      m: SG,
      n: SR,
      r: SS,
    },
    [DIGITS],
  ),
  table(0, { h: DS, l: DR, r: DT, s: DV }, [DIGITS]),
  table(0, { ";": T2 }, [DIGITS]),
  table(0, { "\x07": TB, "\x7f": XX }, [[0x20, 0xff, TX]]),
  table(MB),
  table(0, { c: D2 }, [DIGITS]),
];

/** The NVT emulator's state, which x3270 keeps as statics in nvt.c. */
export function createNvt() {
  return {
    state: DATA,
    n: new Array(NN + 1).fill(0),
    nx: 0,
    ch: 0,
    /** @type {number[]} */
    text: [],
    gr: 0,
    savedGr: 0,
    fg: 0,
    savedFg: 0,
    bg: 0,
    savedBg: 0,
    cset: 0,
    savedCset: 0,
    csd: [CSD_US, CSD_US, CSD_US, CSD_US],
    savedCsd: [CSD_US, CSD_US, CSD_US, CSD_US],
    onceCset: -1,
    savedCursor: 0,
    insertMode: false,
    autoNewlineMode: false,
    applCursor: false,
    savedApplCursor: false,
    wraparoundMode: true,
    savedWraparoundMode: true,
    revWraparoundMode: false,
    savedRevWraparoundMode: false,
    allowWideMode: false,
    savedAllowWideMode: false,
    wideMode: false,
    savedWideMode: false,
    savedAltbuffer: false,
    scrollTop: -1,
    scrollBottom: -1,
    tabs: new Uint8Array(0),
    csToChange: 0,
    pendingMbs: new Uint8Array(MB_MAX),
    pmi: 0,
    heldWrap: false,
    cursorEnabled: false,
    neverReset: true,
  };
}

/** @typedef {ReturnType<typeof createNvt>} Nvt */

/** nvt_process(): one byte of host NVT data. @param {State} s @param {number} c */
export function nvtProcess(s, c) {
  const v = s.nvt;
  v.ch = c & 0xff;
  scrollToBottom(s);
  v.state = act(s, v, ST[v.state][v.ch]);
  const t = s.script;
  t.nvtSave[t.nvtSaveIx] = c & 0xff;
  t.nvtSaveIx = (t.nvtSaveIx + 1) % t.nvtSave.length;
  if (t.nvtSaveCnt < t.nvtSave.length) t.nvtSaveCnt++;
  taskHostOutput(s);
}

/** One entry of nvt_fn[]; returns the next parser state. @param {State} s @param {Nvt} v @param {number} action @returns {number} */
function act(s, v, action) {
  const cols = s.cols;
  const cursor = s.cursor;
  const n0 = v.n[0];
  const n1 = v.n[1];
  switch (action) {
    case SC:
      saveCursor(s, v);
      return DATA;
    case RC:
      restoreCursor(s, v);
      return DATA;
    case NL: {
      cursorMove(s, cursor - (cursor % cols));
      const nc = s.cursor + cols;
      if (nc < v.scrollBottom * cols) cursorMove(s, nc);
      else nvtScroll(s, v);
      v.heldWrap = false;
      return DATA;
    }
    case UP:
      cursorUp(s, v, n0);
      return DATA;
    case E2:
      v.n.fill(0);
      v.nx = 0;
      return N1;
    case RS:
      ansiReset(s, v);
      return DATA;
    case IC:
      insertChars(s, n0);
      return DATA;
    case DN: {
      const nn = Math.max(n0, 1);
      if (((cursor / cols) | 0) + nn >= s.rows)
        cursorMove(s, (s.rows - 1) * cols + (cursor % cols));
      else cursorMove(s, cursor + nn * cols);
      v.heldWrap = false;
      return DATA;
    }
    case RT: {
      const cc = cursor % cols;
      if (cc === cols - 1) return DATA;
      cursorMove(s, cursor + Math.min(Math.max(n0, 1), cols - 1 - cc));
      v.heldWrap = false;
      return DATA;
    }
    case LT: {
      if (v.heldWrap) {
        v.heldWrap = false;
        return DATA;
      }
      const cc = cursor % cols;
      if (cc) cursorMove(s, cursor - Math.min(Math.max(n0, 1), cc));
      return DATA;
    }
    case CM: {
      const row = Math.min(Math.max(n0, 1), s.rows);
      const col = Math.min(Math.max(n1, 1), cols);
      cursorMove(s, (row - 1) * cols + (col - 1));
      v.heldWrap = false;
      return DATA;
    }
    case CH: {
      const col = Math.min(Math.max(n0, 1), cols);
      cursorMove(s, ((cursor / cols) | 0) * cols + (col - 1));
      v.heldWrap = false;
      return DATA;
    }
    case VP: {
      const row = Math.min(Math.max(n0, 1), s.rows);
      cursorMove(s, (row - 1) * cols + (cursor % cols));
      v.heldWrap = false;
      return DATA;
    }
    case ED:
      if (n0 === 0) clearCells(s, cursor, s.rows * cols - cursor);
      else if (n0 === 1) clearCells(s, 0, cursor + 1);
      else if (n0 === 2) {
        if (cursor === 0 && !s.isAltbuffer) scrollSave(s, s.rows);
        clearCells(s, 0, s.rows * cols);
      }
      return DATA;
    case EL: {
      const nc = cursor % cols;
      if (n0 === 0) clearCells(s, cursor, cols - nc);
      else if (n0 === 1) clearCells(s, cursor - nc, nc + 1);
      else if (n0 === 2) clearCells(s, cursor - nc, cols);
      return DATA;
    }
    case IL:
      insertLines(s, v, n0);
      return DATA;
    case DL: {
      const rr = (cursor / cols) | 0;
      if (rr < v.scrollTop - 1 || rr >= v.scrollBottom) return DATA;
      const mr = v.scrollBottom - rr;
      const nn = Math.min(Math.max(n0, 1), mr);
      const ns = mr - nn;
      if (ns) copyCells(s, (rr + nn) * cols, rr * cols, ns * cols);
      clearCells(s, (rr + ns) * cols, nn * cols);
      return DATA;
    }
    case DC: {
      const mc = cols - (cursor % cols);
      const nn = Math.min(Math.max(n0, 1), mc);
      const ns = mc - nn;
      if (ns) copyCells(s, cursor + nn, cursor, ns);
      clearCells(s, cursor + ns, nn);
      return DATA;
    }
    case SG:
      for (let i = 0; i <= v.nx && i < NN; i++) sgr(v, v.n[i]);
      return DATA;
    case BL:
      s.emit({ type: "alarm" });
      return DATA;
    case NP:
      clear(s);
      return DATA;
    case BS:
      if (v.heldWrap) {
        v.heldWrap = false;
        return DATA;
      }
      if (
        v.revWraparoundMode ? cursor > (v.scrollTop - 1) * cols : cursor % cols
      )
        cursorMove(s, cursor - 1);
      return DATA;
    case CR:
      if (cursor % cols) cursorMove(s, cursor - (cursor % cols));
      if (v.autoNewlineMode) lineFeed(s, v);
      v.heldWrap = false;
      return DATA;
    case LF:
      lineFeed(s, v);
      return DATA;
    case HT: {
      const col = cursor % cols;
      v.heldWrap = false;
      if (col === cols - 1) return DATA;
      let i = col + 1;
      while (i < cols - 1 && !(v.tabs[i >> 3] & (1 << (i % 8)))) i++;
      cursorMove(s, cursor - col + i);
      return DATA;
    }
    case E1:
      return ESC;
    case XX:
      return DATA;
    case PC:
      return printing(s, v);
    case SEMI:
      if (v.nx >= NN) return DATA;
      v.nx++;
      return v.state;
    case DG:
      v.n[v.nx] = (Math.imul(v.n[v.nx], 10) + (v.ch - 0x30)) | 0;
      return v.state;
    case RI: {
      // x3270 scrolls back only with the cursor on the region's top line.
      v.heldWrap = false;
      if (((cursor / cols) | 0) === v.scrollTop - 1) insertLines(s, v, 1);
      else cursorUp(s, v, 1);
      return DATA;
    }
    case DA:
      if (!n0) send(s, "\x1b[?1;2c");
      return DATA;
    case SM:
    case RM:
      if (n0 === 4) v.insertMode = action === SM;
      if (n0 === 20) v.autoNewlineMode = action === SM;
      return DATA;
    case SR:
      if (n0 === 5) send(s, "\x1b[0n");
      if (n0 === 6)
        send(s, `\x1b[${((cursor / cols) | 0) + 1};${(cursor % cols) + 1}R`);
      return DATA;
    case CS:
      v.csToChange = "()*+".indexOf(String.fromCharCode(v.ch));
      return CSDES;
    case C2:
      v.csd[v.csToChange] = "0AB".indexOf(String.fromCharCode(v.ch));
      return DATA;
    case G0:
    case G1:
    case G2:
    case G3:
      v.cset = action - G0;
      return DATA;
    case S2:
      v.onceCset = 2;
      return DATA;
    case S3:
      v.onceCset = 3;
      return DATA;
    case E3:
      return DECP;
    case DS:
      for (let i = 0; i <= v.nx && i < NN; i++) decSet(s, v, v.n[i]);
      return DATA;
    case DR:
      for (let i = 0; i <= v.nx && i < NN; i++) decReset(s, v, v.n[i]);
      return DATA;
    case DV:
      for (let i = 0; i <= v.nx && i < NN; i++) decSave(s, v, v.n[i]);
      return DATA;
    case DT:
      for (let i = 0; i <= v.nx && i < NN; i++) decRestore(s, v, v.n[i]);
      return DATA;
    case SS: {
      const top = Math.max(n0, 1);
      const bottom = Math.min(n1, s.rows);
      if (top <= bottom && (top > 1 || bottom < s.rows)) {
        v.scrollTop = top;
        v.scrollBottom = bottom;
        cursorMove(s, 0);
      } else {
        v.scrollTop = 1;
        v.scrollBottom = s.rows;
      }
      return DATA;
    }
    case TM:
      v.nx = 0;
      v.n[0] = 0;
      return TEXT;
    case T2:
      v.text.length = 0;
      return TEXT2;
    case TX:
      if (v.text.length < NT) v.text.push(v.ch);
      return v.state;
    case TB:
      s.emit({
        type: "title",
        code: n0,
        text: Buffer.from(v.text).toString("utf8"),
      });
      return DATA;
    case TS: {
      const col = cursor % cols;
      v.tabs[col >> 3] |= 1 << (col % 8);
      return DATA;
    }
    case TC:
      if (n0 === 0) {
        const col = cursor % cols;
        v.tabs[col >> 3] &= ~(1 << (col % 8));
      } else if (n0 === 3) {
        v.tabs.fill(0);
      }
      return DATA;
    case MB:
      return multibyte(s, v);
    case GT:
      return ESCGT;
    case D2:
      // Like x3270, no answer to secondary device attributes: it triggers too much chatter.
      return DATA;
    default:
      return DATA;
  }
}

/** @param {State} s @param {string} text */
function send(s, text) {
  netSends(s, Buffer.from(text, "latin1"));
}

/** dec_save_cursor() @param {State} s @param {Nvt} v */
function saveCursor(s, v) {
  v.savedCursor = s.cursor;
  v.savedCset = v.cset;
  v.savedCsd = [...v.csd];
  v.savedFg = v.fg;
  v.savedBg = v.bg;
  v.savedGr = v.gr;
}

/** dec_restore_cursor() @param {State} s @param {Nvt} v */
function restoreCursor(s, v) {
  v.cset = v.savedCset;
  v.csd = [...v.savedCsd];
  v.fg = v.savedFg;
  v.bg = v.savedBg;
  v.gr = v.savedGr;
  cursorMove(s, v.savedCursor);
  v.heldWrap = false;
}

/** ansi_cursor_up() @param {State} s @param {Nvt} v @param {number} nn */
function cursorUp(s, v, nn) {
  if (nn < 1) nn = 1;
  if (((s.cursor / s.cols) | 0) - nn < 0) cursorMove(s, s.cursor % s.cols);
  else cursorMove(s, s.cursor - nn * s.cols);
  v.heldWrap = false;
}

/** ansi_insert_chars() @param {State} s @param {number} nn */
function insertChars(s, nn) {
  const mc = s.cols - (s.cursor % s.cols);
  nn = Math.min(Math.max(nn, 1), mc);
  const ns = mc - nn;
  if (ns) copyCells(s, s.cursor, s.cursor + nn, ns);
  clearCells(s, s.cursor, nn);
}

/** ansi_insert_lines() @param {State} s @param {Nvt} v @param {number} nn */
function insertLines(s, v, nn) {
  const cols = s.cols;
  const rr = (s.cursor / cols) | 0;
  if (rr < v.scrollTop - 1 || rr >= v.scrollBottom) return;
  const mr = v.scrollBottom - rr;
  nn = Math.min(Math.max(nn, 1), mr);
  const ns = mr - nn;
  if (ns) copyCells(s, rr * cols, (rr + nn) * cols, ns * cols);
  clearCells(s, rr * cols, nn * cols);
}

/** ansi_lf() @param {State} s @param {Nvt} v */
function lineFeed(s, v) {
  const nc = s.cursor + s.cols;
  v.heldWrap = false;
  if (((s.cursor / s.cols) | 0) >= v.scrollBottom) {
    if (nc < s.rows * s.cols) cursorMove(s, nc);
    return;
  }
  if (nc < v.scrollBottom * s.cols) cursorMove(s, nc);
  else nvtScroll(s, v);
}

/** nvt_scroll(): scrolls the screen or the scrolling region up a line. @param {State} s @param {Nvt} v */
function nvtScroll(s, v) {
  const cols = s.cols;
  v.heldWrap = false;
  if (v.scrollTop === 1 && v.scrollBottom === s.rows) {
    if (!s.isAltbuffer) scrollSave(s, 1);
    scroll(s, v.fg, v.bg);
    return;
  }
  if (v.scrollBottom > v.scrollTop) {
    copyCells(
      s,
      v.scrollTop * cols,
      (v.scrollTop - 1) * cols,
      (v.scrollBottom - v.scrollTop) * cols,
    );
  }
  clearCells(s, (v.scrollBottom - 1) * cols, cols);
}

/** ansi_reset() @param {State} s @param {Nvt} v */
function ansiReset(s, v) {
  v.gr = v.savedGr = 0;
  v.fg = v.savedFg = 0;
  v.bg = v.savedBg = 0;
  v.cset = v.savedCset = 0;
  v.csd = [CSD_US, CSD_US, CSD_US, CSD_US];
  v.savedCsd = [CSD_US, CSD_US, CSD_US, CSD_US];
  v.onceCset = -1;
  v.savedCursor = 0;
  v.cursorEnabled = true;
  v.insertMode = false;
  v.autoNewlineMode = false;
  v.applCursor = v.savedApplCursor = false;
  v.wraparoundMode = v.savedWraparoundMode = true;
  v.revWraparoundMode = v.savedRevWraparoundMode = false;
  v.allowWideMode = v.savedAllowWideMode = false;
  v.wideMode = false;
  v.savedAltbuffer = false;
  v.scrollTop = 1;
  v.scrollBottom = s.rows;
  v.tabs = new Uint8Array((s.cols + 7) >> 3).fill(0x01);
  v.heldWrap = false;
  if (!v.neverReset) {
    altBuffer(s, true);
    clearCells(s, 0, s.rows * s.cols);
    altBuffer(s, false);
    clear(s);
    ctlrEnableCursor(s, true, EC_NVT);
  }
  v.neverReset = false;
  v.pmi = 0;
}

/** One ansi_sgr() parameter. @param {Nvt} v @param {number} p */
function sgr(v, p) {
  if (p === 0) {
    v.gr = v.fg = v.bg = 0;
  } else if (p === 1) {
    v.gr |= GR_INTENSIFY;
  } else if (p === 4) {
    v.gr |= GR_UNDERLINE;
  } else if (p === 5) {
    v.gr |= GR_BLINK;
  } else if (p === 7) {
    v.gr |= GR_REVERSE;
  } else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
    v.fg = 0xf0 | SGR_COLORS[p % 10];
  } else if (p === 39) {
    v.fg = 0;
  } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
    v.bg = 0xf0 | SGR_COLORS[p % 10];
  } else if (p === 49) {
    v.bg = 0;
  }
}

/** dec_set(), one parameter. @param {State} s @param {Nvt} v @param {number} p */
function decSet(s, v, p) {
  switch (p) {
    case 1:
      v.applCursor = true;
      break;
    case 2:
      v.csd = [CSD_US, CSD_US, CSD_US, CSD_US];
      break;
    case 3:
      if (v.allowWideMode) v.wideMode = true;
      break;
    case 7:
      v.wraparoundMode = true;
      break;
    case 25:
      v.cursorEnabled = true;
      ctlrEnableCursor(s, true, EC_NVT);
      break;
    case 40:
      v.allowWideMode = true;
      break;
    case 45:
      v.revWraparoundMode = true;
      break;
    case 47:
    case 1049:
      saveCursor(s, v);
      altBuffer(s, true);
      clearCells(s, 0, s.rows * s.cols);
      break;
  }
}

/** dec_reset(), one parameter. @param {State} s @param {Nvt} v @param {number} p */
function decReset(s, v, p) {
  switch (p) {
    case 1:
      v.applCursor = false;
      break;
    case 3:
      if (v.allowWideMode) v.wideMode = false;
      break;
    case 7:
      v.wraparoundMode = false;
      break;
    case 25:
      v.cursorEnabled = false;
      ctlrEnableCursor(s, false, EC_NVT);
      break;
    case 40:
      v.allowWideMode = false;
      break;
    case 45:
      v.revWraparoundMode = false;
      break;
    case 47:
    case 1049:
      altBuffer(s, false);
      restoreCursor(s, v);
      break;
  }
}

/** dec_save(), one parameter. @param {State} s @param {Nvt} v @param {number} p */
function decSave(s, v, p) {
  switch (p) {
    case 1:
      v.savedApplCursor = v.applCursor;
      break;
    case 3:
      v.savedWideMode = v.wideMode;
      break;
    case 7:
      v.savedWraparoundMode = v.wraparoundMode;
      break;
    case 40:
      v.savedAllowWideMode = v.allowWideMode;
      break;
    case 45:
      v.savedRevWraparoundMode = v.revWraparoundMode;
      break;
    case 47:
    case 1049:
      v.savedAltbuffer = s.isAltbuffer;
      saveCursor(s, v);
      break;
  }
}

/** dec_restore(), one parameter. @param {State} s @param {Nvt} v @param {number} p */
function decRestore(s, v, p) {
  switch (p) {
    case 1:
      v.applCursor = v.savedApplCursor;
      break;
    case 3:
      if (v.allowWideMode) v.wideMode = v.savedWideMode;
      break;
    case 7:
      v.wraparoundMode = v.savedWraparoundMode;
      break;
    case 40:
      v.allowWideMode = v.savedAllowWideMode;
      break;
    case 45:
      v.revWraparoundMode = v.savedRevWraparoundMode;
      break;
    case 47:
    case 1049:
      altBuffer(s, v.savedAltbuffer);
      restoreCursor(s, v);
      break;
  }
}

/** The smallest character each UTF-8 length may encode; x3270 allows overlong 2-byte forms. */
const UTF8_MIN = [0, 0, 0, 0x800, 0x10000, 0x200000, 0x4000000];

/**
 * utf8_to_unicode() on the first len bytes: returns the bytes used, 0 if the sequence
 * is incomplete, or -1 if it is invalid. The character lands in v.ch.
 * @param {{ch: number}} v @param {Uint8Array} b @param {number} len
 */
export function utf8ToUnicode(v, b, len) {
  const c = b[0];
  const need =
    c < 0x80
      ? 1
      : (c & 0xe0) === 0xc0
        ? 2
        : (c & 0xf0) === 0xe0
          ? 3
          : (c & 0xf8) === 0xf0
            ? 4
            : (c & 0xfc) === 0xf8
              ? 5
              : (c & 0xfe) === 0xfc
                ? 6
                : -1;
  if (need < 0) return -1;
  if (len < need) return 0;
  let u = need === 1 ? c : c & (0x7f >> need);
  for (let i = 1; i < need; i++) {
    if ((b[i] & 0xc0) !== 0x80) return -1;
    u = (u << 6) | (b[i] & 0x3f);
  }
  // x3270's own decoder has no such cap and happily hands back pseudo-UCS4 past
  // U+10FFFF (it's a pre-2003 UTF-8 holdover) - but unlike C, String.fromCodePoint()
  // throws on that, so node3270 needs this check where x3270 didn't.
  if (u < UTF8_MIN[need] || u === 0 || u > 0x10ffff) return -1;
  v.ch = u;
  return need;
}

/** ansi_multibyte(): the next byte of a UTF-8 sequence. @param {State} s @param {Nvt} v @returns {number} */
function multibyte(s, v) {
  if (v.pmi >= MB_MAX - 2) {
    v.pmi = 0;
    v.ch = 0x3f;
    return printing(s, v);
  }
  const c = v.ch;
  v.pendingMbs[v.pmi++] = c;
  const used = utf8ToUnicode(v, v.pendingMbs, v.pmi);
  if (used > 0) return printing(s, v);
  if (used === 0) return MBPEND;
  v.pmi = 0;
  v.ch = 0x3f;
  printing(s, v);
  // Reprocess the byte the sequence choked on, especially if it is a control character.
  v.ch = c;
  v.state = DATA;
  return act(s, v, ST[DATA][c]);
}

/** PWRAP: moves past the character just printed, scrolling if needed. @param {State} s @param {Nvt} v */
function printWrap(s, v) {
  const cols = s.cols;
  if (s.cursor % cols === cols - 1)
    addGr(s, s.cursor, s.gr[s.cursor] | GR_WRAP);
  const nc = s.cursor + 1;
  if (nc < v.scrollBottom * cols) {
    cursorMove(s, nc);
  } else if (((s.cursor / cols) | 0) >= v.scrollBottom) {
    cursorMove(s, ((s.cursor / cols) | 0) * cols);
  } else {
    nvtScroll(s, v);
    cursorMove(s, nc - cols);
  }
}

/** @param {State} s @param {Nvt} v @param {number} b */
function addRendition(s, v, b) {
  addGr(s, b, v.gr);
  addFg(s, b, v.fg);
  addBg(s, b, v.bg);
}

/** ansi_printing() @param {State} s @param {Nvt} v */
function printing(s, v) {
  const cols = s.cols;
  if (v.pmi === 0 && v.ch & 0x80) {
    v.pendingMbs[0] = v.ch;
    const used = utf8ToUnicode(v, v.pendingMbs, 1);
    if (used === 0) {
      v.pmi = 1;
      return MBPEND;
    }
    if (used < 0) v.ch = 0x3f;
  }
  v.pmi = 0;
  const ch = v.ch;

  if (v.heldWrap) {
    printWrap(s, v);
    v.heldWrap = false;
  }
  if (v.insertMode) insertChars(s, 1);
  let d = dbcsState(s, s.cursor);
  const xcset = v.csd[v.onceCset !== -1 ? v.onceCset : v.cset];
  if (xcset === CSD_LD && ch >= 0x5f && ch <= 0x7e) {
    addNvt(s, s.cursor, ch - 0x5f, CS_LINEDRAW);
  } else if (xcset === CSD_UK && ch === 0x23) {
    addNvt(s, s.cursor, 0x1e, CS_LINEDRAW);
  } else if (ch >= 0x2e80 && ch <= 0x9fff) {
    if (s.cursor % cols === cols - 1) {
      if (!v.wraparoundMode) return DATA;
      addNvt(s, s.cursor, 0x20, CS_BASE);
      addRendition(s, v, s.cursor);
      s.cursor++;
      d = dbcsState(s, s.cursor);
    }
    addNvt(s, s.cursor, ch, CS_DBCS);
    addRendition(s, v, s.cursor);
    if (d === DBCS_RIGHT || d === DBCS_RIGHT_WRAP) {
      const xaddr = dec(s, s.cursor);
      addNvt(s, xaddr, 0x20, CS_BASE);
      s.db[xaddr] = DBCS_NONE;
    }
    s.cursor = inc(s, s.cursor);
    addNvt(s, s.cursor, 0x20, CS_DBCS);
    addRendition(s, v, s.cursor);
    if (v.wraparoundMode) {
      if (!((s.cursor + 1) % cols)) v.heldWrap = true;
      else printWrap(s, v);
    } else if (s.cursor % cols !== cols - 1) {
      cursorMove(s, s.cursor + 1);
    }
    return DATA;
  } else {
    addNvt(s, s.cursor, ch, CS_BASE);
  }

  // Overwriting half of a DBCS character blanks the other half.
  if (d === DBCS_RIGHT || d === DBCS_RIGHT_WRAP) {
    const xaddr = dec(s, s.cursor);
    addNvt(s, xaddr, 0x20, CS_BASE);
    s.db[xaddr] = DBCS_NONE;
    s.db[s.cursor] = DBCS_NONE;
  }
  if (d === DBCS_LEFT || d === DBCS_LEFT_WRAP) {
    const xaddr = inc(s, s.cursor);
    addNvt(s, xaddr, 0x20, CS_BASE);
    s.db[xaddr] = DBCS_NONE;
    s.db[s.cursor] = DBCS_NONE;
  }

  v.onceCset = -1;
  addRendition(s, v, s.cursor);
  if (v.wraparoundMode) {
    // Like xterm, a character in the last column leaves the cursor there until
    // the next one arrives; vi depends on it.
    if (!((s.cursor + 1) % cols)) v.heldWrap = true;
    else printWrap(s, v);
  } else if (s.cursor % cols !== cols - 1) {
    cursorMove(s, s.cursor + 1);
  }
  return DATA;
}

/** nvt_in3270(): the ST_3270_MODE hook. @param {State} s @param {boolean} in3270 */
export function nvtIn3270(s, in3270) {
  if (!in3270) {
    ansiReset(s, s.nvt);
    return;
  }
  if (!s.nvt.cursorEnabled) {
    s.nvt.cursorEnabled = true;
    ctlrEnableCursor(s, true, EC_NVT);
  }
  altBuffer(s, false);
}

/** nvt_wrapping_backspace(): a backspace that may back up onto the previous line. @param {State} s */
export function nvtWrappingBackspace(s) {
  const prev = s.nvt.revWraparoundMode;
  s.nvt.revWraparoundMode = true;
  nvtProcess(s, 0x08);
  s.nvt.revWraparoundMode = prev;
}

/** nvt_connect(): the ST_CONNECT hook. @param {State} s @param {boolean} connected */
export function nvtConnect(s, connected) {
  if (s.nvt.cursorEnabled === connected) return;
  s.nvt.cursorEnabled = connected;
  ctlrEnableCursor(s, connected, EC_NVT);
}

/** VT220 F1-F12, xterm F13-F20, x3270's F21-F24 (\E[16~ is missing on purpose). */
const PF_CODES = [
  11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24, 25, 26, 28, 29, 31, 32, 33,
  34, 35, 36, 37, 38,
];

/**
 * nvt_send_*() and linemode_send_*(): what a 3270 key sends in NVT mode.
 * @param {State} s @param {string} key @param {number} n
 */
export function nvtSendKey(s, key, n) {
  const appl = s.nvt.applCursor;
  const cursorKey = (/** @type {string} */ c) =>
    send(s, appl ? `\x1bO${c}` : `\x1b[${c}`);
  switch (key) {
    case "up":
      return cursorKey("A");
    case "down":
      return cursorKey("B");
    case "right":
      return cursorKey("C");
    case "left":
      return cursorKey("D");
    // x3270 sends \E[OH and \E[OF in application mode, not \EOH; kept as is.
    case "home":
      return send(s, appl ? "\x1b[OH" : "\x1b[H");
    case "end":
      return send(s, appl ? "\x1b[OF" : "\x1b[F");
    case "pageup":
      return send(s, "\x1b[5~");
    case "pagedown":
      return send(s, "\x1b[6~");
    case "clear":
      return send(s, "\x1b[2K");
    case "pa":
      if (n >= 1 && n <= 4) send(s, `\x1bO${"PQRS"[n - 1]}`);
      return;
    case "pf":
      if (n < 1 || n > PF_CODES.length) return;
      // xterm sends PF codes instead of F codes for F1-F4.
      if (n <= 4) send(s, `\x1bO${"PQRS"[n - 1]}`);
      else send(s, `\x1b[${PF_CODES[n - 1]}~`);
      return;
    case "erase":
      return netSends(s, Uint8Array.of(VERASE));
    case "kill":
      return netSends(s, Uint8Array.of(VKILL));
    case "werase":
      return netSends(s, Uint8Array.of(VWERASE));
  }
}
