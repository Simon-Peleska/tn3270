import { CELL_ARRAYS, FA_MODIFY, newCells } from "../src/ctlr.js";
import { NOT_CONNECTED } from "../src/session.js";
import {
  BLUE,
  COLOR_NAMES,
  NEUTRAL_BLACK,
  NEUTRAL_WHITE,
  blank,
  createRendered,
  cursorChange,
  eaEmpty,
  emitCursor,
  emitErase,
  render,
  seeGr,
} from "../src/ui.js";

// What only b3270 writes, which the conformance tests plug in to compare with real b3270
// line by line: the rest of its screen.c, the screen indications describing each change
// against its last render where the emulator only says which rows changed, and the
// indications the app has no use for: hello, proxies, terminal name, stats, scroll thumb.

/** @typedef {import("../src/session.js").State} State */
/** @typedef {import("../src/session.js").Session} Session */
/** @typedef {{kind: string, body: any}} Indication */
/** @typedef {import("../src/ui.js").Ui} Ui */
/** @typedef {import("../src/ui.js").Rendered} Rendered */

const RED_SPAN = 16;
const AM_MAX = 16;

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

const createState = () => ({
  savedRows: 0,
  savedCols: 0,
  savedEa: newCells(0),
  savedEmpty: false,
  savedFormatted: false,
  savedScrolled: false,
  saved: createRendered(0),
  fresh: createRendered(0),
  xformatted: false,
  termtype: "",
  termOverride: false,
  /** The counters the last stats indication showed. */
  stats: { brcvd: 0, rrcvd: 0, bsent: 0, rsent: 0 },
  /** @type {NodeJS.Timeout | null} */
  statsTimer: null,
  thumb: { top: -1, shown: -1, saved: -1, back: -1 },
});
/** @typedef {ReturnType<typeof createState>} B3270 */

/**
 * Session.indications(), but writing what `b3270 -json` writes.
 * @param {Session} session @param {(indication: Indication) => void} listener
 */
export function b3270Indications(session, listener) {
  const b = createState();
  /** @param {Indication} indication */
  const forward = (indication) => {
    listener(indication);
    if (indication.kind === "setting" && indication.body.name === "trace")
      listener({ kind: "trace-file", body: {} });
  };
  /** @type {Indication[] | null} */
  let init = [];
  session.indications(
    (indication) => (init ? init.push(indication) : forward(indication)),
    {
      reset: (s) => reset(b, s),
      disp: (s, always) => screenDisp(b, s, always),
      scroll: (s) => screenScroll(b, s),
      thumb: (s, top) => setThumb(b, s, top),
      terminalName: (s) => reportTerminalName(b, s),
      statsPoke: (s) => statsPoke(b, s),
      connection: (s) => {
        if (s.cstate !== NOT_CONNECTED) {
          if (!b.statsTimer) dumpStats(b, s);
        } else if (b.statsTimer) {
          clearTimeout(b.statsTimer);
          b.statsTimer = null;
          dumpStats(b, s);
        }
      },
    },
  );
  const rest = init;
  init = null;

  // b3270's initialize block, with its own indications back in their places.
  forward({
    kind: "hello",
    body: { version: "4.5.5", build: "node3270 v4.5ga5", copyright: COPYRIGHT },
  });
  const firstSetting = rest.findIndex(({ kind }) => kind === "setting");
  for (const indication of rest.slice(0, firstSetting)) {
    forward(indication);
    if (indication.kind !== "models") continue;
    forward({ kind: "proxies", body: PROXIES });
    forward({ kind: "prefixes", body: { value: "ACLNPSBYT" } });
  }
  reportTerminalName(b, session.s);
  forward({
    kind: "tls-hello",
    body: {
      supported: true,
      provider: `OpenSSL ${process.versions.openssl}`,
      options: TLS_OPTIONS,
    },
  });
  for (const indication of rest.slice(firstSetting)) forward(indication);
}

/** report_terminal_name(), when the name has changed. @param {B3270} b @param {State} s */
function reportTerminalName(b, s) {
  const override = s.options.termName !== null;
  if (b.termtype === s.termtype && b.termOverride === override) return;
  b.termtype = s.termtype;
  b.termOverride = override;
  /** @type {Ui} */ (s.ui).out("terminal-name", { text: s.termtype, override });
}

/** dump_stats(), when the counters moved since the last one. @param {B3270} b @param {State} s */
function dumpStats(b, s) {
  const now = s.stats;
  const last = b.stats;
  if (
    last.brcvd === now.brcvd &&
    last.rrcvd === now.rrcvd &&
    last.bsent === now.bsent &&
    last.rsent === now.rsent
  )
    return;
  Object.assign(last, now);
  /** @type {Ui} */ (s.ui).out("stats", {
    "bytes-received": now.brcvd,
    "records-received": now.rrcvd,
    "bytes-sent": now.bsent,
    "records-sent": now.rsent,
  });
}

/** stats_poke(): the counters moved, so report them within 2 seconds. @param {B3270} b @param {State} s */
function statsPoke(b, s) {
  if (b.statsTimer) return;
  b.statsTimer = setTimeout(() => {
    b.statsTimer = null;
    dumpStats(b, s);
  }, 2000);
  b.statsTimer.unref();
}

/** b3270 prints thumb doubles with %g, and scroll.c computes them in float. @param {number} x */
const g = (x) => Number(Math.fround(x).toPrecision(6));

/** screen_set_thumb(): b3270 drops repeats. @param {B3270} b @param {State} s @param {number} top */
function setThumb(b, s, top) {
  const sc = s.scroll;
  const last = b.thumb;
  if (
    top === last.top &&
    sc.shown === last.shown &&
    sc.saved === last.saved &&
    sc.back === last.back
  )
    return;
  last.top = top;
  last.shown = sc.shown;
  last.saved = sc.saved;
  last.back = sc.back;
  /** @type {Ui} */ (s.ui).out("thumb", {
    top: g(top),
    shown: g(sc.shown),
    saved: sc.saved,
    screen: s.maxRows,
    back: sc.back,
  });
}

/** internal_screen_init(), after the screen-mode and erase, with buffers for the new size. @param {B3270} b @param {State} s */
function reset(b, s) {
  const size = s.maxRows * s.maxCols;
  b.savedEa = newCells(size);
  b.saved = createRendered(size);
  b.fresh = createRendered(size);
  saveEmpty(b, s);
}

/** @param {B3270} b @param {State} s */
function saveEmpty(b, s) {
  for (const name of CELL_ARRAYS) b.savedEa[name].fill(0);
  b.savedRows = s.rows;
  b.savedCols = s.cols;
  b.savedEmpty = true;
  blank(s, b.saved);
}

/** @param {Rendered} a @param {number} i @param {Rendered} b @param {number} j */
const sameAttrs = (a, i, b, j) =>
  a.fg[i] === b.fg[j] && a.bg[i] === b.bg[j] && a.gr[i] === b.gr[j];
/** @param {Rendered} a @param {Rendered} b @param {number} i */
export const sameCell = (a, b, i) =>
  a.cc[i] === b.cc[i] && sameAttrs(a, i, b, i);

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

/**
 * Compares the cells with the last render: which rows differ, and whether a change may show
 * beyond its own row. Null when the screen size differs.
 * @param {B3270} b @param {State} s
 */
function compareSaved(b, s) {
  if (b.savedRows !== s.rows || b.savedCols !== s.cols) return null;
  const rows = new Uint8Array(s.rows);
  const n = s.rows * s.cols;
  const savedFa = b.savedEa.fa;
  for (const name of CELL_ARRAYS) {
    const now = s[name];
    const was = b.savedEa[name];
    const nowBytes = Buffer.from(now.buffer, now.byteOffset, now.byteLength);
    const wasBytes = Buffer.from(was.buffer, was.byteOffset, was.byteLength);
    if (nowBytes.compare(wasBytes, 0, n, 0, n) === 0) continue;
    const fieldLooks =
      name === "fa" ||
      name === "fg" ||
      name === "bg" ||
      name === "gr" ||
      name === "cs";
    for (let row = 0; row < s.rows; row++) {
      const start = row * s.cols;
      const end = start + s.cols;
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

/** screen_disp_cond(): tells the UI what changed since the last call; `always` redraws even an unchanged buffer. @param {B3270} b @param {State} s @param {boolean} always */
function screenDisp(b, s, always) {
  const ui = /** @type {Ui} */ (s.ui);
  let sentErase = false;
  if (s.rows !== ui.lastRows || s.cols !== ui.lastCols) {
    emitErase(s, s.rows, s.cols);
    ui.lastRows = s.rows;
    ui.lastCols = s.cols;
    sentErase = true;
    b.xformatted = false;
    saveEmpty(b, s);
  }

  // s.changed is set by every cell write and only cleared by Session.flush() after this has drawn.
  if (!always && !s.changed && !b.savedEmpty && !b.savedScrolled) {
    emitCursor(ui, s);
    return;
  }

  const diff = compareSaved(b, s);
  if (!always && diff && !diff.rows.includes(1)) {
    emitCursor(ui, s);
    return;
  }

  if (eaEmpty(s)) {
    if (!b.savedEmpty) {
      if (!sentErase) emitErase(s, -1, -1);
      b.xformatted = false;
    }
    saveEmpty(b, s);
    emitCursor(ui, s);
    return;
  }

  if (s.formatted !== b.xformatted) {
    ui.out("formatted", { state: s.formatted });
    b.xformatted = s.formatted;
  }

  const o = b.saved;
  const n = b.fresh;
  const dirty =
    !always &&
    diff &&
    !diff.spreads &&
    !b.savedEmpty &&
    !b.savedScrolled &&
    b.savedFormatted === s.formatted
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
    b.savedEa[name].set(s[name].subarray(0, size));
  b.savedEmpty = false;
  b.savedFormatted = s.formatted;
  b.savedScrolled = false;
  b.saved = n;
  b.fresh = o;
  b.savedRows = s.rows;
  b.savedCols = s.cols;
}

/** screen_scroll(): b3270 flushes pending changes first, then scrolls its UI's copy. @param {B3270} b @param {State} s */
function screenScroll(b, s) {
  screenDisp(b, s, false);
  const ui = /** @type {Ui} */ (s.ui);
  const fg = s.mode3279 ? BLUE : NEUTRAL_WHITE;
  const bg = NEUTRAL_BLACK;
  if (!b.savedEmpty) {
    const qty = (s.rows - 1) * s.cols;
    for (const name of CELL_ARRAYS) {
      b.savedEa[name].copyWithin(0, s.cols, s.rows * s.cols);
      b.savedEa[name].fill(0, qty, qty + s.cols);
    }
    b.savedEa.fg.fill(0xf0 | fg, qty, qty + s.cols);
    b.savedEa.bg.fill(0xf0 | bg, qty, qty + s.cols);
  }
  const last = (s.maxRows - 1) * s.maxCols;
  const r = b.saved;
  for (const arr of [r.cc, r.fg, r.bg, r.gr]) arr.copyWithin(0, s.maxCols);
  r.cc.fill(0x20, last);
  r.fg.fill(fg & 0x0f, last);
  r.bg.fill(bg & 0x0f, last);
  r.gr.fill(0, last);
  // The new last row is filled here rather than by render(), so it may not be what render() would draw.
  b.savedScrolled = true;
  ui.out("scroll", { fg: COLOR_NAMES[fg & 0x0f], bg: COLOR_NAMES[bg & 0x0f] });
}
