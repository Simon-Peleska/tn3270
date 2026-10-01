import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { Session } from "../src/index.js";
import { compare, noB3270, scenario, startOurs } from "./harness.js";

// The task.c actions scripts use, each compared with b3270's own answer to the same calls.

/** A 3270 Write of "HOST" at row 2, column 1 that also moves the cursor there: changes the screen. */
const HOST_WRITE = "f1c211d1c3c8d6e2e313ffef";
/** The same Write with a TN3270E header, for traces that negotiated TN3270E. */
const HOST_WRITE_E = `0000000000${HOST_WRITE}`;

/** NVT data in TN3270E's NVT-DATA record, which nvt-data.trc negotiated. @param {string} hex */
const nvt = (hex) => `0500000000${hex}ffef`;

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

test("ReadBuffer(Field) on an unformatted screen fails like b3270", opts, () =>
  compare("nvt-data.trc", [
    ["ReadBuffer", "Field"],
    ["AsciiField"],
    ["Ascii", 0, 0, 20],
  ]),
);

test(
  "Echo, Bell, Info, Fail, ignore and the like answer like b3270",
  opts,
  () =>
    compare("three-fields.trc", [
      ["Echo"],
      ["Echo", "a", "b"],
      ["Bell"],
      ["Bell", "x"],
      ["Info", "hi"],
      ["Info"],
      ["ignore", 1, 2],
      ["Capabilities"],
      ["Capabilities", "x"],
      ["KeyboardDisable"],
      ["KeyboardDisable", "x"],
      ["KeyboardDisable", "forceenable"],
      ["KeyboardDisable", "False"],
      ["Pause"],
      ["Pause", 1],
      ["NvtText"],
      ["AnsiText", "x"],
      ["Expect", "x"],
      ["Expect"],
      ["Fail"],
      ["Fail", "a", "b"],
      ["Fail", "-async"],
      ["Echo", "after"],
      ["Fail", "-ASYNC", "late", "error"],
      ["Pause"],
      ["Abort"],
      ["Abort", 1],
      ["Echo", "still running"],
    ]),
);

test("Snap saves the screen and reads from the copy like b3270", opts, () =>
  compare("three-fields.trc", [
    ["Snap", "Status"],
    ["Snap", "Ascii"],
    ["Snap"],
    ["Tab"],
    ["String", "later"],
    ["Snap", "Status"],
    ["Snap", "Rows"],
    ["Snap", "Cols"],
    ["Snap", "Ascii", 0, 0, 160],
    ["Snap", "Ascii1", 1, 1, 10],
    ["Snap", "Ebcdic", 0, 0, 10],
    ["Snap", "Ebcdic1", 1, 1, 1],
    ["Snap", "ReadBuffer"],
    ["Snap", "ReadBuffer", "Field"],
    ["Snap", "Ascii", 1, 2],
    ["Snap", "Status", 1],
    ["Snap", "save"],
    ["Snap", "Status"],
    ["Snap", "x"],
    ["Snap", "Wait"],
    ["Snap", "Wait", 1, 2, "Output"],
    ["Snap", "Wait", 1, "x"],
    ["Snap", "Wait", "Output", "x"],
  ]),
);

test("Snap(Wait,Output) times out like b3270", opts, () =>
  compare("three-fields.trc", [
    ["Ascii", 0, 0, 1],
    ["Snap", "Wait", 1, "Output"],
    ["Snap", "Status"],
    ["Wait", 1, "Output"],
  ]),
);

// b3270 segfaults when the host output a Snap(Wait) waits for arrives (snap_save() runs
// without a current task), so this one only checks that ours saves the screen then.
test("Snap(Wait,Output) saves the screen once the host changes it", async () => {
  const { lines } = await scenario(startOurs(), "three-fields.trc", [
    ["Ascii", 0, 0, 1],
    ["+Snap", "Wait", 5, "Output"],
    ["host", HOST_WRITE_E],
    ["await"],
    ["Snap", "Ascii", 13, 51, 4],
    ["Snap", "Status"],
  ]);
  const results = lines
    .filter((line) => line.startsWith('{"run-result"'))
    .map((line) => JSON.parse(line)["run-result"]);
  assert.deepEqual(
    results.slice(2, 5).map((r) => [r.success, r.text]),
    [
      [true, undefined],
      [true, ["HOST"]],
      [true, ["U F P C(127.0.0.1) I 4 43 80 13 55 0x0"]],
    ],
  );
});

// Fuzz datastream seed 5045: the paste overwrites the last field attribute while the screen
// still counts as formatted, and blank fill looked for a field start that is gone. b3270 hangs.
test("RestoreInput over a screen losing its last field attribute doesn't hang", async () => {
  const { lines } = await scenario(
    startOurs(),
    "three-fields.trc",
    /** @type {Step[]} */ (
      JSON.parse(
        '[["host", "0000000000f54011c6e32c01462c05d9d284d4d344c911c8f53ce6c5c4110483ffef"], ["host", "0000000000f1c211d84cffef"], ["host", "00000000007ec313c391d8c4c5c4914bf57dc2c84b328695089811d34c1de228c06cffef"], ["PA", 1], ["host", "0000000000f1c02903c06045f6c04c3cc3e540f0d599c693d8d399d1828189d7f583f0821d40084012d3d711d3c8117ce808d3ffef"], ["Insert"], ["host", "0000000000f1c3115b4d08400511d84f11c65a08d31d6c12d4f42902c0c5005e05115061899687ffef"], ["host", "0000000000f1acffef"], ["host", "0000000000f5c3c3c1d297c3964b6b11c9e52c02410041f43c5ac7088311c5f62903c003b1c143f11d502900ffef"], ["SaveInput"], ["host", "0000000000f5c028410083c299d7845cf4d58693c8d8940ed81de8131100d408cc894082d7923c5d4dc912010d1dd63cd9f3089211d2f2ffef"], ["RestoreInput"]]',
      )
    ),
  );
  const restored = lines.find((line) => line.includes('"r-tag":"5"'));
  assert.equal(restored, '{"run-result":{"r-tag":"5","success":true}}');
});

test(
  "Wait answers at once when the state is already there, like b3270",
  opts,
  () =>
    compare("three-fields.trc", [
      ["Wait"],
      ["Wait", "InputField"],
      ["Wait", "Unlock"],
      ["Wait", "3270Mode"],
      ["Wait", "3270"],
      ["Wait", "Output"],
      ["Wait", 0.1, "Seconds"],
      ["Wait", "Seconds", 1],
      ["Wait", "foo"],
      ["Wait", -1, "Output"],
      ["Wait", 1, 2],
      ["Wait", "Output", 1],
      ["Wait", "CursorAt"],
      ["Wait", "CursorAt", 5000],
      ["Wait", "CursorAt", "x"],
      ["Wait", "CursorAt", -44, 1],
      ["Wait", "CursorAt", 1, -81],
      ["Wait", "CursorAt", 1, 80],
      ["Wait", "CursorAt", 43, 1],
      ["Wait", "InputFieldAt", 43, 1],
      ["Wait", "StringAt", "x", 1, "abc"],
      ["Wait", 0.1, "NvtMode"],
      ["Wait", 0.1, "Ansi"],
      ["Wait", 0.2, "Disconnect"],
      ["Ascii", 0, 0, 1],
      ["Wait", 0.1, "Output"],
      ["Wait", 0.1, "StringAt", 1, 1, "nope"],
      ["Wait", 0.1, "CursorAt", 10, 10],
      ["Wait", 0.1, "InputFieldAt", 1, 1],
    ]),
);

test(
  "Wait finds the cursor, strings and input fields where the screen has them, like b3270",
  opts,
  () =>
    compare("three-fields.trc", [
      ["Snap"],
      ["Snap", "Status"],
      ["ReadBuffer"],
      ["Tab"],
      ["Snap"],
      ["Snap", "Status"],
      ["Wait", 0.1, "InputFieldAt", 2, 1],
      ["Wait", 0.1, "InputFieldAt", 1, 20],
      ["Wait", 0.1, "InputFieldAt", 100],
      ["Wait", 0.1, "CursorAt", 0],
      ["Wait", 0.1, "CursorAt", 1, 1],
      ["Wait", 0.1, "CursorAt", -43, -80],
      ["Wait", 0.1, "StringAt", 1, 1, " "],
      ["Wait", 0.1, "StringAt", 0, " "],
    ]),
);

test("Wait blocks until the host changes the screen, like b3270", opts, () =>
  compare("three-fields.trc", [
    ["Ascii", 0, 0, 1],
    ["+Wait", 5, "Output"],
    ["host", HOST_WRITE_E],
    ["await"],
    ["+Wait", 5, "CursorAt", 1, 6],
    ["host", "0000000000f1c21140c1c8d6e2e313ffef"],
    ["await"],
    ["+Wait", 5, "StringAt", 1, 66, "HOST"],
    ["host", "0000000000f1c211c1c1c8d6e2e3ffef"],
    ["await"],
    ["Ascii", 0, 0, 80],
    ["Ascii", 1, 0, 10],
    ["+Wait", 5, "Disconnect"],
    ["hostClose"],
    ["await"],
    ["Wait", "Disconnect"],
    ["Wait"],
    ["Snap", "Wait", "Output"],
  ]),
);

test("a Wait the host hangs up on fails like b3270", opts, () =>
  compare("three-fields.trc", [
    ["Ascii", 0, 0, 1],
    ["+Wait", 5, "Output"],
    ["hostClose"],
    ["await"],
  ]),
);

test("Expect and NvtText see the NVT host's bytes like b3270", opts, () =>
  compare("nvt-data.trc", [
    ["NvtText"],
    ["Wait", "NvtMode"],
    ["Wait", 0.1, "3270Mode"],
    ["Expect", "x", 0],
    ["Expect", "x", 601],
    ["Expect", "x", 1, 2],
    ["host", nvt("68656c6c6f0d0a5c09c3a4")],
    ["Expect", "hel"],
    ["Expect", "lo\\r\\n"],
    ["Expect", "\\x5c\\11\\303\\xa4", 1],
    ["Expect", "\\tä"],
    ["host", nvt("776f726c64")],
    ["NvtText"],
    ["NvtText"],
    ["AnsiText"],
    ["+Expect", "later", 5],
    ["host", nvt("6c61746572")],
    ["await"],
    ["Expect", "gone", 1],
    ["+Expect", "never", 5],
    ["hostClose"],
    ["await"],
  ]),
);

test("Abort stops the rest of its run and says so, like b3270", async () => {
  const session = new Session({ model: "3279-4-E" });
  /** @type {any[]} */
  const results = [];
  session.indications(({ kind, body }) => {
    if (kind === "run-result") results.push(body);
  });
  await session.run([
    { action: "Echo", args: [1] },
    { action: "Abort" },
    { action: "Echo", args: [2] },
  ]);
  const { time, ...result } = results[0];
  assert.deepEqual(result, {
    success: true,
    text: ["1", "Canceled"],
    "text-err": [false, true],
    abort: true,
  });
});

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
    ["Wait", "Unlock"],
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
    await compare("nvt-data.trc", [["String", "a\\ecdFb"], ["ReadBuffer"]]);
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
  "ReadBuffer shows a wide NVT character's right half as -, like b3270",
  opts,
  () =>
    compare("nvt-data.trc", [
      ["String", "\\x419D"],
      ["ReadBuffer"],
      ["ReadBuffer", "Unicode"],
    ]),
);

test(
  "HexString sends its bytes as they are to an NVT host, like b3270",
  opts,
  () =>
    compare("nvt-data.trc", [
      ["HexString", "41ff0d0d0a42"],
      ["HexString", "-Ascii", "4344"],
    ]),
);

test(
  "MonoCase, CircumNot, ClearRegion, SaveInput, RestoreInput and friends act like b3270",
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
      ["ClearRegion"],
      ["ClearRegion", 1, 1, 1, 1],
      ["ClearRegion", "a", "b", "c", "d"],
      ["ClearRegion", 1, 1, 0, 0],
      ["ClearRegion", 1, 1, -1, 2],
      ["Home"],
      ["String", "abcdef"],
      ["ClearRegion", 1, 3, 1, 3],
      ["Ascii", 0, 0, 10],
      ["ClearRegion", 1, 1, 43, 80],
      ["Ascii", 0, 0, 240],
      ["ClearRegion", 43, 80, 1, 1],
      ["ClearRegion", 44, 1, 0, 0],
      ["Home"],
      ["String", "saved"],
      ["SaveInput"],
      ["SaveInput", "n"],
      ["SaveInput", 1, 2],
      ["Home"],
      ["EraseEOF"],
      ["Tab"],
      ["String", "other"],
      ["RestoreInput", "none"],
      ["RestoreInput", 1, 2],
      ["RestoreInput"],
      ["Ascii", 0, 0, 240],
      ["Home"],
      ["EraseEOF"],
      ["RestoreInput", "n"],
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
      ["SaveInput"],
      ["Toggle", "overlayPaste"],
      ["RestoreInput"],
      ["Toggle", "overlayPaste"],
      ["RestoreInput"],
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
