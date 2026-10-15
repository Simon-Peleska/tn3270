import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSameLines,
  noB3270,
  scenario,
  startB3270,
  startOurs,
} from "./harness.js";
import { CLOSE, UNFORMATTED, insert, message, open } from "./indfile.js";

// IND$FILE GET, with b3270 receiving the same records.

// Lines as IND$FILE sends them in ASCII CRLF mode, with every byte it can send.
const DATA = [
  Buffer.from("HELLO, WORLD\r\n"),
  Buffer.from([...Array(224).keys()].map((i) => i + 0x20)),
  Buffer.from("\r\n\x00\x01\x09\x1b\x1a\r\nlast line\r\n"),
];

/** Our Session and b3270 through the same records; the text must be what b3270 wrote. @param {import("./harness.js").Step[]} steps @param {string[]} args */
async function receive(steps, args) {
  const dir = mkdtempSync(join(tmpdir(), "node3270-ft-"));
  try {
    const localFile = join(dir, "out.txt");
    const transfer = /** @type {import("./harness.js").Step} */ ([
      "+Transfer",
      ...args,
      `LocalFile=${localFile}`,
    ]);
    /** @type {import("./harness.js").Step[]} */
    const all = [["host", UNFORMATTED], transfer, ["aid"], ...steps, ["await"]];
    const ours = startOurs();
    /** @type {string[]} */
    const text = [];
    ours.session.on("transfer", (chunk) => text.push(chunk));
    const [theirs, mine] = await Promise.all([
      scenario(startB3270(), "fields.trc", all),
      scenario(ours, "fields.trc", all),
    ]);
    assertSameLines(mine.lines, theirs.lines);
    assert.equal(mine.received, theirs.received);
    const written = existsSync(localFile)
      ? readFileSync(localFile, "utf8")
      : "";
    assert.equal(text.join(""), written);
    return { lines: mine.lines, text: text.join("") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} hex */
const host = (hex) =>
  /** @type {import("./harness.js").Step} */ (["host", hex]);

test(
  "a data set arrives as text, like b3270 writes it",
  { skip: noB3270 },
  async () => {
    const { lines, text } = await receive(
      [
        host(open("FT:DATA")),
        ...DATA.map((data) => host(insert(data))),
        host(CLOSE),
        ...message("TRANS03 File transfer complete").map(host),
      ],
      ["HostFile=TEST.DATA"],
    );
    assert.match(text, /^HELLO, WORLD\n !"#.*\nlast line\n$/s);
    assert.ok(
      lines.some((line) => line.includes("Transfer complete, ")),
      "the run reports the byte count",
    );
  },
);

test(
  "the host's error message fails the transfer",
  { skip: noB3270 },
  async () => {
    await receive(message("TRANS34 Data set not found").map(host), [
      "HostFile",
      "NO.SUCH.DATA",
      "Host",
      "vm",
      "Cr",
      "keep",
    ]);
  },
);

test(
  "a cancel mid-transfer aborts at the next record",
  { skip: noB3270 },
  async () => {
    await receive(
      [
        host(open("FT:DATA")),
        host(insert(DATA[0])),
        ["+Transfer", "Cancel"],
        host(insert(DATA[1])),
        host(CLOSE),
        ...message("TRANS99 Aborted").map(host),
      ],
      ["HostFile=TEST.DATA", "Remap=no"],
    );
  },
);

test(
  "a cancel before the host answers ends the transfer at once",
  { skip: noB3270 },
  async () => {
    await receive([["Transfer", "Cancel"]], ["HostFile=TEST.DATA"]);
  },
);

test("a disconnect ends the transfer", { skip: noB3270 }, async () => {
  await receive(
    [host(open("FT:DATA")), host(insert(DATA[0])), ["hostClose"]],
    ["HostFile=TEST.DATA"],
  );
});

test("bad arguments fail the way b3270 says", { skip: noB3270 }, async () => {
  const bad = [
    [],
    ["Cancel"],
    ["HostFile"],
    ["=x"],
    ["HostFile="],
    ["HostFile=A", "Host=mvs"],
    ["HostFile=A", "Lrecl=80"],
    ["HostFile=A", "BufferSize=x"],
    ["HostFile=A", "Mode=binary", "Cr=keep"],
    ["HostFile=A", "Mode=binary", "Remap=no"],
    ["HostFile=A", "Recfm=fixed"],
    ["HostFile=A", "Allocation=tracks"],
  ];
  const steps = bad.map(
    (args) =>
      /** @type {import("./harness.js").Step} */ ([
        "Transfer",
        ...args,
        ...(args.length > 1 ? ["LocalFile=/nonexistent/x"] : []),
      ]),
  );
  const [theirs, ours] = await Promise.all([
    scenario(startB3270(), "fields.trc", steps),
    scenario(startOurs(), "fields.trc", steps),
  ]);
  assertSameLines(ours.lines, theirs.lines);
  assert.equal(ours.received, theirs.received);
});
