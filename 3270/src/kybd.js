import { CS_APL, CS_DBCS, CS_GE, CS_MASK, unicodeToEbcdic } from "./charset.js";
import { scrollToBottom } from "./scroll.js";
import {
  AID_CLEAR,
  AID_ENTER,
  AID_SYSREQ,
  add,
  addBg,
  addFg,
  addGr,
  clear,
  cursorMove,
  csAt,
  copyCells,
  dec,
  faAt,
  fieldAttribute,
  findFieldAttribute,
  hasFields,
  inc,
  isNumeric,
  isProtected,
  isSkip,
  mdtClear,
  mdtSet,
  mutableCs,
  nextUnprotected,
  readModified,
  scroll,
  sscpUp,
  wrappingMemmove,
  EBC_DUP,
  EBC_FM,
  EBC_NULL,
  EBC_SI,
  EBC_SO,
} from "./ctlr.js";
import { KEYSYMS } from "./keysyms.js";
import { doToggle } from "./toggles.js";
import { bound, netAbort, netBreak, netInterrupt } from "./telnet.js";
import {
  popupError,
  statusCtlrDone,
  statusFlag,
  statusMinus,
  statusOerr,
  statusReset,
  statusTwait,
} from "./ui.js";
import {
  CONNECTED_UNBOUND,
  inE,
  inSscp,
  in3270,
  isConnected,
} from "./session.js";

// Port of x3270's Common/kybd.c: keyboard lock, typeahead and the editing actions.
// Every action returns false when x3270's would fail (a script would see "error").

export const KL_OERR_MASK = 0x000f;
export const KL_OERR_PROTECTED = 1,
  KL_OERR_NUMERIC = 2,
  KL_OERR_OVERFLOW = 3,
  KL_OERR_DBCS = 4;
export const KL_NOT_CONNECTED = 0x0010,
  KL_AWAITING_FIRST = 0x0020,
  KL_OIA_TWAIT = 0x0040,
  KL_OIA_LOCKED = 0x0080;
export const KL_DEFERRED_UNLOCK = 0x0100,
  KL_ENTER_INHIBIT = 0x0200,
  KL_SCROLLED = 0x0400,
  KL_OIA_MINUS = 0x0800;
export const KL_FT = 0x1000,
  KL_BID = 0x2000;

const EBC_SPACE = 0x40;
const EBC_UNDERSCORE = 0x6d,
  EBC_GREATER = 0x6e,
  EBC_QUESTION = 0x6f,
  EBC_AMPERSAND = 0x50;
const EBC_0 = 0xf0,
  EBC_9 = 0xf9,
  EBC_PLUS = 0x4e,
  EBC_MINUS = 0x60,
  EBC_PERIOD = 0x4b,
  EBC_COMMA = 0x6b;
const AID_SELECT = 0x7e;

/** PF1-PF24 and PA1-PA3 AIDs. */
export const PF_AIDS = [
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c, 0xc1,
  0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c,
];
export const PA_AIDS = [0x6c, 0x6e, 0x6b];

/** @typedef {import("./session.js").State} State */
/** @typedef {(s: State, ...args: any[]) => boolean} Action */

/** enq_ta(): holds an action until the keyboard unlocks. @param {State} s @param {Action} fn @param {any[]} args */
function enqTa(s, fn, ...args) {
  if (!in3270(s) && !inSscp(s)) return;
  if (s.kybdlock & (KL_OERR_MASK | KL_SCROLLED | KL_FT)) {
    s.emit({ type: "alarm" });
    return;
  }
  if (!s.options.typeahead) return;
  s.typeahead.push({ fn, args });
  if (s.typeahead.length === 1) statusFlag(s, "typeahead", true);
}

/** run_ta(): one queued action, if the keyboard allows it. @param {State} s */
export function runTypeahead(s) {
  if (s.kybdlock || s.typeahead.length === 0) return false;
  const ta = /** @type {{fn: Action, args: any[]}} */ (s.typeahead.shift());
  if (s.typeahead.length === 0) statusFlag(s, "typeahead", false);
  ta.fn(s, ...ta.args);
  return true;
}

/** flush_ta() @param {State} s */
function flushTypeahead(s) {
  const any = s.typeahead.length > 0;
  s.typeahead.length = 0;
  statusFlag(s, "typeahead", false);
  return any;
}

/** kybd_inhibit(): the lock between a Query Reply and the host's next write. @param {State} s @param {boolean} inhibit */
export function kybdInhibit(s, inhibit) {
  if (inhibit) {
    s.kybdlock |= KL_ENTER_INHIBIT;
    if (s.kybdlock === KL_ENTER_INHIBIT) statusReset(s);
  } else {
    s.kybdlock &= ~KL_ENTER_INHIBIT;
    if (!s.kybdlock) statusReset(s);
  }
}

/** insert_mode(): flips the insertMode toggle when it differs. @param {State} s @param {boolean} on */
export function insertMode(s, on) {
  if (on !== s.options.insertMode) doToggle(s, "insertMode");
}

/** @param {State} s */
function cancelDeferredUnlock(s) {
  if (s.unlockTimer === null) return;
  clearTimeout(s.unlockTimer);
  s.unlockTimer = null;
}

/** kybd_connect(): the ST_CONNECT hook. @param {State} s */
export function kybdConnect(s) {
  cancelDeferredUnlock(s);
  s.kybdlock = 0;
  if (isConnected(s)) {
    if (!s.hostPrefixes.includes("C")) s.kybdlock |= KL_AWAITING_FIRST;
  } else {
    s.kybdlock |= KL_NOT_CONNECTED;
    flushTypeahead(s);
    insertMode(s, false);
  }
}

/** kybd_in3270(): the ST_3270_MODE hook. @param {State} s */
export function kybdIn3270(s) {
  cancelDeferredUnlock(s);
  insertMode(s, in3270(s) && s.options.alwaysInsert);
  switch (s.cstate) {
    case CONNECTED_UNBOUND:
      if (!s.hostPrefixes.includes("C")) s.kybdlock |= KL_AWAITING_FIRST;
      break;
    default:
      if (inSscp(s)) {
        s.kybdlock = 0;
      } else if (inE(s)) {
        if (s.options.bindUnlock && bound(s)) s.kybdlock = 0;
        else s.kybdlock &= KL_AWAITING_FIRST | KL_OIA_LOCKED;
      } else {
        s.kybdlock &= KL_AWAITING_FIRST;
      }
  }
  if (isConnected(s)) while (runTypeahead(s));
}

/** operator_error() @param {State} s @param {number} type @param {boolean} fail */
function operatorError(s, type, fail) {
  s.log.debug(`keyboard locked, operator error ${type}`);
  if (fail) {
    s.log.warn(`N3013 keyboard locked, operator error ${type}`);
    popupError(s, "Keyboard locked");
  }
  if (s.options.oerrLock || fail) {
    statusOerr(s, type);
    s.kybdlock |= type;
    flushTypeahead(s);
  }
  return !fail;
}

/** OERR_CLEAR_OR_ENQ: true when the action should run now. @param {State} s @param {Action} fn @param {any[]} args */
function oerrClearOrEnq(s, fn, ...args) {
  if (!s.kybdlock) return true;
  if (!(s.kybdlock & ~KL_OERR_MASK)) {
    s.kybdlock &= ~KL_OERR_MASK;
    statusReset(s);
    return true;
  }
  enqTa(s, fn, ...args);
  return false;
}

/** do_reset() @param {State} s @param {boolean} explicit */
export function doReset(s, explicit) {
  if (explicit && flushTypeahead(s)) return;
  scrollToBottom(s);
  if (!isConnected(s)) {
    insertMode(s, false);
    return;
  }
  insertMode(s, in3270(s) && s.options.alwaysInsert);
  cancelDeferredUnlock(s);
  // The host's unlock can be held back a little (unlockDelay), so a script doesn't type
  // into a screen the host is still painting; a deferral older than a second is let go.
  const deferredSince = s.kybdlock & KL_DEFERRED_UNLOCK ? s.deferredSince : 0;
  if (
    explicit ||
    !s.options.unlockDelay ||
    (deferredSince !== 0 &&
      Math.floor(Date.now() / 1000) - deferredSince > 1) ||
    !s.options.unlockDelayMs
  ) {
    s.kybdlock &= explicit ? KL_BID : KL_FT | KL_BID;
  } else if (
    s.kybdlock &
    (KL_DEFERRED_UNLOCK | KL_OIA_TWAIT | KL_OIA_LOCKED | KL_AWAITING_FIRST)
  ) {
    if (!(s.kybdlock & KL_DEFERRED_UNLOCK))
      s.deferredSince = Math.floor(Date.now() / 1000);
    s.kybdlock = KL_DEFERRED_UNLOCK;
    s.log.debug(`deferring keyboard unlock ${s.options.unlockDelayMs}ms`);
    s.unlockTimer = setTimeout(() => {
      s.unlockTimer = null;
      s.kybdlock &= ~KL_DEFERRED_UNLOCK;
      statusReset(s);
      if (isConnected(s)) while (runTypeahead(s));
      s.emit({ type: "timer" });
    }, s.options.unlockDelayMs);
  }
  statusReset(s);
}

/** key_AID() @param {State} s @param {number} aid */
function keyAid(s, aid) {
  if (inSscp(s)) {
    if (s.kybdlock & KL_OIA_MINUS) return;
    if (aid === AID_CLEAR) return;
    if (aid !== AID_ENTER) {
      statusMinus(s);
      s.kybdlock |= KL_OIA_MINUS;
      return;
    }
    let needScroll = false;
    if (((s.cursor / s.cols) | 0) === s.rows - 1) needScroll = true;
    else cursorMove(s, (((s.cursor + s.cols) / s.cols) | 0) * s.cols);
    // Act as if the host had written our input, and send it as a Read Modified.
    s.bufferAddr = s.cursor;
    s.aid = aid;
    readModified(s, aid, false);
    statusCtlrDone(s);
    if (needScroll) {
      scroll(s);
      cursorMove(s, (s.rows - 1) * s.cols);
      s.bufferAddr = (s.rows - 1) * s.cols;
    }
    return;
  }
  statusTwait(s);
  insertMode(s, s.options.alwaysInsert);
  s.kybdlock |= KL_OIA_TWAIT | KL_OIA_LOCKED;
  s.aid = aid;
  readModified(s, aid, false);
  statusCtlrDone(s);
}

/** Enter_action @type {Action} */
export function enter(s) {
  if (s.kybdlock & KL_OIA_MINUS) return true;
  if (s.kybdlock) enqTa(s, enter);
  else keyAid(s, AID_ENTER);
  return true;
}

/** PF_action @type {Action} */
export function pf(s, /** @type {number | string} */ arg) {
  const n = parseInt(String(arg), 10) || 0;
  if (!(n >= 1 && n <= PF_AIDS.length)) {
    s.log.warn(`N3001 invalid PF key ${arg}`);
    popupError(s, `PF(): Invalid argument '${arg}'`);
    return false;
  }
  if (s.kybdlock & KL_OIA_MINUS) return true;
  if (s.kybdlock) enqTa(s, pf, n);
  else keyAid(s, PF_AIDS[n - 1]);
  return true;
}

/** PA_action @type {Action} */
export function pa(s, /** @type {number | string} */ arg) {
  const n = parseInt(String(arg), 10) || 0;
  if (!(n >= 1 && n <= PA_AIDS.length)) {
    s.log.warn(`N3002 invalid PA key ${arg}`);
    popupError(s, `PA(): Invalid argument '${arg}'`);
    return false;
  }
  if (s.kybdlock & KL_OIA_MINUS) return true;
  if (s.kybdlock) enqTa(s, pa, n);
  else keyAid(s, PA_AIDS[n - 1]);
  return true;
}

/** Clear_action @type {Action} */
export function clearKey(s) {
  if (s.kybdlock & KL_OIA_MINUS) return true;
  if (s.kybdlock && in3270(s)) {
    enqTa(s, clearKey);
    return true;
  }
  s.bufferAddr = 0;
  clear(s);
  cursorMove(s, 0);
  if (in3270(s) || inSscp(s)) keyAid(s, AID_CLEAR);
  return true;
}

/** SysReq_action @type {Action} */
export function sysReq(s) {
  if (inE(s)) {
    netAbort(s);
  } else if (s.kybdlock & KL_OIA_MINUS) {
    return true;
  } else if (s.kybdlock) {
    enqTa(s, sysReq);
  } else {
    keyAid(s, AID_SYSREQ);
  }
  return true;
}

/** Attn_action @type {Action} */
export function attn(s) {
  if (inE(s)) {
    if (bound(s)) netInterrupt(s);
    else {
      statusMinus(s);
      s.kybdlock |= KL_OIA_MINUS;
    }
    return true;
  }
  if (in3270(s)) {
    netBreak(s);
    return true;
  }
  return false;
}

/** Interrupt_action @type {Action} */
export function interrupt(s) {
  if (!in3270(s)) return false;
  netInterrupt(s);
  return true;
}

/** Reset_action @type {Action} */
export function reset(s) {
  doReset(s, true);
  return true;
}

/**
 * ins_prep(): makes room for count characters at baddr by shifting the field right.
 * @param {State} s @param {number} faddr @param {number} baddr @param {number} count @param {boolean} oerrFail
 * @returns {{ok: boolean, noRoom: boolean}}
 */
function insPrep(s, faddr, baddr, count, oerrFail) {
  const size = s.rows * s.cols;
  let nextFaddr;
  if (faddr === -1) {
    nextFaddr = size - 1;
  } else {
    nextFaddr = inc(s, faddr);
    while (nextFaddr !== faddr && !s.fa[nextFaddr])
      nextFaddr = inc(s, nextFaddr);
  }
  if (!mutableCs(s)) {
    for (let x = baddr; x !== nextFaddr; x = inc(s, x)) {
      if (s.cs[x] & CS_MASK) return { ok: false, noRoom: false };
    }
  }

  let xaddr = baddr;
  let need = count;
  let ntb = 0;
  while (need && xaddr !== nextFaddr) {
    const c = s.ec[xaddr];
    if (c === EBC_NULL) need--;
    else if (
      s.options.blankFill &&
      (c === EBC_SPACE ||
        (s.options.underscoreBlankFill && c === EBC_UNDERSCORE))
    )
      ntb++;
    else ntb = 0;
    xaddr = inc(s, xaddr);
  }
  if (need - ntb > 0) {
    if (!s.options.reverseInputMode) {
      operatorError(s, KL_OERR_OVERFLOW, oerrFail);
      return { ok: false, noRoom: false };
    }
    return { ok: true, noRoom: true };
  }

  // Shift right over each run of nulls.
  need = count;
  xaddr = baddr;
  while (need && xaddr !== nextFaddr) {
    let nNulls = 0;
    let firstNull = -1;
    while (need && s.ec[xaddr] === EBC_NULL) {
      need--;
      nNulls++;
      if (firstNull === -1) firstNull = xaddr;
      xaddr = inc(s, xaddr);
    }
    if (nNulls) {
      let copyLen = firstNull - baddr;
      if (copyLen < 0) copyLen += size;
      if (copyLen) wrappingMemmove(s, (baddr + nNulls) % size, baddr, copyLen);
    }
    xaddr = inc(s, xaddr);
  }
  if (!need) return { ok: true, noRoom: false };

  // Shift over the trailing blanks, which we know there are enough of.
  let copyLen = nextFaddr - baddr;
  if (copyLen < 0) copyLen += size;
  copyLen -= need;
  wrappingMemmove(s, (baddr + need) % size, baddr, copyLen);
  return { ok: true, noRoom: false };
}

/**
 * key_Character(): one EBCDIC character typed at the cursor.
 * @param {State} s @param {number} ebc @param {boolean} withGe @param {boolean} pasting @param {boolean} oerrFail
 * @returns {{ok: boolean, consumed: boolean}}
 */
function keyCharacter(s, ebc, withGe, pasting, oerrFail) {
  if (s.kybdlock) {
    enqTa(s, keyCharacterAction, ebc, withGe, pasting, oerrFail);
    return { ok: true, consumed: false };
  }
  let baddr = s.cursor;
  const faddr = findFieldAttribute(s, baddr);
  const fa = fieldAttribute(s, baddr);
  const autoSkip = !(pasting && s.options.overlayPaste);
  const oerr = (/** @type {number} */ type) => ({
    ok: operatorError(s, type, oerrFail),
    consumed: false,
  });

  if (s.fa[baddr] || isProtected(fa)) {
    if (autoSkip) return oerr(KL_OERR_PROTECTED);
    // Overlay paste drops characters that land on protected cells.
    cursorMove(s, inc(s, baddr));
    return { ok: true, consumed: false };
  }
  if (
    isNumeric(fa) &&
    s.options.numericLock &&
    !(
      (ebc >= EBC_0 && ebc <= EBC_9) ||
      ebc === EBC_PLUS ||
      ebc === EBC_MINUS ||
      ebc === EBC_PERIOD ||
      ebc === EBC_COMMA
    )
  ) {
    return oerr(KL_OERR_NUMERIC);
  }
  if (csAt(s, faddr) === CS_DBCS) return oerr(KL_OERR_DBCS);
  if (s.cs[baddr] === CS_DBCS && !mutableCs(s)) return oerr(KL_OERR_DBCS);
  if (s.ec[baddr] === EBC_SI) {
    baddr = inc(s, baddr);
    if (baddr === faddr) return oerr(KL_OERR_OVERFLOW);
  }

  let noRoom = false;
  if (s.ec[baddr] === EBC_SO) {
    if (s.options.insertMode) {
      const prep = insPrep(s, faddr, baddr, 1, oerrFail);
      if (!prep.ok) return { ok: oerrFail, consumed: false };
      noRoom = prep.noRoom;
    } else {
      // Overwriting an SO: SO/SI becomes x/space, a longer subfield keeps its SO one further on.
      let xaddr = inc(s, baddr);
      const wasSi = s.ec[xaddr] === EBC_SI;
      add(s, xaddr, EBC_SPACE, 0);
      addFg(s, xaddr, 0);
      addBg(s, xaddr, 0);
      if (!wasSi) {
        xaddr = inc(s, xaddr);
        add(s, xaddr, EBC_SO, 0);
        addFg(s, xaddr, 0);
        addBg(s, xaddr, 0);
      }
    }
  } else if (s.options.reverseInputMode || s.options.insertMode) {
    const prep = insPrep(s, faddr, baddr, 1, oerrFail);
    if (!prep.ok) return { ok: oerrFail, consumed: false };
    noRoom = prep.noRoom;
  }

  if (noRoom) {
    do baddr = inc(s, baddr);
    while (s.fa[baddr]);
  } else {
    add(s, baddr, ebc, withGe ? CS_GE : 0);
    addFg(s, baddr, 0);
    addGr(s, baddr, 0);
    if (!s.options.reverseInputMode) {
      baddr = inc(s, baddr);
      if (inSscp(s) && baddr === 0) {
        scroll(s);
        sscpUp(s);
        cursorMove(s, (s.rows - 1) * s.cols);
        s.bufferAddr = (s.rows - 1) * s.cols;
        baddr = (s.rows - 1) * s.cols;
      }
    }
  }

  // Typing can overwrite the last field attribute while the screen still counts as formatted;
  // with no field start to stop at, b3270 loops here forever.
  if (s.formatted && s.options.blankFill && faddr !== -1) {
    let fill = dec(s, baddr);
    while (fill !== faddr) {
      if (fill % s.cols === s.cols - 1) {
        // A row of nothing but nulls ends the fill.
        let aborted = true;
        let scan = fill;
        while (scan !== faddr) {
          if (s.ec[scan] !== EBC_NULL) {
            aborted = false;
            break;
          }
          if (!(scan % s.cols)) break;
          scan = dec(s, scan);
        }
        if (aborted) break;
      }
      if (s.ec[fill] === EBC_NULL) add(s, fill, EBC_SPACE, 0);
      fill = dec(s, fill);
    }
  }

  mdtSet(s, s.cursor);

  if (autoSkip && (pasting || ebc !== EBC_DUP)) {
    while (s.fa[baddr])
      baddr = isSkip(s.fa[baddr]) ? nextUnprotected(s, baddr) : inc(s, baddr);
  }
  cursorMove(s, baddr);
  return { ok: true, consumed: true };
}

/** key_Character_wrapper, for the typeahead queue. @type {Action} */
function keyCharacterAction(s, ebc, withGe, pasting, oerrFail) {
  keyCharacter(s, ebc, withGe, pasting, oerrFail);
  return true;
}

/**
 * Key(name...): types each character, named as itself, a keysym, U+nnnn or 0xnn.
 * Like b3270's script actions it fails on an operator error, unless told NoFailOnError.
 * @param {State} s @param {...any} args
 */
export function keyAction(s, ...args) {
  const names = args.map(String);
  let oerrFail = true;
  for (const name of names) {
    if (name.toLowerCase() === "failonerror") oerrFail = true;
    // x3270 checks the first argument here, not the current one.
    else if (names[0].toLowerCase() === "nofailonerror") oerrFail = false;
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower === "failonerror" || lower === "nofailonerror") continue;
    let ucs4 = Object.hasOwn(KEYSYMS, name) ? KEYSYMS[name] : 0;
    if (!ucs4 && lower === "euro") ucs4 = 0x20ac;
    else if (!ucs4 && (lower.startsWith("u+") || lower.startsWith("0x")))
      ucs4 = parseInt(name.slice(2), 16) || 0;
    else if (!ucs4 && Array.from(name).length === 1)
      ucs4 = /** @type {number} */ (name.codePointAt(0));
    if (!ucs4) {
      s.log.warn(`N3337 Key(): unknown key ${name}`);
      popupError(s, `Key(): Nonexistent or invalid name: ${name}`);
      continue;
    }
    keyUnicode(s, ucs4, { oerrFail });
  }
  return true;
}

/**
 * key_UCharacter(): a Unicode character from the keyboard (or a string, with oerrFail).
 * @param {State} s @param {number} ucs4 @param {{ge?: boolean, pasting?: boolean, oerrFail?: boolean}} [how]
 */
export function keyUnicode(s, ucs4, how = {}) {
  const oerrFail = how.oerrFail ?? false;
  if (s.kybdlock) {
    enqTa(s, keyUnicode, ucs4, how);
    return true;
  }
  if (in3270(s)) {
    if (ucs4 < 0x20) return true;
    const e = unicodeToEbcdic(s.codePage, ucs4, how.ge || s.options.aplMode);
    if (e === 0) {
      s.log.debug(`U+${ucs4.toString(16)} dropped, no EBCDIC translation`);
      return true;
    }
    const ge = (e & 0x100) !== 0;
    if (csAt(s, findFieldAttribute(s, s.cursor)) === CS_APL && !ge) return true;
    return keyCharacter(
      s,
      e & 0xff,
      how.ge || ge,
      how.pasting ?? false,
      oerrFail,
    ).ok;
  }
  s.log.debug(`U+${ucs4.toString(16)} dropped, not connected`);
  return true;
}

/** Tab_action @type {Action} */
export function tab(s) {
  if (!oerrClearOrEnq(s, tab)) return true;
  cursorMove(s, nextUnprotected(s, s.cursor));
  return true;
}

/** BackTab_action @type {Action} */
export function backTab(s) {
  if (!oerrClearOrEnq(s, backTab)) return true;
  if (!in3270(s)) return true;
  let baddr = dec(s, s.cursor);
  if (s.fa[baddr]) baddr = dec(s, baddr);
  const sbaddr = baddr;
  for (;;) {
    const nbaddr = inc(s, baddr);
    if (s.fa[baddr] && !isProtected(s.fa[baddr]) && !s.fa[nbaddr]) break;
    baddr = dec(s, baddr);
    if (baddr === sbaddr) {
      cursorMove(s, 0);
      return true;
    }
  }
  cursorMove(s, inc(s, baddr));
  return true;
}

/** Home_action @type {Action} */
export function home(s) {
  if (!oerrClearOrEnq(s, home)) return true;
  if (!s.formatted) cursorMove(s, 0);
  else cursorMove(s, nextUnprotected(s, s.rows * s.cols - 1));
  return true;
}

/** @param {State} s */
function doLeft(s) {
  cursorMove(s, dec(s, s.cursor));
}

/** Left_action @type {Action} */
export function left(s) {
  if (!oerrClearOrEnq(s, left)) return true;
  if (!s.flipped) doLeft(s);
  else cursorMove(s, inc(s, s.cursor));
  return true;
}

/** Right_action @type {Action} */
export function right(s) {
  if (!oerrClearOrEnq(s, right)) return true;
  if (!s.flipped) cursorMove(s, inc(s, s.cursor));
  else doLeft(s);
  return true;
}

/** Left2_action @type {Action} */
export function left2(s) {
  if (!oerrClearOrEnq(s, left2)) return true;
  cursorMove(s, dec(s, dec(s, s.cursor)));
  return true;
}

/** Right2_action @type {Action} */
export function right2(s) {
  if (!oerrClearOrEnq(s, right2)) return true;
  cursorMove(s, inc(s, inc(s, s.cursor)));
  return true;
}

/** Up_action @type {Action} */
export function up(s) {
  if (!oerrClearOrEnq(s, up)) return true;
  let baddr = s.cursor - s.cols;
  if (baddr < 0) baddr = s.cursor + s.rows * s.cols - s.cols;
  cursorMove(s, baddr);
  return true;
}

/** Down_action @type {Action} */
export function down(s) {
  if (!oerrClearOrEnq(s, down)) return true;
  cursorMove(s, (s.cursor + s.cols) % (s.cols * s.rows));
  // x3270 4.5's Down() reports failure after moving; scripts see the same.
  return false;
}

/** do_delete() @param {State} s */
function doDelete(s) {
  const size = s.rows * s.cols;
  let baddr = s.cursor;
  const fa = fieldAttribute(s, baddr);
  if (isProtected(fa) || s.fa[baddr])
    return operatorError(s, KL_OERR_PROTECTED, true);
  let ndel = 1;
  if (s.ec[baddr] === EBC_SO || s.ec[baddr] === EBC_SI) {
    // SO and SI only go together with their partner.
    const opposite = s.ec[baddr] === EBC_SO ? EBC_SI : EBC_SO;
    if (s.ec[inc(s, baddr)] !== opposite)
      return operatorError(s, KL_OERR_PROTECTED, true);
    ndel = 2;
  }
  let endBaddr;
  if (s.formatted) {
    endBaddr = baddr;
    do {
      endBaddr = inc(s, endBaddr);
      if (s.fa[endBaddr]) break;
    } while (endBaddr !== baddr);
    endBaddr = dec(s, endBaddr);
  } else {
    endBaddr = size - 1;
  }
  // Character set attributes can't move with their characters unless the host said so.
  if (!mutableCs(s))
    for (let b = baddr; b !== endBaddr; b = inc(s, b))
      if (s.cs[b] & CS_MASK) return false;
  if (endBaddr > baddr) {
    copyCells(s, baddr + ndel, baddr, endBaddr - (baddr + ndel) + 1);
  } else if (endBaddr !== baddr) {
    copyCells(s, baddr + ndel, baddr, size - 1 - (baddr + ndel) + 1);
    copyCells(s, 0, size - ndel, ndel);
    copyCells(s, ndel, 0, endBaddr - ndel + 1);
  }
  for (let i = 0; i < ndel; i++) add(s, endBaddr - i, EBC_NULL, 0);
  mdtSet(s, s.cursor);
  return true;
}

/** Delete_action @type {Action} */
export function deleteKey(s) {
  if (s.kybdlock) {
    enqTa(s, deleteKey);
    return true;
  }
  if (!doDelete(s)) return true;
  if (s.options.reverseInputMode) {
    const baddr = dec(s, s.cursor);
    if (!s.fa[baddr]) cursorMove(s, baddr);
  }
  return true;
}

/** BackSpace_action @type {Action} */
export function backSpace(s) {
  if (s.kybdlock) {
    enqTa(s, backSpace);
    return true;
  }
  if (s.options.reverseInputMode) doDelete(s);
  else if (!s.flipped) doLeft(s);
  else cursorMove(s, dec(s, s.cursor));
  return true;
}

/** do_erase() @param {State} s */
function doErase(s) {
  let baddr = s.cursor;
  const faddr = findFieldAttribute(s, baddr);
  if (faddr === baddr || isProtected(s.fa[baddr]))
    operatorError(s, KL_OERR_PROTECTED, true);
  if (baddr && faddr === baddr - 1) return;
  doLeft(s);
  if (s.ec[s.cursor] === EBC_SI) cursorMove(s, dec(s, s.cursor));
  if (!doDelete(s)) return;
  // Erasing the last character of a subfield takes its SO/SI pair along.
  baddr = dec(s, s.cursor);
  if (s.ec[baddr] === EBC_SO && s.ec[s.cursor] === EBC_SI) {
    cursorMove(s, baddr);
    doDelete(s);
  }
}

/** Erase_action @type {Action} */
export function erase(s) {
  if (s.kybdlock) {
    enqTa(s, erase);
    return true;
  }
  if (s.options.reverseInputMode) doDelete(s);
  else doErase(s);
  return true;
}

/** @param {number} c */
const isBlank = (c) => c === EBC_SPACE || c === EBC_NULL;

/** PreviousWord_action @type {Action} */
export function previousWord(s) {
  if (s.kybdlock) {
    enqTa(s, previousWord);
    return true;
  }
  if (!s.formatted) return false;
  let baddr = s.cursor;
  let prot = isProtected(fieldAttribute(s, baddr));
  // Skip to before this word, if in one now.
  if (!prot) {
    while (!s.fa[baddr] && !isBlank(s.ec[baddr])) {
      baddr = dec(s, baddr);
      if (baddr === s.cursor) return true;
    }
  }
  // Find the end of the previous word.
  const baddr0 = baddr;
  do {
    if (s.fa[baddr]) {
      baddr = dec(s, baddr);
      prot = isProtected(fieldAttribute(s, baddr));
      continue;
    }
    if (!prot && !isBlank(s.ec[baddr])) break;
    baddr = dec(s, baddr);
  } while (baddr !== baddr0);
  if (baddr === baddr0) return true;
  // Go to its start.
  for (;;) {
    baddr = dec(s, baddr);
    if (s.fa[baddr] || isBlank(s.ec[baddr])) break;
  }
  cursorMove(s, inc(s, baddr));
  return true;
}

/** nu_word(): the next unprotected word, or -1. @param {State} s @param {number} baddr */
function nuWord(s, baddr) {
  const baddr0 = baddr;
  let prot = isProtected(fieldAttribute(s, baddr));
  do {
    if (s.fa[baddr]) prot = isProtected(s.fa[baddr]);
    else if (!prot && !isBlank(s.ec[baddr])) return baddr;
    baddr = inc(s, baddr);
  } while (baddr !== baddr0);
  return -1;
}

/** nt_word(): the next word in this field, or -1. @param {State} s @param {number} baddr */
function ntWord(s, baddr) {
  const baddr0 = baddr;
  let inWord = true;
  do {
    if (s.fa[baddr]) return -1;
    if (inWord) {
      if (isBlank(s.ec[baddr])) inWord = false;
    } else if (!isBlank(s.ec[baddr])) {
      return baddr;
    }
    baddr = inc(s, baddr);
  } while (baddr !== baddr0);
  return -1;
}

/** NextWord_action @type {Action} */
export function nextWord(s) {
  if (s.kybdlock) {
    enqTa(s, nextWord);
    return true;
  }
  if (!s.formatted) return false;
  if (s.fa[s.cursor] || isProtected(fieldAttribute(s, s.cursor))) {
    const baddr = nuWord(s, s.cursor);
    if (baddr !== -1) cursorMove(s, baddr);
    return true;
  }
  let baddr = ntWord(s, s.cursor);
  if (baddr !== -1) {
    cursorMove(s, baddr);
    return true;
  }
  // No next word in this field: go to the end of this word, or on to the next field.
  if (!isBlank(s.ec[s.cursor])) {
    baddr = s.cursor;
    do {
      if (isBlank(s.ec[baddr])) {
        cursorMove(s, baddr);
        return true;
      }
      if (s.fa[baddr]) {
        baddr = nuWord(s, baddr);
        if (baddr !== -1) cursorMove(s, baddr);
        return true;
      }
      baddr = inc(s, baddr);
    } while (baddr !== s.cursor);
  } else {
    baddr = nuWord(s, s.cursor);
    if (baddr !== -1) cursorMove(s, baddr);
  }
  return true;
}

/** Newline_action @type {Action} */
export function newline(s) {
  if (s.kybdlock) {
    enqTa(s, newline);
    return true;
  }
  let baddr = (s.cursor + s.cols) % (s.cols * s.rows);
  baddr = ((baddr / s.cols) | 0) * s.cols;
  const faddr = findFieldAttribute(s, baddr);
  if (faddr !== baddr && !isProtected(faAt(s, faddr))) cursorMove(s, baddr);
  else cursorMove(s, nextUnprotected(s, baddr));
  return true;
}

/** Dup_action @type {Action} */
export function dup(s, oerrFail = false) {
  if (s.kybdlock) {
    enqTa(s, dup, oerrFail);
    return true;
  }
  const r = keyCharacter(s, EBC_DUP, false, false, oerrFail);
  if (!r.ok) return false;
  if (r.consumed) cursorMove(s, nextUnprotected(s, s.cursor));
  return true;
}

/** FieldMark_action @type {Action} */
export function fieldMark(s, oerrFail = false) {
  if (s.kybdlock) {
    enqTa(s, fieldMark, oerrFail);
    return true;
  }
  return keyCharacter(s, EBC_FM, false, false, oerrFail).ok;
}

/** lightpen_select() @param {State} s @param {number} baddr */
function lightpenSelect(s, baddr) {
  const faddr = findFieldAttribute(s, baddr);
  const fa = faAt(s, faddr);
  // FA_IS_SELECTABLE: protected-and-intensified or unprotected-and-intensified, i.e. intensity bits 01 or 10.
  const intensity = fa & 0x0c;
  if (intensity !== 0x04 && intensity !== 0x08) {
    s.emit({ type: "alarm" });
    return;
  }
  const designator = inc(s, faddr);
  switch (s.ec[designator]) {
    case EBC_GREATER:
      add(s, designator, EBC_QUESTION, 0);
      mdtClear(s, faddr);
      break;
    case EBC_QUESTION:
      add(s, designator, EBC_GREATER, 0);
      mdtSet(s, faddr);
      break;
    case EBC_SPACE:
    case EBC_NULL:
      mdtSet(s, faddr);
      keyAid(s, AID_SELECT);
      break;
    case EBC_AMPERSAND:
      mdtSet(s, faddr);
      keyAid(s, AID_ENTER);
      break;
    default:
      s.emit({ type: "alarm" });
  }
}

/** CursorSelect_action @type {Action} */
export function cursorSelect(s) {
  if (s.kybdlock) {
    enqTa(s, cursorSelect);
    return true;
  }
  lightpenSelect(s, s.cursor);
  return true;
}

/** EraseEOF_action @type {Action} */
export function eraseEOF(s) {
  if (!oerrClearOrEnq(s, eraseEOF)) return true;
  let baddr = s.cursor;
  const fa = fieldAttribute(s, baddr);
  if (isProtected(fa) || s.fa[baddr])
    return operatorError(s, KL_OERR_PROTECTED, true);
  const cs = (/** @type {number} */ b) => (mutableCs(s) ? 0 : s.cs[b]);
  if (hasFields(s)) {
    do {
      add(s, baddr, EBC_NULL, cs(baddr));
      baddr = inc(s, baddr);
    } while (!s.fa[baddr]);
    mdtSet(s, s.cursor);
  } else {
    do {
      add(s, baddr, EBC_NULL, cs(baddr));
      baddr = inc(s, baddr);
    } while (baddr !== 0);
  }
  return true;
}

/** EraseInput_action @type {Action} */
export function eraseInput(s) {
  if (!oerrClearOrEnq(s, eraseInput)) return true;
  if (!hasFields(s)) {
    clear(s);
    cursorMove(s, 0);
    return true;
  }
  let baddr = 0;
  do {
    if (s.fa[baddr]) break;
    baddr = inc(s, baddr);
  } while (baddr !== 0);
  const sbaddr = baddr;
  let found = false;
  do {
    if (!isProtected(s.fa[baddr])) {
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
      do baddr = inc(s, baddr);
      while (!s.fa[baddr]);
    }
  } while (baddr !== sbaddr);
  if (!found) cursorMove(s, 0);
  return true;
}

/** DeleteWord_action @type {Action} */
export function deleteWord(s) {
  if (!oerrClearOrEnq(s, deleteWord)) return true;
  if (!s.formatted) return false;
  const fa = fieldAttribute(s, s.cursor);
  if (isProtected(fa) || s.fa[s.cursor])
    return operatorError(s, KL_OERR_PROTECTED, true);
  // Backspace over blanks, then over the word. A screen without field attributes (see
  // hasFields) that is all blanks has no end to stop at, hence the bound.
  const size = s.rows * s.cols;
  for (let n = 0; n < size; n++) {
    const baddr = dec(s, s.cursor);
    if (s.fa[baddr]) return true;
    if (!isBlank(s.ec[baddr])) break;
    doErase(s);
  }
  for (let n = 0; n < size; n++) {
    const baddr = dec(s, s.cursor);
    if (s.fa[baddr]) return true;
    if (isBlank(s.ec[baddr])) break;
    doErase(s);
  }
  return true;
}

/** DeleteField_action @type {Action} */
export function deleteField(s) {
  if (!oerrClearOrEnq(s, deleteField)) return true;
  if (!hasFields(s)) return false;
  let baddr = s.cursor;
  const fa = fieldAttribute(s, baddr);
  if (isProtected(fa) || s.fa[baddr])
    return operatorError(s, KL_OERR_PROTECTED, true);
  while (!s.fa[baddr]) baddr = dec(s, baddr);
  baddr = inc(s, baddr);
  mdtSet(s, s.cursor);
  cursorMove(s, baddr);
  while (!s.fa[baddr]) {
    add(s, baddr, EBC_NULL, 0);
    baddr = inc(s, baddr);
  }
  return true;
}

/** FieldEnd_action @type {Action} */
export function fieldEnd(s) {
  if (!oerrClearOrEnq(s, fieldEnd)) return true;
  if (!hasFields(s)) return false;
  let baddr = s.cursor;
  const faddr = findFieldAttribute(s, baddr);
  const fa = faAt(s, faddr);
  if (faddr === baddr || isProtected(fa)) return true;
  let lastNonblank = -1;
  baddr = faddr;
  for (;;) {
    baddr = inc(s, baddr);
    if (s.fa[baddr]) break;
    if (!isBlank(s.ec[baddr])) lastNonblank = baddr;
  }
  if (lastNonblank === -1) {
    baddr = inc(s, faddr);
  } else {
    baddr = inc(s, lastNonblank);
    if (s.fa[baddr]) baddr = lastNonblank;
  }
  cursorMove(s, baddr);
  return true;
}

/**
 * MoveCursor_common(): moveCursor(s, offset) or moveCursor(s, row, col, origin), origin 0 or 1.
 * Negative rows and columns count from the end.
 * @type {Action}
 */
export function moveCursor(
  s,
  /** @type {number} */ a,
  /** @type {number=} */ col,
  origin = 0,
) {
  const name = origin ? "MoveCursor1" : "MoveCursor";
  if (s.kybdlock) {
    enqTa(s, moveCursor, a, col, origin);
    return true;
  }
  let baddr;
  if (col === undefined) {
    baddr = a;
    if (baddr < 0 || baddr >= s.rows * s.cols) {
      s.log.warn(`N3003 MoveCursor(): invalid offset ${baddr}`);
      popupError(s, `${name}(): Invalid offset`);
      return false;
    }
  } else {
    let row = a;
    let column = col;
    if (row < 0) {
      if (-row > s.rows) {
        s.log.warn(`N3009 MoveCursor(): invalid row ${row}`);
        popupError(s, `${name}(): Invalid row`);
        return false;
      }
      row += s.rows + origin;
    } else if (row < origin) {
      row = origin;
    } else if (row > s.rows - (origin ? 0 : 1)) {
      s.log.warn(`N3017 MoveCursor(): row past the bottom ${row}`);
      popupError(s, `${name}(): Invalid row`);
      return false;
    }
    if (column < 0) {
      if (-column > s.cols) {
        s.log.warn(`N3010 MoveCursor(): invalid column ${column}`);
        popupError(s, `${name}(): Invalid column`);
        return false;
      }
      column += s.cols + origin;
    } else if (column < origin) {
      column = origin;
    } else if (column > s.cols - (origin ? 0 : 1)) {
      s.log.warn(`N3018 MoveCursor(): column past the right edge ${column}`);
      popupError(s, `${name}(): Invalid column`);
      return false;
    }
    baddr = ((row - origin) * s.cols + (column - origin)) % (s.rows * s.cols);
  }
  if (baddr < 0) baddr = 0;
  else if (baddr >= s.rows * s.cols) baddr = s.rows * s.cols - 1;
  cursorMove(s, baddr);
  return true;
}

/**
 * hex_input(): HexString()'s bytes, typed as EBCDIC.
 * HexString() has checked that the text is pairs of hex digits.
 * @param {State} s @param {string} hex
 */
export function hexInput(s, hex) {
  if (!in3270(s)) return;
  for (const c of Buffer.from(hex, "hex"))
    keyCharacter(s, c, false, true, true);
}

/**
 * emulate_uinput(): types a string the way x3270's String() and paste do.
 * Returns how many characters were left unprocessed (after an AID, or a locked keyboard).
 * @param {State} s @param {string} text @param {boolean} pasting
 */
export function emulateInput(s, text, pasting, margin = true) {
  const ws = Array.from(text, (c) => /** @type {number} */ (c.codePointAt(0)));
  let xlen = ws.length;
  let i = 0;
  let state = "base";
  let literal = 0;
  let nc = 0;
  const origAddr = s.cursor;
  const origCol = s.cursor % s.cols;
  // x3270's margined paste; b3270 has no marginedPaste toggle, so overlayPaste alone turns it on.
  const offMargin = () =>
    pasting &&
    margin &&
    in3270(s) &&
    !inSscp(s) &&
    s.options.overlayPaste &&
    s.cursor % s.cols < origCol;
  let lastAddr = s.cursor;
  let lastRow = (s.cursor / s.cols) | 0;
  let justWrapped = false;
  const autoSkip = !(pasting && s.options.overlayPaste);
  const key = (/** @type {number} */ u) =>
    keyUnicode(s, u, { pasting, oerrFail: true });
  // Wider codes go to key_WCharacter, which ignores them without a DBCS code page.
  const ebcdic = (/** @type {number} */ e) =>
    e <= 0xff && keyCharacter(s, e, false, true, true);
  const hex = (/** @type {number} */ c) =>
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x46) ||
    (c >= 0x61 && c <= 0x66);
  const digit = (/** @type {number} */ c) => c >= 0x30 && c <= 0x39;
  const fromHex = (/** @type {number} */ c) =>
    parseInt(String.fromCharCode(c), 16);

  while (xlen) {
    // It isn't possible to unlock the keyboard from a string.
    if (s.kybdlock) return 0;
    if (pasting && in3270(s) && s.cursor < origAddr) return xlen - 1;
    if (offMargin()) cursorMove(s, s.cursor - (s.cursor % s.cols) + origCol);
    if (lastAddr !== s.cursor) {
      lastAddr = s.cursor;
      const row = (s.cursor / s.cols) | 0;
      justWrapped = row !== lastRow;
      lastRow = row;
    }
    const c = ws[i];
    let rescan = false;
    switch (state) {
      case "base":
        switch (c) {
          case 0x08:
            left(s);
            break;
          case 0x0c:
            if (pasting) {
              key(0x20);
            } else {
              clearKey(s);
              if (in3270(s)) return xlen - 1;
            }
            break;
          case 0x0a:
            if (pasting) {
              if (autoSkip) {
                if (!justWrapped) newline(s);
              } else {
                // Overlay paste: on to the next row, unless we just wrapped there.
                if (xlen === 1) return 0;
                if (!justWrapped) {
                  const row = (s.cursor / s.cols) | 0;
                  if (row >= s.rows - 1) return xlen - 1;
                  cursorMove(s, (row + 1) * s.cols);
                }
              }
              lastRow = (s.cursor / s.cols) | 0;
              justWrapped = false;
            } else {
              enter(s);
              if (in3270(s)) return xlen - 1;
            }
            break;
          case 0x0d:
            if (!pasting) newline(s);
            break;
          case 0x09:
            tab(s);
            break;
          case 0x5c:
            if (!pasting) state = "backslash";
            else key(c);
            break;
          default:
            key(c);
        }
        break;
      case "backslash":
        state = "base";
        switch (c) {
          case 0x62: // b
            left(s);
            break;
          case 0x66: // f
            clearKey(s);
            if (in3270(s)) return xlen - 1;
            break;
          case 0x6e: // n
            enter(s);
            if (in3270(s)) return xlen - 1;
            break;
          case 0x70: // p
            state = "backp";
            break;
          case 0x72: // r
            newline(s);
            break;
          case 0x74: // t
            tab(s);
            break;
          case 0x54: // T
            backTab(s);
            break;
          case 0x75: // u
          case 0x78: // x
            state = "backx";
            break;
          case 0x65: // e
            state = "backe";
            break;
          case 0x5c:
            key(c);
            break;
          case 0x61: // a
          case 0x76: // v
            s.log.warn(
              `N3004 String(): \\${String.fromCharCode(c)} not supported`,
            );
            popupError(
              s,
              c === 0x61
                ? "String(): Bell not supported"
                : "String(): Vertical tab not supported",
            );
            break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              state = "octal";
              literal = 0;
              nc = 0;
            }
            rescan = true;
        }
        break;
      case "backp":
        literal = 0;
        nc = 0;
        if (c === 0x61) state = "backpa";
        else if (c === 0x66) state = "backpf";
        else {
          s.log.warn("N3005 String(): unknown character after \\p");
          popupError(s, "String(): Unknown character after \\p");
          state = "base";
        }
        break;
      case "backpf":
      case "backpa": {
        const max = state === "backpf" ? 2 : 1;
        if (nc < max && digit(c)) {
          literal = literal * 10 + (c - 0x30);
          nc++;
        } else if (!nc) {
          s.log.warn(
            `N3006 String(): unknown character after \\${state === "backpf" ? "pf" : "pa"}`,
          );
          popupError(
            s,
            `String(): Unknown character after \\${state === "backpf" ? "pf" : "pa"}`,
          );
          state = "base";
        } else {
          if (state === "backpf") {
            pf(s, literal);
            if (in3270(s)) return xlen;
          } else {
            pa(s, literal);
            if (in3270(s)) return xlen - 1;
          }
          state = "base";
          rescan = true;
        }
        break;
      }
      case "backx":
      case "backe":
        if (!hex(c)) {
          s.log.warn(
            `N3007 String(): missing hex digits after \\${state === "backx" ? "x" : "e"}`,
          );
          popupError(
            s,
            `String(): Missing hex digits after \\${state === "backx" ? "x" : "e"}`,
          );
        }
        state = !hex(c) ? "base" : state === "backx" ? "hex" : "ebc";
        literal = 0;
        nc = 0;
        rescan = true;
        break;
      case "octal":
        if (nc < 3 && c >= 0x30 && c <= 0x37) {
          literal = literal * 8 + (c - 0x30);
          nc++;
        } else {
          key(literal & 0xff);
          state = "base";
          rescan = true;
        }
        break;
      case "hex":
      case "ebc":
        if (nc < 4 && hex(c)) {
          literal = literal * 16 + fromHex(c);
          nc++;
        } else {
          if (state === "hex") key(literal);
          else ebcdic(literal);
          state = "base";
          rescan = true;
        }
        break;
    }
    if (rescan) continue;
    i++;
    xlen--;
  }
  switch (state) {
    case "base":
      break;
    case "octal":
      key(literal & 0xff);
      break;
    case "hex":
      key(literal);
      break;
    case "ebc":
      ebcdic(literal);
      break;
    case "backpf":
      if (nc > 0) pf(s, literal);
      break;
    case "backpa":
      if (nc > 0) pa(s, literal);
      break;
    default:
      s.log.warn("N3008 String(): missing data after \\");
      popupError(s, "String(): Missing data after \\");
      return xlen;
  }
  if (offMargin()) cursorMove(s, s.cursor - (s.cursor % s.cols) + origCol);
  return xlen;
}
