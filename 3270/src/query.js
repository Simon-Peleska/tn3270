// query.c: Query() and Show(), x3270's read-only view of the session.

import { ALIASES, CODE_PAGES } from "./codepages.js";
import { canonicalModel } from "./toggles.js";
import { SF_SRM_CHAR, SF_SRM_FIELD, SF_SRM_XFIELD } from "./ctlr.js";
import {
  KL_AWAITING_FIRST,
  KL_BID,
  KL_DEFERRED_UNLOCK,
  KL_ENTER_INHIBIT,
  KL_FT,
  KL_NOT_CONNECTED,
  KL_OERR_MASK,
  KL_OIA_LOCKED,
  KL_OIA_MINUS,
  KL_OIA_TWAIT,
  KL_SCROLLED,
} from "./kybd.js";
import {
  ACTION_NAMES,
  CONNECTED_TN3270E,
  in3270,
  inE,
  isConnected,
} from "./session.js";
import { actionOutput, CSTATE_NAMES, popupError } from "./ui.js";

/** @typedef {import("./session.js").State} State */

export const BUILD = "node3270 v4.5ga5";
const CYEAR = "2025";
const PROXIES_DUMP = [
  "passthru no-username 3514",
  "http username 3128",
  "telnet no-username",
  "socks4 username 1080",
  "socks4a username 1080",
  "socks5 username 1080",
  "socks5d username 1080",
].join("\n");

const TELOPTS = [
  "BINARY",
  "ECHO",
  "RCP",
  "SUPPRESS GO AHEAD",
  "NAME",
  "STATUS",
  "TIMING MARK",
  "RCTE",
  "NAOL",
  "NAOP",
  "NAOCRD",
  "NAOHTS",
  "NAOHTD",
  "NAOFFD",
  "NAOVTS",
  "NAOVTD",
  "NAOLFD",
  "EXTEND ASCII",
  "LOGOUT",
  "BYTE MACRO",
  "DATA ENTRY TERMINAL",
  "SUPDUP",
  "SUPDUP OUTPUT",
  "SEND LOCATION",
  "TERMINAL TYPE",
  "END OF RECORD",
  "TACACS UID",
  "OUTPUT MARKING",
  "TTYLOC",
  "3270 REGIME",
  "X.3 PAD",
  "NAWS",
  "TSPEED",
  "LFLOW",
  "LINEMODE",
  "XDISPLOC",
  "OLD-ENVIRON",
  "AUTHENTICATION",
  "ENCRYPT",
  "NEW-ENVIRON",
  "TN3270E",
];
const TELOPT_STARTTLS = 46;

const E_FUNCTIONS = [
  "BIND-IMAGE",
  "DATA-STREAM-CTL",
  "RESPONSES",
  "SCS-CTL-CODES",
  "SYSREQ",
  "CONTENTION-RESOLUTION",
  "SNA-SENSE",
];

const LOCK_NAMES = /** @type {[number, string][]} */ ([
  [KL_NOT_CONNECTED, "NOT_CONNECTED"],
  [KL_AWAITING_FIRST, "AWAITING_FIRST"],
  [KL_OIA_TWAIT, "OIA_TWAIT"],
  [KL_OIA_LOCKED, "OIA_LOCKED"],
  [KL_DEFERRED_UNLOCK, "DEFERRED_UNLOCK"],
  [KL_ENTER_INHIBIT, "ENTER_INHIBIT"],
  [KL_SCROLLED, "SCROLLED"],
  [KL_OIA_MINUS, "OIA_MINUS"],
  [KL_FT, "FT"],
  [KL_BID, "BID"],
]);
const OERR_NAMES = ["?0", "PROTECTED", "NUMERIC", "OVERFLOW", "DBCS"];

/** @type {Record<number, string>} */
const EFA_NAMES = {
  0x00: "all",
  0xc0: "3270",
  0xc1: "validation",
  0xc2: "outlining",
  0x41: "highlighting",
  0x42: "foreground",
  0x43: "charset",
  0x45: "background",
  0x46: "transparency",
};

/** kybdlock_decode() @param {number} bits */
export function kybdlockDecode(bits) {
  if (bits === 0) return "NONE";
  const names = [];
  if (bits & KL_OERR_MASK) {
    const oerr = bits & KL_OERR_MASK;
    names.push(`OERR(${OERR_NAMES[oerr] ?? `?${oerr}`})`);
    bits &= ~KL_OERR_MASK;
  }
  for (const [flag, name] of LOCK_NAMES) {
    if (!(bits & flag)) continue;
    names.push(name);
    bits &= ~flag;
  }
  if (bits) names.push(`?0x${bits.toString(16)}`);
  return names.join(" ");
}

/** @param {Uint8Array} opts */
function telnetOpts(opts) {
  const names = [];
  for (let i = 0; i < 256; i++) {
    if (!opts[i]) continue;
    names.push(TELOPTS[i] ?? (i === TELOPT_STARTTLS ? "START-TLS" : String(i)));
  }
  return names.join(" ");
}

/** @param {State} s */
function connectTime(s) {
  if (!isConnected(s)) return null;
  const td = Math.floor((Date.now() - s.connectTime) / 1000);
  const dy = Math.floor(td / (3600 * 24));
  // x3270 takes the hours from the day count, so they are always 0.
  const hr = Math.floor((dy % (3600 * 24)) / 3600);
  const mn = Math.floor((td % 3600) / 60);
  const sc = td % 60;
  const hms = [hr, mn, sc].map((n) => String(n).padStart(2, "0")).join(":");
  return dy > 0 ? `${dy}d${hms}` : hms;
}

/** @param {State} s */
function replyMode(s) {
  switch (s.replyMode) {
    case SF_SRM_FIELD:
      return "field";
    case SF_SRM_XFIELD:
      return "extended-field";
    case SF_SRM_CHAR: {
      let r = "character";
      for (const attr of s.crmAttr.subarray(0, s.crmNattr))
        r += ` +${EFA_NAMES[attr] ?? `unknown[0x${attr.toString(16)}]`}`;
      return r;
    }
    default:
      return `0x${s.replyMode.toString(16).padStart(2, "0")}`;
  }
}

/** @param {State} s */
function tlsState(s) {
  if (!isConnected(s)) return "";
  if (!s.secure) return "not secure";
  return `secure ${s.verified ? "host-verified" : "host-unverified"}`;
}

/** @param {State} s @param {boolean} received */
function stats(s, received) {
  if (!isConnected(s)) return null;
  const [records, bytes] = received
    ? [s.stats.rrcvd, s.stats.brcvd]
    : [s.stats.rsent, s.stats.bsent];
  return in3270(s) ? `records ${records} bytes ${bytes}` : `bytes ${bytes}`;
}

function codePages() {
  /** @type {Record<string, string[]>} */
  const aliases = {};
  for (const [alias, name] of Object.entries(ALIASES))
    (aliases[name] ??= []).push(alias);
  return Object.keys(CODE_PAGES)
    .map((name) => [name, "sbcs", ...(aliases[name] ?? [])].join(" "))
    .join("\n");
}

function actionNames() {
  const names = [...ACTION_NAMES.values()];
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((n) => `${n}()`).join(" ");
}

const COPYRIGHT = `Copyright (c) 1993-${CYEAR}, Paul Mattes.
Copyright (c) 1990, Jeff Sparkes.
Copyright (c) 1989, Georgia Tech Research Corporation (GTRC), Atlanta, GA
 30332.
All rights reserved.
 
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the names of Paul Mattes, Jeff Sparkes, GTRC nor the names of
      their contributors may be used to endorse or promote products derived
      from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY PAUL MATTES, JEFF SPARKES AND GTRC "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL PAUL MATTES, JEFF SPARKES OR GTRC BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.`;

/**
 * Every query, sorted by name the way register_queries() leaves them.
 * hidden ones don't show in Query(), specific ones show there as "...".
 * @type {{name: string, get: (s: State) => string | null, hidden?: boolean, specific?: boolean}[]}
 */
const QUERIES = [
  {
    name: "About",
    get: () =>
      `${BUILD}\nCopyright 1989-${CYEAR} by Paul Mattes, GTRC and others.`,
    specific: true,
  },
  { name: "Actions", get: actionNames, specific: true },
  {
    name: "BindPluName",
    get: (s) =>
      s.cstate === CONNECTED_TN3270E && s.eFuncs[0] ? s.pluName : "",
  },
  { name: "BuildOptions", get: () => "" },
  { name: "CodePage", get: (s) => codePageInfo(s) },
  { name: "CodePages", get: codePages, specific: true },
  { name: "ConnectTime", get: connectTime },
  { name: "ConnectionState", get: (s) => CSTATE_NAMES[s.cstate] },
  {
    name: "Copyright",
    get: () => `${BUILD}\n\n${COPYRIGHT}`,
    specific: true,
  },
  {
    name: "Cursor",
    get: (s) => `${(s.cursor / s.cols) | 0} ${s.cursor % s.cols}`,
    hidden: true,
  },
  {
    name: "Cursor1",
    get: (s) =>
      `row ${((s.cursor / s.cols) | 0) + 1} column ${(s.cursor % s.cols) + 1} offset ${s.cursor}`,
  },
  {
    name: "Formatted",
    get: (s) => (s.formatted ? "formatted" : "unformatted"),
  },
  {
    name: "Host",
    get: (s) => (isConnected(s) ? `host ${s.connHost} ${s.connPort}` : ""),
  },
  {
    name: "KeyboardLock",
    get: (s) => (s.kybdlock !== 0 ? "true" : "false"),
  },
  {
    name: "KeyboardLockDetail",
    get: (s) =>
      s.kybdlock === 0
        ? ""
        : kybdlockDecode(s.kybdlock)
            .replace(/\)/g, "")
            .replace(/[(_]/g, "-")
            .toLowerCase(),
  },
  { name: "LocalEncoding", get: () => "UTF-8" },
  {
    name: "LuName",
    get: (s) => (isConnected(s) && s.connectedLu ? s.connectedLu : ""),
  },
  {
    name: "Model",
    get: (s) =>
      `IBM-${canonicalModel(s.options.model, s.options.extendedDataStream)?.canon}`,
    hidden: true,
  },
  { name: "Prefixes", get: () => "ACLNPSBYT" },
  { name: "Proxies", get: () => PROXIES_DUMP, specific: true },
  { name: "Proxy", get: () => null },
  { name: "ReplyMode", get: replyMode },
  { name: "ScreenCurSize", get: (s) => `${s.rows} ${s.cols}`, hidden: true },
  {
    name: "ScreenMaxSize",
    get: (s) => `${s.maxRows} ${s.maxCols}`,
    hidden: true,
  },
  {
    name: "ScreenSizeCurrent",
    get: (s) => `rows ${s.rows} columns ${s.cols}`,
  },
  {
    name: "ScreenSizeMax",
    get: (s) => `rows ${s.maxRows} columns ${s.maxCols}`,
  },
  { name: "ScreenTraceFile", get: () => null },
  { name: "Ssl", get: tlsState, hidden: true },
  { name: "StatsRx", get: (s) => stats(s, true) },
  { name: "StatsTx", get: (s) => stats(s, false) },
  {
    name: "Tasks",
    get: (s) =>
      `CB(ui) #${s.runSeq}\n  CB(ui)[#${s.runSeq}.1] RUNNING\n   Macro[#${s.runSeq}.2] RUNNING => ${s.runAction}`,
    specific: true,
  },
  { name: "TelnetHostOptions", get: (s) => telnetOpts(s.hisopts) },
  { name: "TelnetMyOptions", get: (s) => telnetOpts(s.myopts) },
  { name: "TerminalName", get: (s) => s.termtype },
  { name: "Tls", get: tlsState },
  { name: "TlsCertInfo", get: (s) => s.tlsCertInfo, specific: true },
  {
    name: "TlsProvider",
    get: () => `OpenSSL ${process.versions.openssl}`,
  },
  { name: "TlsSessionInfo", get: (s) => s.tlsSessionInfo, specific: true },
  { name: "TlsSubjectNames", get: () => null, specific: true },
  {
    name: "Tn3270eOptions",
    get: (s) => {
      if (!inE(s)) return null;
      const names = [];
      for (let i = 0; i < 8; i++)
        if (s.eFuncs[i]) names.push(E_FUNCTIONS[i] ?? "??");
      return names.join(" ") || null;
    },
  },
  { name: "TraceFile", get: () => null },
  { name: "Version", get: () => BUILD },
];

/** @param {State} s */
function codePageInfo(s) {
  const cg = s.codePage.cgcsgid;
  return `${s.codePage.name} sbcs gcsgid ${(cg >>> 16) & 0xffff} cpgid ${cg & 0xffff}`;
}

/** action_output() splits on newlines and drops the last one. @param {State} s @param {string} text */
function output(s, text) {
  for (const line of text.replace(/\n$/, "").split("\n")) actionOutput(s, line);
}

/** query_common(): Query() lists everything, Query(name) shows one, by unique prefix. @param {State} s @param {string} action @param {any[]} args */
export function query(s, action, args) {
  if (args.length > 1) {
    s.log.warn(`N3201 ${action}: ${args.length} arguments`);
    popupError(s, `${action}() requires 0 or 1 arguments`);
    return false;
  }
  if (args.length === 0) {
    for (const q of QUERIES) {
      if (q.hidden) continue;
      let value = q.get(s) ?? "";
      if (q.specific && value !== "") value = "...";
      output(s, `${q.name}:${value ? " " : ""}${value}\n`);
    }
    return true;
  }
  const want = String(args[0]).toLowerCase();
  const i = QUERIES.findIndex((q) => q.name.toLowerCase().startsWith(want));
  if (i < 0) {
    s.log.warn(`N3202 ${action}: unknown parameter ${JSON.stringify(args[0])}`);
    popupError(s, `${action}: Unknown parameter`);
    return false;
  }
  const next = QUERIES[i + 1];
  if (
    QUERIES[i].name.length > want.length &&
    next &&
    next.name.toLowerCase().startsWith(want)
  ) {
    s.log.warn(
      `N3203 ${action}: ambiguous parameter ${JSON.stringify(args[0])}`,
    );
    popupError(s, `${action}: Ambiguous parameter`);
    return false;
  }
  output(s, `${QUERIES[i].get(s) ?? ""}\n`);
  return true;
}
