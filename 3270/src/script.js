// task.c: the actions scripts use to read the screen and wait for the host.

import { CS_LINEDRAW } from "./charset.js";
import {
  add,
  CELL_ARRAYS,
  DBCS_LEFT,
  DBCS_NONE,
  DBCS_RIGHT,
  DBCS_RIGHT_WRAP,
  dbcsState,
  faAt,
  csAt,
  cursorMove,
  fieldAttribute,
  findFieldAttribute,
  findFieldAttributeRaw,
  isProtected,
  isZero,
  mdtSet,
  readBufferText,
} from "./ctlr.js";
import { ebcdicToUnicode, linedrawToUnicode } from "./charset.js";
import * as kybd from "./kybd.js";
import {
  CONNECTED_NVT,
  NOT_CONNECTED,
  RECONNECTING,
  RESOLVING,
  in3270,
  inNvt,
  inSscp,
  isConnected,
  kbwait,
} from "./session.js";
import { actionOutput, popupError } from "./ui.js";

/** @typedef {import("./session.js").State} State */
/** @typedef {import("./session.js").RunText} RunText */

const UPRIV2 = 0xe000;

/** x3270's toupper table leaves these alone, where JavaScript has an upper case for them. */
const NO_UPPER = new Set([
  0xb5, 0x131, 0x17f, 0x19b, 0x1c5, 0x1c8, 0x1cb, 0x1f2, 0x23f, 0x240, 0x252,
  0x25c, 0x261, 0x264, 0x265, 0x266, 0x26a, 0x26c, 0x282, 0x287, 0x29d, 0x29e,
  0x345, 0x3c2, 0x3d0, 0x3d1, 0x3d5, 0x3d6, 0x3f0, 0x3f1, 0x3f3, 0x3f5, 0x525,
  0x527, 0x529, 0x52b, 0x52d, 0x52f,
]);

/** u_toupper() @param {number} u */
function toUpper(u) {
  if (u >= 0x600 || NO_UPPER.has(u)) return u;
  const up = String.fromCodePoint(u).toUpperCase();
  return up.length === 1 ? up.charCodeAt(0) : u;
}

export function createScript() {
  return {
    /** output_wait_needed: the script has looked at the screen since the host last changed it. */
    outputWaitNeeded: false,
    /** Called, once, the next time the host changes the screen. @type {(() => void)[]} */
    onHostOutput: /** @type {(() => void)[]} */ ([]),
    /** The NVT bytes Expect() and NvtText() look at. */
    nvtSave: new Uint8Array(4096),
    nvtSaveIx: 0,
    nvtSaveCnt: 0,
    /** SaveInput()'s screens as fprint_screen() text, by name (undefined for the unnamed one). */
    savedScreens:
      /** @type {Map<string | undefined, {text: string, rows: number, cols: number}>} */ (
        new Map()
      ),
    /** @type {{status: string, buf: State, caddr: number} | null} what Snap() saved */
    snap: null,
    /** @type {NodeJS.Timeout | null} */
    asyncFail: null,
    asyncFailText: "",
    keyboardDisables: 0,
    /** Abort() was run: Session.run() stops and reports it. */
    abort: false,
  };
}
/** @typedef {ReturnType<typeof createScript>} Script */

/** check_argc() @param {State} s @param {string} name @param {number} n @param {number} min @param {number} max */
function checkArgc(s, name, n, min, max) {
  if (n >= min && n <= max) return true;
  const paren = name.includes("(") ? "" : "()";
  s.log.warn(`N3301 ${name}: ${n} arguments`);
  if (min === max)
    popupError(
      s,
      `${name}${paren} requires ${min} argument${min === 1 ? "" : "s"}`,
    );
  else if (max === min + 1)
    popupError(s, `${name}${paren} requires ${min} or ${max} arguments`);
  else popupError(s, `${name}${paren} requires ${min} to ${max} arguments`);
  return false;
}

/** action_args_are() @param {State} s @param {string} name @param {string[]} keywords */
function argsAre(s, name, keywords) {
  s.log.warn(`N3302 ${name}: bad keyword`);
  const list =
    keywords.length > 1
      ? `${keywords.slice(0, -1).join(", ")} or ${keywords.at(-1)}`
      : keywords[0];
  popupError(s, `${name}(): Parameter must be ${list}`);
  return false;
}

/** popup_an_error() for a task that waited, so the error lands in its own run-result. @param {State} s @param {RunText | null} out @param {string} text */
function popupErrorTo(s, out, text) {
  const current = s.runText;
  s.runText = out;
  popupError(s, text);
  s.runText = current;
}

/** atoi() @param {string} text */
function atoi(text) {
  const m = /^\s*([+-]?\d+)/.exec(text);
  return m ? Number(m[1]) | 0 : 0;
}

/** strtol() over the whole string, NaN if anything is left over. @param {string} text */
function strtolAll(text) {
  return /^\s*[+-]?\d+$/.test(text) ? Number(text) : NaN;
}

/** strtof() over the whole string, NaN if anything is left over. @param {string} text */
function strtofAll(text) {
  if (/^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text))
    return Math.fround(Number(text));
  if (/^\s*\+?inf(inity)?$/i.test(text)) return Infinity;
  return NaN;
}

const pconnected = (/** @type {State} */ s) =>
  s.cstate > NOT_CONNECTED && s.cstate !== RECONNECTING;
const halfConnected = (/** @type {State} */ s) =>
  s.cstate >= RESOLVING && s.cstate < CONNECTED_NVT;
export const ckbwait = (/** @type {State} */ s) =>
  s.options.aidWait && kbwait(s);

/** CAN_PROCEED: the screen is ready for a script to type into. @param {State} s */
function canProceed(s) {
  return (
    inSscp(s) ||
    (in3270(s) &&
      (s.hostPrefixes.includes("C") || (s.formatted && s.cursor !== 0)) &&
      !ckbwait(s)) ||
    (inNvt(s) && !(s.kybdlock & kybd.KL_AWAITING_FIRST))
  );
}

/**
 * dump_range(): len cells from first as text (or EBCDIC hex), a line per screen row.
 * buf is the live screen or a Snap() copy of it.
 * @param {State} s @param {State} buf @param {number} first @param {number} len @param {boolean} ascii
 */
function dumpRange(s, buf, first, len, ascii) {
  if (buf === s) s.script.outputWaitNeeded = true;
  const attr = findFieldAttributeRaw(buf, first);
  let zero = isZero(faAt(buf, attr));
  let faCs = csAt(buf, attr);
  let line = "";
  let any = false;
  for (let i = 0; i < len; i++) {
    const b = first + i;
    if (i && b % buf.cols === 0) {
      actionOutput(s, line);
      line = "";
      any = false;
    }
    // x3270 asks the live screen, even when dumping a Snap() copy.
    const d = dbcsState(s, b);
    if (!ascii) {
      let ebc = buf.ec[b];
      if (buf.ucs4[b]) {
        if (d === DBCS_RIGHT || d === DBCS_RIGHT_WRAP) continue;
        ebc = 0;
        if (buf.cs[b] !== CS_LINEDRAW)
          ebc = s.codePage.toEbcdic.get(buf.ucs4[b]) ?? 0;
      }
      line += `${any ? " " : ""}${ebc.toString(16).padStart(2, "0")}`;
    } else if (buf.fa[b]) {
      faCs = buf.cs[b];
      zero = isZero(buf.fa[b]);
      line += " ";
    } else if (zero) {
      line += " ";
    } else if (d === DBCS_RIGHT) {
      continue;
    } else if (d === DBCS_RIGHT_WRAP) {
      line += " ";
    } else if (buf.cs[b] === CS_LINEDRAW || buf.ucs4[b]) {
      let u =
        buf.cs[b] === CS_LINEDRAW
          ? linedrawToUnicode(buf.ucs4[b])
          : buf.ucs4[b];
      if (u >= UPRIV2 + 0x41 && u <= UPRIV2 + 0x5a) u -= UPRIV2;
      if (s.options.monoCase) u = toUpper(u);
      line += String.fromCodePoint(u);
    } else {
      let u = ebcdicToUnicode(s.codePage, buf.ec[b], faCs || buf.cs[b]);
      if (u && s.options.monoCase) u = toUpper(u);
      line += u ? String.fromCodePoint(u) : " ";
    }
    any = true;
  }
  if (any) actionOutput(s, line);
  return any;
}

/**
 * dump_fixed(): Ascii() and friends: everything, n cells from the cursor, n cells from
 * row,col or a rows x cols rectangle.
 * @param {State} s @param {string[]} args @param {number} origin @param {string} name
 * @param {boolean} ascii @param {State} buf @param {number} caddr
 */
function dumpFixed(s, args, origin, name, ascii, buf, caddr) {
  const relRows = buf.rows;
  const relCols = buf.cols;
  let row, col;
  let len = 0;
  let rows = 0,
    cols = 0;
  if (args.length === 0) {
    row = col = origin;
    len = relRows * relCols;
  } else if (args.length === 1) {
    row = Math.floor(caddr / relCols);
    col = caddr % relCols;
    len = atoi(args[0]);
  } else if (args.length === 3) {
    [row, col, len] = args.map(atoi);
  } else if (args.length === 4) {
    [row, col, rows, cols] = args.map(atoi);
  } else {
    s.log.warn(`N3303 ${name}: ${args.length} arguments`);
    popupError(s, `${name}() requires 0, 1, 3 or 4 arguments`);
    return false;
  }
  if (row < 0) {
    if (-row > relRows) {
      s.log.warn(`N3304 ${name}: invalid row ${row}`);
      popupError(s, `${name}(): Invalid row`);
      return false;
    }
    row += relRows;
  } else row -= origin;
  if (col < 0) {
    if (-col > relCols) {
      s.log.warn(`N3305 ${name}: invalid column ${col}`);
      popupError(s, `${name}(): Invalid column`);
      return false;
    }
    col += relCols;
  } else col -= origin;
  if (
    row < 0 ||
    row > relRows ||
    col < 0 ||
    col > relCols ||
    len < 0 ||
    (args.length < 4 && row * relCols + col + len > relRows * relCols) ||
    (args.length === 4 &&
      (cols < 0 || rows < 0 || col + cols > relCols || row + rows > relRows))
  ) {
    s.log.warn(`N3306 ${name}: invalid argument ${JSON.stringify(args)}`);
    popupError(s, `${name}(): Invalid argument`);
    return false;
  }
  let any = false;
  // b3270 reads past the screen (and dies) for a zero-length dump at its very end.
  if (args.length < 4 && row * relCols + col < relRows * relCols)
    any = dumpRange(s, buf, row * relCols + col, len, ascii);
  if (args.length === 4)
    for (let i = 0; i < rows; i++)
      any = dumpRange(s, buf, (row + i) * relCols + col, cols, ascii) || any;
  if (!any) actionOutput(s, "");
  return true;
}

/** dump_field(): AsciiField() and EbcdicField(). @param {State} s @param {string[]} args @param {string} name @param {boolean} ascii */
function dumpField(s, args, name, ascii) {
  if (!checkArgc(s, name, args.length, 0, 0)) return false;
  if (!s.formatted) {
    s.log.warn(`N3307 ${name}: screen is not formatted`);
    popupError(s, `${name}(): Screen is not formatted`);
    return false;
  }
  const size = s.rows * s.cols;
  const start = (findFieldAttribute(s, s.cursor) + 1) % size;
  let len = 0;
  for (let b = start; !s.fa[b]; b = (b + 1) % size) {
    len++;
    if ((b + 1) % size === start) break;
  }
  dumpRange(s, s, start, len, ascii);
  return true;
}

/** status_string(): the 11 fields of s3270's prompt. @param {State} s */
export function statusString(s) {
  const prot =
    s.formatted && isProtected(fieldAttribute(s, s.cursor)) ? "P" : "U";
  const connection = s.cstate > RECONNECTING ? `C(${s.connHost})` : "N";
  let mode = "N";
  if (s.cstate > NOT_CONNECTED)
    mode = inNvt(s) ? (s.linemode ? "L" : "C") : in3270(s) ? "I" : "P";
  return [
    s.kybdlock ? "L" : "U",
    s.formatted ? "F" : "U",
    prot,
    connection,
    mode,
    s.model,
    s.rows,
    s.cols,
    Math.floor(s.cursor / s.cols),
    s.cursor % s.cols,
    "0x0",
  ].join(" ");
}

/** snap_save() @param {State} s */
function snapSave(s) {
  s.script.outputWaitNeeded = true;
  const buf = { ...s };
  for (const name of CELL_ARRAYS)
    /** @type {any} */ (buf)[name] = s[name].slice(0, s.rows * s.cols);
  s.script.snap = { status: statusString(s), buf, caddr: s.cursor };
}

/**
 * Resolves with what check() returns once that is not null, checked whenever the session
 * settles, or with "timeout" after ms (never, if ms is negative).
 * @template T @param {State} s @param {() => T | null} check @param {number} ms
 * @returns {Promise<T | "timeout">}
 */
function waitUntil(s, check, ms) {
  const now = check();
  if (now !== null) return Promise.resolve(now);
  return new Promise((resolve) => {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const settled = () => {
      const result = check();
      if (result === null) return;
      clearTimeout(timer);
      s.settled.delete(settled);
      resolve(result);
    };
    s.settled.add(settled);
    if (ms >= 0)
      timer = setTimeout(() => {
        s.settled.delete(settled);
        resolve("timeout");
      }, ms);
  });
}

/** Waits for the host to change the screen. @param {State} s @param {() => void} [then] */
function nextHostOutput(s, then) {
  const seen = { done: false, canceled: false };
  s.script.onHostOutput.push(() => {
    if (seen.canceled) return;
    seen.done = true;
    then?.();
  });
  return seen;
}

/** grab_string(): len bytes of screen text from baddr, for Wait(StringAt). @param {State} s @param {number} baddr @param {number} len */
function grabString(s, baddr, len) {
  const size = s.rows * s.cols;
  let zero = isZero(fieldAttribute(s, baddr));
  let text = "";
  for (let i = 0; Buffer.byteLength(text) < len; i++) {
    const b = (baddr + i) % size;
    const d = dbcsState(s, b);
    if (s.fa[b]) {
      zero = isZero(s.fa[b]);
      text += " ";
    } else if (zero) {
      text += " ";
    } else if (d === DBCS_RIGHT || d === DBCS_RIGHT_WRAP) {
      continue;
    } else if (s.cs[b] === CS_LINEDRAW || s.ucs4[b]) {
      let u =
        s.cs[b] === CS_LINEDRAW ? linedrawToUnicode(s.ucs4[b]) : s.ucs4[b];
      if (u >= UPRIV2 + 0x41 && u <= UPRIV2 + 0x5a) u -= UPRIV2;
      if (s.options.monoCase) u = toUpper(u);
      text += String.fromCodePoint(u);
    } else {
      let u = ebcdicToUnicode(s.codePage, s.ec[b], s.cs[b]);
      if (u && s.options.monoCase) u = toUpper(u);
      text += u ? String.fromCodePoint(u) : " ";
    }
  }
  return text;
}

/**
 * parse_rco(): an offset, or a 1-based row and column where negatives count from the end.
 * Returns the buffer address, or null after reporting the error.
 * @param {State} s @param {string} keyword @param {string[]} args
 */
function parseRco(s, keyword, args) {
  const size = s.rows * s.cols;
  if (args.length === 1) {
    const offset = /^\s*[+-]?\d+$/.test(args[0]) ? Number(args[0]) : NaN;
    // strtoul() takes "-n" as a huge number, so only "-0" gets through.
    if (!(offset >= 0 && offset < size) || (offset > 0 && /-/.test(args[0]))) {
      s.log.warn(`N3308 Wait(${keyword}): invalid offset ${args[0]}`);
      popupError(s, `Wait(${keyword}): Invalid offset '${args[0]}'`);
      return null;
    }
    return offset;
  }
  let row = strtolAll(args[0]);
  if (Number.isNaN(row) || row >= s.rows || -row > s.rows) {
    s.log.warn(`N3309 Wait(${keyword}): invalid row ${args[0]}`);
    popupError(s, `Wait(${keyword}): Invalid row '${args[0]}'`);
    return null;
  }
  if (row < 0) row += s.rows + 1;
  let col = strtolAll(args[1]);
  if (Number.isNaN(col) || col >= s.cols) {
    s.log.warn(`N3310 Wait(${keyword}): invalid column ${args[1]}`);
    popupError(s, `Wait(${keyword}): Invalid column '${args[1]}'`);
    return null;
  }
  if (col < 0) {
    if (-col > s.cols) {
      s.log.warn(`N3311 Wait(${keyword}): invalid column ${args[1]}`);
      // x3270 quotes the row here.
      popupError(s, `Wait(${keyword}): Invalid column '${args[0]}'`);
      return null;
    }
    col += s.cols + 1;
  }
  return (row - 1) * s.cols + (col - 1);
}

const WAIT_KEYWORDS = [
  { keyword: "3270mode", min: 0, max: 0, state: "3270mode" },
  { keyword: "3270", min: 0, max: 0, state: "3270mode" },
  { keyword: "nvtmode", min: 0, max: 0, state: "nvtmode" },
  { keyword: "ansi", min: 0, max: 0, state: "nvtmode" },
  { keyword: "disconnect", min: 0, max: 0, state: "disconnect" },
  { keyword: "inputfield", min: 0, max: 0, state: "inputfield" },
  { keyword: "output", min: 0, max: 0, state: "output" },
  { keyword: "unlock", min: 0, max: 0, state: "unlock" },
  { keyword: "seconds", min: 0, max: 0, state: "seconds" },
  { keyword: "cursorat", min: 1, max: 2, state: "cursorat" },
  { keyword: "stringat", min: 2, max: 3, state: "stringat" },
  { keyword: "inputfieldat", min: 1, max: 2, state: "inputfieldat" },
];

/**
 * Wait([timeout,] [keyword [,args]]): blocks the run until the screen or connection is
 * in the state asked for. The checks after the first follow run_taskq().
 * @param {State} s @param {...any} argv
 */
async function wait(s, ...argv) {
  const out = s.runText;
  let args = argv.map(String);
  let tmo = args.length ? strtofAll(args[0]) : NaN;
  if (tmo >= 0) args = args.slice(1);
  else tmo = -1;
  let state = "inputfield";
  if (args.length) {
    const entry = WAIT_KEYWORDS.find(
      (k) => k.keyword === args[0].toLowerCase(),
    );
    if (!entry)
      return argsAre(s, "Wait", [
        "inputfield",
        "nvtmode",
        "3270mode",
        "output",
        "seconds",
        "disconnect",
        "unlock",
        "cursorat",
        "stringat",
        "inputfieldat",
      ]);
    if (
      !checkArgc(
        s,
        `Wait(${entry.keyword})`,
        args.length - 1,
        entry.min,
        entry.max,
      )
    )
      return false;
    state = entry.state;
  }
  const notConnected = () => {
    s.log.warn(`N3312 Wait(${state}): not connected`);
    popupError(s, "Wait(): Not connected");
    return false;
  };
  const connected = isConnected(s) || halfConnected(s);
  let baddr = -1;
  let match = "";
  if (state === "cursorat" || state === "inputfieldat") {
    const parsed = parseRco(s, state, args.slice(1));
    if (parsed === null) return false;
    baddr = parsed;
  } else if (state === "stringat") {
    if (!connected) return notConnected();
    const parsed = parseRco(s, state, args.slice(1, -1));
    if (parsed === null) return false;
    baddr = parsed;
    match = args.at(-1) ?? "";
  }
  if (state !== "seconds" && state !== "disconnect" && !connected)
    return notConnected();

  const size = s.rows * s.cols;
  /** @type {Record<string, () => boolean>} */
  const met = {
    "3270mode": () => in3270(s),
    nvtmode: () => inNvt(s),
    disconnect: () => !isConnected(s),
    inputfield: () => canProceed(s),
    output: () => !s.script.outputWaitNeeded,
    unlock: () => !kbwait(s),
    seconds: () => false,
    cursorat: () => s.cursor === baddr,
    stringat: () =>
      baddr < size && grabString(s, baddr, Buffer.byteLength(match)) === match,
    inputfieldat: () =>
      baddr < size &&
      findFieldAttribute(s, baddr) >= 0 &&
      !isProtected(fieldAttribute(s, baddr)),
  };
  if (met[state]()) return true;

  const keyword = state;
  const output = state === "output" ? nextHostOutput(s) : null;
  s.log.debug(`Wait(${keyword}) blocks`);
  const result = await waitUntil(
    s,
    () => {
      const stillConnected = pconnected(s);
      if (state === "nvtmode" || state === "3270mode") {
        if (!stillConnected) return "disconnected";
        if (!(state === "nvtmode" ? inNvt(s) : in3270(s))) return null;
        state = "inputfield";
      }
      if (state === "unlock") return kbwait(s) ? null : "ok";
      if (state === "disconnect")
        return !isConnected(s) || s.cstate === RECONNECTING ? "ok" : null;
      if (state === "seconds") return null;
      if (!stillConnected) return "disconnected";
      if (state === "output") return output?.done ? "ok" : null;
      if (state === "cursorat") return s.cursor === baddr ? "ok" : null;
      if (state === "stringat" || state === "inputfieldat")
        return met[state]() ? "ok" : null;
      if (!canProceed(s)) return null;
      const connecting =
        halfConnected(s) ||
        (isConnected(s) && s.kybdlock & kybd.KL_AWAITING_FIRST);
      return connecting ? null : "ok";
    },
    tmo < 0 ? -1 : Math.max(1, Math.trunc(tmo * 1000)),
  );
  if (output) output.canceled = true;
  if (result === "ok") return true;
  if (result === "timeout") {
    if (keyword === "seconds") return true;
    s.log.warn(`N3313 Wait(${keyword}) timed out`);
    popupErrorTo(s, out, `Wait(${keyword}): Timed out`);
    return false;
  }
  s.log.warn(`N3314 Wait(${keyword}): host disconnected`);
  popupErrorTo(s, out, "Host disconnected");
  return false;
}

/** Snap(): saves the screen, then reads from that copy. @param {State} s @param {...any} argv */
async function snap(s, ...argv) {
  const out = s.runText;
  const args = argv.map(String);
  const t = s.script;
  if (args.length === 0) {
    snapSave(s);
    return true;
  }
  const kw = args[0].toLowerCase();
  if (kw === "wait") {
    const tmo = args.length > 1 ? strtolAll(args[1]) : NaN;
    const maxp = tmo >= 0 ? 3 : 2;
    if (args.length !== maxp) {
      s.log.warn(`N3315 Snap(Wait): ${args.length} arguments`);
      popupError(
        s,
        `Too ${args.length > maxp ? "many" : "few"} arguments to Snap(Wait)`,
      );
      return false;
    }
    if (args[maxp - 1].toLowerCase() !== "output") {
      s.log.warn(`N3316 Snap(Wait): bad parameter ${args[maxp - 1]}`);
      popupError(s, "Unknown parameter to Snap(Wait)");
      return false;
    }
    if (!(isConnected(s) || halfConnected(s))) {
      s.log.warn("N3317 Snap(Wait): not connected");
      popupError(s, "Snap(): Not connected");
      return false;
    }
    if (!t.outputWaitNeeded) {
      snapSave(s);
      return true;
    }
    const output = nextHostOutput(s, () => snapSave(s));
    const result = await waitUntil(
      s,
      () => (output.done ? "ok" : pconnected(s) ? null : "disconnected"),
      tmo >= 0 ? Math.max(1, tmo * 1000) : -1,
    );
    output.canceled = true;
    if (result === "ok") return true;
    if (result === "timeout") {
      s.log.warn("N3318 Snap(Wait) timed out");
      popupErrorTo(s, out, "Wait(Unknown): Timed out");
      return false;
    }
    s.log.warn("N3319 Snap(Wait): host disconnected");
    popupErrorTo(s, out, "Host disconnected");
    return false;
  }
  if (["save", "status", "rows", "cols"].includes(kw) && args.length !== 1) {
    s.log.warn(`N3320 Snap(${kw}): extra arguments`);
    popupError(s, "Snap(): Extra argument(s)");
    return false;
  }
  if (kw === "save") {
    snapSave(s);
    return true;
  }
  const readers = ["ascii", "ascii1", "ebcdic", "ebcdic1", "readbuffer"];
  if (!["status", "rows", "cols", ...readers].includes(kw))
    return argsAre(s, "Snap", [
      "save",
      "status",
      "rows",
      "cols",
      "Wait",
      "Ascii",
      "Ascii1",
      "Ebcdic",
      "Ebcdic1",
      "ReadBuffer",
    ]);
  if (!t.snap) {
    s.log.warn(`N3321 Snap(${kw}): nothing saved`);
    popupError(s, "Snap(): No saved state");
    return false;
  }
  const { buf, caddr } = t.snap;
  const rest = args.slice(1);
  if (kw === "status") actionOutput(s, t.snap.status);
  else if (kw === "rows") actionOutput(s, String(buf.rows));
  else if (kw === "cols") actionOutput(s, String(buf.cols));
  else if (kw === "ascii")
    return dumpFixed(s, rest, 0, "Ascii", true, buf, caddr);
  else if (kw === "ascii1")
    return dumpFixed(s, rest, 1, "Ascii1", true, buf, caddr);
  else if (kw === "ebcdic")
    return dumpFixed(s, rest, 0, "Ebcdic", false, buf, caddr);
  else if (kw === "ebcdic1")
    return dumpFixed(s, rest, 1, "Ebcdic1", false, buf, caddr);
  else return readBuffer(s, buf, rest);
  return true;
}

/**
 * ReadBuffer(Ascii|Ebcdic|Unicode|Field): the screen, a line per row, or the cursor's field.
 * @param {State} s @param {State} buf @param {string[]} args
 */
function readBuffer(s, buf, args) {
  /** @type {"ascii" | "ebcdic" | "unicode"} */
  let mode = "ascii";
  let field = false;
  for (const arg of args) {
    const word = arg.toLowerCase();
    if ("ascii".startsWith(word)) mode = "ascii";
    else if ("ebcdic".startsWith(word)) mode = "ebcdic";
    else if ("unicode".startsWith(word)) mode = "unicode";
    else if ("field".startsWith(word)) field = true;
    else
      return argsAre(s, "ReadBuffer", ["ascii", "ebcdic", "unicode", "field"]);
  }
  if (buf === s) s.script.outputWaitNeeded = true;
  if (!field) {
    for (const line of readBufferText(buf, mode)) actionOutput(s, line);
    return true;
  }
  if (!s.formatted) {
    s.log.warn("N3322 ReadBuffer(Field): screen is not formatted");
    popupError(s, "ReadBuffer(): no field");
    return false;
  }
  // x3270 takes the field and cursor from the live screen, even for Snap(ReadBuffer).
  const start = findFieldAttribute(s, s.cursor);
  const at = (/** @type {number} */ b) =>
    `${Math.floor(b / s.cols) + 1} ${(b % s.cols) + 1}`;
  actionOutput(s, `Start1: ${at(start)}`);
  actionOutput(s, `StartOffset: ${start}`);
  actionOutput(s, `Cursor1: ${at(s.cursor)}`);
  actionOutput(s, `CursorOffset: ${s.cursor}`);
  actionOutput(s, `Contents: ${readBufferText(buf, mode, start)[0]}`);
  return true;
}

/**
 * Expect(text[, timeout]): waits for the host to send text in NVT mode.
 * @param {State} s @param {...any} argv
 */
async function expect(s, ...argv) {
  const out = s.runText;
  const args = argv.map(String);
  if (!checkArgc(s, "Expect", args.length, 1, 2)) return false;
  if (!inNvt(s)) {
    s.log.warn("N3323 Expect(): not in NVT mode");
    popupError(s, "Expect() is valid only when connected in NVT mode");
    return false;
  }
  const tmo = args.length === 2 ? atoi(args[1]) : 30;
  if (tmo < 1 || tmo > 600) {
    s.log.warn(`N3324 Expect(): invalid timeout ${args[1]}`);
    popupError(s, `Expect(): Invalid timeout: ${args[1]}`);
    return false;
  }
  const text = expandExpect(args[0]);
  const result = await waitUntil(
    s,
    () =>
      expectMatches(s, text) ? "ok" : pconnected(s) ? null : "disconnected",
    tmo * 1000,
  );
  if (result === "ok") return true;
  if (result === "timeout") {
    s.log.warn("N3325 Expect() timed out");
    popupErrorTo(s, out, "Expect(): Timed out");
    return false;
  }
  s.log.warn("N3326 Expect(): host disconnected");
  popupErrorTo(s, out, "Host disconnected");
  return false;
}

/** expand_expect(): backslash escapes, as bytes. @param {string} text */
function expandExpect(text) {
  /** @type {number[]} */
  const t = [];
  let state = "base";
  let n = 0;
  let nd = 0;
  for (const c of Buffer.from(text)) {
    const ch = String.fromCharCode(c);
    if (state === "base") {
      if (ch === "\\") state = "bs";
      else t.push(c);
    } else if (state === "bs") {
      state = "base";
      if (ch === "x") {
        n = nd = 0;
        state = "x";
      } else if (ch === "r") t.push(0x0d);
      else if (ch === "n") t.push(0x0a);
      else if (ch === "b") t.push(0x08);
      else if (ch === "t") t.push(0x09);
      else if (ch >= "0" && ch <= "7") {
        nd = 1;
        n = c - 0x30;
        state = "o";
      } else t.push(c);
    } else if (state === "o") {
      if (nd < 3 && ch >= "0" && ch <= "7") {
        n = n * 8 + (c - 0x30);
        nd++;
      } else {
        t.push(n & 0xff, c);
        state = "base";
      }
    } else if (/[0-9a-f]/i.test(ch)) {
      n = n * 16 + parseInt(ch, 16);
      nd++;
    } else {
      t.push(nd ? n & 0xff : 0x78, c);
      state = "base";
    }
  }
  return Buffer.from(t);
}

/** expect_matches(): finds text in the saved NVT bytes and drops everything up to its end. @param {State} s @param {Buffer} text */
function expectMatches(s, text) {
  const t = s.script;
  const ix = (t.nvtSaveIx + t.nvtSave.length - t.nvtSaveCnt) % t.nvtSave.length;
  const saved = Buffer.alloc(t.nvtSaveCnt);
  for (let i = 0; i < t.nvtSaveCnt; i++)
    saved[i] = t.nvtSave[(ix + i) % t.nvtSave.length];
  const at = saved.indexOf(text);
  if (at < 0) return false;
  t.nvtSaveCnt -= at + text.length;
  return true;
}

/** NvtText(): the NVT data since the last call, with control characters escaped. @param {State} s @param {...any} args */
function nvtText(s, ...args) {
  if (!checkArgc(s, "NvtText", args.length, 0, 0)) return false;
  const t = s.script;
  if (!t.nvtSaveCnt) {
    actionOutput(s, "");
    return true;
  }
  const ix = (t.nvtSaveIx + t.nvtSave.length - t.nvtSaveCnt) % t.nvtSave.length;
  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < t.nvtSaveCnt; i++) {
    const c = t.nvtSave[(ix + i) % t.nvtSave.length];
    let escaped = "";
    if (c === 0x0a) escaped = "\\n";
    else if (c === 0x0d) escaped = "\\r";
    else if (c === 0x08) escaped = "\\b";
    else if (c < 0x20) escaped = `\\${c.toString(8).padStart(3, "0")}`;
    else if (c === 0x5c) escaped = "\\\\";
    if (escaped) bytes.push(...Buffer.from(escaped));
    else bytes.push(c);
  }
  actionOutput(s, Buffer.from(bytes).toString());
  t.nvtSaveCnt = 0;
  t.nvtSaveIx = 0;
  return true;
}

/** Fail([-async,] text...): fails the run, or pops the error up a moment later. @param {State} s @param {...any} argv */
function fail(s, ...argv) {
  const args = argv.map(String);
  const t = s.script;
  if (args.length && args[0].toLowerCase() === "-async") {
    if (t.asyncFail) {
      s.log.warn("N3327 Fail(-async): already pending");
      popupError(s, "Fail(): async already pending");
      return false;
    }
    t.asyncFailText = args.length > 1 ? args.slice(1).join(" ") : "Failed";
    t.asyncFail = setTimeout(() => asyncFail(s), 0);
    return true;
  }
  s.log.info("N3329 Fail()");
  popupError(s, args.length ? args.join(" ") : "Failed");
  return false;
}

/**
 * Pops up a pending Fail(-async). b3270 does that on its next turn of the event loop, which
 * comes before it can read another run, so Session.run() calls this first.
 * @param {State} s
 */
export function asyncFail(s) {
  const t = s.script;
  if (!t.asyncFail) return;
  clearTimeout(t.asyncFail);
  t.asyncFail = null;
  s.log.warn(`N3328 Fail(-async): ${t.asyncFailText}`);
  popupError(s, t.asyncFailText);
}

/** Pause(): waits unlockDelayMs. @param {State} s @param {...any} args */
async function pause(s, ...args) {
  if (!checkArgc(s, "Pause", args.length, 0, 0)) return false;
  if (!s.options.unlockDelayMs) return true;
  await waitUntil(s, () => null, s.options.unlockDelayMs);
  return true;
}

/** KeyboardDisable([true|false|forceenable]): only keymaps look at it, and b3270 has none. @param {State} s @param {...any} argv */
function keyboardDisable(s, ...argv) {
  const args = argv.map(String);
  const t = s.script;
  if (!checkArgc(s, "KeyboardDisable", args.length, 0, 1)) return false;
  const kw = args.length ? args[0].toLowerCase() : "true";
  if (kw === "true") t.keyboardDisables++;
  else if (kw === "false")
    t.keyboardDisables = Math.max(0, t.keyboardDisables - 1);
  else if (kw === "forceenable") t.keyboardDisables = 0;
  else return argsAre(s, "KeyboardDisable", ["true", "false", "forceenable"]);
  return true;
}

/**
 * fprint_screen() as text, the way SaveInput() keeps a screen: every cell, input fields even when
 * they don't display, one line per row.
 * @param {State} s
 */
function screenText(s) {
  const attr = findFieldAttributeRaw(s, 0);
  let fa = faAt(s, attr);
  let faCs = csAt(s, attr);
  let text = "";
  for (let b = 0; b < s.rows * s.cols; b++) {
    if (b && b % s.cols === 0) text += "\n";
    if (s.fa[b]) {
      fa = s.fa[b];
      faCs = s.cs[b];
      text += " ";
    } else if (isZero(fa) && isProtected(fa)) {
      text += " ";
    } else if (s.ucs4[b]) {
      if (dbcsState(s, b) === DBCS_RIGHT) continue;
      text += String.fromCodePoint(
        s.cs[b] === CS_LINEDRAW ? linedrawToUnicode(s.ucs4[b]) : s.ucs4[b],
      );
    } else {
      const u = ebcdicToUnicode(s.codePage, s.ec[b], s.cs[b] || faCs);
      text += u ? String.fromCodePoint(u) : " ";
    }
  }
  return `${text}\n`;
}

/** SaveInput([name]) @param {State} s @param {...any} args */
function saveInput(s, ...args) {
  if (!checkArgc(s, "SaveInput", args.length, 0, 1)) return false;
  if (!in3270(s)) return true;
  const name = args.length ? String(args[0]) : undefined;
  const text = screenText(s);
  s.script.savedScreens.set(name, { text, rows: s.rows, cols: s.cols });
  return true;
}

/** RestoreInput([name]): pastes a saved screen back over the input fields. @param {State} s @param {...any} args */
function restoreInput(s, ...args) {
  if (!checkArgc(s, "RestoreInput", args.length, 0, 1)) return false;
  if (!in3270(s) || s.kybdlock) return true;
  const name = args.length ? String(args[0]) : undefined;
  const saved = s.script.savedScreens.get(name);
  if (!saved) {
    s.log.warn(`N3335 RestoreInput(): no screen ${name}`);
    popupError(s, `RestoreInput: No such screen: ${name ?? "(default)"}`);
    return false;
  }
  if (saved.rows !== s.rows || saved.cols !== s.cols) {
    s.log.warn(`N3336 RestoreInput(): saved at ${saved.rows}x${saved.cols}`);
    popupError(s, "RestoreInput: Rows/Columns mismatch");
    return false;
  }
  const oldCursor = s.cursor;
  s.cursor = 0;
  // toggle_toggle(): the toggle flips without telling anyone.
  const overlaid = s.options.overlayPaste;
  s.options.overlayPaste = true;
  kybd.emulateInput(s, saved.text, true);
  s.options.overlayPaste = overlaid;
  cursorMove(s, oldCursor);
  return true;
}

/**
 * b3270's ClearRegion(row, column, rows, columns): blanks the unprotected cells of a 1-origin
 * rectangle and marks their fields modified. Like b3270 it reports bad coordinates but clears anyway,
 * only here cells off the screen are skipped instead of overrunning the buffer.
 * @param {State} s @param {...any} args
 */
function clearRegion(s, ...args) {
  if (!checkArgc(s, "ClearRegion", args.length, 4, 4)) return false;
  const [row, column, rows, columns] = args.map((a) => atoi(String(a)));
  if (row <= 0 || row > s.rows || column <= 0 || column > s.cols) {
    s.log.warn(`N3332 ClearRegion(): invalid coordinates ${row},${column}`);
    popupError(s, "ClearRegion(): invalid coordinates");
  }
  if (
    rows < 0 ||
    columns < 0 ||
    row - 1 + rows > s.rows ||
    column - 1 + columns > s.cols
  ) {
    s.log.warn(`N3333 ClearRegion(): invalid size ${rows}x${columns}`);
    popupError(s, "ClearRegion(): invalid size");
  }
  const size = s.rows * s.cols;
  const lastRow = Math.min(row - 1 + rows, s.rows);
  const lastCol = Math.min(column - 1 + columns, s.cols);
  for (let r = Math.max(row - 1, 0); r < lastRow; r++)
    for (let c = Math.max(column - 1, 0); c < lastCol; c++) {
      const b = r * s.cols + c;
      if (s.fa[b] || isProtected(fieldAttribute(s, b))) continue;
      if (s.ec[b] === 0x0e || s.ec[b] === 0x0f) continue;
      const state = dbcsState(s, b);
      if (state === DBCS_NONE) add(s, b, 0x40, s.cs[b]);
      if (state === DBCS_LEFT) {
        add(s, b, 0x40, s.cs[b]);
        add(s, (b + 1) % size, 0x40, s.cs[b]);
      }
      if (state === DBCS_RIGHT) {
        add(s, (b + size - 1) % size, 0x40, s.cs[b]);
        add(s, b, 0x40, s.cs[b]);
      }
      mdtSet(s, b);
    }
  return true;
}

/**
 * The task.c actions. The waiting ones return a Promise, which Session.run() awaits.
 * @type {Record<string, (s: State, ...args: any[]) => boolean | Promise<boolean>>}
 */
export const SCRIPT_ACTIONS = {
  Abort: (s, ...args) => {
    if (!checkArgc(s, "Abort", args.length, 0, 0)) return false;
    s.script.abort = true;
    return true;
  },
  AnsiText: nvtText,
  Ascii: (s, ...args) =>
    dumpFixed(s, args.map(String), 0, "Ascii", true, s, s.cursor),
  Ascii1: (s, ...args) =>
    dumpFixed(s, args.map(String), 1, "Ascii1", true, s, s.cursor),
  AsciiField: (s, ...args) => dumpField(s, args, "AsciiField", true),
  Bell: (s, ...args) => {
    if (!checkArgc(s, "Bell", args.length, 0, 0)) return false;
    actionOutput(s, "(ding)");
    return true;
  },
  ClearRegion: clearRegion,
  Capabilities: (s, ...args) => {
    if (!args.length) return true;
    s.log.warn("N3330 Capabilities(): cannot set");
    popupError(s, "Capabilities(): cannot set on this task type");
    return false;
  },
  Ebcdic: (s, ...args) =>
    dumpFixed(s, args.map(String), 0, "Ebcdic", false, s, s.cursor),
  Ebcdic1: (s, ...args) =>
    dumpFixed(s, args.map(String), 1, "Ebcdic1", false, s, s.cursor),
  EbcdicField: (s, ...args) => dumpField(s, args, "EbcdicField", false),
  Echo: (s, ...args) => {
    actionOutput(s, args.length ? args.join(" ") : " ");
    return true;
  },
  Expect: expect,
  Fail: fail,
  ignore: () => true,
  Info: (s, ...args) => {
    if (!checkArgc(s, "Info", args.length, 1, 1)) return false;
    s.ui?.out("popup", { type: "info", text: String(args[0]) });
    return true;
  },
  KeyboardDisable: keyboardDisable,
  NvtText: nvtText,
  Pause: pause,
  RestoreInput: restoreInput,
  SaveInput: saveInput,
  ReadBuffer: (s, ...args) => readBuffer(s, s, args.map(String)),
  Snap: snap,
  Wait: wait,
};
