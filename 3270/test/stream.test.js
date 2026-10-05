import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { Session } from "../src/index.js";
import { utf8ToUnicode } from "../src/nvt.js";
import {
  FakeHost,
  TRACES,
  compare,
  noB3270,
  scenario,
  startB3270,
  startOurs,
  sync,
  telnetUnits,
} from "./harness.js";

// The indication stream from Session.indications() and Session.run() must match what
// `b3270 -json` writes for the same host data and actions, line by line.

test(
  "connecting, typing, Enter and Disconnect stream like b3270",
  { skip: noB3270, timeout: 20_000 },
  () =>
    compare("three-fields.trc", [
      ["String", "abc"],
      ["Tab"],
      ["String", "xy"],
      ["Enter"],
    ]),
);

test(
  "several actions in one run stream like b3270",
  {
    skip: noB3270,
    timeout: 20_000,
    todo: "b3270 sends fewer, differently cut screen updates within a run than node3270",
  },
  () =>
    compare("three-fields.trc", [
      ["run", ["String", "abc"], ["Tab"], ["String", "xy"]],
      ["run", ["Home"], ["String", "def"], ["BackTab"], ["Tab"], ["EraseEOF"]],
      ["run", ["Home"], ["String", "HELLO"], ["Enter"]],
      ["run", ["Tab"], ["String", "q"], ["PF", 3]],
    ]),
);

describe("traces", { concurrency: 16 }, () => {
  for (const trace of readdirSync(TRACES).filter((name) =>
    name.endsWith(".trc"),
  )) {
    test(
      `${trace} streams like b3270`,
      { skip: noB3270, timeout: 20_000 },
      () =>
        compare(trace, [
          ["ReadBuffer", "Ascii"],
          ["ReadBuffer", "Ebcdic"],
          ["ReadBuffer", "Unicode"],
          ["Set", "model", "3279-2"],
        ]),
    );
  }
});

test(
  "keyboard errors, insert mode and failing actions stream like b3270",
  { skip: noB3270, timeout: 20_000 },
  () =>
    compare("three-fields.trc", [
      ["ToggleInsert"],
      ["String", "abcdef"],
      ["Reset"],
      ["Insert"],
      ["Home"],
      ["String", "z"],
      ["BackTab"],
      ["String", "p"],
      ["Reset"],
      ["ToggleReverse"],
      ["String", "rv"],
      ["ToggleReverse"],
      ["Nope"],
      ["PF", 99],
      ["MoveCursor1", "5", "5"],
      ["String", "prot"],
      ["Reset"],
      ["Clear"],
      ["String", "after clear"],
      ["PF", 3],
    ]),
);

test(
  "scrollback saves cleared screens and scrolls through them like b3270",
  { skip: noB3270, timeout: 20_000 },
  () =>
    compare("three-fields.trc", [
      ["String", "one"],
      ["Clear"],
      ["String", "two"],
      ["Clear"],
      ["Scroll", "Backward"],
      ["String", "locked"],
      ["Scroll", "Backward"],
      ["Scroll", "Backward"],
      ["Scroll", "Forward"],
      ["Scroll", "Set", "1"],
      ["Scroll", "Set", "x"],
      ["Scroll", "Set", "500"],
      ["Scroll", "Sideways"],
      ["Scroll"],
      ["Reset"],
      ["Scroll", "Backward"],
      ["Scroll", "Reset"],
      ["Scroll", "Backward"],
      ["Set", "saveLines", "10"],
      ["String", "three"],
      ["Clear"],
      ["Scroll", "Backward"],
      ["Enter"],
    ]),
);

test("saveLines 0 keeps no scrollback at all, unlike b3270's five screens", async () => {
  const { lines } = await scenario(
    startOurs(),
    "three-fields.trc",
    [
      ["String", "one"],
      ["Clear"],
      ["String", "two"],
      ["Clear"],
      ["Scroll", "Backward"],
      ["String", "three"],
      ["Ascii", 0, 0, 6],
    ],
    [["Set", "saveLines", "0"]],
  );
  const thumbs = lines.filter((line) => line.startsWith('{"thumb"'));
  assert.ok(
    thumbs.every((line) => line.includes('"saved":0')),
    thumbs.join("\n"),
  );
  assert.ok(
    lines.some((line) => line.includes('"text":["three "]')),
    lines.join("\n"),
  );
});

// Typing over an SO that sits right before a field attribute wipes the attribute, in x3270
// too. Restoring a saved screen full of SOs wipes all of them, and b3270 then spins forever
// walking from field to field. On a pool thread that would freeze every session on it.
const WIPE_EVERY_FIELD = /** @type {[string, ...(string | number)[]][]} */ ([
  ["HexString", "0e99ee74"],
  ["SaveInput"],
  ["RestoreInput"],
]);

test("every field walk still ends on a formatted screen whose field attributes were typed away", async () => {
  const { lines, received } = await scenario(startOurs(), "three-fields.trc", [
    ...WIPE_EVERY_FIELD,
    ["Query", "Formatted"],
    ["FieldEnd"],
    ["DeleteField"],
    ["EraseEOF"],
    ["PF", 12],
    ["ClearRegion", 1, 1, 43, 80],
    ["DeleteWord"],
    ["EraseInput"],
    ["Query", "Formatted"],
  ]);
  const answers = lines.flatMap(
    (line) => line.match(/"text":\["((?:un)?formatted)"\]/)?.[1] ?? [],
  );
  assert.deepEqual(answers, ["formatted", "unformatted"]);
  // PF12 reads the screen as an unformatted one: AID, cursor, then every character.
  assert.ok(received.includes("00000000007c40c5400e99ee40ffef"), received);
});

test("the host's Erase All Unprotected still ends on a screen whose field attributes were typed away", async () => {
  const { lines } = await scenario(startOurs(), "three-fields.trc", [
    ...WIPE_EVERY_FIELD,
    ["host", "00000000006fffef"],
    ["Query", "Formatted"],
  ]);
  assert.ok(
    lines.some((line) => line.includes('"text":["unformatted"]')),
    lines.join("\n"),
  );
});

const QUERY_KEYS = [
  "BindPluName",
  "CodePage",
  "ConnectionState",
  "Cursor",
  "Cursor1",
  "Formatted",
  "Host",
  "KeyboardLock",
  "KeyboardLockDetail",
  "LocalEncoding",
  "LuName",
  "Model",
  "Prefixes",
  "Proxies",
  "Proxy",
  "ReplyMode",
  "ScreenCurSize",
  "ScreenMaxSize",
  "ScreenSizeCurrent",
  "ScreenSizeMax",
  "ScreenTraceFile",
  "Ssl",
  "StatsRx",
  "StatsTx",
  "TelnetHostOptions",
  "TelnetMyOptions",
  "TerminalName",
  "Tls",
  "TlsCertInfo",
  "TlsSessionInfo",
  "TlsSubjectNames",
  "Tn3270eOptions",
  "TraceFile",
  "Tasks",
  "Copyright",
  "About",
  "Version",
];
/** @type {[string, ...string[]][]} */
const QUERIES = [
  ["Query"],
  ["Show"],
  ...QUERY_KEYS.map((key) => /** @type {[string, string]} */ (["Query", key])),
  ["Show", "cursor1"],
  ["Query", "Cu"],
  ["Query", "Tls"],
  ["Query", "Tl"],
  ["Show", "nope"],
  ["Query", "Model", "x"],
];

for (const trace of ["three-fields.trc", "nvt-data.trc", "ibmlink.trc"])
  test(
    `Query and Show answer like b3270 (${trace})`,
    { skip: noB3270, timeout: 20_000 },
    () => compare(trace, QUERIES, QUERIES),
  );

test(
  "NVT data scrolling off the top fills the scrollback like b3270",
  { skip: noB3270, timeout: 20_000 },
  () =>
    compare("nvt-data.trc", [
      ["Scroll", "Backward"],
      ["Scroll", "Set", "3"],
      ["Scroll", "Forward"],
      ["Scroll", "Backward"],
      ["String", "x"],
    ]),
);

test("NVT UTF-8 decoding rejects pseudo-UCS4 past U+10FFFF, unlike x3270's own decoder", () => {
  // x3270's utf8_to_unicode() predates the Unicode ceiling and never checks for it, so a
  // 4/5/6-byte sequence can decode past U+10FFFF there without complaint. node3270 must
  // reject it instead: String.fromCodePoint() throws on that when the UI renders the
  // screen, which used to crash the whole process - found by fuzzing a live NVT session.
  const v = { ch: 0 };
  assert.equal(
    utf8ToUnicode(v, Uint8Array.from([0xf4, 0x90, 0x80, 0x80]), 4),
    -1,
  );
  assert.equal(
    utf8ToUnicode(v, Uint8Array.from([0xf7, 0xbf, 0xbf, 0xbf]), 4),
    -1,
  );
  // U+10FFFF itself, the true max, must still decode.
  assert.equal(
    utf8ToUnicode(v, Uint8Array.from([0xf4, 0x8f, 0xbf, 0xbf]), 4),
    4,
  );
  assert.equal(v.ch, 0x10ffff);
});

test(
  "classic toggles and deferred settings stream like b3270",
  { skip: noB3270, timeout: 20_000 },
  () =>
    compare(
      "three-fields.trc",
      [
        ["Toggle", "monoCase"],
        ["Toggle", "lineWrap"],
        ["Toggle", "visibleControl"],
        ["Toggle", "visibleControl"],
        ["Toggle", "altCursor", "true"],
        ["Toggle", "altCursor", "maybe"],
        ["Toggle", "altCursor", "true", "crosshair", "true"],
        ["Toggle", "scrollBar"],
        ["Toggle", "codePage"],
        ["Set", "crosshair"],
        ["Set", "underscoreBlankFill", "true", "blankFill", "on"],
        ["Set", "-defer", "model", "3278-2", "codePage", "cp037"],
        ["Set", "-defer", "termName", "IBM-DYNAMIC"],
        ["Set", "termName", "X"],
        ["Set", "codePage", "cp273"],
        ["Set", "codePage", "nope"],
        ["Set", "lineMode", "true"],
        ["Set", "aplMode", "true"],
        ["Set", "typeahead", "false"],
        ["Set", "rightToLeftMode", "true"],
        ["Set", "rightToLeftMode", "false"],
        ["Set", "alwaysInsert", "true"],
        ["Set", "reverseInputMode", "true"],
        ["String", "rev"],
        ["Set"],
      ],
      [
        ["Set", "unlockDelay", "false"],
        ["Set", "-defer", "monoCase", "true"],
        ["Set", "saveLines", "x"],
        ["Set", "saveLines", "100"],
        ["Set", "retry", "true", "reconnect", "false"],
        ["Set", "bindLimit", "maybe"],
      ],
    ),
);

test(
  "a model and oversize set before connecting stream like b3270",
  { skip: noB3270, timeout: 20_000 },
  () =>
    compare(
      "three-fields.trc",
      [["ReadBuffer", "Ascii"]],
      [
        ["Set", "model", "3279-2", "oversize", "100x40"],
        ["Set", "oversize", ""],
        ["Set", "Model"],
        ["set", "oversize"],
        ["Set", "model", "3278-3"],
        ["Set", "model", "3278-5", "oversize", "140x30"],
        ["Set", "model", "IBM-3279-4-E"],
      ],
    ),
);

test(
  "nopSeconds is set, queried and refused like b3270",
  { skip: noB3270, timeout: 20_000 },
  () =>
    compare(
      "three-fields.trc",
      [["Set", "nopSeconds"]],
      [
        ["Set", "nopSeconds"],
        ["Set", "nopSeconds", "5"],
        ["Set", "nopSeconds"],
        ["Set", "nopSeconds", "x"],
        ["Set", "nopSeconds", "-1"],
        ["Set", "nopSeconds", ""],
        ["Set", "nopseconds", "7"],
        ["Set", "nopSeconds=8"],
        ["Set", "nopSeconds", "9", "model", "bad"],
        ["Set", "nopSeconds"],
        ["Set", "model", "3278-2", "nopSeconds", "x"],
        ["Set", "model"],
        ["Set", "nopSeconds", "3", "oversize", "1x1"],
        ["Set", "nopSeconds"],
      ],
    ),
);

test(
  "a TELNET NOP reaches the host every nopSeconds, as from b3270",
  { skip: noB3270, timeout: 10_000 },
  async () => {
    await Promise.all(
      [startB3270(), startOurs()].map(async (emulator) => {
        const host = await FakeHost.listen(TRACES + "three-fields.trc");
        try {
          await emulator.run("Set", ["nopSeconds", "1"]);
          const opened = emulator.run("Open", [`127.0.0.1:${host.port}`]);
          await host.waitForConnection();
          for (const unit of telnetUnits(host.payloads)) {
            host.socket?.write(unit);
            await sync(host);
          }
          await opened;
          const before = host.received.length;
          await host.waitUntil(
            () => /^(..)*?fff1/.test(host.received.slice(before)),
            3000,
            "no NOP",
          );
        } finally {
          emulator.stop();
          await host.close();
        }
      }),
    );
  },
);

test(
  "Open refuses bad host syntax like b3270",
  { skip: noB3270, timeout: 10_000 },
  async () => {
    const targets = [
      "",
      "  ",
      "a b",
      "[::1",
      "x[a]",
      "[a]b",
      "[a[b]]",
      "@h",
      "lu@",
      "h:",
      "h:1:2",
      "h=",
      "h=a=b",
      "lu@h@x",
      "h:1@x",
      "h\\",
      "L:",
      "y:l:",
      "127.0.0.1:99999",
      "127.0.0.1:1",
      "L:Y:127.0.0.1:1",
    ];
    const [theirs, ours] = await Promise.all(
      [startB3270(), startOurs()].map(async (emulator) => {
        try {
          for (const target of targets) await emulator.run("Open", [target]);
          return emulator.lines.filter((line) =>
            line.startsWith('{"run-result"'),
          );
        } finally {
          emulator.stop();
        }
      }),
    );
    assert.deepEqual(ours, theirs);
  },
);

test(
  "Open asks for the LUs given as lu@host, like b3270",
  { skip: noB3270, timeout: 20_000 },
  () =>
    compare(
      "three-fields.trc",
      [["ReadBuffer", "Ascii"]],
      [],
      "LUA,LUB@127.0.0.1:PORT",
    ),
);

test(
  "Open with N:, a bracketed host and an accept name streams like b3270",
  { skip: noB3270, timeout: 20_000 },
  () =>
    compare(
      "three-fields.trc",
      [["ReadBuffer", "Ascii"]],
      [],
      "c:LUA\\,X@N:[127.0.0.1]:PORT=accepted.example",
    ),
);

test(
  "Open with S: asks for a terminal type without -E, like b3270",
  { skip: noB3270, timeout: 20_000 },
  () =>
    compare(
      "three-fields.trc",
      [["ReadBuffer", "Ascii"]],
      [],
      "s:127.0.0.1:PORT",
    ),
);

const TLS_KEY = {
  key: readFileSync(new URL("fixtures/tls-key.pem", import.meta.url)),
  cert: readFileSync(new URL("fixtures/tls-cert.pem", import.meta.url)),
};

/**
 * A TLS server with the self-signed fixture certificate, passing everything on to the
 * plain host at port. Resolves to its own port.
 * @param {import("node:test").TestContext} t @param {number} port
 */
async function tlsFront(t, port) {
  const server = tls.createServer(TLS_KEY, (secure) => {
    const plain = net.connect(port, "127.0.0.1");
    secure.pipe(plain).pipe(secure);
    secure.on("error", () => plain.destroy());
    plain.on("error", () => secure.destroy());
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  t.after(() => server.close());
  return /** @type {net.AddressInfo} */ (server.address()).port;
}

test(
  "Open with L:Y: speaks TLS to a host with an unverifiable certificate, like b3270",
  { skip: noB3270, timeout: 20_000 },
  (t) =>
    compare(
      "three-fields.trc",
      [["ReadBuffer", "Ascii"]],
      [],
      async (port) => `L:Y:127.0.0.1:${await tlsFront(t, port)}`,
    ),
);

test(
  "Open with L: refuses a certificate it cannot verify",
  { timeout: 10_000 },
  async (t) => {
    const host = await FakeHost.listen(TRACES + "three-fields.trc");
    t.after(() => host.close());
    const session = new Session({ model: "3279-4-E" });
    t.after(() => session.close());
    const result = await session.run([
      { action: "Open", args: [`L:127.0.0.1:${await tlsFront(t, host.port)}`] },
    ]);
    assert.equal(result.success, false);
    assert.deepEqual(result.text, [
      "Connection failed:",
      "TLS: Host certificate verification failed:",
      "self-signed certificate (18)",
    ]);
  },
);
