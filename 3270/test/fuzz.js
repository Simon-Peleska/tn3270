import assert from "node:assert/strict";
import { assertSameLines, scenario, startB3270, startOurs } from "./harness.js";
import { FuzzedDataProvider } from "@jazzer.js/core/dist/FuzzedDataProvider.js";
import { CODE_TABLE } from "../src/ctlr.js";

// Random scenarios that b3270 and node3270 must play out identically: keyboard actions on a
// formatted screen, random 3270 data streams from the host, and random NVT text and escapes.
// Every choice comes from an Rng: a seed for scripts/fuzz.mjs, or the input of Jazzer.js's
// coverage-guided fuzz() below (npm run fuzz). A case is a pure function of either, so a failure
// replays exactly.

/** @typedef {[string, ...(string | number)[]]} Step */

/** mulberry32: small, fast and good enough to pick test inputs. @param {number} seed */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** 0 <= n < max @param {number} max */
    int: (max) => Math.floor(next() * max),
    /** @template T @param {T[]} items @returns {T} */
    pick: (items) => items[Math.floor(next() * items.length)],
    /** @param {number} p */
    chance: (p) => next() < p,
  };
}
/** @typedef {ReturnType<typeof rng>} Rng */

/**
 * The same choices, read from a fuzzer's input. A finished input reads as all zeros, which keeps
 * every case finite.
 * @param {Buffer} data @returns {Rng}
 */
export function fromData(data) {
  const p = new FuzzedDataProvider(data);
  const int = (/** @type {number} */ max) =>
    max <= 1 ? 0 : p.consumeIntegralInRange(0, max - 1);
  return {
    next: () => p.consumeProbabilityFloat(),
    int,
    pick: (items) => items[int(items.length)],
    chance: (chance) => p.consumeProbabilityFloat() < chance,
  };
}

const TYPED_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."      .,;:-_+*/=()<>!?&%$#@'\"|",
  ..."äöüÄÖÜß€¢¬",
];

/** Text for String(): mostly plain characters, sometimes x3270's escapes. @param {Rng} r */
function typedText(r) {
  let text = "";
  const len = 1 + r.int(12);
  for (let i = 0; i < len; i++) {
    if (r.chance(0.04))
      text += r.pick(["\\t", "\\b", "\\n", "\\r", "\\\\", "\\x41", "\\e"]);
    else text += r.pick(TYPED_CHARS);
  }
  return text;
}

/** @param {Rng} r @param {number} bytes */
function hexBytes(r, bytes) {
  let hex = "";
  for (let i = 0; i < bytes; i++)
    hex += r.int(256).toString(16).padStart(2, "0");
  return hex;
}

/** Actions that edit the screen and never wait on the host. @param {Rng} r @returns {Step} */
function editAction(r) {
  switch (r.int(14)) {
    case 0:
    case 1:
    case 2:
      return ["String", typedText(r)];
    case 3:
      return [
        r.pick([
          "Tab",
          "BackTab",
          "Home",
          "Left",
          "Right",
          "Up",
          "Down",
          "Newline",
          "FieldEnd",
          "NextWord",
          "PreviousWord",
          "Left2",
          "Right2",
        ]),
      ];
    case 4:
      return [
        r.pick([
          "Delete",
          "BackSpace",
          "Erase",
          "EraseEOF",
          "EraseInput",
          "DeleteField",
          "DeleteWord",
          "Dup",
          "FieldMark",
          "CircumNot",
        ]),
      ];
    case 5:
      return [r.pick(["Insert", "ToggleInsert", "Reset", "ToggleReverse"])];
    case 6:
      return r.chance(0.5)
        ? ["MoveCursor", r.int(26), r.int(82)]
        : ["MoveCursor1", 1 + r.int(25), 1 + r.int(81)];
    case 7:
      return ["Key", r.pick(TYPED_CHARS)];
    case 8:
      return ["HexString", hexBytes(r, 1 + r.int(4))];
    case 9:
      return [
        "PasteString",
        Buffer.from(typedText(r).replace(/\\/g, ""), "utf8").toString("hex"),
      ];
    case 10: {
      const row = 1 + r.int(24);
      const col = 1 + r.int(80);
      return [
        "ClearRegion",
        row,
        col,
        r.int(25 - row + 1),
        r.int(81 - col + 1),
      ];
    }
    case 11:
      return [
        "Toggle",
        r.pick([
          "monoCase",
          "blankFill",
          "overlayPaste",
          "insertMode",
          "reverseInputMode",
          "underscoreBlankFill",
        ]),
      ];
    case 12:
      return ["SaveInput"];
    default:
      return ["RestoreInput"];
  }
}

/** Actions that send the host an AID; the harness answers each with a keyboard unlock. @param {Rng} r @returns {Step} */
function aidAction(r) {
  switch (r.int(4)) {
    case 0:
      return ["Enter"];
    case 1:
      return ["PF", 1 + r.int(24)];
    case 2:
      return ["PA", 1 + r.int(3)];
    default:
      return ["Clear"];
  }
}

/** Actions that only read; the screen must stay inside 24x80 for the ranges, as dumping from the very end crashes b3270. @param {Rng} r @returns {Step} */
function readAction(r) {
  switch (r.int(8)) {
    case 0:
      return ["Ascii"];
    case 1:
      return ["Ascii", r.int(24), r.int(80), 1 + r.int(80)];
    case 2:
      return ["Ebcdic", r.int(24), 0, 1 + r.int(80)];
    case 3:
      return ["ReadBuffer"];
    case 4:
      return ["ReadBuffer", "Ebcdic"];
    case 5:
      return ["AsciiField"];
    case 6:
      return [
        "Query",
        r.pick(["Cursor", "Cursor1", "Formatted", "ScreenCurSize"]),
      ];
    default:
      return ["Snap", "Ascii", 0, 0, 1 + r.int(80)];
  }
}

/** Keyboard work on three-fields.trc's formatted screen. @param {Rng} r */
export function keyboardCase(r) {
  /** @type {Step[]} */
  const actions = [];
  const steps = 20 + r.int(30);
  for (let i = 0; i < steps; i++) {
    const roll = r.next();
    if (roll < 0.75) actions.push(editAction(r));
    else if (roll < 0.83) actions.push(aidAction(r));
    else actions.push(readAction(r));
  }
  actions.push(["Ascii", 0, 0, 240], ["ReadBuffer"]);
  return { trace: "three-fields.trc", actions };
}

/** A buffer address, usually on a 24x80 screen, sometimes past even 43x80. @param {Rng} r */
function address(r) {
  const addr = r.chance(0.9) ? r.int(1920) : r.int(4200);
  if (addr < 4096 && r.chance(0.8))
    return [CODE_TABLE[addr >> 6], CODE_TABLE[addr & 0x3f]];
  return [(addr >> 8) & 0x3f, addr & 0xff];
}

/** Mostly printable EBCDIC, now and then any byte. @param {Rng} r */
function ebcdicChar(r) {
  if (r.chance(0.05)) return r.int(256);
  return r.pick([
    0x40,
    0x40,
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => [
      0x81 + i,
      0x91 + i,
      0xc1 + i,
      0xd1 + i,
    ]),
    0xf0,
    0xf1,
    0xf5,
    0xf9,
    0x4b,
    0x4d,
    0x5c,
    0x6b,
    0x7d,
  ]);
}

/** A field attribute: the common ones, and any byte. @param {Rng} r */
function fieldAttr(r) {
  return r.chance(0.8)
    ? r.pick([0x40, 0x60, 0xc8, 0xe8, 0x4c, 0x6c, 0x50, 0xf0, 0xf8, 0x7c, 0xc1])
    : r.int(256);
}

/** An extended attribute pair for SFE, SA and MF. @param {Rng} r */
function extAttr(r) {
  const type = r.pick([0xc0, 0x41, 0x42, 0x43, 0x45, 0x46, 0x00, r.int(256)]);
  const value =
    type === 0xc0
      ? fieldAttr(r)
      : type === 0x41
        ? r.pick([0x00, 0xf1, 0xf2, 0xf4, 0xf8])
        : type === 0x42 || type === 0x45
          ? r.pick([0x00, 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xff])
          : type === 0x43
            ? r.pick([0x00, 0xf1, 0x41])
            : r.int(256);
  return [type, value];
}

/** A 3270 Write, Erase/Write, Erase/Write Alternate or Erase All Unprotected, with random orders. @param {Rng} r */
function writeRecord(r) {
  const command = r.pick([0xf1, 0xf1, 0xf1, 0xf5, 0x7e, 0x6f, 0xf1]);
  /** @type {number[]} */
  const bytes = [command];
  if (command === 0x6f) return bytes;
  // WCC: mostly keyboard restore, sometimes reset MDT, sound alarm or nothing.
  bytes.push(r.pick([0xc2, 0xc3, 0xc6, 0x40, 0xc0, r.int(256)]));
  const orders = r.int(14);
  for (let i = 0; i < orders; i++) {
    switch (r.int(12)) {
      case 0:
      case 1:
        bytes.push(0x11, ...address(r));
        break;
      case 2:
        bytes.push(0x1d, fieldAttr(r));
        break;
      case 3: {
        const pairs = r.int(4);
        bytes.push(0x29, pairs);
        for (let p = 0; p < pairs; p++) bytes.push(...extAttr(r));
        break;
      }
      case 4:
        bytes.push(0x28, ...extAttr(r));
        break;
      case 5: {
        const pairs = r.int(3);
        bytes.push(0x2c, pairs);
        for (let p = 0; p < pairs; p++) bytes.push(...extAttr(r));
        break;
      }
      case 6:
        bytes.push(r.pick([0x13, 0x05]));
        break;
      case 7:
        bytes.push(0x3c, ...address(r));
        if (r.chance(0.2)) bytes.push(0x08);
        bytes.push(ebcdicChar(r));
        break;
      case 8:
        bytes.push(0x12, ...address(r));
        break;
      case 9:
        bytes.push(0x08, ebcdicChar(r));
        break;
      default: {
        const len = 1 + r.int(20);
        for (let c = 0; c < len; c++) bytes.push(ebcdicChar(r));
      }
    }
  }
  return bytes;
}

/** Read Buffer, Read Modified, Read Modified All, or a Read Partition query. @param {Rng} r */
function readRecord(r) {
  if (r.chance(0.2)) return [0xf3, 0x00, 0x05, 0x01, 0xff, 0xff, 0x02];
  return [r.pick([0xf2, 0xf6, 0x6e])];
}

/** One TN3270E 3270-DATA record, IACs doubled. @param {number[]} bytes */
function record3270(bytes) {
  const body = Buffer.from(bytes.flatMap((b) => (b === 0xff ? [b, b] : [b])));
  return `0000000000${body.toString("hex")}ffef`;
}

/** Random host writes on three-fields.trc, mixed with typing and reading. @param {Rng} r */
export function dataStreamCase(r) {
  /** @type {Step[]} */
  const actions = [];
  const steps = 15 + r.int(25);
  for (let i = 0; i < steps; i++) {
    const roll = r.next();
    if (roll < 0.45) actions.push(["host", record3270(writeRecord(r))]);
    else if (roll < 0.5) actions.push(["host", record3270(readRecord(r))]);
    else if (roll < 0.8) actions.push(editAction(r));
    else if (roll < 0.85) actions.push(aidAction(r));
    else actions.push(readAction(r));
  }
  actions.push(["Ascii"], ["ReadBuffer"]);
  return { trace: "three-fields.trc", actions };
}

/** Random NVT output: text, controls, UTF-8 and ANSI escapes. @param {Rng} r */
function nvtBytes(r) {
  let text = "";
  const parts = 1 + r.int(8);
  for (let i = 0; i < parts; i++) {
    switch (r.int(9)) {
      case 0:
      case 1:
        for (let n = 1 + r.int(30); n > 0; n--) text += r.pick(TYPED_CHARS);
        break;
      case 2:
        text += r.pick([
          "\r\n",
          "\r",
          "\n",
          "\b",
          "\t",
          "\x07",
          "\x0e",
          "\x0f",
        ]);
        break;
      case 3: {
        const params = [];
        for (let n = r.int(3); n > 0; n--) params.push(String(r.int(50)));
        text += `\x1b[${r.chance(0.1) ? "?" : ""}${params.join(";")}${r.pick([..."ABCDEFGHJKLMPX@dfghlmnrsu"])}`;
        break;
      }
      case 4:
        text += `\x1b[${r.pick(["0", "1", "4", "5", "7", "22", "24", "27", "3" + r.int(10), "4" + r.int(10)])}m`;
        break;
      case 5:
        text += `\x1b${r.pick([..."78DEMc=>"])}`;
        break;
      case 6:
        text += `\x1b${r.pick(["(", ")"])}${r.pick(["0", "B", "A"])}`;
        break;
      case 7:
        text += `\x1b[${1 + r.int(24)};${1 + r.int(80)}H`;
        break;
      default:
        text += String.fromCharCode(r.int(128));
    }
  }
  const bytes = Buffer.from(text, r.chance(0.8) ? "utf8" : "latin1");
  return Buffer.from(
    [...bytes].flatMap((b) => (b === 0xff ? [b, b] : [b])),
  ).toString("hex");
}

/** NVT host output on nvt-data.trc, mixed with typing and reading. @param {Rng} r */
export function nvtCase(r) {
  /** @type {Step[]} */
  const actions = [];
  const steps = 10 + r.int(25);
  for (let i = 0; i < steps; i++) {
    const roll = r.next();
    if (roll < 0.55) actions.push(["host", `0500000000${nvtBytes(r)}ffef`]);
    else if (roll < 0.75)
      actions.push(
        r.chance(0.6)
          ? ["String", typedText(r)]
          : [r.pick(["Enter", "Tab", "BackSpace", "Left", "Right", "Home"])],
      );
    else
      actions.push(
        r.pick([
          /** @type {Step} */ (["Ascii"]),
          ["NvtText"],
          ["Query", "Cursor"],
          ["ReadBuffer"],
          ["Ascii", r.int(24), r.int(80), 1 + r.int(80)],
        ]),
      );
  }
  actions.push(["Ascii"], ["NvtText"]);
  return { trace: "nvt-data.trc", actions };
}

export const CASES = {
  keyboard: keyboardCase,
  datastream: dataStreamCase,
  nvt: nvtCase,
};

/**
 * Plays one case against both emulators; a mismatch names the case and lists the steps to replay.
 * b3270 hangs or crashes on some inputs (see test/script.test.js); then there is nothing to compare,
 * and the case only has to finish on our side.
 * @param {keyof typeof CASES} kind @param {Rng} r @param {string} label what replays it, like "seed 42"
 * @returns {Promise<string>} "" when compared, otherwise why b3270 was skipped
 */
export async function check(kind, r, label) {
  const { trace, actions } = CASES[kind](r);
  const name = `fuzz ${kind} ${label} (${trace})`;
  const b3270 = startB3270();
  const stuck = setTimeout(() => b3270.stop(), 8000);
  const [theirs, ours] = await Promise.allSettled([
    scenario(b3270, trace, actions),
    scenario(startOurs(), trace, actions),
  ]);
  clearTimeout(stuck);
  try {
    if (ours.status === "rejected") throw ours.reason;
    if (theirs.status === "rejected")
      return `${name}: b3270 failed: ${/** @type {Error} */ (theirs.reason).message}`;
    assertSameLines(ours.value.lines, theirs.value.lines);
    assert.equal(ours.value.received, theirs.value.received);
    return "";
  } catch (e) {
    const error = /** @type {Error} */ (e);
    error.message = `${name}: ${error.message}\nsteps: ${JSON.stringify(actions)}`;
    throw error;
  }
}

/**
 * Jazzer.js's entry point: the input picks the kind of case and every choice in it, and Jazzer
 * keeps the inputs that reach new code in 3270/src/. A mismatch lands in test/fuzz-findings/,
 * which fuzz.test.js replays on every run.
 * @param {Buffer} data @param {string} [label]
 */
export async function fuzz(data, label = "Jazzer input") {
  const r = fromData(data);
  const kind = r.pick(
    /** @type {(keyof typeof CASES)[]} */ (Object.keys(CASES)),
  );
  return check(kind, r, label);
}
