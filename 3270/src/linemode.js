import { nvtProcess, nvtWrappingBackspace, utf8ToUnicode } from "./nvt.js";
import { netBreak, netCookedout, netInterrupt } from "./telnet.js";

// Port of x3270's Common/linemode.c: in NVT line mode the keyboard is edited
// locally, echoed through the NVT emulator, and sent a line at a time.

/** @typedef {import("./session.js").State} State */

const LM_BUFSZ = 16384;
// s3270's stty defaults; icrnl is on and inlcr off.
export const VINTR = 0x03,
  VQUIT = 0x1c,
  VERASE = 0x08,
  VKILL = 0x15,
  VEOF = 0x04,
  VWERASE = 0x17,
  VRPRNT = 0x12,
  VLNEXT = 0x16;

export function createLinemode() {
  return {
    /** @type {number[]} */
    buf: [],
    lnext: false,
    backslashed: false,
  };
}

/** linemode_buf_init() @param {State} s */
export function linemodeBufInit(s) {
  s.lm.buf = [];
  s.lm.lnext = false;
  s.lm.backslashed = false;
}

/** linemode_dump(): the switch to character mode sends whatever was typed. @param {State} s */
export function linemodeDump(s) {
  forwardData(s);
}

/** linemode_out(): keyboard data in line mode. @param {State} s @param {ArrayLike<number>} bytes */
export function linemodeOut(s, bytes) {
  const lm = s.lm;
  for (let i = 0; i < bytes.length; i++) {
    let c = bytes[i];
    if (!lm.lnext && c === 0x0d) c = 0x0a;
    lm.backslashed = c === 0x5c && !lm.backslashed;
    if (c === 0x0a) doEol(s, c);
    else if (c === VINTR) doIntr(s, c);
    else if (c === VQUIT) doQuit(s, c);
    else if (c === VERASE) doCerase(s, c);
    else if (c === VKILL) doKill(s, c);
    else if (c === VWERASE) doWerase(s, c);
    else if (c === VRPRNT) doRprnt(s, c);
    else if (c === VEOF) doEof(s, c);
    else if (c === VLNEXT) doLnext(s, c);
    // x3270's "yes, a hack": BS and DEL always erase.
    else if (c === 0x08 || c === 0x7f) doCerase(s, c);
    else doData(s, c);
  }
}

/** @param {State} s @param {string} text */
function echo(s, text) {
  for (let i = 0; i < text.length; i++) nvtProcess(s, text.charCodeAt(i));
}

/** just_ctl_see(): control characters as ^X, DEL as ^?, everything else as the byte itself. @param {number} c */
function justCtlSee(c) {
  if (c === 0x7f) return "^?";
  if (c < 0x20) return `^${String.fromCharCode(c + 0x40)}`;
  return String.fromCharCode(c);
}

/** ctl_see(): like just_ctl_see(), plus M- for 0x80-0xa0. @param {number} c */
function ctlSee(c) {
  if (c & 0x80 && c <= 0xa0) return `M-${justCtlSee(c & 0x7f)}`;
  return justCtlSee(c);
}

/**
 * expand_lbuf(): the typed line as characters, with how many bytes each takes and
 * how many columns its echo does. Undecodable bytes are skipped, as x3270 does.
 * @param {State} s
 */
function expandLbuf(s) {
  const buf = Uint8Array.from(s.lm.buf);
  /** @type {{ucs4: number, mbLen: number, echoLen: number, dbcs: boolean}[]} */
  const widths = [];
  const decoded = { ch: 0 };
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0) {
      widths.push({ ucs4: 0, mbLen: 1, echoLen: 2, dbcs: false });
      i++;
      continue;
    }
    const used = utf8ToUnicode(decoded, buf.subarray(i), buf.length - i);
    const u = decoded.ch;
    if (used <= 0) {
      i++;
      continue;
    }
    if (u < 0x20 || u === 0x7f)
      widths.push({ ucs4: u, mbLen: used, echoLen: 2, dbcs: false });
    else
      widths.push({
        ucs4: u,
        mbLen: used,
        echoLen: 1,
        dbcs: u >= 0x2e80 && u <= 0xd7ff,
      });
    i += used;
  }
  return widths;
}

/** nvt_backspace(): rubs out one echoed column, or two for DBCS. @param {State} s @param {boolean} dbcs */
function rubOut(s, dbcs) {
  nvtWrappingBackspace(s);
  if (dbcs) nvtWrappingBackspace(s);
  echo(s, dbcs ? "  " : " ");
  nvtWrappingBackspace(s);
  if (dbcs) nvtWrappingBackspace(s);
}

/** @param {State} s */
function forwardData(s) {
  netCookedout(s, s.lm.buf);
  linemodeBufInit(s);
}

/** @param {State} s @param {number} c */
function doData(s, c) {
  const lm = s.lm;
  if (lm.buf.length + 1 < LM_BUFSZ) {
    lm.buf.push(c);
    if (c === 0x0d) lm.buf.push(0);
    echo(s, justCtlSee(c));
  } else {
    echo(s, "\x07");
  }
  lm.lnext = false;
  lm.backslashed = false;
}

/** @param {State} s @param {number} c */
function doIntr(s, c) {
  if (s.lm.lnext) return doData(s, c);
  echo(s, ctlSee(c));
  linemodeBufInit(s);
  netInterrupt(s);
}

/** @param {State} s @param {number} c */
function doQuit(s, c) {
  if (s.lm.lnext) return doData(s, c);
  echo(s, ctlSee(c));
  linemodeBufInit(s);
  netBreak(s);
}

/** @param {State} s @param {number} c */
function doCerase(s, c) {
  if (s.lm.lnext) return doData(s, c);
  const widths = expandLbuf(s);
  if (!widths.length) return;
  const last = widths[widths.length - 1];
  s.lm.buf.length -= last.mbLen;
  for (let n = 0; n < last.echoLen; n++) rubOut(s, last.dbcs);
}

/** @param {State} s @param {number} c */
function doWerase(s, c) {
  if (s.lm.lnext) return doData(s, c);
  const widths = expandLbuf(s);
  let any = false;
  for (let ix = widths.length - 1; ix >= 0; ix--) {
    const w = widths[ix];
    if (w.ucs4 === 0x20 || w.ucs4 === 0x09) {
      if (any) break;
    } else {
      any = true;
    }
    s.lm.buf.length -= w.mbLen;
    for (let n = 0; n < w.echoLen; n++) rubOut(s, w.dbcs);
  }
}

/** @param {State} s @param {number} c */
function doKill(s, c) {
  if (s.lm.lnext) return doData(s, c);
  const widths = expandLbuf(s);
  if (!widths.length) return;
  for (let ix = widths.length - 1; ix >= 0; ix--) {
    for (let n = 0; n < widths[ix].echoLen; n++) rubOut(s, widths[ix].dbcs);
  }
  s.lm.buf = [];
}

/** @param {State} s @param {number} c */
function doRprnt(s, c) {
  if (s.lm.lnext) return doData(s, c);
  echo(s, justCtlSee(c));
  echo(s, "\r\n");
  let p = 0;
  for (const w of expandLbuf(s)) {
    if (w.ucs4 < 0x20) echo(s, `^${String.fromCharCode(w.ucs4 + 0x40)}`);
    else if (w.ucs4 === 0x7f) echo(s, "^?");
    else for (let i = 0; i < w.mbLen; i++) nvtProcess(s, s.lm.buf[p + i]);
    p += w.mbLen;
  }
}

/** @param {State} s @param {number} c */
function doEof(s, c) {
  if (s.lm.lnext) return doData(s, c);
  doData(s, c);
  forwardData(s);
}

/** @param {State} s @param {number} c */
function doEol(s, c) {
  if (s.lm.lnext) return doData(s, c);
  if (s.lm.buf.length + 2 >= LM_BUFSZ) {
    echo(s, "\x07");
    return;
  }
  s.lm.buf.push(0x0d, 0x0a);
  echo(s, "\r\n");
  forwardData(s);
}

/** @param {State} s @param {number} c */
function doLnext(s, c) {
  if (s.lm.lnext) return doData(s, c);
  s.lm.lnext = true;
  echo(s, "^");
  nvtWrappingBackspace(s);
}
