import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { Session } from "../src/index.js";
import { compare, noB3270 } from "./harness.js";

// Actions with arguments and error paths the app never sends, each compared with b3270's own answer to the same calls.

const opts = { skip: noB3270, timeout: 20_000 };

test(
  "Ascii, Ebcdic and their field and 1-origin forms read the screen like b3270",
  opts,
  () =>
    compare("three-fields.trc", [
      ["Ascii"],
      ["Ascii", 1],
      ["Ascii", 12],
      ["Ascii", 0, 0, 10],
      ["Ascii", 0, 0, 0],
      ["Ascii", 0, 80, 0],
      ["Ascii", 0, 81, 0],
      ["Ascii", 2, 5, 3, 10],
      ["Ascii", 0, 78, 2, 2],
      ["Ascii", 0, 79, 2, 2],
      ["Ascii", 0, 0, 1, 0],
      ["Ascii", -1, -1, 1],
      ["Ascii", -44, 0, 1],
      ["Ascii", 0, -81, 1],
      ["Ascii", 0, 0, 3441],
      ["Ascii", 1, 2],
      ["Ascii", 1, 2, 3, 4, 5],
      ["Ascii", "a", "b", "c"],
      ["Ascii1"],
      ["Ascii1", 1, 1, 20],
      ["Ascii1", 0, 0, 1],
      ["Ascii1", 3],
      ["Ebcdic"],
      ["Ebcdic", 0, 0, 20],
      ["Ebcdic", 5],
      ["Ebcdic1", 2, 2, 2, 4],
      ["AsciiField"],
      ["EbcdicField"],
      ["AsciiField", "x"],
      ["Tab"],
      ["String", "typed"],
      ["AsciiField"],
      ["EbcdicField"],
      ["Ascii", 0, 0, 160],
      ["MoveCursor", 0, 0],
      ["AsciiField"],
    ]),
);

test("ReadBuffer(Field) reads the cursor's field like b3270", opts, () =>
  compare("three-fields.trc", [
    ["ReadBuffer", "Field"],
    ["ReadBuffer", "Field", "Ebcdic"],
    ["ReadBuffer", "Unicode", "Field"],
    ["Tab"],
    ["String", "abc"],
    ["ReadBuffer", "f"],
    ["Tab"],
    ["ReadBuffer", "Field"],
    ["ReadBuffer", "Fieldx"],
  ]),
);

/** @typedef {[string, ...(string | number)[]]} Step */

/** Each input on an emptied first field, then that field read back. @param {Step[][]} inputs @returns {Step[]} */
const onEmptyField = (inputs) =>
  inputs.flatMap((input) => [
    ["Reset"],
    ["Home"],
    ["EraseEOF"],
    ...input,
    ["Ascii", 0, 0, 80],
  ]);

test("String, PasteString and HexString type like b3270", opts, () =>
  compare("three-fields.trc", [
    ["String"],
    ["PasteString"],
    ["PasteString", "abc"],
    ["PasteString", "616"],
    ["PasteString", "c3"],
    ["PasteString", "1", "2", "3"],
    ["HexString"],
    ["HexString", ""],
    ["HexString", "4"],
    ["HexString", "zz"],
    ["HexString", "\\e81"],
    ...onEmptyField([
      [["String", "a", "b"]],
      [["String", "-subst", "c"]],
      [["PasteString", "0x6465", "66"]],
      [["PasteString", "-nomargin", "c3a4"]],
      [["HexString", "0x8182", "0X83"]],
      [
        ["HexString", "-Ascii", "6869"],
        ["HexString", "-ascii", "0x4a"],
      ],
      [["HexString", "-Ascii", "c3a4"]],
      [["HexString", "-Ascii", "61006263"]],
      [["HexString", "-Ascii", "41ff42"]],
      [["HexString", "4a5b"]],
    ]),
    ["Home"],
    ["HexString", "7d"],
  ]),
);

test(
  "String ignores a \\e code wider than a byte, like b3270",
  opts,
  async () => {
    await compare("three-fields.trc", [
      ["String", "a\\ecdFb\\e1c1c"],
      ["Ascii", 0, 0, 80],
    ]);
  },
);

test(
  "An error inside a String fails it only if it has to resume after an AID, like b3270",
  opts,
  () =>
    compare("three-fields.trc", [
      ["String", "a\\eZb"],
      ["String", "c\\eZ\\nd"],
      ["String", "e\\xZ\\n"],
      ["Ascii", 0, 0, 80],
    ]),
);

test(
  "MonoCase, CircumNot, Reconnect, Quit and friends act like b3270",
  opts,
  () =>
    compare("three-fields.trc", [
      ["MonoCase"],
      ["MonoCase", "x"],
      ["Ascii", 0, 0, 80],
      ["MonoCase"],
      ["CircumNot", "x"],
      ["Home"],
      ["CircumNot"],
      ["Ascii", 0, 0, 10],
      ["Home"],
      ["String", "abcdef"],
      ["Ascii", 0, 0, 10],
      ["Ascii", 0, 0, 240],
      ["Home"],
      ["String", "saved"],
      ["Home"],
      ["EraseEOF"],
      ["Tab"],
      ["String", "other"],
      ["Ascii", 0, 0, 240],
      ["Home"],
      ["EraseEOF"],
      ["Ascii", 0, 0, 240],
      ["Reconnect", "x"],
      ["Reconnect"],
      ["Close", "x"],
      ["Quit", 1, 2],
      ["Exit", 1, 2],
    ]),
);

test(
  "Keys on protected cells, margined paste and String's resume after Enter act like b3270",
  opts,
  () =>
    compare("three-fields.trc", [
      ["MoveCursor", 0, 30],
      ["Dup"],
      ["Dup", "NoFailOnError"],
      ["Dup", "x"],
      ["Dup", 1, 2],
      ["Reset"],
      ["FieldMark"],
      ["FieldMark", "nofailonerror"],
      ["Reset"],
      ["CircumNot"],
      ["Reset"],
      ["MoveCursor", 17, 79],
      ["PasteString", "c3bc794c2d"],
      ["MoveCursor", 0, 5],
      ["PasteString", "-nomargin", "6162630a646566"],
      ["Ascii", 0, 0, 240],
      ["Home"],
      ["String", "saved"],
      ["Toggle", "overlayPaste"],
      ["Toggle", "overlayPaste"],
      ["Home"],
      ["String", "¬\\nGh+zfÜ2$Ü"],
      ["Ascii", 0, 0, 80],
    ]),
);

test("Reconnect opens the host Open last tried", async () => {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(null)),
  );
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  const session = new Session({ model: "3279-4-E" });
  try {
    await session.run([{ action: "Open", args: [`127.0.0.1:${port}`] }]);
    const again = await session.run([{ action: "Reconnect" }]);
    assert.equal(connections, 2);
    assert.deepEqual(again.text, ["Connection failed"]);
  } finally {
    server.close();
  }
});

test("a host resetting the connection closes the session instead of throwing", async () => {
  /** @type {(socket: net.Socket) => void} */
  let accepted = () => {};
  const hostSide = new Promise((resolve) => (accepted = resolve));
  const server = net.createServer((socket) => accepted(socket));
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(null)),
  );
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  const session = new Session({ model: "3279-4-E" });
  try {
    const closed = new Promise((resolve) => session.once("close", resolve));
    await session.connect("127.0.0.1", port);
    /** @type {net.Socket} */ (await hostSide).resetAndDestroy();
    await closed;
  } finally {
    server.close();
  }
});

test("a host sending plain text instead of negotiating TN3270 is dropped with N1203", async () => {
  const server = net.createServer((socket) => socket.write("login: "));
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(null)),
  );
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  const session = new Session({ model: "3279-4-E" });
  try {
    const closed = new Promise((resolve) => session.once("close", resolve));
    await session.connect("127.0.0.1", port);
    await closed;
    assert.match(session.s.connectError, /^N1203 /);
  } finally {
    server.close();
  }
});

test("Quit ends the session after its run-result", async () => {
  const session = new Session({ model: "3279-4-E" });
  /** @type {string[]} */
  const seen = [];
  session.indications(({ kind }) => {
    if (kind === "run-result") seen.push(kind);
  });
  session.on("quit", () => seen.push("quit"));
  await session.run([{ action: "Quit" }]);
  assert.deepEqual(seen, ["run-result", "quit"]);
});
