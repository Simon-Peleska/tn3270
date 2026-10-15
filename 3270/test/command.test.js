import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseCommand } from "../src/command.js";

const S3270 = process.env["S3270_PATH"] ?? "s3270";
const noS3270 =
  spawnSync(S3270, ["-v"], { stdio: "pipe" }).error && "s3270 not installed";

// Echo() prints its arguments joined by spaces, so s3270 shows how it split each line.
const COMMANDS = [
  "Echo",
  "Echo()",
  "Echo(a)",
  "Echo(a,b)",
  "Echo( a , b )",
  "Echo(a b)",
  "Echo(a,)",
  "Echo(,)",
  "Echo(,a)",
  'Echo("a b",c)',
  'Echo("a,b")',
  'Echo("a\\"b")',
  'Echo("a\\\\b")',
  'Echo("a\\\\")',
  'Echo("a\\\\\\\\")',
  'Echo("a\\nb")',
  "Echo x y",
  'Echo "x y" z',
  "Echo x (y)",
  "Echo  (a)",
  "Echo(a) Echo(b)",
  "Echo(a)Echo(b)",
  "  Echo(a)   ",
  "Echo(a) # a comment",
  "# just a comment",
  "! another",
  "Echo(a",
  'Echo("a',
  'Echo("a\\',
  "Echo(a b c",
  'Echo("a" b)',
  "Echo(a) $",
  "$Echo",
  "Echo$",
  "Ec_h-o",
  "Echo(a,b",
  "Echo(a,",
];

/** What s3270 says for each command: its data lines, then ok or error. */
function s3270Says() {
  const run = spawnSync(S3270, [], {
    input: COMMANDS.map((command) => `${command}\nEcho(--)\n`).join(""),
    encoding: "utf8",
    timeout: 10_000,
  });
  /** @type {string[][]} */
  const answers = [];
  /** @type {string[]} */
  let lines = [];
  for (const line of run.stdout.split("\n")) {
    if (line.startsWith("data: ")) lines.push(line.slice(6));
    else if (line === "ok" || line === "error") {
      lines.push(line);
      if (lines.join() === "--,ok") lines = [];
      else {
        answers.push(lines);
        lines = [];
      }
    }
  }
  return answers;
}

/** The same through parseCommand(), with Echo() and the unknown actions s3270 would refuse. */
function oursSays() {
  return COMMANDS.map((command) => {
    const { actions, error } = parseCommand(command);
    const lines = [];
    for (const { action, args } of actions) {
      if (action !== "Echo") {
        lines.push(`Unknown action: ${action}`, "error");
        return lines;
      }
      lines.push(args.length === 0 ? " " : args.join(" "));
    }
    if (error !== null) lines.push(error, "error");
    else lines.push("ok");
    return lines;
  });
}

test("action strings split like s3270 splits them", { skip: noS3270 }, () => {
  const theirs = s3270Says();
  const ours = oursSays();
  for (const [i, command] of COMMANDS.entries())
    assert.deepEqual(ours[i], theirs[i], command);
});

test("arguments keep their boundaries", () => {
  assert.deepEqual(parseCommand('String("a b", c) Enter() PF(3)'), {
    actions: [
      { action: "String", args: ["a b", "c"] },
      { action: "Enter", args: [] },
      { action: "PF", args: ["3"] },
    ],
    error: null,
  });
  assert.deepEqual(parseCommand("Ascii 0 0 1 5"), {
    actions: [{ action: "Ascii", args: ["0", "0", "1", "5"] }],
    error: null,
  });
});
