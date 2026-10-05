import { ALIASES, CODE_PAGES } from "./codepages.js";
import { scrollBufInit } from "./scroll.js";
import {
  CS_APL,
  CS_GE,
  CS_LINEDRAW,
  CS_MASK,
  aplUnderlined,
  ebcdicToUnicode,
  linedrawToUnicode,
} from "./charset.js";
import {
  CELL_ARRAYS,
  DBCS_LEFT,
  DBCS_LEFT_WRAP,
  DBCS_NONE,
  DBCS_RIGHT,
  DBCS_RIGHT_WRAP,
  FA_INTENSITY,
  FA_MODIFY,
  FA_PROTECT,
  dbcsState,
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
import { NOT_CONNECTED, in3270, inNvt } from "./session.js";
import { initialSettings } from "./toggles.js";

// Port of b3270's screen.c and status.c, plus the connection report from b3270.c:
// the indications `b3270 -json` writes, handed out as (kind, body) pairs. A State
// without s.ui skips all of it, so sessions that don't stream pay nothing.

/** @typedef {import("./session.js").State} State */
/** @typedef {(kind: string, body: any) => void} Out */

const RED_SPAN = 16;
const AM_MAX = 16;

const XX_UNDERLINE = 0x0001,
  XX_BLINK = 0x0002,
  XX_HIGHLIGHT = 0x0004,
  XX_SELECTABLE = 0x0008,
  XX_REVERSE = 0x0010;
const XX_WIDE = 0x0020,
  XX_ORDER = 0x0040,
  XX_PUA = 0x0080,
  XX_NO_COPY = 0x0100,
  XX_WRAP = 0x0200;
const XX_LEFT_HALF = 0x0400,
  XX_RIGHT_HALF = 0x0800;
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

const COLOR_NAMES = [
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
const BLUE = 1,
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
function createRendered(size) {
  return {
    cc: new Uint32Array(size),
    fg: new Uint8Array(size),
    bg: new Uint8Array(size),
    gr: new Uint16Array(size),
  };
}
/** @typedef {ReturnType<typeof createRendered>} Rendered */

/** @param {number} size cells on the largest screen @param {Out} out */
export function createUi(size, out) {
  return {
    out,
    // screen.c
    savedRows: 0,
    savedCols: 0,
    lastRows: 0,
    lastCols: 0,
    savedEa: newCells(size),
    savedEmpty: false,
    savedFormatted: false,
    savedScrolled: false,
    saved: createRendered(size),
    fresh: createRendered(size),
    sentBaddr: 0,
    cursorEnabled: true,
    xformatted: false,
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
    termtype: "",
    termOverride: false,
    oldCstate: NOT_CONNECTED,
    /** @type {NodeJS.Timeout | null} */
    ncTimer: null,
    /** The counters the last stats indication showed. */
    stats: { brcvd: 0, rrcvd: 0, bsent: 0, rsent: 0 },
    /** @type {NodeJS.Timeout | null} */
    statsTimer: null,
  };
}
/** @typedef {ReturnType<typeof createUi>} Ui */

/** x3270's license, which b3270 says hello with and this port carries. */
const COPYRIGHT = `Copyright © 1993-2025, Paul Mattes.
Copyright © 1990, Jeff Sparkes.
Copyright © 1989, Georgia Tech Research Corporation (GTRC), Atlanta, GA
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

const PROXIES = [
  { name: "passthru", username: false, port: 3514 },
  { name: "http", username: true, port: 3128 },
  { name: "telnet", username: false },
  { name: "socks4", username: true, port: 1080 },
  { name: "socks4a", username: true, port: 1080 },
  { name: "socks5", username: true, port: 1080 },
  { name: "socks5d", username: true, port: 1080 },
];

const TLS_OPTIONS = [
  "acceptHostname",
  "verifyHostCert",
  "startTls",
  "caDir",
  "caFile",
  "certFile",
  "certFileType",
  "chainFile",
  "keyFile",
  "keyFileType",
  "keyPasswd",
  "tlsMinProtocol",
  "tlsMaxProtocol",
  "tlsSecurityLevel",
];

/**
 * b3270's initialize block.
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
  ui.out("hello", {
    version: "4.5.5",
    build: "node3270 v4.5ga5",
    copyright: COPYRIGHT,
  });
  ui.out("code-pages", codePages);
  ui.out("models", models);
  ui.out("proxies", PROXIES);
  ui.out("prefixes", { value: "ACLNPSBYT" });
  statusReset(s);
  screenInit(s);
  scrollBufInit(s);
  reportTerminalName(s);
  ui.out("tls-hello", {
    supported: true,
    provider: `OpenSSL ${process.versions.openssl}`,
    options: TLS_OPTIONS,
  });
  list.push(...initialSettings(s));
  ui.out = out;
  return list;
}

// ---- screen.c

/** @param {Ui} ui @param {State} s */
function saveEmpty(ui, s) {
  for (const name of CELL_ARRAYS) ui.savedEa[name].fill(0);
  ui.savedRows = s.rows;
  ui.savedCols = s.cols;
  ui.savedEmpty = true;
  blank(s, ui.saved);
}

/** @param {State} s @param {Rendered} r */
function blank(s, r) {
  r.cc.fill(0x20);
  r.fg.fill(s.mode3279 ? BLUE : NEUTRAL_WHITE);
  r.bg.fill(NEUTRAL_BLACK);
  r.gr.fill(0);
}

/** @param {State} s @param {number} rows @param {number} cols */
function emitErase(s, rows, cols) {
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
  const ui = s.ui;
  if (!ui) return;
  const size = s.maxRows * s.maxCols;
  ui.savedEa = newCells(size);
  ui.saved = createRendered(size);
  ui.fresh = createRendered(size);
  screenInit(s);
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
  saveEmpty(ui, s);
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
function render(s, r, dirty) {
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
    let dbcs = false,
      leftHalf = false,
      rightHalf = false,
      order = false,
      extraUnderline = false,
      pua = false;
    let noCopy = false;
    const d = dbcsState(s, i);
    if (s.fa[i]) {
      uc = 0x20;
      fa = s.fa[i];
      faFg = s.fg[i] ? s.fg[i] & 0x0f : colorFromFa(s, fa);
      faBg = s.bg[i] ? s.bg[i] & 0x0f : NEUTRAL_BLACK;
      faHigh = s.gr[i] & GR_INTENSIFY ? true : isHigh(fa);
      faGr = s.gr[i];
      faCs = s.cs[i];
    } else if (isZero(fa)) {
      if (d === DBCS_LEFT) {
        uc = 0x3000;
        dbcs = true;
      } else {
        uc = 0x20;
      }
    } else {
      cs = s.cs[i] || faCs;
      const nvt =
        s.cs[i] === CS_LINEDRAW ? linedrawToUnicode(s.ucs4[i]) : s.ucs4[i];
      if (nvt) {
        uc = nvt;
        if (d === DBCS_RIGHT) uc = 0;
        if (d === DBCS_RIGHT || d === DBCS_LEFT) dbcs = true;
      } else if (d === DBCS_NONE) {
        const ec = s.ec[i];
        const visible = s.options.visibleControl;
        if (ec === EBC_NULL || ec === EBC_SO || ec === EBC_SI) {
          uc = 0x20;
          if (visible) {
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
      } else if (d === DBCS_LEFT || d === DBCS_LEFT_WRAP) {
        // 3270 data is SBCS only here, so this is an NVT cell that lost its character.
        uc = 0x3000;
        if (d === DBCS_LEFT) dbcs = true;
        else leftHalf = true;
      } else if (d === DBCS_RIGHT) {
        uc = 0;
        dbcs = true;
      } else if (d === DBCS_RIGHT_WRAP) {
        uc = 0x3000;
        rightHalf = true;
      } else {
        uc = 0x20;
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
    if (dbcs) xx |= XX_WIDE;
    if (leftHalf) xx |= XX_LEFT_HALF;
    if (rightHalf) xx |= XX_RIGHT_HALF | XX_NO_COPY;
    if (order || visibleFa) xx |= XX_ORDER;
    if (!s.fa[i] && !isZero(fa) && extraUnderline) xx |= XX_UNDERLINE;
    if (pua) xx |= XX_PUA;
    if (noCopy) xx |= XX_NO_COPY;
    if (s.gr[i] & GR_WRAP) xx |= XX_WRAP;
    r.gr[si] = xx;
  }
}

/** @param {Rendered} a @param {number} i @param {Rendered} b @param {number} j */
const sameAttrs = (a, i, b, j) =>
  a.fg[i] === b.fg[j] && a.bg[i] === b.bg[j] && a.gr[i] === b.gr[j];
/** @param {Rendered} a @param {Rendered} b @param {number} i */
const sameCell = (a, b, i) => a.cc[i] === b.cc[i] && sameAttrs(a, i, b, i);

/** @param {number} gr */
function seeGr(gr) {
  if (!gr) return "default";
  return GR_NAMES.filter((_, bit) => gr & (1 << bit)).join(",");
}

/**
 * generate_rowdiffs(), merge_adjacent() and emit_rowdiffs() for the row starting at `base`.
 * @param {Rendered} o @param {Rendered} n @param {number} base @param {number} width
 */
function rowChanges(o, n, base, width) {
  /** @type {{start: number, width: number, text: boolean}[]} */
  const diffs = [];
  for (let col = 0; col < width; col++) {
    const c = base + col;
    if (sameCell(o, n, c)) continue;
    const text = o.cc[c] !== n.cc[c];
    let w = 1;
    for (let x = c + 1; x < base + width; x++) {
      if (
        (o.cc[x] !== n.cc[x]) !== text ||
        !sameAttrs(n, c, n, x) ||
        !sameAttrs(o, c, o, x)
      )
        break;
      w++;
    }
    diffs.push({ start: col, width: w, text });
    col += w - 1;
  }

  for (let k = 0; k + 1 < diffs.length;) {
    const d = diffs[k];
    const next = diffs[k + 1];
    const a = base + d.start;
    const b = base + next.start;
    const attrsMatch = sameAttrs(o, a, o, b) && sameAttrs(n, a, n, b);
    const adjacent = next.start === d.start + d.width;
    let merge = false;
    if (
      d.text &&
      next.text &&
      next.start - (d.start + d.width) <= RED_SPAN &&
      attrsMatch
    ) {
      merge = true;
      for (let x = a + d.width; x < b; x++) {
        if (!sameAttrs(o, x, o, a) || !sameAttrs(n, x, n, a)) merge = false;
      }
    } else if (
      d.text &&
      !next.text &&
      next.width <= AM_MAX &&
      adjacent &&
      attrsMatch
    ) {
      merge = true;
    } else if (
      !d.text &&
      d.width <= AM_MAX &&
      next.text &&
      adjacent &&
      attrsMatch
    ) {
      merge = true;
      d.text = true;
    }
    if (!merge) {
      k++;
      continue;
    }
    d.width = next.start + next.width - d.start;
    diffs.splice(k + 1, 1);
  }

  return diffs.map((d) => {
    const c = base + d.start;
    /** @type {Record<string, any>} */
    const change = { column: d.start + 1 };
    if (o.fg[c] !== n.fg[c]) change.fg = COLOR_NAMES[n.fg[c]];
    if (o.bg[c] !== n.bg[c]) change.bg = COLOR_NAMES[n.bg[c]];
    if (o.gr[c] !== n.gr[c]) change.gr = seeGr(n.gr[c]);
    if (d.text) {
      let text = "";
      for (let x = c; x < c + d.width; x++)
        if (n.cc[x]) text += String.fromCodePoint(n.cc[x]);
      change.text = text;
    } else {
      change.count = d.width;
    }
    return change;
  });
}

/** emit_cursor_cond(false): the cursor part of a screen indication, or null. @param {Ui} ui @param {State} s */
function cursorChange(ui, s) {
  if (!ui.cursorEnabled || ui.sentBaddr === s.savedBaddr) return null;
  ui.sentBaddr = s.savedBaddr;
  return {
    enabled: true,
    row: ((s.savedBaddr / s.cols) | 0) + 1,
    column: (s.savedBaddr % s.cols) + 1,
  };
}

/** emit_cursor_cond(true) @param {Ui} ui @param {State} s */
function emitCursor(ui, s) {
  const cursor = cursorChange(ui, s);
  if (cursor) ui.out("screen", { cursor });
}

/**
 * Compares the cells with the last render: which rows differ, and whether a change may show
 * beyond its own row. Null when the screen size differs.
 * @param {State} s @param {Ui} ui
 */
function compareSaved(s, ui) {
  if (ui.savedRows !== s.rows || ui.savedCols !== s.cols) return null;
  const rows = new Uint8Array(s.rows);
  const n = s.rows * s.cols;
  const savedFa = ui.savedEa.fa;
  for (const name of CELL_ARRAYS) {
    const now = s[name];
    const was = ui.savedEa[name];
    const nowBytes = Buffer.from(now.buffer, now.byteOffset, now.byteLength);
    const wasBytes = Buffer.from(was.buffer, was.byteOffset, was.byteLength);
    const bytes = n * now.BYTES_PER_ELEMENT;
    if (nowBytes.compare(wasBytes, 0, bytes, 0, bytes) === 0) continue;
    const fieldLooks =
      name === "fa" ||
      name === "fg" ||
      name === "bg" ||
      name === "gr" ||
      name === "cs";
    const rowBytes = s.cols * now.BYTES_PER_ELEMENT;
    for (let row = 0; row < s.rows; row++) {
      const start = row * rowBytes;
      const end = start + rowBytes;
      if (nowBytes.compare(wasBytes, start, end, start, end) === 0) continue;
      rows[row] = 1;
      if (!fieldLooks) continue;
      for (let i = row * s.cols; i < (row + 1) * s.cols; i++) {
        if (now[i] === was[i] || (!s.fa[i] && !savedFa[i])) continue;
        // A field attribute's looks carry over to every cell up to the next one; its MDT bit doesn't.
        const onlyMdt =
          name === "fa" &&
          now[i] &&
          was[i] &&
          !((now[i] ^ was[i]) & ~FA_MODIFY);
        if (!onlyMdt) return { rows, spreads: true };
      }
    }
  }
  return { rows, spreads: false };
}

/** @param {State} s */
function eaEmpty(s) {
  const n = s.rows * s.cols;
  for (const name of CELL_ARRAYS) {
    const a = s[name];
    for (let i = 0; i < n; i++) if (a[i]) return false;
  }
  return true;
}

/** screen_disp_cond(): tells the UI what changed since the last call; `always` redraws even an unchanged buffer. @param {State} s @param {boolean} [always] */
export function screenDisp(s, always = false) {
  const ui = s.ui;
  if (!ui) return;
  let sentErase = false;
  if (s.rows !== ui.lastRows || s.cols !== ui.lastCols) {
    emitErase(s, s.rows, s.cols);
    ui.lastRows = s.rows;
    ui.lastCols = s.cols;
    sentErase = true;
    ui.xformatted = false;
    saveEmpty(ui, s);
  }

  // s.changed is set by every cell write and only cleared by Session.flush() after this has drawn.
  if (!always && !s.changed && !ui.savedEmpty && !ui.savedScrolled) {
    emitCursor(ui, s);
    return;
  }

  const diff = compareSaved(s, ui);
  if (!always && diff && !diff.rows.includes(1)) {
    emitCursor(ui, s);
    return;
  }

  if (eaEmpty(s)) {
    if (!ui.savedEmpty) {
      if (!sentErase) emitErase(s, -1, -1);
      ui.xformatted = false;
    }
    saveEmpty(ui, s);
    emitCursor(ui, s);
    return;
  }

  if (s.formatted !== ui.xformatted) {
    ui.out("formatted", { state: s.formatted });
    ui.xformatted = s.formatted;
  }

  const o = ui.saved;
  const n = ui.fresh;
  const dirty =
    !always &&
    diff &&
    !diff.spreads &&
    !ui.savedEmpty &&
    !ui.savedScrolled &&
    ui.savedFormatted === s.formatted
      ? diff.rows
      : null;
  if (dirty)
    for (const name of /** @type {const} */ (["cc", "fg", "bg", "gr"]))
      n[name].set(o[name]);
  render(s, n, dirty);
  /** @type {Record<string, any>} */
  const body = {};
  const cursor = cursorChange(ui, s);
  if (cursor) body.cursor = cursor;
  body.rows = [];
  for (let row = 0; row < s.maxRows; row++) {
    if (dirty && !dirty[row]) continue;
    const base = row * s.maxCols;
    let same = true;
    for (let c = base; c < base + s.maxCols && same; c++)
      same = sameCell(o, n, c);
    if (!same)
      body.rows.push({
        row: row + 1,
        changes: rowChanges(o, n, base, s.maxCols),
      });
  }
  ui.out("screen", body);

  const size = s.rows * s.cols;
  for (const name of CELL_ARRAYS)
    ui.savedEa[name].set(s[name].subarray(0, size));
  ui.savedEmpty = false;
  ui.savedFormatted = s.formatted;
  ui.savedScrolled = false;
  ui.saved = n;
  ui.fresh = o;
  ui.savedRows = s.rows;
  ui.savedCols = s.cols;
}

/** screen_scroll(): the UI's copy of the screen scrolls along. @param {State} s @param {number} fg @param {number} bg */
export function screenScroll(s, fg, bg) {
  const ui = s.ui;
  if (!ui) return;
  if (!fg) fg = s.mode3279 ? BLUE : NEUTRAL_WHITE;
  if (!bg) bg = NEUTRAL_BLACK;
  if (!ui.savedEmpty) {
    const qty = (s.rows - 1) * s.cols;
    for (const name of CELL_ARRAYS) {
      ui.savedEa[name].copyWithin(0, s.cols, s.rows * s.cols);
      ui.savedEa[name].fill(0, qty, qty + s.cols);
    }
    ui.savedEa.fg.fill(0xf0 | fg, qty, qty + s.cols);
    ui.savedEa.bg.fill(0xf0 | bg, qty, qty + s.cols);
  }
  const last = (s.maxRows - 1) * s.maxCols;
  const r = ui.saved;
  for (const arr of [r.cc, r.fg, r.bg, r.gr]) arr.copyWithin(0, s.maxCols);
  r.cc.fill(0x20, last);
  r.fg.fill(fg & 0x0f, last);
  r.bg.fill(bg & 0x0f, last);
  r.gr.fill(0, last);
  // The new last row is filled here rather than by render(), so it may not be what render() would draw.
  ui.savedScrolled = true;
  ui.out("scroll", { fg: COLOR_NAMES[fg & 0x0f], bg: COLOR_NAMES[bg & 0x0f] });
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
  if (!in3270(s) && !inNvt(s)) lockAs(ui, "not-connected", "not-connected");
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

/** Reports the terminal name when it has changed, like report_terminal_name(). @param {State} s */
export function reportTerminalName(s) {
  const ui = s.ui;
  const override = s.options.termName !== null;
  if (!ui || (ui.termtype === s.termtype && ui.termOverride === override))
    return;
  ui.termtype = s.termtype;
  ui.termOverride = override;
  ui.out("terminal-name", { text: s.termtype, override });
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
        if (ui.statsTimer) {
          clearTimeout(ui.statsTimer);
          ui.statsTimer = null;
          dumpStats(s);
        }
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
  if (!ui.statsTimer) dumpStats(s);
  ui.oldCstate = s.cstate;
}

/** b3270's dump_stats(), when the counters moved since the last one. @param {State} s */
function dumpStats(s) {
  const ui = s.ui;
  const now = s.stats;
  const last = ui?.stats;
  if (!ui || !last) return;
  if (
    last.brcvd === now.brcvd &&
    last.rrcvd === now.rrcvd &&
    last.bsent === now.bsent &&
    last.rsent === now.rsent
  )
    return;
  Object.assign(last, now);
  ui.out("stats", {
    "bytes-received": now.brcvd,
    "records-received": now.rrcvd,
    "bytes-sent": now.bsent,
    "records-sent": now.rsent,
  });
}

/** stats_poke(): the counters moved, so report them within 2 seconds. @param {State} s */
export function statsPoke(s) {
  const ui = s.ui;
  if (!ui || ui.statsTimer) return;
  ui.statsTimer = setTimeout(() => {
    ui.statsTimer = null;
    dumpStats(s);
  }, 2000);
  ui.statsTimer.unref();
}
