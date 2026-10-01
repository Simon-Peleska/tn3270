import { codePage } from "./charset.js";
import { scrollBufInit } from "./scroll.js";
import { ALIASES, CODE_PAGES } from "./codepages.js";
import { erase, newCells, setRowsCols } from "./ctlr.js";
import {
  in3270,
  inNvt,
  MODEL_SIZES,
  NOT_CONNECTED,
  TELNET_PENDING,
} from "./session.js";
import { insertMode } from "./kybd.js";
import {
  netCharmode,
  netLinemode,
  netNopSeconds,
  netSetDefaultTermtype,
} from "./telnet.js";
import {
  actionOutput,
  popupError,
  reportTerminalName,
  screenChangeModel,
  screenDisp,
  statusFlag,
} from "./ui.js";

// Port of x3270's Common/toggles.c: Set(), Toggle() and every setting b3270 reports.
// Values live in s.options under their b3270 names; an unset string is null.

/** @typedef {import("./session.js").State} State */

/** The classic toggles b3270 supports, in toggle_names[] order. */
export const CLASSIC = [
  "monoCase",
  "altCursor",
  "cursorBlink",
  "showTiming",
  "trace",
  "lineWrap",
  "blankFill",
  "screenTrace",
  "crosshair",
  "visibleControl",
  "aidWait",
  "overlayPaste",
  "typeahead",
  "aplMode",
  "alwaysInsert",
  "rightToLeftMode",
  "reverseInputMode",
  "insertMode",
  "underscoreBlankFill",
];

const OK = 0,
  FAIL = 1,
  DEFERRED = 2;

/**
 * An extended toggle: a typed setting with its own upcall.
 * @typedef {{
 *   name: string,
 *   type: "string" | "boolean" | "int",
 *   set: (s: State, typed: string, value: string, defer: boolean) => number,
 *   done?: typeof modelDone,
 *   canon?: (s: State, value: any) => string | null,
 *   get?: (s: State) => any,
 *   noAddress?: boolean,
 * }} Extended
 */

/** @param {State} s @param {string} code @param {string} text */
function reject(s, code, text) {
  s.log.warn(`${code} ${text.replace(/\n/g, " ")}`);
  popupError(s, text);
  return FAIL;
}

/** boolstr() @param {string} text @returns {boolean | null} */
export function boolstr(text) {
  const t = text.toLowerCase();
  if (["true", "t", "set", "on", "1"].includes(t)) return true;
  if (["false", "f", "clear", "off", "0"].includes(t)) return false;
  return null;
}
const BOOL_ERROR = "value must be true or false";

/**
 * strtoul(text) cast to int, as the x3270 toggles check it: null unless all of text is a
 * number whose unsigned long survives the round trip through int.
 * @param {string} text
 */
function strtoulInt(text) {
  const m = /^[ \t\n\v\f\r]*([+-]?)(\d+)$/.exec(text);
  if (!m) return null;
  const MAX = (1n << 64n) - 1n;
  let l = BigInt(m[2]);
  if (l > MAX) l = MAX;
  else if (m[1] === "-") l = -l & MAX;
  const asInt = Number(BigInt.asIntN(32, l));
  if (BigInt.asUintN(64, BigInt(asInt)) !== l) return null;
  return asInt;
}

/** sscanf's %u: whitespace, a sign, digits; wraps like glibc does. @param {string} text @param {number} at */
function scanUnsigned(text, at) {
  const m = /^[ \t\n\v\f\r]*([+-]?)(\d+)/.exec(text.slice(at));
  if (!m) return null;
  const MAX = (1n << 64n) - 1n;
  let l = BigInt(m[2]);
  if (l > MAX) l = MAX;
  else if (m[1] === "-") l = -l & MAX;
  return { value: Number(BigInt.asUintN(32, l)), end: at + m[0].length };
}

/** canonical_oversize_x(): "COLSxROWS" exactly, as sscanf("%u%c%u%c") reads it. @param {string | null} text */
export function canonicalOversize(text) {
  if (text === null) return null;
  const cols = scanUnsigned(text, 0);
  if (!cols || !"xX".includes(text[cols.end] ?? "\0")) return null;
  const rows = scanUnsigned(text, cols.end + 1);
  if (!rows || rows.end !== text.length) return null;
  return {
    canon: `${cols.value}x${rows.value}`,
    cols: cols.value,
    rows: rows.value,
  };
}

/** canonical_model_x(): "3279-4-E", "IBM-3278-2" or just "4". @param {string | null} text @param {boolean} extended */
export function canonicalModel(text, extended) {
  if (text === null) return null;
  const m = /^(?:[Ii][Bb][Mm]-)?(?:([2-5])|327([89])-([2-5])(?:-[Ee])?)$/.exec(
    text,
  );
  if (!m) return null;
  const color = m[2] ?? "9";
  const model = Number(m[1] ?? m[3]);
  return {
    canon: `327${color}-${model}${extended ? "-E" : ""}`,
    model,
    mode3279: color === "9",
  };
}

/** canonical_cs(): the code page's canonical name, if the name is exactly a known one. @param {string | null} value */
function canonicalCs(value) {
  if (value === null) return null;
  const name = /^\d+$/.test(value) ? `cp${value}` : value;
  const aliases = /** @type {Record<string, string>} */ (ALIASES);
  if (aliases[name]) return aliases[name];
  if (name in CODE_PAGES) return name;
  return null;
}

const NTIM_NAMES = ["line", "character", "characterCrLf"];

/** check_rows_cols() @param {State} s @param {number} model @param {number} ovc @param {number} ovr */
function checkRowsCols(s, model, ovc, ovr) {
  const [mxr, mxc] = MODEL_SIZES[/** @type {2|3|4|5} */ (model)];
  if (ovc === 0 && ovr === 0) return true;
  const signed = (/** @type {number} */ n) => n | 0;
  const size = `${signed(ovc)}x${signed(ovr)}`;
  if (ovc === 0)
    return (
      reject(s, "N9007", `Invalid oversize ${size} columns:\nzero`) !== FAIL
    );
  if (ovr === 0)
    return reject(s, "N9020", `Invalid oversize ${size} rows:\nzero`) !== FAIL;
  if (ovc > 0x3fff || ovr > 0x3fff || Math.imul(ovc, ovr) >>> 0 > 0x3fff)
    return (
      reject(
        s,
        "N9021",
        `Invalid oversize ${size}:\nExceeds protocol limit`,
      ) !== FAIL
    );
  if (ovc < mxc)
    return (
      reject(
        s,
        "N9022",
        `Invalid oversize columns (${ovc}):\nLess than model ${model} columns (${mxc})`,
      ) !== FAIL
    );
  if (ovr < mxr)
    return (
      reject(
        s,
        "N9023",
        `Invalid oversize rows (${ovr}):\nLess than model ${model} rows (${mxr})`,
      ) !== FAIL
    );
  return true;
}

/**
 * toggle_model_done(): applies the model, oversize and extendedDataStream values the upcalls
 * left pending, all at once, since each constrains the others.
 * @param {State} s @param {boolean} success @param {boolean} defer
 */
function modelDone(s, success, defer) {
  const p = s.modelPending;
  s.modelPending = {
    model: null,
    oversize: null,
    eds: null,
    oversizeWasPending: false,
  };
  if (!success || (p.model === null && p.oversize === null && p.eds === null))
    return OK;
  if (p.model !== null && p.model === s.options.model) p.model = null;
  if (
    p.oversize !== null &&
    s.options.oversize !== null &&
    p.oversize === s.options.oversize
  )
    p.oversize = null;
  let xext = s.options.extendedDataStream;
  if (p.eds !== null) {
    const b = boolstr(p.eds);
    if (b !== null) xext = b;
    if (b === s.options.extendedDataStream) p.eds = null;
  }
  if (p.model === null && p.oversize === null && p.eds === null) return OK;

  if (p.eds !== null && boolstr(p.eds) === null)
    return reject(s, "N9024", "Invalid extendedDataStream");
  let model = s.model;
  let mode3279 = s.mode3279;
  if (p.eds !== null || p.model !== null) {
    const canonical = canonicalModel(p.model ?? s.options.model, false);
    if (!canonical)
      return reject(s, "N9005", "model value must be 327{89}-{2345}[-E]");
    ({ model, mode3279 } = canonical);
    if (p.model !== null) p.model = canonical.canon;
  }
  if (!xext) p.oversize = "";
  let ovc = s.oversized ? s.maxCols : 0;
  let ovr = s.oversized ? s.maxRows : 0;
  if (p.oversize) {
    const canonical = canonicalOversize(p.oversize);
    if (!canonical)
      return reject(s, "N9006", "oversize value must be <cols>x<rows>");
    p.oversize = canonical.canon;
    ovc = canonical.cols;
    ovr = canonical.rows;
  } else if (p.oversize === "") {
    ovc = ovr = 0;
  }
  if (!checkRowsCols(s, model, ovc, ovr)) return FAIL;

  if (s.cstate >= TELNET_PENDING) {
    if (!defer)
      return reject(
        s,
        "N9008",
        "Cannot change model or oversize while connected",
      );
    if (p.model !== null) saveDisconnectSet(s, "model", p.model);
    if (p.oversize !== null) saveDisconnectSet(s, "oversize", p.oversize);
    if (p.eds !== null) saveDisconnectSet(s, "extendedDataStream", p.eds);
    s.log.info("Set(): model change deferred until disconnect");
    return DEFERRED;
  }

  s.log.info(
    `Set(): model ${p.model ?? "unchanged"}, oversize ${p.oversize ?? "unchanged"}, extendedDataStream ${p.eds ?? "unchanged"}`,
  );
  s.mode3279 = mode3279;
  if (p.eds !== null) s.options.extendedDataStream = xext;
  const resize = p.model !== null || Boolean(p.oversize);
  if (resize) {
    const [modelRows, modelCols] = MODEL_SIZES[/** @type {2|3|4|5} */ (model)];
    s.model = model;
    s.oversized = ovc > 0;
    s.maxRows = ovr || modelRows;
    s.maxCols = ovc || modelCols;
    const size = s.maxRows * s.maxCols;
    Object.assign(s, newCells(size));
    s.altCells = null;
    s.isAltbuffer = false;
    setRowsCols(s);
    netSetDefaultTermtype(s);
    s.rows = s.maxRows;
    s.cols = s.maxCols;
  }
  screenChangeModel(s);
  if (resize) erase(s, true);
  if (s.options.termName === null) reportTerminalName(s);
  if (p.model !== null) s.options.model = p.model;
  if (p.oversize) s.options.oversize = p.oversize;
  else if (p.oversize === "") {
    const force = !p.oversizeWasPending && s.options.oversize !== null;
    s.options.oversize = null;
    if (force) notify(s, extendedByName("oversize"), "none");
  }
  netSetDefaultTermtype(s);
  return OK;
}

/** @param {State} s @param {string} _typed @param {string} value */
function setCodePage(s, _typed, value) {
  try {
    s.codePage = codePage(value);
  } catch {
    return reject(
      s,
      "N9001",
      `Cannot find definition of host code page "${value}"`,
    );
  }
  s.log.info(`Set(): codePage ${s.codePage.name}`);
  if (s.ui) screenDisp(s, true);
  s.options.codePage = canonicalCs(value);
  return OK;
}

/**
 * A plain Boolean: errors are boolstr()'s message alone.
 * @param {string} name @param {string} code @param {(s: State) => void} [changed]
 * @returns {Extended}
 */
function plainBool(name, code, changed) {
  return {
    name,
    type: "boolean",
    set(s, _typed, value) {
      const b = boolstr(value);
      if (b === null) return reject(s, code, BOOL_ERROR);
      const previous = s.options[name];
      s.options[name] = b;
      if (b !== previous) changed?.(s);
      return OK;
    },
  };
}

/** A string kept as typed, "" meaning unset. @param {string} name @returns {Extended} */
function plainString(name) {
  return {
    name,
    type: "string",
    set(s, _typed, value) {
      s.options[name] = value || null;
      return OK;
    },
  };
}

/** An int setting checked like the x3270 toggles: "" for 0, else a non-negative int. @param {string} name @param {string} code @param {string} error @param {(s: State) => void} [then] @returns {Extended} */
function plainInt(name, code, error, then) {
  return {
    name,
    type: "int",
    set(s, _typed, value) {
      if (!value) {
        s.options[name] = 0;
        then?.(s);
        return OK;
      }
      const n = strtoulInt(value);
      if (n === null || n < 0) return reject(s, code, error);
      s.options[name] = n;
      then?.(s);
      return OK;
    },
  };
}

/** A setting this library can't act on: unset is fine, anything else fails. @param {string} name @param {string} code @returns {Extended} */
function unsupported(name, code) {
  return {
    name,
    type: "string",
    set(s, _typed, value) {
      if (!value) {
        s.options[name] = null;
        return OK;
      }
      return reject(s, code, `Invalid ${name}: ${value}`);
    },
  };
}

/** sio_toggle(): TLS options, which wait for a disconnect when changed while connected. @param {string} name @param {"string" | "boolean"} type @returns {Extended} */
function tlsOption(name, type) {
  return {
    name,
    type,
    set(s, typed, value, defer) {
      const connected = s.cstate !== NOT_CONNECTED;
      if (connected && !defer)
        return reject(s, "N9025", `${typed} cannot change while connected`);
      /** @type {string | boolean | null} */
      let stored = value || null;
      if (type === "boolean") {
        const b = boolstr(value);
        if (b === null) return reject(s, "N9026", `${typed} ${BOOL_ERROR}`);
        stored = b;
      } else if (name === "tlsSecurityLevel") stored = value;
      if (connected) {
        saveDisconnectSet(s, typed, String(stored ?? ""));
        return DEFERRED;
      }
      s.options[name] = stored;
      return OK;
    },
  };
}

/** @type {Extended[]} extended_upcalls, in b3270's registration order. */
const EXTENDED = [
  {
    name: "codePage",
    type: "string",
    set: setCodePage,
    canon: (_s, value) => canonicalCs(value),
  },
  {
    name: "ftBufferSize",
    type: "int",
    set(s, _typed, value) {
      let size = 16384;
      if (value) {
        const n = strtoulInt(value);
        if (n === null) return reject(s, "N9027", "Invalid ftBufferSize value");
        if (n >= 256 && n <= 32767) size = n;
      }
      s.options.ftBufferSize = size;
      return OK;
    },
  },
  {
    name: "confDir",
    type: "string",
    set: (s) => reject(s, "N9028", "Cannot set confDir"),
  },
  plainBool("reconnect", "N9029"),
  plainBool("retry", "N9030"),
  {
    name: "oerrLock",
    type: "boolean",
    set(s, _typed, value) {
      const b = boolstr(value);
      if (b === null)
        return reject(s, "N9031", "oerrLock value must be true or false");
      s.options.oerrLock = b;
      return OK;
    },
  },
  {
    name: "unlockDelay",
    type: "boolean",
    set(s, _typed, value) {
      const b = boolstr(value);
      if (b === null)
        return reject(s, "N9032", "unlockDelay value must be true or false");
      s.options.unlockDelay = b;
      return OK;
    },
  },
  plainInt("unlockDelayMs", "N9033", "Invalid unlockDelay value"),
  unsupported("scriptPort", "N9012"),
  {
    name: "printerLu",
    type: "string",
    set(s, _typed, value) {
      s.options.printerLu = value || null;
      if (value)
        s.log.warn(
          `N9034 printerLu ${value} stored, but there is no printer session`,
        );
      return OK;
    },
  },
  {
    name: "printer.options",
    type: "string",
    noAddress: true,
    set(s, _typed, value) {
      s.options["printer.options"] = value || null;
      return OK;
    },
  },
  {
    name: "saveLines",
    type: "int",
    set(s, _typed, value) {
      // x3270 4.5 sets the wrong variable for an empty saveLines.
      if (!value) {
        s.options.unlockDelayMs = 0;
        return OK;
      }
      const n = strtoulInt(value);
      if (n === null || n < 0)
        return reject(s, "N9035", "Invalid saveLines value");
      s.options.saveLines = n;
      scrollBufInit(s);
      return OK;
    },
  },
  tlsOption("acceptHostname", "string"),
  tlsOption("verifyHostCert", "boolean"),
  tlsOption("startTls", "boolean"),
  tlsOption("caDir", "string"),
  tlsOption("caFile", "string"),
  tlsOption("certFile", "string"),
  tlsOption("certFileType", "string"),
  tlsOption("chainFile", "string"),
  tlsOption("keyFile", "string"),
  tlsOption("keyFileType", "string"),
  tlsOption("keyPasswd", "string"),
  tlsOption("tlsMinProtocol", "string"),
  tlsOption("tlsMaxProtocol", "string"),
  tlsOption("tlsSecurityLevel", "string"),
  unsupported("httpd", "N9036"),
  unsupported("proxy", "N9013"),
  {
    name: "extendedDataStream",
    type: "boolean",
    done: modelDone,
    set(s, _typed, value) {
      s.modelPending.eds = value || null;
      return OK;
    },
  },
  {
    name: "model",
    type: "string",
    done: modelDone,
    canon: (s, value) =>
      canonicalModel(value, s.options.extendedDataStream)?.canon ?? null,
    set(s, _typed, value) {
      s.modelPending.model = value || null;
      return OK;
    },
  },
  plainInt("nopSeconds", "N9010", "Invalid nopSeconds value", netNopSeconds),
  {
    name: "oversize",
    type: "string",
    done: modelDone,
    canon: (_s, value) => canonicalOversize(value)?.canon ?? null,
    set(s, _typed, value) {
      s.modelPending.oversize = value;
      s.modelPending.oversizeWasPending = true;
      return OK;
    },
  },
  {
    name: "termName",
    type: "string",
    set(s, _typed, value) {
      if (s.cstate >= TELNET_PENDING)
        return reject(s, "N9037", "termName cannot change while connected");
      s.options.termName =
        value.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "") || null;
      netSetDefaultTermtype(s);
      return OK;
    },
  },
  {
    name: "lineMode",
    type: "boolean",
    get: (s) => s.linemode,
    set(s, _typed, value) {
      if (!inNvt(s))
        return reject(s, "N9038", "Can only change lineMode in NVT mode");
      const b = boolstr(value);
      if (b === null)
        return reject(s, "N9039", "lineMode value must be true or false");
      if (b) netLinemode(s);
      else netCharmode(s);
      return OK;
    },
  },
  {
    name: "noTelnetInputMode",
    type: "string",
    canon: (_s, value) =>
      value === null
        ? null
        : (NTIM_NAMES.find((n) => n.toLowerCase() === value.toLowerCase()) ??
          "?"),
    set(s, _typed, value) {
      if (!NTIM_NAMES.some((n) => n.toLowerCase() === value.toLowerCase()))
        return reject(s, "N9040", `Invalid noTelnetInputMode value '${value}'`);
      s.options.noTelnetInputMode = value;
      return OK;
    },
  },
  plainBool("bindLimit", "N9041"),
  plainBool("wrongTerminalName", "N9042", netSetDefaultTermtype),
  plainBool("contentionResolution", "N9043"),
  plainBool("tls992", "N9044"),
  plainString("loginMacro"),
  ...["preferIpv4", "preferIpv6"].map((name) => ({
    name,
    type: /** @type {const} */ ("boolean"),
    /** @param {State} s @param {string} _typed @param {string} value */
    set(s, _typed, value) {
      const b = boolstr(value);
      if (b === null) return reject(s, "N9045", `'${value}': ${BOOL_ERROR}`);
      s.options[name] = b;
      return OK;
    },
  })),
  plainString("user"),
  plainString("devName"),
  {
    name: "rpq",
    type: "string",
    set(s, _typed, value) {
      s.options.rpq = value;
      return OK;
    },
  },
];

/** @param {string} name */
function extendedByName(name) {
  const lower = name.toLowerCase();
  return EXTENDED.find((u) => u.name.toLowerCase() === lower);
}

/** The setting's value as b3270 holds it. @param {State} s @param {Extended} u */
const rawValue = (s, u) => (u.get ? u.get(s) : s.options[u.name]);

/** u_value(): the value as Set() shows it, or null. @param {State} s @param {Extended} u */
function shownValue(s, u) {
  const raw = rawValue(s, u);
  const text = raw === null || raw === undefined ? null : String(raw);
  return u.canon ? u.canon(s, text) : text;
}

/** b3270_toggle_notify() @param {State} s @param {Extended | undefined} u @param {string} cause */
function notify(s, u, cause) {
  if (!s.ui || !u || u.noAddress) return;
  const value = rawValue(s, u);
  s.ui.out(
    "setting",
    value === null ? { name: u.name, cause } : { name: u.name, value, cause },
  );
}

/**
 * do_toggle(): flips a classic toggle, runs what depends on it, and reports it.
 * @param {State} s @param {string} name
 */
export function doToggle(s, name) {
  const on = !s.options[name];
  s.options[name] = on;
  s.log.debug(`toggle ${name} ${on}`);
  switch (name) {
    case "lineWrap":
      s.nvt.wraparoundMode = on;
      break;
    case "visibleControl":
      if (s.ui) screenDisp(s, true);
      break;
    case "alwaysInsert":
      insertMode(s, in3270(s) && on);
      break;
    case "rightToLeftMode":
      if (s.flipped !== on) {
        s.flipped = !s.flipped;
        s.ui?.out("flipped", { value: s.flipped });
      }
      break;
    case "reverseInputMode":
      statusFlag(s, "reverse-input", on);
      break;
    case "insertMode":
      statusFlag(s, "insert", on);
      break;
    case "trace":
    case "screenTrace":
      if (on) s.log.warn(`N9011 ${name} is not supported, nothing is traced`);
      break;
  }
  s.ui?.out("setting", { name, value: on });
  if (name === "trace") s.ui?.out("trace-file", {});
}

/** split_equals(): "x=y" counts as two arguments where a name is expected. @param {string[]} args */
function splitEquals(args) {
  /** @type {string[]} */
  const out = [];
  let left = true;
  for (const arg of args) {
    const equals = arg.indexOf("=");
    if (left && equals > 0) {
      out.push(arg.slice(0, equals), arg.slice(equals + 1));
      left = false;
    } else out.push(arg);
    left = !left;
  }
  return out;
}

/** @param {string} name */
const findClassic = (name) =>
  CLASSIC.find((c) => c.toLowerCase() === name.toLowerCase());

/** toggle_values() sorted by name, then printed like toggle_show(). @param {State} s @param {boolean} defer */
function show(s, defer) {
  /** @type {[string, string | null][]} */
  const values = [
    ...CLASSIC.map(
      (name) =>
        /** @type {[string, string]} */ ([name, String(s.options[name])]),
    ),
    ...EXTENDED.map(
      (u) =>
        /** @type {[string, string | null]} */ ([u.name, shownValue(s, u)]),
    ),
  ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, value] of values) {
    if (!defer) {
      actionOutput(s, value === null ? `${name}:` : `${name}: ${value}`);
      continue;
    }
    const pending = s.disconnectSets.find(
      (d) => d.name.toLowerCase() === name.toLowerCase(),
    );
    if (!pending) continue;
    if (value === null ? pending.value === "" : value === pending.value)
      continue;
    actionOutput(s, `${name}:${pending.value ? " " : ""}${pending.value}`);
  }
}

/**
 * toggle_common(): Set() and Toggle().
 * @param {State} s @param {"Set" | "Toggle"} action @param {string[]} argv
 */
function toggleCommon(s, action, argv) {
  if (argv.length === 0) {
    show(s, false);
    return true;
  }
  let args = splitEquals(argv);
  let defer = false;
  if (action === "Toggle" && args.length > 2) {
    reject(s, "N9014", `${action}() can only set one value`);
    return false;
  }
  if (args[0].toLowerCase() === "-defer") {
    defer = true;
    args = args.slice(1);
  }
  if (args.length === 0) {
    show(s, true);
    return true;
  }
  if (action === "Set" && args.length > 2 && args.length % 2) {
    reject(s, "N9015", `${action}(): '${args.at(-1)}' requires a value`);
    return false;
  }

  /** @type {{done: typeof modelDone, ret: number}[]} */
  const dones = [];
  /** @type {Extended[]} */
  const doneUs = [];
  let success = true;
  for (let arg = 0; arg < args.length; arg += 2) {
    const typed = args[arg];
    const classic = findClassic(typed);
    const u = classic ? undefined : extendedByName(typed);
    if (!classic && !u) {
      reject(s, "N9009", `${action}(): Unknown toggle name '${typed}'`);
      success = false;
      break;
    }
    let value = args[arg + 1];
    if (args.length - arg === 1) {
      if (action === "Set") {
        const shown = u
          ? shownValue(s, u)
          : String(s.options[/** @type {string} */ (classic)]);
        const live = shown ?? "\n";
        if (defer) {
          const pending = s.disconnectSets.find(
            (d) => d.name.toLowerCase() === typed.toLowerCase(),
          );
          const deferred = pending && (pending.value || "\n");
          if (deferred && deferred !== live)
            actionOutput(s, deferred === "\n" ? "" : deferred);
        } else actionOutput(s, live === "\n" ? "" : live);
        return true;
      }
      if (classic) {
        doToggle(s, classic);
        break;
      }
      if (u?.type !== "boolean") {
        reject(s, "N9016", `${action}(): '${typed}' requires a value`);
        success = false;
        break;
      }
      value = String(!rawValue(s, u));
    }

    if (classic) {
      const b = boolstr(value);
      if (b === null) {
        reject(s, "N9017", `${action}(): ${typed} ${BOOL_ERROR}`);
        success = false;
        break;
      }
      if (b !== s.options[classic]) doToggle(s, classic);
      continue;
    }
    const ext = /** @type {Extended} */ (u);
    if (ext.done) {
      doneUs.push(ext);
      if (!dones.some((d) => d.done === ext.done))
        dones.push({ done: ext.done, ret: FAIL });
    }
    const ret = ext.set(s, typed, value, defer);
    if (ret === FAIL) {
      success = false;
      break;
    }
    if (ret !== DEFERRED && !ext.done) notify(s, ext, "ui");
  }

  for (const d of dones) {
    d.ret = d.done(s, success, defer);
    success &&= d.ret !== FAIL;
  }
  for (const u of doneUs) {
    const d = dones.find((x) => x.done === u.done);
    if (d && d.ret !== OK) continue;
    notify(s, u, "ui");
  }
  return success;
}

/** Set(name[, value, ...]) @param {State} s @param {...any} args */
export function set(s, ...args) {
  return toggleCommon(s, "Set", args.map(String));
}

/** Toggle(name[, value]) @param {State} s @param {...any} args */
export function toggle(s, ...args) {
  return toggleCommon(s, "Toggle", args.map(String));
}

/** toggle_save_disconnect_set(): kept unique by name, newest last. @param {State} s @param {string} name @param {string} value */
function saveDisconnectSet(s, name, value) {
  s.disconnectSets = s.disconnectSets.filter(
    (d) => d.name.toLowerCase() !== name.toLowerCase(),
  );
  s.disconnectSets.push({ name, value });
}

/**
 * toggle_connect_change(): on disconnect, runs the Set()s that waited for it, grouping the
 * settings that share a done function so they apply together.
 * @param {State} s
 */
export function replayDisconnectSets(s) {
  if (s.cstate !== NOT_CONNECTED || s.disconnectSets.length === 0) return;
  s.log.info("applying the Set() operations deferred until disconnect");
  const pending = s.disconnectSets.map((d) => ({ ...d, processed: false }));
  s.disconnectSets = [];
  while (pending.some((d) => !d.processed)) {
    /** @type {string[]} */
    const argv = [];
    /** @type {Function | null} */
    let group = null;
    for (const d of pending) {
      if (d.processed) continue;
      const u = extendedByName(d.name);
      if (u?.done) {
        if (group !== null && group !== u.done) continue;
        group = u.done;
        argv.push(d.name, d.value);
        d.processed = true;
        continue;
      }
      if (group !== null) continue;
      argv.push(d.name, d.value);
      d.processed = true;
      break;
    }
    if (!set(s, ...argv))
      s.log.warn(`N9018 deferred Set(${argv.join(",")}) failed`);
  }
}

/** The settings b3270's initialize block reports, in its order. @param {State} s */
export function initialSettings(s) {
  /** @type {{kind: string, body: any}[]} */
  const list = [];
  for (const u of EXTENDED) {
    if (u.noAddress) continue;
    const value = rawValue(s, u);
    list.push({
      kind: "setting",
      body:
        value === null
          ? { name: u.name, cause: "none" }
          : { name: u.name, value, cause: "none" },
    });
  }
  for (const name of CLASSIC) {
    list.push({ kind: "setting", body: { name, value: s.options[name] } });
    if (name === "trace") list.push({ kind: "trace-file", body: {} });
  }
  return list;
}
