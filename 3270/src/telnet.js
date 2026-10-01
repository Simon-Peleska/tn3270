import {
  PDS_BAD_ADDR,
  PDS_OKAY_NO_OUTPUT,
  erase,
  processDs,
  psProcess,
  writeSscpLu,
} from "./ctlr.js";
import { KL_AWAITING_FIRST, KL_BID } from "./kybd.js";
import {
  popupError,
  reportTerminalName,
  statsPoke,
  statusLu,
  statusReset,
} from "./ui.js";
import { linemodeBufInit, linemodeDump, linemodeOut } from "./linemode.js";
import { nvtProcess } from "./nvt.js";
import {
  CONNECTED_3270,
  CONNECTED_E_NVT,
  CONNECTED_NVT,
  CONNECTED_NVT_CHAR,
  CONNECTED_SSCP,
  CONNECTED_TN3270E,
  CONNECTED_UNBOUND,
  NOT_CONNECTED,
  TCP_PENDING,
  TELNET_PENDING,
  changeCstate,
  inE,
  inNvt,
  in3270,
} from "./session.js";

// Port of x3270's Common/telnet.c (the protocol half; sockets live in session.js).

const IAC = 0xff,
  DONT = 0xfe,
  DO = 0xfd,
  WONT = 0xfc,
  WILL = 0xfb,
  SB = 0xfa,
  AO = 0xf5;
const NOP = 0xf1;
const IP = 0xf4,
  BREAK = 0xf3,
  DM = 0xf2,
  SE = 0xf0,
  EOR = 0xef;

const TELOPT_BINARY = 0,
  TELOPT_ECHO = 1,
  TELOPT_SGA = 3,
  TELOPT_TM = 6,
  TELOPT_TTYPE = 24,
  TELOPT_EOR = 25;
const TELOPT_NAWS = 31,
  TELOPT_NEW_ENVIRON = 39,
  TELOPT_TN3270E = 40;
const TELQUAL_IS = 0,
  TELQUAL_SEND = 1;
const TELOBJ_VAR = 0,
  TELOBJ_VALUE = 1,
  TELOBJ_ESC = 2,
  TELOBJ_USERVAR = 3;

const TN3270E_OP_CONNECT = 1,
  TN3270E_OP_DEVICE_TYPE = 2,
  TN3270E_OP_FUNCTIONS = 3,
  TN3270E_OP_IS = 4;
const TN3270E_OP_REJECT = 6,
  TN3270E_OP_REQUEST = 7,
  TN3270E_OP_SEND = 8;
const TN3270E_REASON_UNSUPPORTED_REQ = 7;
const TN3270E_FUNC_BIND_IMAGE = 0,
  TN3270E_FUNC_RESPONSES = 2,
  TN3270E_FUNC_SYSREQ = 4;
const TN3270E_FUNC_CONTENTION_RESOLUTION = 5;
const TN3270E_DT_3270_DATA = 0x00,
  TN3270E_DT_RESPONSE = 0x02,
  TN3270E_DT_BIND_IMAGE = 0x03,
  TN3270E_DT_UNBIND = 0x04;
const TN3270E_DT_NVT_DATA = 0x05,
  TN3270E_DT_SSCP_LU_DATA = 0x07,
  TN3270E_DT_BID = 0x09;
const TN3270E_RQF_SEND_DATA = 0x01,
  TN3270E_RQF_KEYBOARD_RESTORE = 0x02;
const TN3270E_RSF_NO_RESPONSE = 0x00,
  TN3270E_RSF_ALWAYS_RESPONSE = 0x02;
const TN3270E_RSF_POSITIVE_RESPONSE = 0x00,
  TN3270E_RSF_NEGATIVE_RESPONSE = 0x01;
const TN3270E_NEG_COMMAND_REJECT = 0x00,
  TN3270E_NEG_OPERATION_CHECK = 0x02;
const EH_SIZE = 5;

export const E_UNBOUND = 0,
  E_3270 = 1,
  E_NVT = 2,
  E_SSCP = 3;

const TNS_DATA = 0,
  TNS_IAC = 1,
  TNS_WILL = 2,
  TNS_WONT = 3,
  TNS_DO = 4,
  TNS_DONT = 5,
  TNS_SB = 6,
  TNS_SB_IAC = 7;

const BIND_RU = 0x31,
  BIND_OFF_MAXRU_SEC = 10,
  BIND_OFF_MAXRU_PRI = 11,
  BIND_OFF_RD = 20,
  BIND_OFF_CD = 21;
const BIND_OFF_RA = 22,
  BIND_OFF_CA = 23,
  BIND_OFF_SSIZE = 24,
  BIND_OFF_PLU_NAME_LEN = 27,
  BIND_PLU_NAME_MAX = 8;
const BIND_OFF_PLU_NAME = 28;
const MODEL_2_ROWS = 24,
  MODEL_2_COLS = 80;

/** @typedef {import("./session.js").State} State */

/** @param {State} s @param {number[] | Uint8Array} bytes */
function rawout(s, bytes) {
  s.write(Uint8Array.from(bytes));
}

/** tn3270e_init() @param {State} s */
function tn3270eInit(s) {
  s.eFuncs.fill(0);
  s.eFuncs[TN3270E_FUNC_BIND_IMAGE] = 1;
  s.eFuncs[TN3270E_FUNC_RESPONSES] = 1;
  s.eFuncs[TN3270E_FUNC_SYSREQ] = 1;
  if (s.options.contentionResolution)
    s.eFuncs[TN3270E_FUNC_CONTENTION_RESOLUTION] = 1;
  s.eXmitSeq = 0;
  s.responseRequired = TN3270E_RSF_NO_RESPONSE;
  s.tn3270eNegotiated = false;
  s.tn3270eSubmode = E_UNBOUND;
  s.tn3270eBound = false;
}

/** net_connected_complete(): the socket is up, start TELNET. @param {State} s */
export function netConnected(s) {
  s.connectTime = Date.now();
  s.stats = { brcvd: 0, rrcvd: 0, bsent: 0, rsent: 0 };
  changeCstate(s, TELNET_PENDING);
  s.myopts.fill(0);
  s.hisopts.fill(0);
  s.didNeSend = false;
  s.deferredWillTtype = false;
  tn3270eInit(s);
  s.telnetState = TNS_DATA;
  s.ibLen = 0;
  s.syncing = false;
  setupLus(s);
  checkLinemode(s, true);
  netNopSeconds(s);
}

/** net_disconnect(), protocol side. @param {State} s */
export function netDisconnected(s) {
  s.pluName = "";
  statusLu(s, null);
  changeCstate(s, NOT_CONNECTED);
  netNopSeconds(s);
  s.hostPrefixes = "";
  netSetDefaultTermtype(s);
}

/** net_set_default_termtype(): the termName setting, or the 3270 name, where the S: prefix drops the -E. @param {State} s */
export function netSetDefaultTermtype(s) {
  const previous = s.termtype;
  s.termtype = s.options.termName ?? create3270Termtype(s, false);
  if (s.termtype !== previous) reportTerminalName(s);
}

/**
 * net_nop_seconds(): (re)starts the TELNET NOP keepalive, which keeps a firewall from
 * dropping a quiet connection. Sent on a fixed beat, traffic or not, as x3270 does.
 * @param {State} s
 */
export function netNopSeconds(s) {
  if (s.nopTimer !== null) clearInterval(s.nopTimer);
  s.nopTimer = null;
  if (s.options.nopSeconds <= 0 || s.cstate < TCP_PENDING) return;
  s.nopTimer = setInterval(() => {
    if (s.cstate < TELNET_PENDING) return;
    s.write(Uint8Array.of(IAC, NOP));
    s.log.debug("SENT NOP");
  }, s.options.nopSeconds * 1000);
  s.nopTimer.unref();
}

/** setup_lus() @param {State} s */
function setupLus(s) {
  s.connectedLu = null;
  s.connectedType = null;
  s.lus = s.luName ? s.luName.split(",") : null;
  s.luIndex = 0;
  s.tryLu = s.lus ? s.lus[0] : null;
}

/** next_lu() @param {State} s */
function nextLu(s) {
  if (s.lus === null || s.luIndex < 0) return;
  s.luIndex++;
  s.tryLu = s.lus[s.luIndex] ?? null;
  if (s.tryLu === null) s.luIndex = -1;
}

/** create_3270_termtype() @param {State} s @param {boolean} force3278 */
export function create3270Termtype(s, force3278) {
  if (s.oversized) return "IBM-DYNAMIC";
  const color =
    !force3278 && s.mode3279 && (s.options.wrongTerminalName || s.model < 4);
  return `IBM-327${color ? "9" : "8"}-${s.model}${s.options.extendedDataStream && !s.hostPrefixes.includes("S") ? "-E" : ""}`;
}

/** @param {string} text */
function ascii(text) {
  return Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

/** net_hexnvt_out_framed(..., true): quotes IAC and bare CR, but not the framing IAC SB / IAC SE. @param {State} s @param {number[]} buf */
function framedOut(s, buf) {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    out.push(c);
    if (i === 0 || i === buf.length - 2) continue;
    if (c === IAC) out.push(IAC);
    else if (c === 0x0d && (i === buf.length - 1 || buf[i + 1] !== 0x0a))
      out.push(0);
  }
  rawout(s, out);
}

/**
 * net_input() + telnet_fsm(): everything the host sent. Returns false when the
 * session must be dropped. @param {State} s @param {Uint8Array} buf
 */
export function netInput(s, buf) {
  let i = 0;
  while (i < buf.length) {
    if (
      s.telnetState === TNS_DATA &&
      s.cstate !== TELNET_PENDING &&
      !(inNvt(s) && !inE(s))
    ) {
      // Bulk path for 3270 data: copy up to the next IAC in one go.
      let end = buf.indexOf(IAC, i);
      if (end < 0) end = buf.length;
      store3270in(s, buf.subarray(i, end));
      i = end;
      if (i === buf.length) break;
    }
    if (!telnetFsm(s, buf[i++])) return false;
  }
  return true;
}

/** @param {State} s @param {Uint8Array} bytes */
function store3270in(s, bytes) {
  const need = s.ibLen + bytes.length;
  if (need > s.ibuf.length) {
    const grown = new Uint8Array(Math.max(need, s.ibuf.length * 2));
    grown.set(s.ibuf.subarray(0, s.ibLen));
    s.ibuf = grown;
  }
  s.ibuf.set(bytes, s.ibLen);
  s.ibLen = need;
}

const ONE = new Uint8Array(1);

/** @param {State} s @param {number} c */
function telnetFsm(s, c) {
  switch (s.telnetState) {
    case TNS_DATA:
      if (c === IAC) {
        s.telnetState = TNS_IAC;
        break;
      }
      if (s.cstate === TELNET_PENDING) {
        if (s.linemode) linemodeBufInit(s);
        changeCstate(s, s.linemode ? CONNECTED_NVT : CONNECTED_NVT_CHAR);
        s.kybdlock &= ~KL_AWAITING_FIRST;
        statusReset(s);
        psProcess(s);
      }
      if (inNvt(s) && !inE(s)) {
        if (!s.syncing) nvtProcess(s, c);
      } else {
        ONE[0] = c;
        store3270in(s, ONE);
      }
      break;
    case TNS_IAC:
      switch (c) {
        case IAC:
          if (inNvt(s) && !inE(s)) {
            nvtProcess(s, c);
          } else {
            ONE[0] = c;
            store3270in(s, ONE);
          }
          s.telnetState = TNS_DATA;
          break;
        case EOR:
          if (in3270(s) || (inE(s) && s.tn3270eNegotiated)) {
            s.stats.rrcvd++;
            statsPoke(s);
            processEor(s);
          } else {
            s.log.warn("N2201 EOR received when not in 3270 mode, ignored");
            popupError(s, "EOR received when not in 3270 mode, ignored");
          }
          s.ibLen = 0;
          s.telnetState = TNS_DATA;
          break;
        case WILL:
          s.telnetState = TNS_WILL;
          break;
        case WONT:
          s.telnetState = TNS_WONT;
          break;
        case DO:
          s.telnetState = TNS_DO;
          break;
        case DONT:
          s.telnetState = TNS_DONT;
          break;
        case SB:
          s.telnetState = TNS_SB;
          s.sbLen = 0;
          break;
        case DM:
          s.syncing = false;
          s.telnetState = TNS_DATA;
          break;
        default:
          s.telnetState = TNS_DATA;
      }
      break;
    case TNS_WILL:
      switch (c) {
        case TELOPT_SGA:
        case TELOPT_BINARY:
        case TELOPT_EOR:
        case TELOPT_TTYPE:
        case TELOPT_ECHO:
        case TELOPT_TN3270E:
          if (c === TELOPT_TN3270E && s.hostPrefixes.includes("N")) break;
          if (!s.hisopts[c]) {
            s.hisopts[c] = 1;
            rawout(s, [IAC, DO, c]);
            if (c === TELOPT_EOR && !s.myopts[c]) {
              s.myopts[c] = 1;
              rawout(s, [IAC, WILL, c]);
            }
            checkIn3270(s);
            checkLinemode(s, false);
          }
          break;
        default:
          rawout(s, [IAC, DONT, c]);
      }
      s.telnetState = TNS_DATA;
      break;
    case TNS_WONT:
      if (s.hisopts[c]) {
        s.hisopts[c] = 0;
        rawout(s, [IAC, DONT, c]);
        checkIn3270(s);
        checkLinemode(s, false);
      } else if (c === TELOPT_TN3270E && s.myopts[c]) {
        s.myopts[c] = 0;
        rawout(s, [IAC, WONT, c]);
        checkIn3270(s);
        checkLinemode(s, false);
      }
      s.telnetState = TNS_DATA;
      break;
    case TNS_DO:
      doOption(s, c);
      s.telnetState = TNS_DATA;
      break;
    case TNS_DONT:
      if (s.myopts[c]) {
        s.myopts[c] = 0;
        rawout(s, [IAC, WONT, c]);
        checkIn3270(s);
        checkLinemode(s, false);
      }
      if (c === TELOPT_TTYPE && s.deferredWillTtype)
        s.deferredWillTtype = false;
      s.telnetState = TNS_DATA;
      break;
    case TNS_SB:
      if (c === IAC) s.telnetState = TNS_SB_IAC;
      else storeSb(s, c);
      break;
    case TNS_SB_IAC:
      storeSb(s, c);
      if (c !== SE) {
        s.telnetState = TNS_SB;
        break;
      }
      s.telnetState = TNS_DATA;
      return subnegotiation(s);
  }
  return true;
}

/** @param {State} s @param {number} c */
function storeSb(s, c) {
  if (s.sbLen === s.sbbuf.length) {
    const grown = new Uint8Array(s.sbbuf.length * 2);
    grown.set(s.sbbuf);
    s.sbbuf = grown;
  }
  s.sbbuf[s.sbLen++] = c;
}

/** The TNS_DO state. @param {State} s @param {number} c */
function doOption(s, c) {
  switch (c) {
    case TELOPT_BINARY:
    case TELOPT_EOR:
    case TELOPT_TTYPE:
    case TELOPT_SGA:
    case TELOPT_NAWS:
    case TELOPT_TM:
    case TELOPT_TN3270E:
    case TELOPT_NEW_ENVIRON:
      if (c === TELOPT_TN3270E && s.hostPrefixes.includes("N")) break;
      if (c === TELOPT_TM && !s.options.bsdTm) break;
      if (c === TELOPT_NEW_ENVIRON && !s.options.newEnviron) break;
      if (c === TELOPT_TTYPE && s.myopts[TELOPT_NEW_ENVIRON] && !s.didNeSend) {
        // Answer DO TTYPE only after NEW-ENVIRON, so the host gets the user first.
        s.myopts[c] = 1;
        s.deferredWillTtype = true;
        return;
      }
      if (!s.myopts[c]) {
        if (c !== TELOPT_TM) s.myopts[c] = 1;
        rawout(s, [IAC, WILL, c]);
        checkIn3270(s);
        checkLinemode(s, false);
      }
      if (c === TELOPT_NAWS) sendNaws(s);
      return;
  }
  // STARTTLS lands here too: TLS is chosen up front with the tls option, like a secure x3270 connection.
  rawout(s, [IAC, WONT, c]);
}

/** @param {number[]} out @param {number} v */
function set16(out, v) {
  out.push((v >> 8) & 0xff);
  if (((v >> 8) & 0xff) === IAC) out.push(IAC);
  out.push(v & 0xff);
  if ((v & 0xff) === IAC) out.push(IAC);
}

/** send_naws() @param {State} s */
function sendNaws(s) {
  const out = [IAC, SB, TELOPT_NAWS];
  set16(out, s.maxCols);
  set16(out, s.maxRows);
  out.push(IAC, SE);
  rawout(s, out);
}

/** IAC SB ... IAC SE has arrived. @param {State} s */
function subnegotiation(s) {
  const sb = s.sbbuf;
  if (sb[0] === TELOPT_TTYPE && sb[1] === TELQUAL_SEND) {
    if (s.lus !== null && s.tryLu === null) {
      s.log.warn("N1201 cannot connect to any of the specified LUs");
      s.connectError = "N1201 Cannot connect to specified LU";
      return false;
    }
    const lu = s.tryLu ? `@${s.tryLu}` : "";
    s.connectedLu = s.tryLu || null;
    statusLu(s, s.connectedLu);
    framedOut(s, [
      IAC,
      SB,
      TELOPT_TTYPE,
      TELQUAL_IS,
      ...ascii(s.termtype + lu),
      IAC,
      SE,
    ]);
    nextLu(s);
    return true;
  }
  if (s.myopts[TELOPT_TN3270E] && sb[0] === TELOPT_TN3270E) {
    tn3270eNegotiate(s);
    return true;
  }
  if (
    sb[0] === TELOPT_NEW_ENVIRON &&
    sb[1] === TELQUAL_SEND &&
    s.options.newEnviron
  ) {
    const reply = newEnviron(s, sb.subarray(2, s.sbLen - 1));
    if (reply === null)
      s.log.warn("N2202 invalid NEW-ENVIRON SEND request, ignored");
    else rawout(s, reply);
    s.didNeSend = true;
    if (s.deferredWillTtype && s.myopts[TELOPT_TTYPE]) {
      rawout(s, [IAC, WILL, TELOPT_TTYPE]);
      checkIn3270(s);
      checkLinemode(s, false);
      s.deferredWillTtype = false;
    }
  }
  return true;
}

/** @param {number} c */
const escaped = (c) =>
  c === TELOBJ_VAR ||
  c === TELOBJ_USERVAR ||
  c === TELOBJ_ESC ||
  c === TELOBJ_VALUE;

/** escaped_copy() @param {string} text */
function escapedBytes(text) {
  /** @type {number[]} */
  const out = [];
  for (const c of ascii(text)) {
    if (escaped(c)) out.push(TELOBJ_ESC);
    out.push(c);
  }
  return out;
}

/** environ_init(): the VARs and USERVARs we offer. @param {State} s */
function environment(s) {
  const cp = s.codePage.cgcsgid & 0xffff;
  const vars = [
    {
      name: escapedBytes("USER"),
      value: escapedBytes(s.options.user ?? process.env.USER ?? ""),
    },
  ];
  const uservars = [];
  if (s.options.devName !== null)
    uservars.push({
      name: escapedBytes("DEVNAME"),
      value: escapedBytes(s.options.devName),
    });
  uservars.push({ name: escapedBytes("IBMELF"), value: escapedBytes("YES") });
  uservars.push({
    name: escapedBytes("IBMAPPLID"),
    value: escapedBytes("None"),
  });
  uservars.push({
    name: escapedBytes("CODEPAGE"),
    value: escapedBytes(cp < 100 ? String(cp).padStart(3, "0") : String(cp)),
  });
  uservars.push({
    name: escapedBytes("CHARSET"),
    value: escapedBytes(String((s.codePage.cgcsgid >>> 16) & 0xffff)),
  });
  uservars.push({
    name: escapedBytes("KBDTYPE"),
    value: escapedBytes(s.codePage.kybdtype || "*SYSVAL"),
  });
  return { vars, uservars };
}

/**
 * telnet_new_environ(): answers a NEW-ENVIRON SEND; null if the request is malformed.
 * @param {State} s @param {Uint8Array} request
 */
function newEnviron(s, request) {
  /** @type {{group: number, name: number[]}[]} */
  const ereqs = [];
  /** @type {{group: number, name: number[]} | null} */
  let ereq = null;
  let state = "base";
  for (const c of request) {
    if (state === "base") {
      if (c !== TELOBJ_VAR && c !== TELOBJ_USERVAR) return null;
      ereq = { group: c, name: [] };
      state = "var";
    } else if (state === "nameEsc") {
      ereq?.name.push(c);
    } else if (c === TELOBJ_VAR || c === TELOBJ_USERVAR) {
      if (ereq) ereqs.push(ereq);
      ereq = { group: c, name: [] };
      state = "var";
    } else {
      ereq?.name.push(c);
      state = c === TELOBJ_ESC ? "nameEsc" : "name";
    }
  }
  if (state === "base") {
    ereqs.push(
      { group: TELOBJ_VAR, name: [] },
      { group: TELOBJ_USERVAR, name: [] },
    );
  } else if (ereq) {
    ereqs.push(ereq);
  }

  const env = environment(s);
  const body = [TELOPT_NEW_ENVIRON, TELQUAL_IS];
  for (const { group, name } of ereqs) {
    const list = group === TELOBJ_VAR ? env.vars : env.uservars;
    if (name.length === 0) {
      for (const v of list)
        body.push(group, ...v.name, TELOBJ_VALUE, ...v.value);
      continue;
    }
    // x3270 matches on the requested length only, so a prefix finds a variable.
    const found = name.includes(0)
      ? undefined
      : list.find((v) => name.every((c, i) => v.name[i] === c));
    body.push(group, ...name);
    if (found) body.push(TELOBJ_VALUE, ...found.value);
  }
  const out = [IAC, SB];
  for (const c of body) {
    if (c === IAC) out.push(IAC);
    out.push(c);
  }
  out.push(IAC, SE);
  return out;
}

/** tn3270e_request(): our device type, always a 3278 per the RFC. @param {State} s */
function tn3270eRequest(s) {
  const out = [
    IAC,
    SB,
    TELOPT_TN3270E,
    TN3270E_OP_DEVICE_TYPE,
    TN3270E_OP_REQUEST,
    ...ascii(create3270Termtype(s, true)),
  ];
  if (s.tryLu) out.push(TN3270E_OP_CONNECT, ...ascii(s.tryLu));
  out.push(IAC, SE);
  framedOut(s, out);
}

/** backoff_tn3270e() @param {State} s @param {string} why */
function backoffTn3270e(s, why) {
  s.log.info(`N1202 giving up on TN3270E: ${why}`);
  rawout(s, [IAC, WONT, TELOPT_TN3270E]);
  setupLus(s);
  s.myopts[TELOPT_TN3270E] = 0;
  tn3270eInit(s);
  checkIn3270(s);
}

/** tn3270e_subneg_send() @param {State} s @param {number} op */
function tn3270eSubnegSend(s, op) {
  const out = [IAC, SB, TELOPT_TN3270E, TN3270E_OP_FUNCTIONS, op];
  for (let i = 0; i < 256; i++) if (s.eFuncs[i]) out.push(i);
  out.push(IAC, SE);
  rawout(s, out);
}

/** tn3270e_negotiate() @param {State} s */
function tn3270eNegotiate(s) {
  const sb = s.sbbuf;
  let sblen = 0;
  while (sb[sblen] !== SE) sblen++;
  switch (sb[1]) {
    case TN3270E_OP_SEND:
      if (sb[2] === TN3270E_OP_DEVICE_TYPE) tn3270eRequest(s);
      break;
    case TN3270E_OP_DEVICE_TYPE:
      if (sb[2] === TN3270E_OP_IS) {
        let tnlen = 0;
        while (sb[3 + tnlen] !== SE && sb[3 + tnlen] !== TN3270E_OP_CONNECT)
          tnlen++;
        let snlen = 0;
        if (sb[3 + tnlen] === TN3270E_OP_CONNECT) {
          while (sb[3 + tnlen + 1 + snlen] !== SE) snlen++;
        }
        const text = (/** @type {number} */ from, /** @type {number} */ len) =>
          String.fromCharCode(...sb.subarray(from, from + Math.min(len, 32)));
        if (tnlen) s.connectedType = text(3, tnlen);
        if (snlen) {
          s.connectedLu = text(3 + tnlen + 1, snlen);
          statusLu(s, s.connectedLu);
        }
        s.log.info(
          `TN3270E device type ${s.connectedType ?? ""} LU ${s.connectedLu ?? ""}`,
        );
        tn3270eSubnegSend(s, TN3270E_OP_REQUEST);
      } else if (sb[2] === TN3270E_OP_REJECT) {
        if (sb[4] === TN3270E_REASON_UNSUPPORTED_REQ) {
          backoffTn3270e(s, "Host rejected request type");
          break;
        }
        nextLu(s);
        if (s.tryLu !== null) tn3270eRequest(s);
        else if (s.lus !== null) backoffTn3270e(s, "Host rejected resource(s)");
        else backoffTn3270e(s, "Device type rejected");
      }
      break;
    case TN3270E_OP_FUNCTIONS: {
      const rcvd = new Uint8Array(256);
      for (let i = 3; i < sblen; i++) rcvd[sb[i]] = 1;
      const noneAdded = rcvd.every((bit, i) => !bit || s.eFuncs[i]);
      if (sb[2] === TN3270E_OP_REQUEST) {
        if (noneAdded) {
          s.eFuncs.set(rcvd);
          tn3270eSubnegSend(s, TN3270E_OP_IS);
          s.tn3270eNegotiated = true;
          checkIn3270(s);
        } else {
          for (let i = 0; i < 256; i++) s.eFuncs[i] &= rcvd[i];
          tn3270eSubnegSend(s, TN3270E_OP_REQUEST);
        }
      } else if (sb[2] === TN3270E_OP_IS) {
        if (!noneAdded) {
          backoffTn3270e(s, "Host illegally added function(s)");
          break;
        }
        s.eFuncs.set(rcvd);
        s.tn3270eNegotiated = true;
        // Without BIND-IMAGE there is no BIND to wait for; the keyboard still waits for a Write.
        if (!s.eFuncs[TN3270E_FUNC_BIND_IMAGE]) s.tn3270eSubmode = E_3270;
        checkIn3270(s);
      }
      break;
    }
  }
}

/** check_in3270(): derives the connection state from the negotiated options. @param {State} s */
function checkIn3270(s) {
  let next;
  if (s.myopts[TELOPT_TN3270E]) {
    if (!s.tn3270eNegotiated) next = CONNECTED_UNBOUND;
    else if (s.tn3270eSubmode === E_UNBOUND) next = CONNECTED_UNBOUND;
    else if (s.tn3270eSubmode === E_NVT) next = CONNECTED_E_NVT;
    else if (s.tn3270eSubmode === E_3270) next = CONNECTED_TN3270E;
    else next = CONNECTED_SSCP;
  } else if (
    s.myopts[TELOPT_BINARY] &&
    s.myopts[TELOPT_EOR] &&
    s.myopts[TELOPT_TTYPE] &&
    s.hisopts[TELOPT_BINARY] &&
    s.hisopts[TELOPT_EOR]
  ) {
    next = CONNECTED_3270;
  } else if (s.cstate === TELNET_PENDING) {
    return;
  } else {
    next = TELNET_PENDING;
  }
  if (next === s.cstate) return;
  if (!s.myopts[TELOPT_TN3270E]) tn3270eInit(s);
  if ((next === CONNECTED_NVT && s.linemode) || next === CONNECTED_E_NVT)
    linemodeBufInit(s);
  changeCstate(s, next);
}

/** net_linemode(): asks the host to stop echoing, for Set(lineMode, true). @param {State} s */
export function netLinemode(s) {
  if (!inNvt(s)) return;
  if (s.hisopts[TELOPT_ECHO]) rawout(s, [IAC, DONT, TELOPT_ECHO]);
  if (s.hisopts[TELOPT_SGA]) rawout(s, [IAC, DONT, TELOPT_SGA]);
}

/** net_charmode(): asks the host to echo, for Set(lineMode, false). @param {State} s */
export function netCharmode(s) {
  if (!inNvt(s)) return;
  if (!s.hisopts[TELOPT_ECHO]) rawout(s, [IAC, DO, TELOPT_ECHO]);
  if (!s.hisopts[TELOPT_SGA]) rawout(s, [IAC, DO, TELOPT_SGA]);
}

/** check_linemode(): NVT line mode follows the host's ECHO. @param {State} s @param {boolean} init */
function checkLinemode(s, init) {
  const wasline = s.linemode;
  s.linemode = !s.hisopts[TELOPT_ECHO];
  if (!init && s.linemode === wasline) return;
  if (s.cstate === CONNECTED_NVT || s.cstate === CONNECTED_NVT_CHAR) {
    changeCstate(s, s.linemode ? CONNECTED_NVT : CONNECTED_NVT_CHAR);
  }
  if (!inNvt(s)) return;
  if (s.linemode) linemodeBufInit(s);
  else linemodeDump(s);
}

/** @param {number} c */
function maxru(c) {
  if (!(c & 0x80)) return 0;
  return ((c >> 4) & 0x0f) * (1 << (c & 0xf));
}

/** process_bind(): screen sizes and PLU name from a BIND image. @param {State} s @param {Uint8Array} buf */
function processBind(s, buf) {
  s.pluName = "";
  let rd = 0,
    cd = 0,
    ra = 0,
    ca = 0;
  let present = false;
  if (buf.length < 1 || buf[0] !== BIND_RU) return;
  s.log.info(
    `BIND MaxSec-RU ${maxru(buf[BIND_OFF_MAXRU_SEC])} MaxPri-RU ${maxru(buf[BIND_OFF_MAXRU_PRI])}`,
  );
  if (buf.length > BIND_OFF_SSIZE) {
    switch (buf[BIND_OFF_SSIZE]) {
      case 0x00:
      case 0x02:
        rd = ra = MODEL_2_ROWS;
        cd = ca = MODEL_2_COLS;
        present = true;
        break;
      case 0x03:
        rd = MODEL_2_ROWS;
        cd = MODEL_2_COLS;
        ra = s.maxRows;
        ca = s.maxCols;
        present = true;
        break;
      case 0x7e:
        rd = ra = buf[BIND_OFF_RD];
        cd = ca = buf[BIND_OFF_CD];
        present = true;
        break;
      case 0x7f:
        rd = buf[BIND_OFF_RD];
        cd = buf[BIND_OFF_CD];
        ra = buf[BIND_OFF_RA];
        ca = buf[BIND_OFF_CA];
        present = true;
        break;
    }
  }
  if (s.options.bindLimit && present) {
    if (rd > s.maxRows || cd > s.maxCols) {
      s.log.warn(
        `N2203 ignoring BIND default size ${rd}x${cd} > maximum ${s.maxRows}x${s.maxCols}`,
      );
    } else if (rd < MODEL_2_ROWS || cd < MODEL_2_COLS) {
      s.log.warn(
        `N2204 ignoring BIND default size ${rd}x${cd} < minimum ${MODEL_2_ROWS}x${MODEL_2_COLS}`,
      );
    } else if (ra > s.maxRows || ca > s.maxCols) {
      s.log.warn(
        `N2205 ignoring BIND alternate size ${ra}x${ca} > maximum ${s.maxRows}x${s.maxCols}`,
      );
    } else if (ra < MODEL_2_ROWS || ca < MODEL_2_COLS) {
      s.log.warn(
        `N2206 ignoring BIND alternate size ${ra}x${ca} < minimum ${MODEL_2_ROWS}x${MODEL_2_COLS}`,
      );
    } else {
      s.defRows = rd;
      s.defCols = cd;
      s.altRows = ra;
      s.altCols = ca;
    }
  }
  erase(s, false);
  if (buf.length > BIND_OFF_PLU_NAME_LEN) {
    const namelen = Math.min(buf[BIND_OFF_PLU_NAME_LEN], BIND_PLU_NAME_MAX);
    if (namelen > 0 && buf.length > BIND_OFF_PLU_NAME + namelen) {
      let name = "";
      for (let i = 0; i < namelen; i++)
        name += String.fromCodePoint(
          s.codePage.base[buf[BIND_OFF_PLU_NAME + i]] || 0x20,
        );
      s.pluName = name;
      statusLu(s, name);
    }
  }
  s.tn3270eSubmode = E_3270;
}

/** process_eor(): a complete record from the host. @param {State} s */
function processEor(s) {
  if (s.syncing || s.ibLen === 0) return;
  const rec = s.ibuf.subarray(0, s.ibLen);
  if (!inE(s)) {
    processDs(s, rec, false);
    return;
  }
  const dataType = rec[0],
    requestFlag = rec[1],
    responseFlag = rec[2];
  const data = rec.subarray(EH_SIZE);
  switch (dataType) {
    case TN3270E_DT_3270_DATA: {
      if (s.eFuncs[TN3270E_FUNC_BIND_IMAGE] && !s.tn3270eBound) return;
      s.tn3270eSubmode = E_3270;
      checkIn3270(s);
      s.responseRequired = responseFlag;
      const rv = processDs(
        s,
        data,
        (requestFlag & TN3270E_RQF_KEYBOARD_RESTORE) !== 0,
      );
      if (rv < 0 && s.responseRequired !== TN3270E_RSF_NO_RESPONSE) {
        tn3270eNak(s, rv);
      } else if (
        rv === PDS_OKAY_NO_OUTPUT &&
        s.responseRequired === TN3270E_RSF_ALWAYS_RESPONSE
      ) {
        tn3270eAck(s);
      }
      s.responseRequired = TN3270E_RSF_NO_RESPONSE;
      if (s.eFuncs[TN3270E_FUNC_CONTENTION_RESOLUTION]) {
        if (requestFlag & TN3270E_RQF_SEND_DATA) {
          s.kybdlock &= ~KL_BID;
          statusReset(s);
          psProcess(s);
        } else {
          s.kybdlock |= KL_BID;
          statusReset(s);
        }
      }
      return;
    }
    case TN3270E_DT_BIND_IMAGE:
      if (!s.eFuncs[TN3270E_FUNC_BIND_IMAGE]) return;
      processBind(s, data);
      s.tn3270eBound = true;
      checkIn3270(s);
      return;
    case TN3270E_DT_UNBIND:
      if (!s.eFuncs[TN3270E_FUNC_BIND_IMAGE]) return;
      s.tn3270eBound = false;
      statusLu(s, s.connectedLu);
      s.pluName = "";
      // The host may send data before a new BIND; that must use the default size.
      s.defRows = MODEL_2_ROWS;
      s.defCols = MODEL_2_COLS;
      s.altRows = s.maxRows;
      s.altCols = s.maxCols;
      erase(s, false);
      s.tn3270eSubmode = E_UNBOUND;
      checkIn3270(s);
      return;
    case TN3270E_DT_NVT_DATA:
      s.tn3270eSubmode = E_NVT;
      checkIn3270(s);
      for (const c of data) nvtProcess(s, c);
      if (responseFlag === TN3270E_RSF_ALWAYS_RESPONSE) tn3270eAck(s);
      return;
    case TN3270E_DT_SSCP_LU_DATA:
      s.tn3270eSubmode = E_SSCP;
      checkIn3270(s);
      writeSscpLu(s, data);
      return;
    case TN3270E_DT_BID:
      if (!s.eFuncs[TN3270E_FUNC_CONTENTION_RESOLUTION]) return;
      s.kybdlock |= KL_BID;
      statusReset(s);
      if (responseFlag !== TN3270E_RSF_NO_RESPONSE) tn3270eAck(s);
      return;
    default:
      s.log.debug(`TN3270E data type 0x${dataType.toString(16)} ignored`);
  }
}

/** @param {State} s @param {number} flag @param {number} [reason] */
function tn3270eResponse(s, flag, reason) {
  const out = [TN3270E_DT_RESPONSE, 0, flag, s.ibuf[3]];
  if (s.ibuf[3] === IAC) out.push(IAC);
  out.push(s.ibuf[4]);
  if (s.ibuf[4] === IAC) out.push(IAC);
  out.push(reason ?? 0, IAC, EOR);
  rawout(s, out);
}

/** tn3270e_ack() @param {State} s */
function tn3270eAck(s) {
  tn3270eResponse(s, TN3270E_RSF_POSITIVE_RESPONSE);
}

/** tn3270e_nak() @param {State} s @param {number} rv */
function tn3270eNak(s, rv) {
  tn3270eResponse(
    s,
    TN3270E_RSF_NEGATIVE_RESPONSE,
    rv === PDS_BAD_ADDR
      ? TN3270E_NEG_OPERATION_CHECK
      : TN3270E_NEG_COMMAND_REJECT,
  );
}

/** net_output(): sends s.out as one record, with the TN3270E header when needed. @param {State} s */
export function netOutput(s) {
  const tn3270e =
    s.cstate === CONNECTED_TN3270E ||
    s.cstate === CONNECTED_SSCP ||
    s.cstate === CONNECTED_E_NVT;
  const body = s.out.bytes.subarray(0, s.out.length);
  const xo = new Uint8Array((body.length + EH_SIZE) * 2 + 2);
  let n = 0;
  if (tn3270e) {
    if (s.responseRequired === TN3270E_RSF_ALWAYS_RESPONSE) {
      tn3270eAck(s);
      s.responseRequired = TN3270E_RSF_NO_RESPONSE;
    }
    const dataType =
      s.cstate === CONNECTED_TN3270E
        ? TN3270E_DT_3270_DATA
        : s.cstate === CONNECTED_E_NVT
          ? TN3270E_DT_NVT_DATA
          : TN3270E_DT_SSCP_LU_DATA;
    for (const c of [
      dataType,
      0,
      0,
      (s.eXmitSeq >> 8) & 0xff,
      s.eXmitSeq & 0xff,
    ]) {
      xo[n++] = c;
      if (c === IAC) xo[n++] = IAC;
    }
    if (s.eFuncs[TN3270E_FUNC_RESPONSES])
      s.eXmitSeq = (s.eXmitSeq + 1) & 0x7fff;
  }
  for (let i = 0; i < body.length; i++) {
    xo[n++] = body[i];
    if (body[i] === IAC) xo[n++] = IAC;
  }
  xo[n++] = IAC;
  xo[n++] = EOR;
  s.write(xo.subarray(0, n));
  s.stats.rsent++;
  statsPoke(s);
}

/** net_cookedout(): NVT keyboard data, already line-edited. @param {State} s @param {number[]} bytes */
export function netCookedout(s, bytes) {
  if (!bytes.length) return;
  if (s.cstate !== CONNECTED_E_NVT) {
    rawout(s, bytes);
    return;
  }
  s.out.reset();
  s.out.push(...bytes);
  netOutput(s);
}

/** net_cookout(): NVT keyboard data, edited locally in line mode. @param {State} s @param {Uint8Array | number[]} bytes */
function netCookout(s, bytes) {
  if (!inNvt(s) || s.kybdlock & KL_AWAITING_FIRST) return;
  if (s.linemode) linemodeOut(s, bytes);
  else netCookedout(s, Array.from(bytes));
}

/** net_sendc(): one NVT character; a lone CR is quoted in character mode. @param {State} s @param {number} c */
export function netSendc(s, c) {
  if (c === 0x0d && !s.linemode) netCookout(s, [0x0d, 0x00]);
  else netCookout(s, [c]);
}

/** net_sends() @param {State} s @param {Uint8Array} bytes */
export function netSends(s, bytes) {
  if (bytes.length === 1 && bytes[0] === 0x0d && !s.linemode)
    netCookout(s, [0x0d, 0x00]);
  else netCookout(s, bytes);
}

/** net_hexnvt_out(): raw bytes from HexString() in NVT mode, with IAC doubled and a bare CR padded. @param {State} s @param {number[]} bytes */
export function netHexnvtOut(s, bytes) {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
    if (bytes[i] === IAC) out.push(IAC);
    else if (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a) out.push(0);
  }
  if (out.length) rawout(s, out);
}

/** net_break(): the Attn key outside TN3270E. @param {State} s */
export function netBreak(s) {
  rawout(s, [IAC, BREAK]);
}

/** net_interrupt(): the Attn key in TN3270E. @param {State} s */
export function netInterrupt(s) {
  rawout(s, [IAC, IP]);
}

/** net_abort(): SysReq in TN3270E. @param {State} s */
export function netAbort(s) {
  if (!s.eFuncs[TN3270E_FUNC_SYSREQ]) return;
  if (s.tn3270eSubmode === E_SSCP || s.tn3270eSubmode === E_3270)
    rawout(s, [IAC, AO]);
}

/** @param {State} s */
export function bound(s) {
  return inE(s) && s.tn3270eBound;
}
