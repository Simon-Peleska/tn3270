import { CS_APL, CS_BASE, CS_DBCS, CS_GE, CS_MASK } from "./charset.js";
import { scrollSave, scrollToBottom } from "./scroll.js";
import {
  doReset,
  kybdInhibit,
  runTypeahead,
  KL_AWAITING_FIRST,
  KL_OIA_TWAIT,
} from "./kybd.js";
import { in3270, inSscp, isConnected } from "./session.js";
import { netOutput } from "./telnet.js";
import { writeStructuredField } from "./sf.js";
import {
  enableCursor,
  popupError,
  screenDisp,
  statusReset,
  statusSyswait,
} from "./ui.js";

// Port of x3270's Common/ctlr.c: the screen buffer and the 3270 data stream.
// The screen is struct-of-arrays; x3270's ea_buf[-1] default field is the
// constants below, returned by faAt/csAt for address -1.

export const CMD_W = 0x01,
  CMD_RB = 0x02,
  CMD_NOP = 0x03,
  CMD_EW = 0x05,
  CMD_RM = 0x06;
export const CMD_EWA = 0x0d,
  CMD_RMA = 0x0e,
  CMD_EAU = 0x0f,
  CMD_WSF = 0x11;
export const SNA_CMD_RMA = 0x6e,
  SNA_CMD_EWA = 0x7e,
  SNA_CMD_W = 0xf1,
  SNA_CMD_RB = 0xf2;
export const SNA_CMD_WSF = 0xf3,
  SNA_CMD_EW = 0xf5,
  SNA_CMD_RM = 0xf6,
  SNA_CMD_EAU = 0x6f;

const ORDER_PT = 0x05,
  ORDER_GE = 0x08,
  ORDER_SBA = 0x11,
  ORDER_EUA = 0x12,
  ORDER_IC = 0x13;
const ORDER_SF = 0x1d,
  ORDER_SA = 0x28,
  ORDER_SFE = 0x29,
  ORDER_MF = 0x2c,
  ORDER_RA = 0x3c;
const FCORDER_NULL = 0x00,
  FCORDER_FF = 0x0c,
  FCORDER_CR = 0x0d,
  FCORDER_SO = 0x0e,
  FCORDER_SI = 0x0f;
const FCORDER_NL = 0x15,
  FCORDER_EM = 0x19,
  FCORDER_DUP = 0x1c,
  FCORDER_FM = 0x1e,
  FCORDER_LF = 0x25;
const FCORDER_SUB = 0x3f,
  FCORDER_EO = 0xff;

export const FA_PRINTABLE = 0xc0,
  FA_PROTECT = 0x20,
  FA_NUMERIC = 0x10,
  FA_INTENSITY = 0x0c;
export const FA_INT_ZERO_NSEL = 0x0c,
  FA_INT_HIGH_SEL = 0x08,
  FA_INT_NORM_SEL = 0x04,
  FA_MODIFY = 0x01,
  FA_MASK = 0x3d;
const DEFAULT_FIELD_FA = FA_PRINTABLE | FA_MODIFY;

export const XA_ALL = 0x00,
  XA_3270 = 0xc0,
  XA_HIGHLIGHTING = 0x41,
  XA_FOREGROUND = 0x42;
export const XA_CHARSET = 0x43,
  XA_BACKGROUND = 0x45,
  XA_INPUT_CONTROL = 0xfe;

export const AID_NO = 0x60,
  AID_QREPLY = 0x61,
  AID_ENTER = 0x7d,
  AID_SELECT = 0x7e,
  AID_CLEAR = 0x6d;
export const AID_SYSREQ = 0xf0,
  AID_SF = 0x88,
  AID_PA1 = 0x6c,
  AID_PA2 = 0x6e,
  AID_PA3 = 0x6b;

export const SF_SRM_FIELD = 0x00,
  SF_SRM_XFIELD = 0x01,
  SF_SRM_CHAR = 0x02;

export const PDS_OKAY_NO_OUTPUT = 0,
  PDS_OKAY_OUTPUT = 1,
  PDS_BAD_CMD = -1,
  PDS_BAD_ADDR = -2;

export const EBC_NULL = 0x00,
  EBC_SO = 0x0e,
  EBC_SI = 0x0f,
  EBC_DUP = 0x1c,
  EBC_FM = 0x1e;
export const GR_BLINK = 0x01,
  GR_REVERSE = 0x02,
  GR_UNDERLINE = 0x04,
  GR_INTENSIFY = 0x08,
  GR_WRAP = 0x10;

export const CODE_TABLE = Uint8Array.from([
  0x40, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c,
  0x4d, 0x4e, 0x4f, 0x50, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
  0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
  0xe7, 0xe8, 0xe9, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0xf0, 0xf1, 0xf2, 0xf3,
  0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f,
]);

/** @typedef {import("./session.js").State} State */

/** @param {number} c1 @param {number} c2 */
export function decodeBaddr(c1, c2) {
  if ((c1 & 0xc0) === 0) return ((c1 & 0x3f) << 8) | c2;
  return ((c1 & 0x3f) << 6) | (c2 & 0x3f);
}

/** @param {State} s @param {number} addr */
export function encodeBaddr(s, addr) {
  if (s.rows * s.cols > 0x1000) {
    s.out.push((addr >> 8) & 0x3f);
    s.out.push(addr & 0xff);
  } else {
    s.out.push(CODE_TABLE[(addr >> 6) & 0x3f]);
    s.out.push(CODE_TABLE[addr & 0x3f]);
  }
}

/** @param {State} s @param {number} b */
export function inc(s, b) {
  // x3270's INC_BA is a plain modulo, and its NVT code does step past the last cell.
  const next = b + 1;
  const size = s.rows * s.cols;
  return next < size ? next : next % size;
}

/** @param {State} s @param {number} b */
export function dec(s, b) {
  return b ? b - 1 : s.rows * s.cols - 1;
}

/** @param {State} s @param {number} faddr */
export function faAt(s, faddr) {
  return faddr < 0 ? DEFAULT_FIELD_FA : s.fa[faddr];
}

/** @param {State} s @param {number} faddr */
export function csAt(s, faddr) {
  return faddr < 0 ? 0 : s.cs[faddr];
}

/** @param {number} fa */
export const isProtected = (fa) => (fa & FA_PROTECT) !== 0;
/** @param {number} fa */
export const isNumeric = (fa) => (fa & FA_NUMERIC) !== 0;
/** @param {number} fa */
export const isSkip = (fa) =>
  (fa & FA_PROTECT) !== 0 && (fa & FA_NUMERIC) !== 0;
/** @param {number} fa */
export const isZero = (fa) => (fa & FA_INTENSITY) === FA_INT_ZERO_NSEL;
/** @param {number} fa */
export const isModified = (fa) => (fa & FA_MODIFY) !== 0;

/** find_field_attribute(): -1 when the screen is unformatted. @param {State} s @param {number} baddr */
export function findFieldAttribute(s, baddr) {
  if (!s.formatted) return -1;
  return findFieldAttributeRaw(s, baddr);
}

/** find_field_attribute_ea(): ignores the formatted flag. @param {State} s @param {number} baddr */
export function findFieldAttributeRaw(s, baddr) {
  const start = baddr;
  do {
    if (s.fa[baddr]) return baddr;
    baddr = dec(s, baddr);
  } while (baddr !== start);
  return -1;
}

/** get_field_attribute() @param {State} s @param {number} baddr */
export function fieldAttribute(s, baddr) {
  return faAt(s, findFieldAttribute(s, baddr));
}

/** next_unprotected(): address of the next unprotected character, 0 if none. @param {State} s @param {number} baddr0 */
export function nextUnprotected(s, baddr0) {
  let nbaddr = baddr0;
  do {
    const baddr = nbaddr;
    nbaddr = inc(s, nbaddr);
    if (s.fa[baddr] && !isProtected(s.fa[baddr]) && !s.fa[nbaddr])
      return nbaddr;
  } while (nbaddr !== baddr0);
  return 0;
}

/** ctlr_add() @param {State} s @param {number} b @param {number} c @param {number} cs */
export function add(s, b, c, cs) {
  if (s.fa[b] || s.ec[b] !== c || s.cs[b] !== cs) {
    const old = s.fa[b] ? 0 : s.ec[b];
    if (s.tracePrimed && !isBlank(old)) {
      scrollSave(s);
      s.tracePrimed = false;
    }
    s.ec[b] = c;
    s.cs[b] = cs;
    s.fa[b] = 0;
    s.changed = true;
  }
}

/** ctlr_add_fa() @param {State} s @param {number} b @param {number} fa @param {number} cs */
export function addFa(s, b, fa, cs) {
  add(s, b, EBC_NULL, cs);
  const value = FA_PRINTABLE | (fa & FA_MASK);
  if (s.fa[b] !== value) s.changed = true;
  s.fa[b] = value;
}

/** @param {State} s @param {number} b @param {number} cs */
export function addCs(s, b, cs) {
  if (s.cs[b] !== cs) s.changed = true;
  s.cs[b] = cs;
}

/** @param {State} s @param {number} b @param {number} gr */
export function addGr(s, b, gr) {
  if (s.gr[b] !== gr) s.changed = true;
  s.gr[b] = gr;
}

/** @param {State} s @param {number} b @param {number} color */
export function addFg(s, b, color) {
  if (!s.mode3279) return;
  if ((color & 0xf0) !== 0xf0) color = 0;
  if (s.fg[b] !== color) s.changed = true;
  s.fg[b] = color;
}

/** @param {State} s @param {number} b @param {number} color */
export function addBg(s, b, color) {
  if (!s.mode3279) return;
  if ((color & 0xf0) !== 0xf0) color = 0;
  if (s.bg[b] !== color) s.changed = true;
  s.bg[b] = color;
}

/** @param {State} s @param {number} b @param {number} ic */
export function addIc(s, b, ic) {
  if (s.ic[b] !== ic) s.changed = true;
  s.ic[b] = ic;
}

/** A cell as the write orders leave it: character plus the current defaults. @param {State} s @param {number} b @param {number} c @param {number} cs */
function addWithDefaults(s, b, c, cs) {
  add(s, b, c, cs);
  addFg(s, b, s.defaultFg);
  addBg(s, b, s.defaultBg);
  addGr(s, b, s.defaultGr);
  addIc(s, b, s.defaultIc);
}

/** @param {State} s @param {number} b */
export function mdtSet(s, b) {
  const faddr = findFieldAttribute(s, b);
  if (faddr < 0 || s.fa[faddr] & FA_MODIFY) return;
  s.fa[faddr] |= FA_MODIFY;
  s.changed = true;
}

/** @param {State} s @param {number} b */
export function mdtClear(s, b) {
  const faddr = findFieldAttribute(s, b);
  if (faddr < 0 || !(s.fa[faddr] & FA_MODIFY)) return;
  s.fa[faddr] &= ~FA_MODIFY;
  s.changed = true;
}

/** @param {State} s */
export function mutableCs(s) {
  return (
    s.replyMode === SF_SRM_CHAR &&
    s.crmAttr.subarray(0, s.crmNattr).includes(XA_CHARSET)
  );
}

/** Everything x3270 keeps in a struct ea, one typed array each. */
export const CELL_ARRAYS = /** @type {const} */ ([
  "ec",
  "fa",
  "cs",
  "fg",
  "bg",
  "gr",
  "ic",
]);

/** One zeroed typed array per cell attribute. @param {number} size */
export function newCells(size) {
  return {
    ec: new Uint8Array(size),
    fa: new Uint8Array(size),
    cs: new Uint8Array(size),
    fg: new Uint8Array(size),
    bg: new Uint8Array(size),
    gr: new Uint8Array(size),
    ic: new Uint8Array(size),
  };
}
/** @typedef {ReturnType<typeof newCells>} Cells */

/** @param {State} s @param {number} to @param {number} from */
function copyCell(s, to, from) {
  s.ec[to] = s.ec[from];
  s.fa[to] = s.fa[from];
  s.cs[to] = s.cs[from];
  s.fg[to] = s.fg[from];
  s.bg[to] = s.bg[from];
  s.gr[to] = s.gr[from];
  s.ic[to] = s.ic[from];
}

/** ctlr_bcopy()/memmove over every attribute. @param {State} s @param {number} from @param {number} to @param {number} count */
export function copyCells(s, from, to, count) {
  for (const name of CELL_ARRAYS) s[name].copyWithin(to, from, from + count);
  s.changed = true;
}

/** ctlr_wrapping_memmove() @param {State} s @param {number} to @param {number} from @param {number} count */
export function wrappingMemmove(s, to, from, count) {
  const size = s.rows * s.cols;
  if (from + count <= size && to + count <= size) {
    copyCells(s, from, to, count);
    return;
  }
  // x3270 writes "x % ROWS*COLS", which C parses as "(x % ROWS) * COLS"; kept for fidelity.
  const wrap = (/** @type {number} */ x) => (x % s.rows) * s.cols;
  if (to <= from) {
    for (let i = 0; i < count; i++) copyCell(s, wrap(to + i), wrap(from + i));
  } else {
    for (let i = count - 1; i >= 0; i--)
      copyCell(s, wrap(to + i), wrap(from + i));
  }
  s.changed = true;
}

/** ctlr_aclear() over a range. @param {State} s @param {number} b @param {number} count */
export function clearCells(s, b, count) {
  for (const name of CELL_ARRAYS) s[name].fill(0, b, b + count);
  s.changed = true;
}

/** ctlr_scroll(): shifts the screen up a row; only b3270's own render scrolls along. @param {State} s */
export function scroll(s) {
  s.ui?.b3270?.scroll(s);
  const qty = (s.rows - 1) * s.cols;
  copyCells(s, s.cols, 0, qty);
  clearCells(s, qty, s.cols);
}

/** set_formatted() @param {State} s */
function setFormatted(s) {
  const size = s.rows * s.cols;
  s.formatted = false;
  for (let b = 0; b < size; b++) {
    if (s.fa[b]) {
      s.formatted = true;
      return;
    }
  }
}

/** set_rows_cols(): (re)sizes for the model. @param {State} s */
export function setRowsCols(s) {
  s.rows = s.defRows = 24;
  s.cols = s.defCols = 80;
  s.altRows = s.maxRows;
  s.altCols = s.maxCols;
  s.screenAlt = false;
  clearCells(s, 0, s.maxRows * s.maxCols);
  s.cursor = 0;
  s.bufferAddr = 0;
}

/** ctlr_clear() @param {State} s */
export function clear(s) {
  if (anyData(s)) scrollSave(s);
  clearCells(s, 0, s.rows * s.cols);
  s.cursor = 0;
  s.savedBaddr = 0;
  s.bufferAddr = 0;
  s.formatted = false;
  s.defaultFg = 0;
  s.defaultBg = 0;
  s.defaultGr = 0;
  s.defaultIc = 0;
  s.sscpStart = 0;
}

/** @param {number} c */
const isBlank = (c) => c === EBC_NULL || c === 0x40;

/** ctlr_any_data() @param {State} s */
function anyData(s) {
  const size = s.rows * s.cols;
  for (let b = 0; b < size; b++) if (!isBlank(s.ec[b])) return true;
  return false;
}

/** ctlr_erase(): clears, switching between the default and alternate size. @param {State} s @param {boolean} alt */
export function erase(s, alt) {
  kybdInhibit(s, false);
  clear(s);
  const rows = alt ? s.altRows : s.defRows;
  const cols = alt ? s.altCols : s.defCols;
  if (alt === s.screenAlt && s.rows === rows && s.cols === cols) return;
  screenDisp(s);
  s.rows = rows;
  s.cols = cols;
  s.screenAlt = alt;
  s.changed = true;
}

/** ctlr_connect(): the ST_CONNECT/ST_3270_MODE hook. @param {State} s */
export function ctlrConnect(s) {
  if (!in3270(s) || (inSscp(s) && s.kybdlock & KL_OIA_TWAIT)) {
    s.kybdlock &= ~KL_OIA_TWAIT;
    statusReset(s);
  }
  s.defaultFg = 0;
  s.defaultBg = 0;
  s.defaultGr = 0;
  s.defaultCs = 0;
  s.defaultIc = 0;
  s.replyMode = SF_SRM_FIELD;
  s.crmNattr = 0;
  ctlrEnableCursor(s, isConnected(s), EC_CONNECT);
  if (!isConnected(s)) {
    s.defRows = 24;
    s.defCols = 80;
    s.altRows = s.maxRows;
    s.altCols = s.maxCols;
  }
}

export const EC_SCROLL = 0x01,
  EC_CONNECT = 0x04;

/** ctlr_enable_cursor(): the cursor shows unless some source has it off. @param {State} s @param {boolean} enable @param {number} source */
export function ctlrEnableCursor(s, enable, source) {
  const disables = enable
    ? s.cursorDisables & ~source
    : s.cursorDisables | source;
  if (!s.cursorDisables !== !disables) enableCursor(s, !disables);
  s.cursorDisables = disables;
}

/** process_ds(): one outbound 3270 record. @param {State} s @param {Uint8Array} buf @param {boolean} restore */
export function processDs(s, buf, restore) {
  let rv = PDS_OKAY_NO_OUTPUT;
  if (buf.length) {
    scrollToBottom(s);
    switch (buf[0]) {
      case CMD_EAU:
      case SNA_CMD_EAU:
        eraseAllUnprotected(s);
        break;
      case CMD_EWA:
      case SNA_CMD_EWA:
        erase(s, true);
        rv = write(s, buf, true);
        break;
      case CMD_EW:
      case SNA_CMD_EW:
        erase(s, false);
        rv = write(s, buf, true);
        break;
      case CMD_W:
      case SNA_CMD_W:
        rv = write(s, buf, false);
        break;
      case CMD_RB:
      case SNA_CMD_RB:
        readBuffer(s, s.aid);
        rv = PDS_OKAY_OUTPUT;
        break;
      case CMD_RM:
      case SNA_CMD_RM:
        readModified(s, s.aid, false);
        rv = PDS_OKAY_OUTPUT;
        break;
      case CMD_RMA:
      case SNA_CMD_RMA:
        readModified(s, s.aid, true);
        rv = PDS_OKAY_OUTPUT;
        break;
      case CMD_WSF:
      case SNA_CMD_WSF:
        rv = writeStructuredField(s, buf);
        break;
      case CMD_NOP:
        break;
      default:
        s.log.warn(`N2001 unknown 3270 command 0x${buf[0].toString(16)}`);
        popupError(
          s,
          `Unknown 3270 Data Stream command: X'${buf[0].toString(16).toUpperCase()}'\n`,
        );
        rv = PDS_BAD_CMD;
    }
  }
  if (restore) {
    s.aid = AID_NO;
    doReset(s, false);
  }
  return rv;
}

/** ctlr_write(): Write, Erase/Write and Erase/Write Alternate. @param {State} s @param {Uint8Array} buf @param {boolean} eraseFlag */
export function write(s, buf, eraseFlag) {
  kybdInhibit(s, false);
  if (buf.length < 2) {
    s.log.warn("N2002 host write error: record too short, missing write flags");
    popupError(s, "Host write error:\nRecord too short, missing write flags");
    return PDS_BAD_ADDR;
  }
  const end = buf.length;
  const size = s.rows * s.cols;
  let rv = PDS_OKAY_NO_OUTPUT;
  let aborted = false;
  let insertCursor = false;
  let icBaddr = 0;
  s.defaultFg = 0;
  s.defaultBg = 0;
  s.defaultGr = 0;
  s.defaultCs = 0;
  s.defaultIc = 0;
  s.tracePrimed = true;
  s.bufferAddr = s.cursor;
  const wcc = buf[1];
  if (wcc & 0x40 && eraseFlag) s.replyMode = SF_SRM_FIELD;
  const keyboardRestore = (wcc & 0x02) !== 0;
  if (wcc & 0x01) {
    for (let b = 0; b < size; b++) if (s.fa[b]) mdtClear(s, b);
  }

  /** @param {string} code @param {string} message */
  const abort = (code, message) => {
    s.log.warn(`${code} host write error: ${message}`);
    popupError(
      s,
      `Host write error:\n${message[0].toUpperCase()}${message.slice(1)}`,
    );
    rv = PDS_BAD_ADDR;
    aborted = true;
  };
  /** START_FIELD @param {number} fa */
  const startField = (fa) => {
    currentFa = fa;
    addFa(s, s.bufferAddr, fa, 0);
    addCs(s, s.bufferAddr, 0);
    addFg(s, s.bufferAddr, 0);
    addBg(s, s.bufferAddr, 0);
    addGr(s, s.bufferAddr, 0);
    addIc(s, s.bufferAddr, 0);
    s.formatted = true;
  };

  let lastCmd = true;
  let lastZpt = false;
  let currentFa = fieldAttribute(s, s.bufferAddr);
  for (let cp = 2; !aborted && cp < end; cp++) {
    switch (buf[cp]) {
      case ORDER_SF:
        cp++;
        if (cp >= end) {
          abort("N2003", "record too short, missing SF attributes");
          break;
        }
        startField(buf[cp]);
        addFg(s, s.bufferAddr, 0);
        addBg(s, s.bufferAddr, 0);
        s.bufferAddr = inc(s, s.bufferAddr);
        lastCmd = true;
        lastZpt = false;
        break;
      case ORDER_SBA: {
        cp += 2;
        if (cp >= end) {
          abort("N2004", "record too short, missing SBA address");
          break;
        }
        const baddr = decodeBaddr(buf[cp - 1], buf[cp]);
        s.bufferAddr = baddr;
        if (baddr >= size) {
          abort("N2005", `SBA address ${baddr} > maximum ${size - 1}`);
          break;
        }
        currentFa = fieldAttribute(s, s.bufferAddr);
        lastCmd = true;
        lastZpt = false;
        break;
      }
      case ORDER_IC:
        insertCursor = true;
        icBaddr = s.bufferAddr;
        lastCmd = true;
        lastZpt = false;
        break;
      case ORDER_PT: {
        if (s.fa[s.bufferAddr] && !isProtected(s.fa[s.bufferAddr])) {
          s.bufferAddr = inc(s, s.bufferAddr);
          lastZpt = false;
          lastCmd = true;
          break;
        }
        let baddr = nextUnprotected(s, s.bufferAddr);
        if (baddr < s.bufferAddr) baddr = 0;
        if (!lastCmd || lastZpt) {
          while (s.bufferAddr !== baddr && !s.fa[s.bufferAddr]) {
            add(s, s.bufferAddr, EBC_NULL, 0);
            addCs(s, s.bufferAddr, 0);
            addFg(s, s.bufferAddr, 0);
            addBg(s, s.bufferAddr, 0);
            addGr(s, s.bufferAddr, 0);
            addIc(s, s.bufferAddr, 0);
            s.bufferAddr = inc(s, s.bufferAddr);
          }
          if (baddr === 0) lastZpt = true;
        } else {
          lastZpt = false;
        }
        s.bufferAddr = baddr;
        lastCmd = true;
        break;
      }
      case ORDER_RA: {
        cp += 2;
        if (cp >= end) {
          abort("N2006", "record too short, missing RA address");
          break;
        }
        const baddr = decodeBaddr(buf[cp - 1], buf[cp]);
        if (baddr >= size) {
          abort("N2007", `RA address ${baddr} > maximum ${size - 1}`);
          break;
        }
        cp++;
        if (cp >= end) {
          abort("N2008", "record too short, missing RA character");
          break;
        }
        // b3270 repeats a DBCS pair only in a DBCS session, which node3270 never is.
        let raGe = false;
        if (buf[cp] === ORDER_GE) {
          raGe = true;
          cp++;
          if (cp >= end) {
            abort("N2013", "record too short, missing RA GE character");
            break;
          }
        }
        const c = buf[cp];
        do {
          addWithDefaults(s, s.bufferAddr, c, raGe ? CS_GE : s.defaultCs);
          s.bufferAddr = inc(s, s.bufferAddr);
        } while (s.bufferAddr !== baddr);
        currentFa = fieldAttribute(s, s.bufferAddr);
        lastCmd = true;
        lastZpt = false;
        break;
      }
      case ORDER_EUA: {
        cp += 2;
        if (cp >= end) {
          abort("N2014", "record too short, missing EUA address");
          break;
        }
        const baddr = decodeBaddr(buf[cp - 1], buf[cp]);
        if (baddr >= size) {
          abort("N2015", `EUA address ${baddr} > maximum ${size - 1}`);
          break;
        }
        do {
          if (s.fa[s.bufferAddr]) {
            currentFa = s.fa[s.bufferAddr];
          } else if (!isProtected(currentFa)) {
            add(s, s.bufferAddr, EBC_NULL, CS_BASE);
          }
          s.bufferAddr = inc(s, s.bufferAddr);
        } while (s.bufferAddr !== baddr);
        currentFa = fieldAttribute(s, s.bufferAddr);
        lastCmd = true;
        lastZpt = false;
        break;
      }
      case ORDER_GE:
        cp++;
        if (cp >= end) {
          abort("N2016", "record too short, missing GE character");
          break;
        }
        addWithDefaults(s, s.bufferAddr, buf[cp], CS_GE);
        s.bufferAddr = inc(s, s.bufferAddr);
        currentFa = fieldAttribute(s, s.bufferAddr);
        lastCmd = false;
        lastZpt = false;
        break;
      case ORDER_MF: {
        cp++;
        if (cp >= end) {
          abort("N2017", "record too short, missing MF count");
          break;
        }
        const na = buf[cp];
        const b = s.bufferAddr;
        if (s.fa[b]) {
          for (let i = 0; i < na; i++) {
            cp++;
            if (cp + 1 >= end) {
              abort("N2018", "record too short, missing MF attribute");
              break;
            }
            const type = buf[cp];
            cp++;
            const value = buf[cp];
            if (type === XA_3270) addFa(s, b, value, s.cs[b]);
            else if (type === XA_FOREGROUND) addFg(s, b, value);
            else if (type === XA_BACKGROUND) addBg(s, b, value);
            else if (type === XA_HIGHLIGHTING) addGr(s, b, value & 0x0f);
            else if (type === XA_CHARSET)
              addCs(
                s,
                b,
                value === 0xf1 ? CS_APL : value === 0xf8 ? CS_DBCS : 0,
              );
            else if (type === XA_INPUT_CONTROL)
              addIc(s, b, value === 1 ? 1 : 0);
          }
          s.bufferAddr = inc(s, s.bufferAddr);
        } else {
          cp += na * 2;
        }
        lastCmd = true;
        lastZpt = false;
        break;
      }
      case ORDER_SFE: {
        cp++;
        if (cp >= end) {
          abort("N2019", "record too short, missing SFE count");
          break;
        }
        const na = buf[cp];
        let anyFa = false;
        let efaFg = 0,
          efaBg = 0,
          efaGr = 0,
          efaCs = 0;
        for (let i = 0; i < na; i++) {
          cp++;
          if (cp + 1 >= end) {
            abort("N2020", "record too short, missing SFE attribute");
            break;
          }
          const type = buf[cp];
          cp++;
          const value = buf[cp];
          if (type === XA_3270) {
            startField(value);
            anyFa = true;
          } else if (type === XA_FOREGROUND) {
            if (s.mode3279) efaFg = value;
          } else if (type === XA_BACKGROUND) {
            if (s.mode3279) efaBg = value;
          } else if (type === XA_HIGHLIGHTING) {
            efaGr = value & 0x07;
          } else if (type === XA_CHARSET) {
            efaCs = value === 0xf1 ? CS_APL : CS_BASE;
          }
        }
        if (!anyFa) startField(0);
        addCs(s, s.bufferAddr, efaCs);
        addFg(s, s.bufferAddr, efaFg);
        addBg(s, s.bufferAddr, efaBg);
        addGr(s, s.bufferAddr, efaGr);
        addIc(s, s.bufferAddr, 0);
        s.bufferAddr = inc(s, s.bufferAddr);
        lastCmd = true;
        lastZpt = false;
        break;
      }
      case ORDER_SA: {
        cp++;
        if (cp + 1 >= end) {
          abort("N2021", "record too short, missing SA attribute");
          break;
        }
        const type = buf[cp];
        const value = buf[cp + 1];
        if (type === XA_FOREGROUND) {
          if (s.mode3279) s.defaultFg = value;
        } else if (type === XA_BACKGROUND) {
          if (s.mode3279) s.defaultBg = value;
        } else if (type === XA_HIGHLIGHTING) {
          s.defaultGr = value & 0x0f;
        } else if (type === XA_ALL) {
          s.defaultFg = 0;
          s.defaultBg = 0;
          s.defaultGr = 0;
          s.defaultCs = 0;
          s.defaultIc = 0;
        } else if (type === XA_CHARSET) {
          s.defaultCs =
            value === 0xf1 ? CS_APL : value === 0xf8 ? CS_DBCS : CS_BASE;
        } else if (type === XA_INPUT_CONTROL) {
          s.defaultIc = value === 1 ? 1 : 0;
        }
        cp++;
        lastCmd = true;
        lastZpt = false;
        break;
      }
      case FCORDER_SUB:
      case FCORDER_DUP:
      case FCORDER_FM:
      case FCORDER_FF:
      case FCORDER_CR:
      case FCORDER_NL:
      case FCORDER_EM:
      case FCORDER_LF:
      case FCORDER_EO:
        if (s.defaultCs === CS_DBCS) {
          abort("N2022", "invalid format control order in DBCS field");
          break;
        }
        addWithDefaults(s, s.bufferAddr, buf[cp], s.defaultCs);
        s.bufferAddr = inc(s, s.bufferAddr);
        lastCmd = true;
        lastZpt = false;
        break;
      case FCORDER_SO:
        addWithDefaults(s, s.bufferAddr, buf[cp], s.defaultCs);
        s.bufferAddr = inc(s, s.bufferAddr);
        lastCmd = true;
        lastZpt = false;
        break;
      case FCORDER_SI: {
        const faddr = findFieldAttribute(s, s.bufferAddr);
        let baddr = dec(s, s.bufferAddr);
        while (
          !aborted &&
          ((faddr >= 0 && baddr !== faddr) || (faddr < 0 && baddr !== size - 1))
        ) {
          if (s.ec[baddr] === FCORDER_SI) {
            abort("N2023", "double SI");
            break;
          }
          if (s.ec[baddr] === FCORDER_SO) break;
          baddr = dec(s, baddr);
        }
        if (aborted) break;
        if (s.ec[baddr] !== FCORDER_SO) {
          abort("N2024", "SI without SO");
          break;
        }
        addWithDefaults(s, s.bufferAddr, buf[cp], s.defaultCs);
        s.bufferAddr = inc(s, s.bufferAddr);
        lastCmd = true;
        lastZpt = false;
        break;
      }
      case FCORDER_NULL: {
        let second = -1;
        if (s.defaultCs === CS_DBCS) {
          cp++;
          if (cp >= end) {
            abort("N2025", "missing second half of DBCS character");
            break;
          }
          const c2 = buf[cp];
          if ([0x00, 0x15, 0x19, 0x0c, 0x0d, 0x1c, 0x1e].includes(c2)) {
            second = c2;
          } else if (c2 === ORDER_SF || c2 === ORDER_SFE) {
            cp--;
          } else {
            abort(
              "N2026",
              `invalid DBCS control character X'00${hex2(c2).toUpperCase()}'`,
            );
            break;
          }
        }
        addWithDefaults(s, s.bufferAddr, EBC_NULL, s.defaultCs);
        s.bufferAddr = inc(s, s.bufferAddr);
        if (second >= 0) {
          addWithDefaults(s, s.bufferAddr, second, s.defaultCs);
          s.bufferAddr = inc(s, s.bufferAddr);
        }
        lastCmd = false;
        lastZpt = false;
        break;
      }
      default: {
        const c1 = buf[cp];
        if (c1 <= 0x3f) {
          lastCmd = true;
          lastZpt = false;
          break;
        }
        let second = -1;
        if (s.defaultCs === CS_DBCS) {
          cp++;
          if (cp >= end) {
            abort("N2027", "missing second half of DBCS character");
            break;
          }
          second = buf[cp];
          if (c1 < 0x40 || c1 > 0xfe || second < 0x40 || second > 0xfe) {
            abort(
              "N2028",
              `invalid DBCS character X'${hex2(c1).toUpperCase()}${hex2(second).toUpperCase()}'`,
            );
            break;
          }
        }
        addWithDefaults(s, s.bufferAddr, c1, s.defaultCs);
        s.bufferAddr = inc(s, s.bufferAddr);
        if (second >= 0) {
          addWithDefaults(s, s.bufferAddr, second, s.defaultCs);
          s.bufferAddr = inc(s, s.bufferAddr);
        }
        lastCmd = false;
        lastZpt = false;
      }
    }
  }
  setFormatted(s);
  if (insertCursor) cursorMove(s, icBaddr);
  s.kybdlock &= ~KL_AWAITING_FIRST;
  if (keyboardRestore) {
    s.aid = AID_NO;
    doReset(s, false);
  } else if (s.kybdlock & KL_OIA_TWAIT) {
    s.kybdlock &= ~KL_OIA_TWAIT;
    statusSyswait(s);
  }
  if (wcc & 0x04) s.emit({ type: "alarm" });
  s.tracePrimed = false;
  psProcess(s);
  return rv;
}

/** @param {State} s @param {number} baddr */
export function cursorMove(s, baddr) {
  if (s.cursor !== baddr) s.changed = true;
  s.cursor = baddr;
  s.savedBaddr = baddr;
}

/** ps_process(): runs whatever typeahead the keyboard now allows. @param {State} s */
export function psProcess(s) {
  while (runTypeahead(s));
}

/** ctlr_write_sscp_lu() @param {State} s @param {Uint8Array} buf */
export function writeSscpLu(s, buf) {
  const addText = (/** @type {number} */ c, /** @type {number} */ cs) => {
    addWithDefaults(s, s.bufferAddr, c, cs);
    s.bufferAddr = inc(s, s.bufferAddr);
    if (s.bufferAddr === 0) {
      scroll(s);
      s.bufferAddr = (s.rows - 1) * s.cols;
    }
  };
  for (let i = 0; i < buf.length; i++) {
    switch (buf[i]) {
      case FCORDER_NL: {
        const row = (s.bufferAddr / s.cols) | 0;
        while (((s.bufferAddr / s.cols) | 0) === row) {
          addWithDefaults(s, s.bufferAddr, EBC_NULL, s.defaultCs);
          s.bufferAddr = inc(s, s.bufferAddr);
        }
        if (s.bufferAddr === 0) {
          scroll(s);
          s.bufferAddr = (s.rows - 1) * s.cols;
        }
        break;
      }
      case ORDER_SF:
        i++;
        addText(0x40, s.defaultCs);
        break;
      case ORDER_IC:
        break;
      case ORDER_SBA:
        i += 2;
        break;
      case ORDER_GE:
        if (++i >= buf.length) break;
        addText(buf[i] <= 0x40 ? 0x40 : buf[i], CS_GE);
        break;
      default:
        addText(buf[i], s.defaultCs);
    }
  }
  cursorMove(s, s.bufferAddr);
  s.sscpStart = s.bufferAddr;
  s.aid = AID_NO;
  doReset(s, false);
}

/** ctlr_sscp_up() @param {State} s */
export function sscpUp(s) {
  if (s.sscpStart > s.cols) s.sscpStart -= s.cols;
}

/** ctlr_erase_all_unprotected() @param {State} s */
export function eraseAllUnprotected(s) {
  kybdInhibit(s, false);
  if (hasFields(s)) {
    let baddr = firstFieldAttribute(s);
    const start = baddr;
    let found = false;
    do {
      const fa = s.fa[baddr];
      if (!isProtected(fa)) {
        mdtClear(s, baddr);
        do {
          baddr = inc(s, baddr);
          if (!found) {
            cursorMove(s, baddr);
            found = true;
          }
          if (!s.fa[baddr]) add(s, baddr, EBC_NULL, 0);
        } while (!s.fa[baddr]);
      } else {
        do {
          baddr = inc(s, baddr);
        } while (!s.fa[baddr]);
      }
    } while (baddr !== start);
    if (!found) cursorMove(s, 0);
  } else {
    clear(s);
  }
  s.aid = AID_NO;
  doReset(s, false);
}

/** host_cs(): the charset attribute value to report. @param {number} cs */
export function hostCs(cs) {
  switch (cs & CS_MASK) {
    case CS_APL:
      return 0xf1;
    case CS_DBCS:
      return 0xf8;
    default:
      return 0;
  }
}

/** insert_sa(): Set Attribute orders for character reply mode. @param {State} s @param {number} b @param {{fg: number, bg: number, gr: number, cs: number}} prev */
function insertSa(
  s,
  b,
  prev,
  fg = s.fg[b],
  bg = s.bg[b],
  gr = s.gr[b],
  cs = s.cs[b],
) {
  if (s.replyMode !== SF_SRM_CHAR) return;
  const attrs = s.crmAttr.subarray(0, s.crmNattr);
  if (attrs.includes(XA_FOREGROUND) && fg !== prev.fg) {
    s.out.push(ORDER_SA, XA_FOREGROUND, fg);
    prev.fg = fg;
  }
  if (attrs.includes(XA_BACKGROUND) && bg !== prev.bg) {
    s.out.push(ORDER_SA, XA_BACKGROUND, bg);
    prev.bg = bg;
  }
  if (attrs.includes(XA_HIGHLIGHTING)) {
    const g = gr ? gr | 0xf0 : 0;
    if (g !== prev.gr) {
      s.out.push(ORDER_SA, XA_HIGHLIGHTING, g);
      prev.gr = g;
    }
  }
  if (attrs.includes(XA_CHARSET)) {
    const c = hostCs(cs);
    if (c !== prev.cs) {
      s.out.push(ORDER_SA, XA_CHARSET, c);
      prev.cs = c;
    }
  }
}

/** ctlr_read_modified(): Read Modified, Read Modified All and every AID. @param {State} s @param {number} aid @param {boolean} all */
export function readModified(s, aid, all) {
  if (inSscp(s) && aid !== AID_ENTER) return;
  const shortRead =
    !all &&
    (aid === AID_PA1 ||
      aid === AID_PA2 ||
      aid === AID_PA3 ||
      aid === AID_CLEAR);
  const sendData = all || !(shortRead || aid === AID_SELECT);
  const prev = { fg: 0, bg: 0, gr: 0, cs: 0 };
  s.out.reset();
  if (aid === AID_SYSREQ) {
    s.out.push(0x01, 0x6c, 0x61, 0x02);
  } else if (!inSscp(s)) {
    s.out.push(aid);
    if (shortRead) {
      netOutput(s);
      return;
    }
    encodeBaddr(s, s.cursor);
  }

  if (hasFields(s)) {
    let baddr = firstFieldAttribute(s);
    const sbaddr = baddr;
    let faddr = baddr;
    do {
      if (isModified(s.fa[baddr])) {
        baddr = inc(s, baddr);
        s.out.push(ORDER_SBA);
        encodeBaddr(s, baddr);
        while (!s.fa[baddr]) {
          if (sendData && s.ec[baddr]) {
            const cs = s.cs[baddr];
            insertSa(
              s,
              baddr,
              prev,
              s.fg[baddr] || s.fg[faddr],
              s.bg[baddr] || s.bg[faddr],
              s.gr[baddr] || s.gr[faddr],
              cs || s.cs[faddr],
            );
            if (
              cs & CS_GE ||
              (cs & CS_MASK) === CS_APL ||
              (s.cs[faddr] === CS_APL && !(cs & CS_MASK))
            )
              s.out.push(ORDER_GE);
            s.out.push(s.ec[baddr]);
          }
          baddr = inc(s, baddr);
        }
        faddr = baddr;
      } else {
        do {
          baddr = inc(s, baddr);
        } while (!s.fa[baddr]);
        faddr = baddr;
      }
    } while (baddr !== sbaddr);
  } else {
    let nbytes = 0;
    let baddr = inSscp(s) ? s.sscpStart : 0;
    do {
      if (s.ec[baddr]) {
        insertSa(s, baddr, prev);
        if (s.cs[baddr] & CS_GE) s.out.push(ORDER_GE);
        s.out.push(s.ec[baddr]);
        nbytes++;
      }
      baddr = inc(s, baddr);
      if (inSscp(s) && (nbytes >= 255 || !baddr)) break;
    } while (baddr !== 0);
  }
  netOutput(s);
}

/** The first field attribute scanning forward from 0; -1 if there is none. @param {State} s */
function firstFieldAttribute(s) {
  const size = s.rows * s.cols;
  for (let b = 0; b < size; b++) if (s.fa[b]) return b;
  return -1;
}

/**
 * Formatted and with a field attribute left. Typing over an SO right before a field attribute
 * wipes the attribute (in x3270 too) but leaves the screen formatted; with the last one gone,
 * a walk from field to field never ends, so those walks treat such a screen as unformatted.
 * b3270 spins forever there instead.
 * @param {State} s
 */
export function hasFields(s) {
  return s.formatted && firstFieldAttribute(s) !== -1;
}

/** ctlr_read_buffer() @param {State} s @param {number} aid */
export function readBuffer(s, aid) {
  const prev = { fg: 0, bg: 0, gr: 0, cs: 0 };
  s.out.reset();
  s.out.push(aid);
  encodeBaddr(s, s.cursor);
  let faCs = csAt(s, findFieldAttribute(s, 0));
  const size = s.rows * s.cols;
  for (let baddr = 0; baddr < size; baddr++) {
    if (s.fa[baddr]) {
      if (s.replyMode === SF_SRM_FIELD) {
        s.out.push(ORDER_SF);
      } else {
        s.out.push(ORDER_SFE);
        const countAt = s.out.length;
        s.out.push(1, XA_3270);
        let count = 1;
        s.out.push(CODE_TABLE[s.fa[baddr] & ~FA_PRINTABLE]);
        if (s.fg[baddr]) {
          s.out.push(XA_FOREGROUND, s.fg[baddr]);
          count++;
        }
        if (s.bg[baddr]) {
          s.out.push(XA_BACKGROUND, s.bg[baddr]);
          count++;
        }
        if (s.gr[baddr]) {
          s.out.push(XA_HIGHLIGHTING, s.gr[baddr] | 0xf0);
          count++;
        }
        if (s.cs[baddr] & CS_MASK) {
          s.out.push(XA_CHARSET, hostCs(s.cs[baddr]));
          count++;
        }
        s.out.bytes[countAt] = count;
        faCs = s.cs[baddr];
        continue;
      }
      s.out.push(CODE_TABLE[s.fa[baddr] & ~FA_PRINTABLE]);
      faCs = s.cs[baddr];
    } else {
      insertSa(s, baddr, prev);
      if (
        s.cs[baddr] & CS_GE ||
        (s.cs[baddr] & CS_MASK) === CS_APL ||
        (faCs === CS_APL && !(s.cs[baddr] & CS_MASK))
      ) {
        s.out.push(ORDER_GE);
      }
      s.out.push(s.ec[baddr]);
    }
  }
  netOutput(s);
}

const hex2 = (/** @type {number} */ n) => n.toString(16).padStart(2, "0");
