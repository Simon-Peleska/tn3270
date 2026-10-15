import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSameLines,
  noB3270,
  scenario,
  startB3270,
  startOurs,
} from "./harness.js";
import { CLOSE, GET, UNFORMATTED, insert, message, open } from "./indfile.js";

// IND$FILE GET and PUT, with b3270 answering the same records.

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
    ["HostFile=A", "Direction=send", "Allocation=tracks"],
    ["HostFile=A", "Direction=send", "Allocation=avblock", "PrimarySpace=1"],
    ["HostFile=A", "Direction=send", "Host=cics", "Recfm=fixed"],
    ["HostFile=A", "Direction=send", "Host=vm", "Blksize=80"],
    ["HostFile=A", "Direction=send", "Host=vm", "Allocation=tracks"],
    ["HostFile=A", "Direction=send", "Host=vm", "Avblock=1"],
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

/** Our Session and b3270 sending the same text; the host must get the same bytes. @param {string} text @param {import("./harness.js").Step[]} steps @param {string[]} args */
async function send(text, steps, args) {
  const dir = mkdtempSync(join(tmpdir(), "node3270-ft-"));
  try {
    const localFile = join(dir, "in.txt");
    writeFileSync(localFile, text);
    /** @type {import("./harness.js").Step[]} */
    const all = [
      ["host", UNFORMATTED],
      ["+Transfer", "Direction=send", ...args, `LocalFile=${localFile}`],
      ["aid"],
      ...steps,
      ["await"],
    ];
    const ours = startOurs();
    ours.session.upload(text);
    const [theirs, mine] = await Promise.all([
      scenario(startB3270(), "fields.trc", all),
      scenario(ours, "fields.trc", all),
    ]);
    assertSameLines(mine.lines, theirs.lines);
    assert.equal(mine.received, theirs.received);
    return mine;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A host that lost the answer to its Get asks for it again.
const READ_MODIFIED = "0000000000f6ffef";

// Bare and CRLF line ends, controls, NUL, what the code page has and what it lacks.
const TEXT =
  "HELLO, WORLD\nkeep\r\nend\n\x00\x01\x09\x1b\x9f\x85 äöüß ¢¬ € 你\n" +
  Array.from({ length: 20 }, (_, i) => `line ${i} ${"x".repeat(i * 3)}\n`).join(
    "",
  );

test(
  "a file goes up a buffer per Get request, like b3270 sends it",
  { skip: noB3270 },
  async () => {
    const { lines, received } = await send(
      TEXT,
      [
        host(open("FT:DATA")),
        host(GET),
        host(READ_MODIFIED),
        host(GET),
        host(GET),
        host(GET),
        host(GET),
        host(CLOSE),
        ...message("TRANS03 File transfer complete").map(host),
      ],
      ["HostFile=TEST.DATA", "BufferSize=256"],
    );
    assert.ok(lines.some((line) => line.includes("Transfer complete, ")));
    assert.match(received, /880009d0460869042200/, "the last Get gets EOF");
  },
);

test(
  "a send without remapping or CRs goes up as UTF-8, unchanged",
  { skip: noB3270 },
  async () => {
    await send(
      TEXT,
      [
        host(open("FT:DATA")),
        host(GET),
        host(GET),
        host(CLOSE),
        ...message("TRANS03 File transfer complete").map(host),
      ],
      ["HostFile=TEST.DATA", "Remap=no", "Cr=keep"],
    );
  },
);

test(
  "the PUT command carries the data set's format and space",
  { skip: noB3270 },
  async () => {
    for (const args of [
      ["Recfm=fixed", "Lrecl=80", "Blksize=3120", "Exist=append"],
      [
        "Recfm=variable",
        "Allocation=avblock",
        "PrimarySpace=10",
        "SecondarySpace=5",
        "Avblock=6160",
      ],
      ["Allocation=cylinders", "PrimarySpace=1", "Lrecl=80"],
      ["Host=vm", "Recfm=fixed", "Lrecl=80"],
      ["Host=vm", "Recfm=undefined"],
    ])
      await send("x\n", message("TRANS99 Stop").map(host), [
        "HostFile=TEST.DATA",
        ...args,
      ]);
  },
);

test(
  "a cancel during a send aborts at the next Get request",
  { skip: noB3270 },
  async () => {
    await send(
      TEXT,
      [
        host(open("FT:DATA")),
        host(GET),
        ["+Transfer", "Cancel"],
        host(GET),
        host(CLOSE),
        ...message("TRANS99 Aborted").map(host),
      ],
      ["HostFile=TEST.DATA", "BufferSize=256"],
    );
  },
);
