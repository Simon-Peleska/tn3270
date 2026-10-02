import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { codePage } from "./charset.js";
import {
  ctlrConnect,
  erase,
  newCells,
  screenText,
  setRowsCols,
} from "./ctlr.js";
import { NodeError } from "./errors.js";
import { splitHost } from "./host.js";
import * as kybd from "./kybd.js";
import { createLinemode } from "./linemode.js";
import { createNvt, nvtConnect, nvtIn3270 } from "./nvt.js";
import {
  createScroll,
  scrollAction,
  scrollBufInit,
  scrollConnect,
} from "./scroll.js";
import {
  canonicalModel,
  canonicalOversize,
  replayDisconnectSets,
  set,
  toggle,
} from "./toggles.js";
import {
  createUi,
  initializeIndications,
  popupError,
  screenDisp,
  statsPoke,
  statusFlag,
  uiConnect,
} from "./ui.js";
import { query } from "./query.js";
import {
  SCRIPT_ACTIONS,
  asyncFail,
  ckbwait,
  createScript,
  statusString,
} from "./script.js";
import {
  create3270Termtype,
  netSetDefaultTermtype,
  netConnected,
  netDisconnected,
  netInput,
} from "./telnet.js";

// One emulated terminal per State; all module functions take it as `s` instead of x3270's globals.

export const NOT_CONNECTED = 0,
  RECONNECTING = 1,
  TLS_PASS = 2,
  RESOLVING = 3,
  TCP_PENDING = 4,
  TLS_PENDING = 5;
export const PROXY_PENDING = 6,
  TELNET_PENDING = 7,
  CONNECTED_NVT = 8,
  CONNECTED_NVT_CHAR = 9,
  CONNECTED_3270 = 10;
export const CONNECTED_UNBOUND = 11,
  CONNECTED_E_NVT = 12,
  CONNECTED_SSCP = 13,
  CONNECTED_TN3270E = 14;

/** @param {State} s */
export const isConnected = (s) => s.cstate > TCP_PENDING;
/** @param {State} s */
export const inNvt = (s) =>
  s.cstate === CONNECTED_NVT ||
  s.cstate === CONNECTED_NVT_CHAR ||
  s.cstate === CONNECTED_E_NVT;
/** @param {State} s */
export const in3270 = (s) =>
  s.cstate === CONNECTED_3270 ||
  s.cstate === CONNECTED_TN3270E ||
  s.cstate === CONNECTED_SSCP;
/** @param {State} s */
export const inSscp = (s) => s.cstate === CONNECTED_SSCP;
/** @param {State} s */
export const inE = (s) => s.cstate >= CONNECTED_UNBOUND;
/** @param {State} s */
export const fullSession = (s) => inNvt(s) || in3270(s);

export const MODEL_SIZES = {
  2: [24, 80],
  3: [32, 80],
  4: [43, 80],
  5: [27, 132],
};

/**
 * b3270's defaults, so a Session answers a host exactly like `b3270 -model 3279-4-E` would.
 * The names are b3270's settings, which Set() and Toggle() change; an unset string is null.
 */
export const DEFAULTS = {
  /**
   * Which x3270 front end's own state hook to copy. Both clear the screen to the alternate
   * (model) size: "b3270" only when a connection starts, "s3270" on every connect and every
   * 3270/NVT mode change, UNBIND included.
   * @type {"b3270" | "s3270"}
   */
  frontend: "b3270",
  /** Comma-separated LU names to try in turn. */
  lu: "",
  numericLock: false,
  bindUnlock: false,
  newEnviron: true,
  bsdTm: false,

  // The extended settings, in b3270's order.
  codePage: /** @type {string | null} */ ("bracket"),
  ftBufferSize: 16384,
  confDir: /** @type {string | null} */ ("/etc/x3270"),
  reconnect: false,
  retry: false,
  oerrLock: true,
  unlockDelay: false,
  unlockDelayMs: 350,
  scriptPort: /** @type {string | null} */ (null),
  printerLu: /** @type {string | null} */ (null),
  "printer.options": /** @type {string | null} */ (null),
  saveLines: 4096,
  acceptHostname: /** @type {string | null} */ (null),
  verifyHostCert: true,
  startTls: true,
  caDir: /** @type {string | null} */ (null),
  caFile: /** @type {string | null} */ (null),
  certFile: /** @type {string | null} */ (null),
  certFileType: /** @type {string | null} */ (null),
  chainFile: /** @type {string | null} */ (null),
  keyFile: /** @type {string | null} */ (null),
  keyFileType: /** @type {string | null} */ (null),
  keyPasswd: /** @type {string | null} */ (null),
  tlsMinProtocol: /** @type {string | null} */ (null),
  tlsMaxProtocol: /** @type {string | null} */ (null),
  tlsSecurityLevel: /** @type {string | null} */ (null),
  httpd: /** @type {string | null} */ (null),
  proxy: /** @type {string | null} */ (null),
  extendedDataStream: true,
  /** "3279-4", or with "-E", "IBM-" or just "4"; kept as "327X-N" like b3270 does. */
  model: "3279-4",
  /** A TELNET NOP every this many seconds while connected; 0 sends none. */
  nopSeconds: 0,
  /** "COLSxROWS", bigger than the model. */
  oversize: /** @type {string | null} */ (null),
  termName: /** @type {string | null} */ (null),
  noTelnetInputMode: /** @type {string | null} */ ("line"),
  bindLimit: true,
  wrongTerminalName: false,
  contentionResolution: true,
  tls992: true,
  loginMacro: /** @type {string | null} */ (null),
  preferIpv4: false,
  preferIpv6: false,
  /** NEW-ENVIRON's USER; null sends $USER. */
  user: /** @type {string | null} */ (null),
  devName: /** @type {string | null} */ (null),
  rpq: /** @type {string | null} */ (null),

  // The classic toggles.
  monoCase: false,
  altCursor: false,
  cursorBlink: false,
  showTiming: false,
  trace: false,
  lineWrap: false,
  blankFill: true,
  screenTrace: false,
  crosshair: false,
  visibleControl: false,
  aidWait: true,
  overlayPaste: true,
  typeahead: true,
  aplMode: false,
  alwaysInsert: false,
  rightToLeftMode: false,
  reverseInputMode: false,
  insertMode: false,
  underscoreBlankFill: true,
};
/** @typedef {typeof DEFAULTS & Record<string, any>} Options */

/** Output record builder, reused across records. */
export class OutBuf {
  constructor() {
    this.bytes = new Uint8Array(4096);
    this.length = 0;
  }

  reset() {
    this.length = 0;
  }

  /** @param {...number} values */
  push(...values) {
    if (this.length + values.length > this.bytes.length)
      this.grow(values.length);
    for (const v of values) this.bytes[this.length++] = v;
  }

  /** @param {number} extra */
  grow(extra) {
    const grown = new Uint8Array(
      Math.max(this.bytes.length * 2, this.length + extra),
    );
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }
}

/**
 * The whole emulator state of one session.
 * @param {Partial<Options>} [opts]
 * @param {{write?: (b: Uint8Array) => void, emit?: (e: any) => void, log?: Logger}} [io]
 */
export function createState(opts = {}, io = {}) {
  /** @type {Options} */
  const options = { ...DEFAULTS, ...opts };
  const canonical = canonicalModel(options.model, false);
  if (!canonical)
    throw new NodeError("N9002", `unknown model "${options.model}"`);
  options.model = canonical.canon;
  const { mode3279, model } = canonical;
  let [maxRows, maxCols] = MODEL_SIZES[/** @type {2|3|4|5} */ (model)];
  if (!options.extendedDataStream) options.oversize = null;
  if (options.oversize) {
    const oversize = canonicalOversize(options.oversize);
    if (!oversize)
      throw new NodeError(
        "N9003",
        `bad oversize "${options.oversize}", want COLSxROWS`,
      );
    const { cols, rows } = oversize;
    if (cols < maxCols || rows < maxRows || cols * rows > 0x3fff) {
      throw new NodeError(
        "N9004",
        `oversize ${options.oversize} is smaller than the model or too big`,
      );
    }
    options.oversize = oversize.canon;
    maxRows = rows;
    maxCols = cols;
  } else options.oversize = null;
  const size = maxRows * maxCols;
  const s = {
    options,
    codePage: codePage(options.codePage ?? "bracket"),
    model,
    mode3279,
    termtype: "",
    maxRows,
    maxCols,
    oversized: options.oversize !== null,
    rows: 24,
    cols: 80,
    defRows: 24,
    defCols: 80,
    altRows: maxRows,
    altCols: maxCols,
    screenAlt: false,

    ...newCells(size),
    isAltbuffer: false,
    /** @type {null | import("./ctlr.js").Cells} */
    altCells: null,
    changed: false,

    cursor: 0,
    bufferAddr: 0,
    formatted: false,
    sscpStart: 0,
    defaultFg: 0,
    defaultBg: 0,
    defaultGr: 0,
    defaultCs: 0,
    defaultIc: 0,
    replyMode: 0,
    crmNattr: 0,
    crmAttr: new Uint8Array(0),
    aid: 0x60,
    flipped: false,

    kybdlock: kybd.KL_NOT_CONNECTED,
    /** @type {NodeJS.Timeout | null} the deferred unlock of unlockDelay */
    unlockTimer: null,
    deferredSince: 0,
    /** @type {{fn: Function, args: any[]}[]} */
    typeahead: [],

    cstate: NOT_CONNECTED,
    /** @type {import("./ui.js").Ui | null} b3270 indications, when someone listens */
    ui: null,
    /** @type {RunText | null} the result text of the action Session.run() is running */
    runText: null,
    savedBaddr: 0,
    cursorDisables: 0,
    /** @type {NodeJS.Timeout | null} */
    nopTimer: null,
    out: new OutBuf(),
    myopts: new Uint8Array(256),
    hisopts: new Uint8Array(256),
    telnetState: 0,
    ibuf: new Uint8Array(4096),
    ibLen: 0,
    sbbuf: new Uint8Array(1024),
    sbLen: 0,
    syncing: false,
    linemode: true,
    didNeSend: false,
    deferredWillTtype: false,
    eFuncs: new Uint8Array(256),
    eXmitSeq: 0,
    responseRequired: 0,
    tn3270eNegotiated: false,
    tn3270eSubmode: 0,
    tn3270eBound: false,
    /** Open()'s "lu@host" or else options.lu, as the comma-separated LUs to try. */
    luName: "",
    /** Open()'s host prefixes, like "LN" for "L:N:host". */
    hostPrefixes: "",
    /** @type {string[] | null} */
    lus: null,
    luIndex: 0,
    /** @type {string | null} */
    tryLu: null,
    /** @type {string | null} */
    connectedLu: null,
    /** @type {string | null} */
    connectedType: null,
    pluName: "",
    connectError: "",
    connHost: "",
    connPort: 0,
    secure: false,
    verified: false,
    /** @type {string | null} */
    tlsCertInfo: null,
    /** @type {string | null} */
    tlsSessionInfo: null,
    connectTime: 0,
    /** For Query(Tasks): how many runs so far, and the action running now. */
    runSeq: 0,
    runAction: "",
    stats: { brcvd: 0, rrcvd: 0, bsent: 0, rsent: 0 },
    nvt: createNvt(),
    lm: createLinemode(),
    /** Set()'s model, oversize and extendedDataStream, until they apply together. */
    modelPending: {
      /** @type {string | null} */ model: null,
      /** @type {string | null} */ oversize: null,
      /** @type {string | null} */ eds: null,
      oversizeWasPending: false,
    },
    /** @type {{name: string, value: string}[]} Set(-defer) values waiting for a disconnect */
    disconnectSets: [],

    write: io.write ?? (() => {}),
    emit: io.emit ?? (() => {}),
    log: io.log ?? SILENT,
    tracePrimed: false,
    scroll: createScroll(),
    script: createScript(),
    /** @type {Set<() => void>} called whenever the session settles after a change, for waiting actions */
    settled: new Set(),
  };
  s.termtype = create3270Termtype(s, false);
  setRowsCols(s);
  // b3270 starts on the full-size screen (but not in alternate mode).
  if (options.frontend === "b3270") {
    s.rows = s.altRows;
    s.cols = s.altCols;
  }
  scrollBufInit(s);
  return s;
}

/** @typedef {ReturnType<typeof createState>} State */
/** @typedef {{text: string[], err: boolean[]}} RunText */
/** @typedef {"string" | "paste" | "hex"} StringMode */

/**
 * What String() types once the keyboard unlocks. b3270 counts the leftover in characters
 * but resumes that many bytes before the end, so multibyte text loses characters; and a
 * resume point inside a character types nothing at all.
 * @param {string[]} chars @param {number} left
 */
function resumeAfter(chars, left) {
  const bytes = Buffer.from(chars.join(""));
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    return Array.from(utf8.decode(bytes.subarray(bytes.length - left)));
  } catch {
    return [];
  }
}

/** @typedef {{warn: (m: string) => void, info: (m: string) => void, debug: (m: string) => void}} Logger */

/** @type {Logger} */
const SILENT = { warn() {}, info() {}, debug() {} };

/**
 * change_cstate(): fires ST_CONNECT, ST_NEGOTIATING, ST_LINE_MODE and ST_3270_MODE in x3270's order.
 * The keyboard's hooks are registered with an explicit order, which puts them first.
 * @param {State} s @param {number} next
 */
export function changeCstate(s, next) {
  const old = s.cstate;
  if (old === next) return;
  s.log.debug(`cstate ${old} -> ${next}`);
  s.cstate = next;
  if (
    old > TCP_PENDING !== next > TCP_PENDING ||
    old > NOT_CONNECTED !== next > NOT_CONNECTED
  ) {
    kybd.kybdConnect(s);
    ctlrConnect(s);
    nvtConnect(s, isConnected(s));
    frontendHook(s, old);
    replayDisconnectSets(s);
    scrollConnect(s);
  }
  if (next >= RESOLVING && next <= TELNET_PENDING) uiConnect(s);
  if (next >= CONNECTED_NVT) {
    if (inNvt(s) || next === CONNECTED_UNBOUND) uiConnect(s);
    kybd.kybdIn3270(s);
    ctlrConnect(s);
    nvtIn3270(s, in3270(s));
    frontendHook(s, old);
    scrollConnect(s);
  }
}

/**
 * s3270_connect() or b3270_connect(): an implied EraseWriteAlternate.
 * b3270 also reports the connection, and erases only when that report leaves not-connected.
 * @param {State} s @param {number} old
 */
function frontendHook(s, old) {
  if (s.ui) uiConnect(s);
  else if (
    s.options.frontend === "s3270" ? isConnected(s) : old === NOT_CONNECTED
  )
    erase(s, true);
}

/** task.c's KBWAIT: the keyboard is locked for something the host will end. @param {State} s */
export const kbwait = (s) => (s.kybdlock & KBWAIT_MASK) !== 0;
const KBWAIT_MASK =
  kybd.KL_OIA_LOCKED |
  kybd.KL_OIA_TWAIT |
  kybd.KL_DEFERRED_UNLOCK |
  kybd.KL_ENTER_INHIBIT |
  kybd.KL_AWAITING_FIRST |
  kybd.KL_FT |
  kybd.KL_BID;

/**
 * Dup/FieldMark from a script fail on an operator error unless told NoFailOnError.
 * @param {State} s @param {string} name @param {string[]} args
 * @param {(s: State, oerrFail: boolean) => boolean} action
 */
function withOerrFail(s, name, args, action) {
  if (args.length > 1) {
    popupError(s, `${name}() requires 0 or 1 arguments`);
    return false;
  }
  const keyword = (args[0] ?? "failonerror").toLowerCase();
  if (keyword !== "failonerror" && keyword !== "nofailonerror") {
    popupError(s, `${name}(): Parameter must be failonerror or nofailonerror`);
    return false;
  }
  return action(s, keyword === "failonerror");
}

/**
 * x3270 action names, so a script written for s3270 reads the same here.
 * Each takes the State plus the action's arguments and returns false where s3270 would say "error";
 * the ones that wait for the host return that as a Promise.
 * @type {Record<string, (s: State, ...args: any[]) => boolean | Promise<boolean>>}
 */
export const ACTIONS = {
  Query: (/** @type {State} */ s, /** @type {any[]} */ ...args) =>
    query(s, "Query", args),
  Show: (/** @type {State} */ s, /** @type {any[]} */ ...args) =>
    query(s, "Show", args),
  Enter: kybd.enter,
  PF: kybd.pf,
  PA: kybd.pa,
  Clear: kybd.clearKey,
  SysReq: kybd.sysReq,
  Attn: kybd.attn,
  Interrupt: kybd.interrupt,
  Reset: kybd.reset,
  Tab: kybd.tab,
  BackTab: kybd.backTab,
  Home: kybd.home,
  Left: kybd.left,
  Right: kybd.right,
  Left2: kybd.left2,
  Right2: kybd.right2,
  Up: kybd.up,
  Down: kybd.down,
  Newline: kybd.newline,
  Delete: kybd.deleteKey,
  BackSpace: kybd.backSpace,
  Erase: kybd.erase,
  EraseEOF: kybd.eraseEOF,
  EraseInput: kybd.eraseInput,
  DeleteWord: kybd.deleteWord,
  DeleteField: kybd.deleteField,
  FieldEnd: kybd.fieldEnd,
  NextWord: kybd.nextWord,
  PreviousWord: kybd.previousWord,
  Dup: (s, ...args) => withOerrFail(s, "Dup", args, kybd.dup),
  FieldMark: (s, ...args) => withOerrFail(s, "FieldMark", args, kybd.fieldMark),
  CursorSelect: kybd.cursorSelect,
  Insert: (s) => set(s, "insertMode", "true"),
  ToggleInsert: (s) => toggle(s, "insertMode"),
  ToggleReverse: (s) => toggle(s, "reverseInputMode"),
  Flip: (s) => toggle(s, "rightToLeftMode"),
  MonoCase: (s, ...args) => {
    if (!args.length) return toggle(s, "monoCase");
    popupError(s, "MonoCase() requires 0 arguments");
    return false;
  },
  CircumNot: (s, ...args) => {
    if (args.length) {
      popupError(s, "CircumNot() requires 0 arguments");
      return false;
    }
    kybd.keyUnicode(s, in3270(s) ? 0xac : 0x5e, { oerrFail: true });
    return true;
  },
  PageUp: kybd.pageUp,
  PageDown: kybd.pageDown,
  MoveCursor: (s, a, b) =>
    kybd.moveCursor(
      s,
      parseInt(a, 10) || 0,
      b === undefined ? b : parseInt(b, 10) || 0,
      0,
    ),
  MoveCursor1: (s, a, b) =>
    kybd.moveCursor(
      s,
      parseInt(a, 10) || 0,
      b === undefined ? b : parseInt(b, 10) || 0,
      1,
    ),
  String: (s, ...args) => {
    kybd.emulateInput(s, args.join(""), false);
    return true;
  },
  Key: kybd.keyAction,
  End: kybd.fieldEnd,
  Set: set,
  Toggle: toggle,
  Scroll: scrollAction,
  ...SCRIPT_ACTIONS,
};

/**
 * What String(), PasteString() and HexString() type, read from their arguments the way kybd.c does.
 * PasteString's arguments are UTF-8 in hex.
 * @param {string} name @param {string[]} args
 * @returns {{mode: StringMode | "none", text: string, margin?: boolean} | {error: string}}
 */
function stringInput(name, args) {
  const strip0x = (/** @type {string} */ a) =>
    /^0x/i.test(a) ? a.slice(2) : a;
  if (name === "String") {
    const rest = args[0]?.toLowerCase() === "-subst" ? args.slice(1) : args;
    const text = rest.join("");
    return { mode: text ? "string" : "none", text };
  }
  if (name === "PasteString") {
    if (args.length < 1 || args.length > 2)
      return { error: "PasteString() requires 1 or 2 arguments" };
    const margin = args[0].toLowerCase() !== "-nomargin";
    const rest = margin ? args : args.slice(1);
    const hex = rest.map(strip0x).join("");
    if (!hex) return { mode: "none", text: "" };
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2)
      return { error: "Invalid hexadecimal paste data" };
    try {
      const utf8 = new TextDecoder("utf-8", { fatal: true });
      const text = utf8.decode(Buffer.from(hex, "hex"));
      return { mode: "paste", text, margin };
    } catch {
      return { error: "Invalid hexadecimal paste data" };
    }
  }
  const ascii = args[0]?.toLowerCase() === "-ascii";
  const hex = (ascii ? args.slice(1) : args).map(strip0x).join("");
  if (!/^[0-9a-f]*$/i.test(hex))
    return { error: "HexString(): Invalid hex character" };
  if (hex.length % 2) return { error: "HexString(): Odd number of nybbles" };
  if (!hex) return { mode: "none", text: "" };
  if (!ascii) return { mode: "hex", text: hex };
  // The String() still runs, but emulate_input() types nothing when the bytes aren't UTF-8.
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    const text = utf8.decode(Buffer.from(hex, "hex"));
    return { mode: "string", text: text.split("\0")[0] };
  } catch {
    return { mode: "string", text: "" };
  }
}

/** @param {RunText} out @param {string} line */
function fail(out, line) {
  out.text.push(line);
  out.err.push(true);
}

/** Node's certificate errors as OpenSSL's verify texts and numbers, the way b3270 shows them. */
const OPENSSL_VERIFY_ERRORS = /** @type {Record<string, string>} */ ({
  CERT_NOT_YET_VALID: "certificate is not yet valid (9)",
  CERT_HAS_EXPIRED: "certificate has expired (10)",
  DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed certificate (18)",
  SELF_SIGNED_CERT_IN_CHAIN:
    "self-signed certificate in certificate chain (19)",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
    "unable to get local issuer certificate (20)",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    "unable to verify the first certificate (21)",
  CERT_REVOKED: "certificate revoked (23)",
  ERR_TLS_CERT_ALTNAME_INVALID: "hostname mismatch (62)",
});

/** x3270 matches action names without regard to case. */
export const ACTION_NAMES = new Map(
  [
    ...Object.keys(ACTIONS),
    "Open",
    "Connect",
    "Disconnect",
    "Close",
    "Reconnect",
    "Quit",
    "Exit",
    "PasteString",
    "HexString",
  ].map((name) => [name.toLowerCase(), name]),
);

/**
 * A TN3270 client session over TCP or TLS.
 * Events: "update" (screen or keyboard changed), "close",
 * "quit" (a Quit() ran: b3270 would exit now).
 */
export class Session extends EventEmitter {
  /** @param {Partial<Options>} [options] @param {Logger} [log] */
  constructor(options = {}, log = SILENT) {
    super();
    /** @type {net.Socket | null} */
    this.socket = null;
    /** What Open() last tried, for Reconnect(). */
    this.lastTarget = "";
    this.log = log;
    /** @type {number | undefined} */
    this.lastKybdlock = undefined;
    /** @type {number | undefined} */
    this.lastCstate = undefined;
    this.s = createState(options, {
      write: (bytes) => {
        this.log.debug(`> ${bytes.length} bytes`);
        if (!this.socket) return;
        this.socket.write(bytes);
        this.s.stats.bsent += bytes.length;
        statsPoke(this.s);
      },
      emit: (e) => {
        if (e.type === "alarm") this.s.ui?.out("bell", {});
        if (e.type === "timer") this.flush();
      },
      log,
    });
  }

  /**
   * Connects; resolves once the socket is up (the TELNET negotiation follows on its own).
   * @param {string} host @param {number} port
   * @param {{tls?: boolean | tls.ConnectionOptions, lu?: string, prefixes?: string}} [how]
   *   lu overrides options.lu; prefixes are x3270's host prefixes, of which C, N and S change the protocol
   */
  connect(host, port, how = {}) {
    const s = this.s;
    if (s.cstate !== NOT_CONNECTED)
      throw new NodeError("N1001", "already connected");
    s.luName = how.lu ?? s.options.lu;
    s.hostPrefixes = how.prefixes ?? "";
    netSetDefaultTermtype(s);
    s.connHost = host;
    s.connPort = port;
    s.secure = !!how.tls;
    s.verified = false;
    s.tlsCertInfo = s.tlsSessionInfo = null;
    s.stats = { brcvd: 0, rrcvd: 0, bsent: 0, rsent: 0 };
    this.log.info(`connecting to ${host}:${port}${how.tls ? " with TLS" : ""}`);
    changeCstate(s, RESOLVING);
    changeCstate(s, TCP_PENDING);
    this.flush();
    return new Promise((resolve, reject) => {
      const tlsOptions = typeof how.tls === "object" ? how.tls : {};
      const socket = how.tls
        ? tls.connect({
            host,
            port,
            servername: net.isIP(host) ? undefined : host,
            ...tlsOptions,
          })
        : net.connect({ host, port });
      this.socket = socket;
      socket.setNoDelay(true);
      let up = false;
      // x3270 reports the TCP connection, then the TLS handshake, then TELNET.
      if (how.tls)
        socket.once("connect", () => {
          changeCstate(s, TELNET_PENDING);
          changeCstate(s, TLS_PENDING);
          this.flush();
        });
      socket.once(how.tls ? "secureConnect" : "connect", () => {
        up = true;
        if (socket instanceof tls.TLSSocket) s.verified = socket.authorized;
        this.log.info(`connected to ${host}:${port}`);
        netConnected(s);
        this.flush();
        resolve(undefined);
      });
      socket.on("data", (/** @type {Buffer} */ buf) => {
        this.log.debug(`< ${buf.length} bytes`);
        s.stats.brcvd += buf.length;
        statsPoke(s);
        if (!netInput(s, buf)) {
          this.log.warn(
            `N1102 disconnecting: ${s.connectError || "host data ended the session"}`,
          );
          socket.destroy();
        }
        this.flush();
      });
      socket.on("error", (e) => {
        const err = new NodeError(
          how.tls ? "N1103" : "N1101",
          `${host}:${port}: ${e.message}`,
          e,
        );
        this.log.warn(`${err.code} socket error\n${e.stack}`);
        if (up) return;
        // Not connected by the time Open() answers, so a retry right after it can connect.
        this.socket = null;
        netDisconnected(s);
        this.flush();
        reject(err);
      });
      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.log.info(`disconnected from ${host}:${port}`);
        this.socket = null;
        netDisconnected(s);
        this.flush();
        this.emit("close");
      });
    });
  }

  close() {
    this.socket?.destroy();
  }

  /** Like close(), but the state changes before this returns, as with b3270's Disconnect(). */
  disconnect() {
    const socket = this.socket;
    if (!socket) return;
    this.log.info("disconnecting");
    this.socket = null;
    socket.destroy();
    netDisconnected(this.s);
    this.flush();
    this.emit("close");
  }

  /**
   * Streams what `b3270 -json` would write, as {kind, body} pairs: first its initialize block,
   * then every change. Drive the session with run() to get run-results too.
   * @param {(indication: {kind: string, body: any}) => void} listener
   */
  indications(listener) {
    const s = this.s;
    s.ui = createUi(s.maxRows * s.maxCols, (kind, body) =>
      listener({ kind, body }),
    );
    for (const indication of initializeIndications(s)) listener(indication);
  }

  /**
   * b3270's run: the actions in order, stopping at the first failure, then a run-result.
   * Like b3270, Open waits for the host to let the keyboard go, and so does an action that sends an AID.
   * @param {{action: string, args?: any[]}[]} actions @param {string} [tag]
   * @returns {Promise<{success: boolean, text: string[]}>}
   */
  async run(actions, tag) {
    const s = this.s;
    const started = performance.now();
    /** @type {RunText} */
    const out = { text: [], err: [] };
    let success = true;
    let aborted = false;
    let quitting = false;
    asyncFail(s);
    s.runSeq++;
    for (const { action, args = [] } of actions) {
      s.runAction = `${action}(${args.map((a) => JSON.stringify(String(a))).join(",")})`;
      this.log.debug(`run ${s.runAction}`);
      const name = ACTION_NAMES.get(action.toLowerCase());
      if (name === "Open" || name === "Connect") {
        const errors = await this.open(String(args[0] ?? ""));
        for (const line of errors) fail(out, line);
        success = errors.length === 0;
      } else if (name === "Disconnect" || name === "Close") {
        success = args.length === 0;
        if (success) this.disconnect();
        else fail(out, "Disconnect() requires 0 arguments");
      } else if (name === "Reconnect") {
        const error = this.reconnectError(args);
        if (error) {
          this.log.warn(`N3334 ${error}`);
          fail(out, error);
          success = false;
        } else {
          const errors = await this.open(this.lastTarget);
          for (const line of errors) fail(out, line);
          success = errors.length === 0;
        }
      } else if (name === "Quit" || name === "Exit") {
        success = args.length <= 1;
        if (success) quitting = true;
        else fail(out, "Quit() requires 0 or 1 arguments");
      } else if (
        name === "String" ||
        name === "PasteString" ||
        name === "HexString"
      ) {
        const input = stringInput(name, args.map(String));
        if ("error" in input) {
          this.log.warn(`N3331 ${name}: ${input.error}`);
          fail(out, input.error);
          success = false;
        } else if (input.mode !== "none")
          success = await this.string(
            input.text,
            input.mode,
            out,
            input.margin ?? true,
          );
      } else if (!name) {
        this.log.warn(`N3012 unknown action ${action}`);
        fail(out, `Unknown action: ${action}`);
        success = false;
      } else {
        const waiting = kbwait(s);
        s.runText = out;
        const done = ACTIONS[name](s, ...args);
        s.runText = null;
        this.flush();
        // run_action_entry()'s return value is ignored: an action fails by popping up an error.
        await done;
        success = !out.err.includes(true);
        if (success && !waiting && ckbwait(s))
          await this.untilKeyboardWaitEnds();
      }
      this.flush();
      if (s.script.abort) {
        s.script.abort = false;
        fail(out, "Canceled");
        aborted = true;
        break;
      }
      if (!success) break;
    }
    if (s.ui) {
      /** @type {Record<string, any>} */
      const result =
        tag === undefined ? { success } : { "r-tag": tag, success };
      if (out.text.length) {
        result.text = out.text;
        result["text-err"] = out.err;
      }
      if (aborted) result.abort = true;
      result.time = Math.round(performance.now() - started) / 1000;
      s.ui.out("run-result", result);
    }
    if (quitting) {
      this.log.info("Quit(): ending the session");
      this.disconnect();
      this.emit("quit");
    }
    return { success, text: out.text };
  }

  /**
   * String(), PasteString() and HexString() the way stringscript.c runs them: typing pauses whenever
   * the keyboard locks for the host, and any other lock ends it.
   * @param {string} text @param {StringMode} mode @param {RunText} out
   * @param {boolean} margin
   */
  async string(text, mode, out, margin) {
    const s = this.s;
    let rest = Array.from(text);
    let aborted = false;
    statusFlag(s, "script", true);
    try {
      for (;;) {
        if (s.kybdlock & kybd.KL_OERR_MASK) {
          fail(out, "Operator error");
          return false;
        }
        if (kbwait(s)) {
          this.flush();
          await this.untilKeyboardWaitEnds();
          continue;
        }
        if (aborted) {
          this.log.warn("N3019 String() terminated by an earlier error");
          fail(out, "String() terminated due to error");
          return false;
        }
        if (s.kybdlock & kybd.KL_NOT_CONNECTED && rest.length === 0)
          return true;
        if (s.kybdlock) {
          this.log.warn("N3016 String() canceled by a locked keyboard");
          fail(out, "Canceled");
          return false;
        }
        if (rest.length === 0) return true;
        s.runText = out;
        const errors = out.err.filter(Boolean).length;
        if (mode === "hex") {
          kybd.hexInput(s, rest.join(""));
          rest = [];
        } else {
          const left = kybd.emulateInput(
            s,
            rest.join(""),
            mode === "paste",
            margin,
          );
          rest = mode === "paste" ? [] : resumeAfter(rest, left);
        }
        s.runText = null;
        // stringscript.c: an error popped up by the input fails the String once it has to resume.
        aborted = out.err.filter(Boolean).length > errors;
        if (s.kybdlock & kybd.KL_OERR_MASK) {
          fail(out, "Operator error");
          return false;
        }
        if (rest.length === 0 && !kbwait(s)) return true;
      }
    } finally {
      statusFlag(s, "script", false);
    }
  }

  /** Why Reconnect() can't, or "". @param {any[]} args */
  reconnectError(args) {
    const s = this.s;
    if (args.length) return "Reconnect() requires 0 arguments";
    if (s.cstate > NOT_CONNECTED && s.cstate !== RECONNECTING)
      return "Reconnect(): Already connected";
    if (!this.lastTarget) return "Reconnect(): No previous host to connect to";
    return "";
  }

  /** Resolves once the host has unlocked the keyboard, or the session has ended. */
  untilKeyboardWaitEnds() {
    return this.waitFor((x) => !kbwait(x.s)).catch(() => {});
  }

  /**
   * host_connect() for run(): Open("[L:][Y:][lu@]host[:port][=accept]") connects and waits for the
   * keyboard; resolves to the error lines for the run-result, or none.
   * @param {string} target
   * @returns {Promise<string[]>}
   */
  async open(target) {
    if (!target.trim()) return ["Invalid (empty) hostname"];
    const spec = splitHost(target);
    if ("error" in spec) {
      this.log.warn(`N1107 open: ${spec.error}`);
      return [spec.error];
    }
    this.lastTarget = target;
    const { prefixes, lu, host, accept } = spec;
    const ignored = prefixes.replace(/[LYNSCB]/g, "");
    if (ignored)
      this.log.warn(
        `N1108 open ${target}: prefixes ${ignored} not supported, ignored`,
      );
    const port = Number(spec.port ?? 23);
    if (!/^\d+$/.test(spec.port ?? "23") || port > 65535) {
      this.log.warn(`N1109 open ${target}: invalid port ${spec.port}`);
      return ["Connection failed:", `${host}/${spec.port}:`, "Invalid port"];
    }
    /** @type {tls.ConnectionOptions | false} */
    const tlsOptions = prefixes.includes("L") && {
      rejectUnauthorized:
        this.s.options.verifyHostCert && !prefixes.includes("Y"),
      ...(accept !== null && {
        checkServerIdentity: (_, cert) => tls.checkServerIdentity(accept, cert),
      }),
    };
    try {
      await this.connect(host, port, {
        tls: tlsOptions,
        lu: lu ?? undefined,
        prefixes,
      });
    } catch (e) {
      const err = /** @type {NodeError} */ (e);
      this.log.warn(`N1105 open ${target} failed\n${err.stack}`);
      const cause = /** @type {NodeJS.ErrnoException | undefined} */ (
        err.cause
      );
      if (cause?.code === "ECONNREFUSED")
        return [
          "Connection failed:",
          `${host}, port ${port}: Connection refused`,
        ];
      const verifyError = cause?.code && OPENSSL_VERIFY_ERRORS[cause.code];
      if (verifyError)
        return [
          "Connection failed:",
          "TLS: Host certificate verification failed:",
          verifyError,
        ];
      return ["Connection failed:", err.message];
    }
    try {
      await this.waitFor(
        () =>
          this.s.cstate > TELNET_PENDING &&
          !(this.s.kybdlock & kybd.KL_AWAITING_FIRST),
      );
      return [];
    } catch {
      this.log.warn(
        `N1106 open ${target}: connection closed before the keyboard unlocked`,
      );
      return ["Connection failed"];
    }
  }

  /**
   * Runs an x3270 action by name, e.g. action("PF", 3) or action("String", "logon\\n").
   * @param {string} name @param {...any} args
   */
  action(name, ...args) {
    const fn = ACTIONS[name];
    if (!fn) throw new NodeError("N3011", `unknown action ${name}`);
    this.log.debug(
      `action ${name}(${args.map((a) => JSON.stringify(a)).join(", ")})`,
    );
    const ok = fn(this.s, ...args);
    this.flush();
    return ok;
  }

  /** Tells listeners once per batch of changes, instead of once per cell. */
  flush() {
    const s = this.s;
    if (s.ui) screenDisp(s);
    for (const settled of [...s.settled]) settled();
    if (
      !s.changed &&
      s.kybdlock === this.lastKybdlock &&
      s.cstate === this.lastCstate
    )
      return;
    s.changed = false;
    this.lastKybdlock = s.kybdlock;
    this.lastCstate = s.cstate;
    this.emit("update");
  }

  /** Resolves the first time pred() holds, checked after every update. @param {(s: Session) => boolean} pred */
  waitFor(pred) {
    if (pred(this)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!pred(this)) return;
        this.off("update", check);
        this.off("close", closed);
        resolve(undefined);
      };
      const closed = () => {
        this.off("update", check);
        reject(new NodeError("N1104", "session closed while waiting"));
      };
      this.on("update", check);
      this.once("close", closed);
    });
  }

  /** s3270's status line without its window id and timing. */
  status() {
    return statusString(this.s).replace(/ 0x0$/, "");
  }

  /** The screen as text rows, like s3270's Ascii(). */
  text() {
    return screenText(this.s);
  }
}
