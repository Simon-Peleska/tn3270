// The host side of test/load.js, run as a child process so its CPU doesn't count as the emulator's.
// It speaks TN3270E to every connection: a full 43x80 screen at connect, on Enter and on Clear,
// one changed row on a PF key, and a bare keyboard restore on anything else.
import { createServer } from "node:net";
import { parseTrace } from "../../test/fakehost.js";

const TRACE = new URL("../../test/traces/three-fields.trc", import.meta.url)
  .pathname;

/** 12-bit buffer address codes. */
const CODES = [
  0x40, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c,
  0x4d, 0x4e, 0x4f, 0x50, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
  0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
  0xe7, 0xe8, 0xe9, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0xf0, 0xf1, 0xf2, 0xf3,
  0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f,
];
const AID_ENTER = 0x7d,
  AID_CLEAR = 0x6d;
const PF_AIDS = new Set([
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c,
]);

// A test runner killed mid-run must not leave its host serving forever.
process.on("disconnect", () => process.exit(0));

// TELNET negotiation only: everything up to the first TN3270E data record.
const negotiation = parseTrace(TRACE).filter((hex) => hex.startsWith("ff"));
const screen = fullScreen();
const restore = Buffer.from([0, 0, 0, 0, 0, 0xf1, 0xc2, 0xff, 0xef]);
let answers = 0;

const server = createServer((socket) => {
  socket.setNoDelay(true);
  socket.on("error", () => {});
  for (const hex of negotiation) socket.write(Buffer.from(hex, "hex"));
  socket.write(screen);
  let pending = "";
  socket.on("data", (chunk) => {
    pending += chunk.toString("latin1");
    const records = pending.split("\xff\xef");
    pending = records.pop() ?? "";
    for (const record of records) {
      // A 3270-DATA header (type, request and response flags zero, then a sequence number);
      // the first record still carries the client's TELNET replies in front of it.
      const header = record.indexOf("\0\0\0");
      if (header < 0) continue;
      const aid = record.charCodeAt(header + 5);
      answers++;
      if (aid === AID_ENTER || aid === AID_CLEAR) socket.write(screen);
      else if (PF_AIDS.has(aid)) socket.write(pfAnswer(aid, answers));
      else socket.write(restore);
    }
  });
});
server.listen(0, "127.0.0.1", () =>
  process.send?.(/** @type {any} */ (server.address()).port),
);

/** @param {string} text */
function ebcdic(text) {
  const letters = "ABCDEFGHI.......JKLMNOPQR........STUVWXYZ";
  return [...text].map((c) =>
    c === " "
      ? 0x40
      : c >= "0" && c <= "9"
        ? 0xf0 + Number(c)
        : 0xc1 + letters.indexOf(c),
  );
}

/** @param {number} a */
function address(a) {
  return [CODES[(a >> 6) & 0x3f], CODES[a & 0x3f]];
}

/** Erase/Write Alternate, WCC restore, 42 protected rows of text and one input field. */
function fullScreen() {
  const bytes = [0, 0, 0, 0, 0, 0x7e, 0xc2];
  for (let row = 0; row < 42; row++) {
    const text = `ROW ${String(row).padStart(2, "0")} ${"ABCDEFGHI ".repeat(7)}`;
    bytes.push(
      0x11,
      ...address(row * 80),
      0x1d,
      0xf0,
      ...ebcdic(text.slice(0, 79)),
    );
  }
  bytes.push(0x11, ...address(42 * 80), 0x1d, 0xf0, ...ebcdic("COMMAND"));
  bytes.push(0x1d, 0x40, 0x13, 0x11, ...address(42 * 80 + 79), 0x1d, 0xf0);
  bytes.push(0xff, 0xef);
  return Buffer.from(bytes);
}

/** A Write with WCC restore that rewrites row 41 only. @param {number} aid @param {number} n */
function pfAnswer(aid, n) {
  const text = `PF ${aid.toString(16).toUpperCase()} ANSWER ${n}`.padEnd(40);
  const bytes = [0, 0, 0, 0, 0, 0xf1, 0xc2, 0x11, ...address(41 * 80 + 1)];
  bytes.push(...ebcdic(text.replace(/[^A-Z0-9 ]/g, " ")), 0xff, 0xef);
  return Buffer.from(bytes);
}
