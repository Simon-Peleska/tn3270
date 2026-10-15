// Port of x3270's ft.c and ft_dft.c, the receiving half: Transfer() types IND$FILE GET into the
// host's input field, answers the DFT structured fields the host sends back, and emits what
// arrives as text instead of writing a local file. Sending, binary mode and CUT mode are left out.
import {
  AID_SF,
  add,
  cursorMove,
  dec,
  fieldAttribute,
  inc,
  isProtected,
  nextUnprotected,
} from "./ctlr.js";
import { ebcdicToUnicode } from "./charset.js";
import { KL_FT, KL_OIA_LOCKED, KL_OIA_TWAIT, emulateInput } from "./kybd.js";
import { in3270, isConnected } from "./session.js";
import { netOutput } from "./telnet.js";
import { actionOutput, popupError, statusReset } from "./ui.js";

const TR_OPEN_REQ = 0x0012,
  TR_CLOSE_REQ = 0x4112,
  TR_SET_CUR_REQ = 0x4511,
  TR_GET_REQ = 0x4611,
  TR_INSERT_REQ = 0x4711,
  TR_DATA_INSERT = 0x4704;
const TR_OPEN_ACK = 0x0009,
  TR_CLOSE_REPLY = 0x4109,
  TR_NORMAL_REPLY = 0x4705,
  TR_ERROR_REPLY = 0x08,
  TR_RECNUM_HDR = 0x6306,
  TR_ERROR_HDR = 0x6904,
  TR_ERR_CMDFAIL = 0x0100;
const SF_TRANSFER_DATA = 0xd0;

const START_TIMEOUT_MS = 30_000;

/** IND$FILE's "ASCII" back to EBCDIC, as ft.c's i_asc2ft[]. */
const ASC2FT = Uint8Array.from(
  Buffer.from(
    "00010203372d2e2f16050a0b0c0d0e0f101112133c3d322618193f271c1d1e1f" +
      "405a7f7b5b6c507d4d5d5c4e6b604b61f0f1f2f3f4f5f6f7f8f97a5e4c7e6e6f" +
      "7cc1c2c3c4c5c6c7c8c9d1d2d3d4d5d6d7d8d9e2e3e4e5e6e7e8e94ae04f5f6d" +
      "79818283848586878889919293949596979899a2a3a4a5a6a7a8a9c06ad0a107" +
      "202122232415061728292a2b2c090a1b30311a333435360838393a3b04143ee1" +
      "4142434445464748495152535455565758596263646566676869707172737475" +
      "767778808a8b8c8d8e8f909a9b9c9d9e9fa0aaabacadaeafb0b1b2b3b4b5b6b7" +
      "b8b9babbbcbdbebfcacbcccdcecfdadbdcdddedfeaebecedeeeffafbfcfdfeff",
    "hex",
  ),
);

/** @typedef {import("./session.js").State} State */
/** @typedef {import("./session.js").RunText} RunText */

/**
 * One transfer under way, as ft.c's ft_state and fts.
 * @typedef {object} Transfer
 * @property {"await-ack" | "running" | "abort-wait" | "abort-sent"} state
 * @property {RunText | null} out where the run that started it collects its result
 * @property {(success: boolean) => void} done
 * @property {NodeJS.Timeout | null} startTimer
 * @property {boolean} cr strip the CRs and ^Zs IND$FILE adds
 * @property {boolean} remap turn IND$FILE's ASCII back into the host code page's characters
 * @property {boolean} message the host opened FT:MSG rather than FT:DATA
 * @property {number} recnum
 * @property {number} length bytes of text so far
 * @property {number} started
 * @property {string | null} abortString
 */

// Each keyword's values, matched by prefix; none for the ones that take any value.
/** @type {[string, string[]][]} */
const KEYWORDS = [
  ["Direction", ["receive", "send"]],
  ["HostFile", []],
  ["LocalFile", []],
  ["Host", ["tso", "vm", "cics"]],
  ["Mode", ["ascii", "binary"]],
  ["Cr", ["auto", "remove", "add", "keep"]],
  ["Remap", ["yes", "no"]],
  ["Exist", ["keep", "replace", "append"]],
  ["Recfm", ["default", "fixed", "variable", "undefined"]],
  ["Lrecl", []],
  ["Blksize", []],
  ["Allocation", ["default", "tracks", "cylinders", "avblock"]],
  ["PrimarySpace", []],
  ["SecondarySpace", []],
  ["BufferSize", []],
  ["Avblock", []],
  ["OtherOptions", []],
  // Not x3270's: what to type in place of IND$FILE, like "TSO IND$FILE" from ISPF.
  ["HostCommand", []],
];
const NUMERIC = [
  "Lrecl",
  "Blksize",
  "PrimarySpace",
  "SecondarySpace",
  "BufferSize",
];
const SEND_ONLY = [
  "Recfm",
  "Lrecl",
  "Blksize",
  "Allocation",
  "PrimarySpace",
  "SecondarySpace",
  "Avblock",
];

/**
 * parse_ft_keywords(): `keyword=value` or `keyword value`, x3270's messages for what is wrong.
 * @param {string[]} args @returns {Record<string, string> | string}
 */
function parseKeywords(args) {
  /** @type {Record<string, string>} */
  const values = {};
  if (args.length === 1 && args[0].toLowerCase() === "defaults") args = [];
  for (let j = 0; j < args.length; j++) {
    const arg = args[j];
    const eq = arg.indexOf("=");
    if (eq === 0 || eq === arg.length - 1)
      return `Transfer(): Invalid option syntax: '${arg}'`;
    if (eq === -1 && j === args.length - 1)
      return `Transfer(): missing value after '${arg}'`;
    const keyword = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? args[j + 1] : arg.slice(eq + 1);
    const known = KEYWORDS.find(
      ([name]) => name.toLowerCase() === keyword.toLowerCase(),
    );
    // x3270's unknown-option check never fires, so b3270 skips just this argument.
    if (!known) continue;
    const [name, choices] = known;
    let chosen = value;
    if (choices.length) {
      const match = choices.find((choice) =>
        choice.startsWith(value.toLowerCase()),
      );
      if (match === undefined)
        return `Transfer(): Invalid option value: '${value}'`;
      chosen = match;
    } else if (NUMERIC.includes(name) && !/^\+?0*[1-9]\d*$/.test(value))
      return `Transfer(): Invalid option value: '${value}'`;
    values[name] = chosen;
    if (eq === -1) j++;
  }
  return values;
}

/**
 * The Transfer() action: Transfer(HostFile=…[,Host=…,Cr=…,…]) waits until the host says the
 * transfer ended; Transfer(Cancel) asks it to stop.
 * @param {State} s @param {...string} args
 * @returns {boolean | Promise<boolean>}
 */
export function transfer(s, ...args) {
  if (!in3270(s)) {
    popupError(s, "Transfer(): Not connected in 3270 mode");
    return false;
  }
  if (args.length === 1 && args[0].toLowerCase() === "cancel") {
    if (!s.ft) actionOutput(s, "No transfer pending.");
    else actionOutput(s, cancel(s) ? "Canceled." : "Cancel initiated.");
    return true;
  }
  if (s.ft) {
    popupError(s, "Transfer(): File transfer already in progress");
    return false;
  }
  const values = parseKeywords(args);
  const error = typeof values === "string" ? values : checkKeywords(values);
  if (typeof values === "string" || error) {
    s.log.warn(`N5001 ${error}`);
    popupError(s, error);
    return false;
  }

  const host = values["Host"] ?? "tso";
  const ascii = (values["Mode"] ?? "ascii") === "ascii";
  const crValue = values["Cr"] ?? "auto";
  const cr = crValue === "auto" ? ascii : crValue !== "keep";
  const remap = !ascii || (values["Remap"] ?? "yes") === "yes";
  let command = `${values["HostCommand"] ?? "IND\\e005BFILE"} GET ${values["HostFile"]} ${host !== "tso" ? "(" : ""}`;
  if (ascii) command += "ASCII";
  else if (host === "cics") command += "BINARY";
  if (ascii && cr) command += " CRLF";
  else if (host === "cics") command += " NOCRLF";
  if (values["OtherOptions"]) command += ` ${values["OtherOptions"]}`;
  command += "\\n";

  const room = prime(s);
  if (typeof room === "string" || room <= 0 || room < command.length - 1) {
    const why = typeof room === "string" ? room : "input field too small";
    s.log.warn(`N5002 cannot begin the transfer: ${why}`);
    popupError(s, `Cannot begin transfer: ${why}`);
    return false;
  }
  s.log.info(`transfer of ${values["HostFile"]} starting`);
  emulateInput(s, command, false, false);

  return new Promise((resolve) => {
    s.ft = {
      state: "await-ack",
      out: s.runText,
      done: resolve,
      startTimer: setTimeout(() => {
        if (!s.ft) return;
        s.ft.startTimer = null;
        complete(s, "Transfer did not start within 30s");
        s.emit({ type: "timer" });
      }, START_TIMEOUT_MS),
      cr,
      remap,
      message: false,
      recnum: 1,
      length: 0,
      started: performance.now(),
      abortString: null,
    };
    kybdFt(s, true);
    s.ui?.out("ft", { state: "awaiting", cause: "ui" });
  });
}

/** The rest of parse_ft_keywords(): what receiving ASCII cannot have. @param {Record<string, string>} values */
function checkKeywords(values) {
  const receive = (values["Direction"] ?? "receive") === "receive";
  const ascii = (values["Mode"] ?? "ascii") === "ascii";
  if (values["Cr"] && values["Cr"] !== "auto" && !ascii)
    return "Transfer(): Invalid 'Cr' option for ASCII mode";
  if (!values["HostFile"]) return "Transfer(): Missing 'HostFile' option";
  if (values["Cr"] && !ascii)
    return "Transfer(): 'Cr' is only for ASCII transfers";
  if (values["Remap"] && !ascii)
    return "Transfer(): 'Remap' is only for ASCII transfers";
  if (receive)
    for (const name of SEND_ONLY)
      if (values[name])
        return `Transfer(): '${name}' is only for sending files`;
  if (!receive) return "Transfer(): Only receiving files is supported";
  if (!ascii) return "Transfer(): Only ASCII transfers are supported";
  return "";
}

/**
 * kybd_prime(): clears the input field the command goes into and puts the cursor at its start.
 * @param {State} s @returns {number | string} the room in it, or why there is none
 */
function prime(s) {
  if (s.kybdlock) return "keyboard locked";
  if (!in3270(s)) return "not in 3270 mode";
  // Unformatted: the blanks from the cursor on, less one to end the command.
  if (!s.formatted) {
    let baddr = s.cursor;
    let len = 0;
    while (s.ec[baddr] === 0x00 || s.ec[baddr] === 0x40) {
      len++;
      baddr = inc(s, baddr);
      if (baddr === s.cursor) break;
    }
    return len ? len - 1 : 0;
  }
  let baddr;
  if (s.fa[s.cursor] || isProtected(fieldAttribute(s, s.cursor))) {
    baddr = nextUnprotected(s, s.cursor);
    if (!baddr) return "no input field";
  } else {
    baddr = s.cursor;
    while (!s.fa[baddr]) baddr = dec(s, baddr);
    baddr = inc(s, baddr);
  }
  cursorMove(s, baddr);
  let len = 0;
  while (!s.fa[baddr]) {
    add(s, baddr, 0, 0);
    len++;
    baddr = inc(s, baddr);
  }
  return len;
}

/** kybd_ft() @param {State} s @param {boolean} on */
function kybdFt(s, on) {
  if (on) {
    s.kybdlock |= KL_FT;
    if (s.kybdlock === KL_FT) statusReset(s);
  } else {
    s.kybdlock &= ~KL_FT;
    if (!s.kybdlock) statusReset(s);
  }
}

/** ft_do_cancel(): true when the transfer is over, false when the host must agree first. @param {State} s */
function cancel(s) {
  const ft = /** @type {Transfer} */ (s.ft);
  if (ft.state === "running") {
    ft.state = "abort-wait";
    return false;
  }
  // The host may not have unlocked the keyboard yet.
  if (ft.state === "await-ack") s.kybdlock &= ~(KL_OIA_TWAIT | KL_OIA_LOCKED);
  complete(s, "Transfer canceled by user");
  return true;
}

/**
 * ft_complete(): ends the transfer, with the error or the byte count as its run's result.
 * @param {State} s @param {string | null} error
 */
function complete(s, error) {
  const ft = s.ft;
  if (!ft) return;
  s.ft = null;
  kybdFt(s, false);
  if (ft.startTimer) clearTimeout(ft.startTimer);
  let text = error;
  if (error === null) {
    const seconds = (performance.now() - ft.started) / 1000;
    text = `Transfer complete, ${ft.length} bytes transferred\n${scale(ft.length / seconds)}bytes/sec in DFT mode`;
    s.log.info(`transfer complete, ${ft.length} bytes`);
  } else s.log.warn(`N5003 transfer ended: ${error}`);
  s.ui?.out("ft", {
    state: "complete",
    success: error === null,
    text,
    cause: "ui",
  });
  for (const line of /** @type {string} */ (text).split("\n")) {
    ft.out?.text.push(line);
    ft.out?.err.push(error !== null);
  }
  ft.done(error === null);
}

/** display_scale() @param {number} d */
function scale(d) {
  const g = (/** @type {number} */ n) => String(Number(n.toPrecision(3)));
  if (d >= 1_000_000) return `${g(d / 1_000_000)} M`;
  if (d >= 1000) return `${g(d / 1000)} K`;
  return `${g(d)} `;
}

/**
 * ft_connected() and ft_in3270(): a transfer cannot outlive the 3270 session.
 * @param {State} s
 */
export function ftCstate(s) {
  if (!s.ft) return;
  if (!isConnected(s)) complete(s, "Host disconnected, transfer canceled");
  else if (!in3270(s)) complete(s, "Not in 3270 mode, transfer canceled");
}

/**
 * ft_dft_data(): one Transfer Data structured field from the host.
 * @param {State} s @param {Uint8Array} field from its length on
 */
export function ftData(s, field) {
  const ft = s.ft;
  if (!ft) {
    s.log.warn("N5004 file transfer data with no transfer in progress");
    return;
  }
  if (field.length < 5) {
    s.log.warn("N5005 file transfer data too short");
    return;
  }
  const length = (field[0] << 8) | field[1];
  const type = (field[3] << 8) | field[4];
  switch (type) {
    case TR_OPEN_REQ: {
      let name;
      if (length === 0x23) name = field.subarray(28, 35);
      else if (length === 0x29) name = field.subarray(34, 41);
      else {
        abort(s, "Unknown DFT Open type from host", TR_OPEN_REQ);
        return;
      }
      ft.message = Buffer.from(name).toString("latin1").trimEnd() === "FT:MSG";
      s.log.info(`transfer open ${ft.message ? "message" : "data"}`);
      if (!ft.message) {
        if (ft.state === "await-ack") {
          ft.state = "running";
          if (ft.startTimer) clearTimeout(ft.startTimer);
          ft.startTimer = null;
        }
        ft.started = performance.now();
        ft.length = 0;
        running(s, ft);
      }
      ft.recnum = 1;
      reply(s, [TR_OPEN_ACK >> 8, TR_OPEN_ACK & 0xff]);
      return;
    }
    case TR_DATA_INSERT:
      dataInsert(s, ft, field);
      return;
    case TR_CLOSE_REQ:
      reply(s, [TR_CLOSE_REPLY >> 8, TR_CLOSE_REPLY & 0xff]);
      return;
    case TR_INSERT_REQ:
    case TR_SET_CUR_REQ:
      return;
    case TR_GET_REQ:
      s.log.warn("N5006 the host asked for data to receive, ignored");
      return;
    default:
      s.log.warn(
        `N5007 unsupported file transfer request 0x${type.toString(16)}`,
      );
  }
}

/** dft_data_insert() @param {State} s @param {Transfer} ft @param {Uint8Array} field */
function dataInsert(s, ft, field) {
  if (!ft.message && ft.state === "abort-wait") {
    abort(s, "Transfer canceled by user", TR_DATA_INSERT);
    return;
  }
  const size = field.length < 10 ? 0 : ((field[8] << 8) | field[9]) - 5;
  const data = field.subarray(10, 10 + Math.max(size, 0));

  if (ft.message) {
    dataAck(s, ft);
    const text = Buffer.from(data).toString("latin1");
    const dollar = text.indexOf("$");
    const message = dollar === -1 ? text : text.slice(0, dollar);
    if (message.startsWith("TRANS03")) complete(s, null);
    else if (ft.state === "abort-sent" && ft.abortString !== null)
      complete(s, ft.abortString);
    else complete(s, message);
    return;
  }

  if (data.length > 0) {
    let text = "";
    for (const c of data) {
      if (ft.cr && (c === 0x0d || c === 0x1a)) continue;
      let u;
      if (!ft.remap) u = c;
      else if (c < 0x20 || (c >= 0x80 && c < 0xa0 && c !== 0x9f)) u = c;
      // IND$FILE maps X'FF' to 0xff; x3270 makes it U+009F.
      else if (c === 0xff) u = 0x9f;
      else u = ebcdicToUnicode(s.codePage, ASC2FT[c], 0) || 0x20;
      text += String.fromCodePoint(u);
    }
    ft.length += Buffer.byteLength(text);
    if (text) s.emit({ type: "ft-data", text });
    running(s, ft);
  }
  dataAck(s, ft);
}

/** dft_data_ack() @param {State} s @param {Transfer} ft */
function dataAck(s, ft) {
  const n = ft.recnum++;
  reply(s, [
    TR_NORMAL_REPLY >> 8,
    TR_NORMAL_REPLY & 0xff,
    TR_RECNUM_HDR >> 8,
    TR_RECNUM_HDR & 0xff,
    (n >>> 24) & 0xff,
    (n >> 16) & 0xff,
    (n >> 8) & 0xff,
    n & 0xff,
  ]);
}

/** dft_abort(): tells the host to stop, and remembers why for when it answers. @param {State} s @param {string} why @param {number} code */
function abort(s, why, code) {
  const ft = /** @type {Transfer} */ (s.ft);
  ft.abortString = why;
  s.log.warn(`N5008 transfer aborted: ${why}`);
  reply(s, [
    code >> 8,
    TR_ERROR_REPLY,
    TR_ERROR_HDR >> 8,
    TR_ERROR_HDR & 0xff,
    TR_ERR_CMDFAIL >> 8,
    TR_ERR_CMDFAIL & 0xff,
  ]);
  if (ft.state === "running" || ft.state === "abort-wait") {
    ft.state = "abort-sent";
    s.ui?.out("ft", { state: "aborting", cause: "ui" });
  }
}

/** ft_gui_running() and ft_gui_update_length() @param {State} s @param {Transfer} ft */
function running(s, ft) {
  s.ui?.out("ft", { state: "running", bytes: ft.length, cause: "ui" });
}

/** An AID_SF reply carrying one Transfer Data field. @param {State} s @param {number[]} body */
function reply(s, body) {
  const length = body.length + 3;
  s.out.reset();
  s.out.push(AID_SF, length >> 8, length & 0xff, SF_TRANSFER_DATA, ...body);
  netOutput(s);
}
