import { CS_GE, CS_MASK, ebcdicToUnicode } from "../src/charset.js";
import {
  XA_3270,
  XA_BACKGROUND,
  XA_CHARSET,
  XA_FOREGROUND,
  XA_HIGHLIGHTING,
  XA_INPUT_CONTROL,
  csAt,
  faAt,
  fieldAttribute,
  findFieldAttribute,
  findFieldAttributeRaw,
  hostCs,
  isProtected,
  isZero,
} from "../src/ctlr.js";
import {
  ACTIONS,
  ACTION_NAMES,
  NOT_CONNECTED,
  RECONNECTING,
  in3270,
} from "../src/session.js";
import { actionOutput, popupError } from "../src/ui.js";

// task.c's actions that read the screen, which the app never runs. The conformance tests read
// the screen through them, field attributes and all, to compare it with b3270's.

/** @typedef {import("../src/session.js").State} State */

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

/** check_argc() @param {State} s @param {string} name @param {number} n */
function noArgs(s, name, n) {
  if (n === 0) return true;
  popupError(s, `${name}() requires 0 arguments`);
  return false;
}

/** atoi() @param {string} text */
function atoi(text) {
  const m = /^\s*([+-]?\d+)/.exec(text);
  return m ? Number(m[1]) | 0 : 0;
}

/**
 * dump_range(): len cells from first as text (or EBCDIC hex), a line per screen row.
 * @param {State} s @param {number} first @param {number} len @param {boolean} ascii
 */
function dumpRange(s, first, len, ascii) {
  /** @type {string[]} */
  const lines = [];
  const attr = findFieldAttributeRaw(s, first);
  let zero = isZero(faAt(s, attr));
  let faCs = csAt(s, attr);
  let line = "";
  let any = false;
  for (let i = 0; i < len; i++) {
    const b = first + i;
    if (i && b % s.cols === 0) {
      lines.push(line);
      line = "";
      any = false;
    }
    if (!ascii) {
      line += `${any ? " " : ""}${s.ec[b].toString(16).padStart(2, "0")}`;
    } else if (s.fa[b]) {
      faCs = s.cs[b];
      zero = isZero(s.fa[b]);
      line += " ";
    } else if (zero) {
      line += " ";
    } else {
      let u = ebcdicToUnicode(s.codePage, s.ec[b], faCs || s.cs[b]);
      if (u && s.options.monoCase) u = toUpper(u);
      line += u ? String.fromCodePoint(u) : " ";
    }
    any = true;
  }
  if (any) lines.push(line);
  return lines;
}

/**
 * dump_fixed(): Ascii() and friends: everything, n cells from the cursor, n cells from
 * row,col or a rows x cols rectangle.
 * @param {State} s @param {string[]} args @param {number} origin @param {string} name @param {boolean} ascii
 */
function dumpFixed(s, args, origin, name, ascii) {
  let row, col;
  let len = 0;
  let rows = 0,
    cols = 0;
  if (args.length === 0) {
    row = col = origin;
    len = s.rows * s.cols;
  } else if (args.length === 1) {
    row = Math.floor(s.cursor / s.cols);
    col = s.cursor % s.cols;
    len = atoi(args[0]);
  } else if (args.length === 3) {
    [row, col, len] = args.map(atoi);
  } else if (args.length === 4) {
    [row, col, rows, cols] = args.map(atoi);
  } else {
    popupError(s, `${name}() requires 0, 1, 3 or 4 arguments`);
    return false;
  }
  if (row < 0) {
    if (-row > s.rows) {
      popupError(s, `${name}(): Invalid row`);
      return false;
    }
    row += s.rows;
  } else row -= origin;
  if (col < 0) {
    if (-col > s.cols) {
      popupError(s, `${name}(): Invalid column`);
      return false;
    }
    col += s.cols;
  } else col -= origin;
  if (
    row < 0 ||
    row > s.rows ||
    col < 0 ||
    col > s.cols ||
    len < 0 ||
    (args.length < 4 && row * s.cols + col + len > s.rows * s.cols) ||
    (args.length === 4 &&
      (cols < 0 || rows < 0 || col + cols > s.cols || row + rows > s.rows))
  ) {
    popupError(s, `${name}(): Invalid argument`);
    return false;
  }
  /** @type {string[]} */
  let lines = [];
  // b3270 reads past the screen (and dies) for a zero-length dump at its very end.
  if (args.length < 4 && row * s.cols + col < s.rows * s.cols)
    lines = dumpRange(s, row * s.cols + col, len, ascii);
  if (args.length === 4)
    for (let i = 0; i < rows; i++)
      lines.push(...dumpRange(s, (row + i) * s.cols + col, cols, ascii));
  if (!lines.length) lines.push("");
  for (const line of lines) actionOutput(s, line);
  return true;
}

/** dump_field(): AsciiField() and EbcdicField(). @param {State} s @param {any[]} args @param {string} name @param {boolean} ascii */
function dumpField(s, args, name, ascii) {
  if (!noArgs(s, name, args.length)) return false;
  if (!s.formatted) {
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
  for (const line of dumpRange(s, start, len, ascii)) actionOutput(s, line);
  return true;
}

const hex2 = (/** @type {number} */ n) => n.toString(16).padStart(2, "0");

/**
 * ReadBuffer(Ascii|Ebcdic|Unicode) of the whole screen: one line per row, one token per cell,
 * with SF() for field attributes and SA() where the character attributes change.
 * With a field address, just that field, as one line.
 * @param {State} s @param {"ascii" | "ebcdic" | "unicode"} mode @param {number} [field]
 */
function readBufferText(s, mode, field = -1) {
  /** @type {string[]} */
  const lines = [];
  let fg = 0,
    bg = 0,
    gr = 0,
    cs = 0;
  let faCs = csAt(s, field >= 0 ? field : findFieldAttributeRaw(s, 0));
  let line = "";
  const size = s.rows * s.cols;
  for (let i = 0; i < size; i++) {
    const b = (Math.max(field, 0) + i) % size;
    if (field < 0 && b % s.cols === 0 && b) {
      lines.push(line.slice(1));
      line = "";
    }
    if (field >= 0 && i && s.fa[b]) break;
    if (s.fa[b]) {
      faCs = s.cs[b];
      line += ` SF(${hex2(XA_3270)}=${hex2(s.fa[b])}`;
      if (s.fg[b]) line += `,${hex2(XA_FOREGROUND)}=${hex2(s.fg[b])}`;
      if (s.bg[b]) line += `,${hex2(XA_BACKGROUND)}=${hex2(s.bg[b])}`;
      if (s.gr[b]) line += `,${hex2(XA_HIGHLIGHTING)}=${hex2(s.gr[b] | 0xf0)}`;
      if (s.ic[b]) line += `,${hex2(XA_INPUT_CONTROL)}=${hex2(s.ic[b])}`;
      if (s.cs[b] & CS_MASK)
        line += `,${hex2(XA_CHARSET)}=${hex2(hostCs(s.cs[b]))}`;
      line += ")";
      continue;
    }
    /** @type {string[]} */
    const sa = [];
    if (s.fg[b] !== fg)
      sa.push(`${hex2(XA_FOREGROUND)}=${hex2((fg = s.fg[b]))}`);
    if (s.bg[b] !== bg)
      sa.push(`${hex2(XA_BACKGROUND)}=${hex2((bg = s.bg[b]))}`);
    if (s.gr[b] !== gr)
      sa.push(`${hex2(XA_HIGHLIGHTING)}=${hex2((gr = s.gr[b]) | 0xf0)}`);
    // x3270 never updates its current input control, so any set one repeats on every cell.
    if (s.ic[b]) sa.push(`${hex2(XA_INPUT_CONTROL)}=${hex2(s.ic[b])}`);
    const xcs = s.cs[b] & CS_MASK;
    if (xcs !== (cs & CS_MASK))
      sa.push(`${hex2(XA_CHARSET)}=${hex2(hostCs((cs = xcs)))}`);
    if (sa.length) line += ` SA(${sa.join(",")})`;

    if (mode === "ebcdic") {
      line += s.cs[b] & CS_GE ? ` GE(${hex2(s.ec[b])})` : ` ${hex2(s.ec[b])}`;
      continue;
    }
    const c = s.ec[b];
    const u =
      c === 0x00
        ? 0
        : c === 0x0e
          ? 0x0e
          : c === 0x0f
            ? 0x0f
            : ebcdicToUnicode(s.codePage, c, s.cs[b] || faCs);
    if (mode === "unicode") line += ` ${u.toString(16).padStart(4, "0")}`;
    else if (u < 0x80) line += ` ${hex2(u)}`;
    else line += ` ${Buffer.from(String.fromCodePoint(u)).toString("hex")}`;
  }
  lines.push(line.slice(1));
  return lines;
}

/**
 * ReadBuffer(Ascii|Ebcdic|Unicode|Field): the screen, a line per row, or the cursor's field.
 * @param {State} s @param {any[]} argv
 */
function readBuffer(s, ...argv) {
  /** @type {"ascii" | "ebcdic" | "unicode"} */
  let mode = "ascii";
  let field = false;
  for (const arg of argv.map(String)) {
    const word = arg.toLowerCase();
    if ("ascii".startsWith(word)) mode = "ascii";
    else if ("ebcdic".startsWith(word)) mode = "ebcdic";
    else if ("unicode".startsWith(word)) mode = "unicode";
    else if ("field".startsWith(word)) field = true;
    else {
      popupError(
        s,
        "ReadBuffer(): Parameter must be ascii, ebcdic, unicode or field",
      );
      return false;
    }
  }
  if (!field) {
    for (const line of readBufferText(s, mode)) actionOutput(s, line);
    return true;
  }
  if (!s.formatted) {
    popupError(s, "ReadBuffer(): no field");
    return false;
  }
  const start = findFieldAttribute(s, s.cursor);
  const at = (/** @type {number} */ b) =>
    `${Math.floor(b / s.cols) + 1} ${(b % s.cols) + 1}`;
  actionOutput(s, `Start1: ${at(start)}`);
  actionOutput(s, `StartOffset: ${start}`);
  actionOutput(s, `Cursor1: ${at(s.cursor)}`);
  actionOutput(s, `CursorOffset: ${s.cursor}`);
  actionOutput(s, `Contents: ${readBufferText(s, mode, start)[0]}`);
  return true;
}

/** @type {Record<string, (s: State, ...args: any[]) => boolean>} */
const READ_ACTIONS = {
  Ascii: (s, ...args) => dumpFixed(s, args.map(String), 0, "Ascii", true),
  Ascii1: (s, ...args) => dumpFixed(s, args.map(String), 1, "Ascii1", true),
  AsciiField: (s, ...args) => dumpField(s, args, "AsciiField", true),
  Ebcdic: (s, ...args) => dumpFixed(s, args.map(String), 0, "Ebcdic", false),
  Ebcdic1: (s, ...args) => dumpFixed(s, args.map(String), 1, "Ebcdic1", false),
  EbcdicField: (s, ...args) => dumpField(s, args, "EbcdicField", false),
  ReadBuffer: readBuffer,
};

Object.assign(ACTIONS, READ_ACTIONS);
for (const name of Object.keys(READ_ACTIONS))
  ACTION_NAMES.set(name.toLowerCase(), name);

/** status_string(): the 11 fields of s3270's prompt, without its window id. @param {State} s */
export function statusString(s) {
  const prot =
    s.formatted && isProtected(fieldAttribute(s, s.cursor)) ? "P" : "U";
  const connection = s.cstate > RECONNECTING ? `C(${s.connHost})` : "N";
  let mode = "N";
  if (s.cstate > NOT_CONNECTED) mode = in3270(s) ? "I" : "P";
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
  ].join(" ");
}

/** The screen as text, one string per row, the way s3270's Ascii() shows it. @param {State} s */
export const screenText = (s) => dumpRange(s, 0, s.rows * s.cols, true);
