import test from "node:test";
import assert from "node:assert/strict";
import { pasteSegments } from "../public/paste.js";

/**
 * '_' is an editable blank; anything else is protected content.
 *
 * @param {string} picture
 * @returns {{ ch: string, editable: boolean }[]}
 */
function row(picture) {
  return [...picture].map((ch) =>
    ch === "_" ? { ch: " ", editable: true } : { ch, editable: false },
  );
}

/**
 * Stands in for b3270: a character landing on a protected cell is dropped, and
 * the paste resumes at the next editable cell. That is why a segment must never
 * span a protected run.
 *
 * @param {{ ch: string, editable: boolean }[]} cells
 * @param {number} cols
 * @param {{ row: number, col: number, text: string }[]} segments
 * @returns {string}
 */
function apply(cells, cols, segments) {
  const result = cells.map((cell) => cell.ch);
  for (const { row: atRow, col, text } of segments) {
    let at = atRow * cols + col;
    for (const ch of text) {
      if (at < cells.length && !cells[at].editable) {
        while (at < cells.length && !cells[at].editable) at++;
        continue;
      }
      if (at >= cells.length) break;
      result[at] = ch;
      at++;
    }
  }
  return result.join("");
}

test("a paste with no gaps of its own fills three short fields in a row, one segment each", () => {
  const cells = row(" ___ ___ ___");
  const segments = pasteSegments(
    cells,
    true,
    cells.length,
    { row: 0, col: 1 },
    "123456789",
  );
  assert.deepEqual(segments, [
    { row: 0, col: 1, text: "123" },
    { row: 0, col: 5, text: "456" },
    { row: 0, col: 9, text: "789" },
  ]);
  assert.equal(apply(cells, cells.length, segments), " 123 456 789");
});

test("a paste whose gaps line up with the ones on screen is consumed there, landing the same way", () => {
  const cells = row(" ___ ___ ___");
  const segments = pasteSegments(
    cells,
    true,
    cells.length,
    { row: 0, col: 1 },
    "123 456 789",
  );
  assert.equal(apply(cells, cells.length, segments), " 123 456 789");
});

test("one gap of the paste lining up by chance does not make the line a match: its blank is typed like any other character", () => {
  const cells = row(" ___ ___ ___");
  const segments = pasteSegments(
    cells,
    true,
    cells.length,
    { row: 0, col: 1 },
    "123456 789",
  );
  assert.equal(apply(cells, cells.length, segments), " 123 456  78");
});

test("text shorter than a run of fields overflows into the next one, skipping the gap between them", () => {
  const cells = row("___ ___ ___");
  const segments = pasteSegments(
    cells,
    true,
    cells.length,
    { row: 0, col: 0 },
    "123456789",
  );
  assert.equal(apply(cells, cells.length, segments), "123 456 789");
});

test("a protected run matching the pasted text there is consumed, not skipped", () => {
  const cells = row("___456___");
  const segments = pasteSegments(
    cells,
    true,
    cells.length,
    { row: 0, col: 0 },
    "123456789",
  );
  assert.equal(apply(cells, cells.length, segments), "123456789");
});

test("a protected run not matching the pasted text is skipped, and the input is not consumed", () => {
  const cells = row("___455___");
  const segments = pasteSegments(
    cells,
    true,
    cells.length,
    { row: 0, col: 0 },
    "123456789",
  );
  assert.equal(apply(cells, cells.length, segments), "123455456");
});

test("a protected run matching by coincidence is left alone, not consumed, when there is room to spare", () => {
  const cells = row("_2_4____8___");
  const segments = pasteSegments(
    cells,
    true,
    cells.length,
    { row: 0, col: 0 },
    "123456789",
  );
  assert.equal(apply(cells, cells.length, segments), "122434568789");
});

test("a label the pasted line ends inside is left alone, not typed into the field below", () => {
  // The second pasted line is the "Address:" label itself, longer than the line has left.
  const cells = [
    ...row("name: ____          "),
    ...row("Address:            "),
    ...row("__________          "),
  ];
  const segments = pasteSegments(
    cells,
    true,
    20,
    { row: 0, col: 0 },
    "name: test\nAddress:",
  );
  assert.equal(
    apply(cells, 20, segments),
    [
      "name: test          ",
      "Address:            ",
      "                    ",
    ].join(""),
  );
});

test("leading and trailing newlines are dropped before anything is typed", () => {
  const cells = row("_____");
  const segments = pasteSegments(
    cells,
    true,
    cells.length,
    { row: 0, col: 1 },
    "\n\nhi\n\n",
  );
  assert.deepEqual(segments, [{ row: 0, col: 1, text: "hi" }]);
});

test("a newline in the middle jumps to the column the paste started at, one row down", () => {
  const cells = [...row("__________"), ...row("__________")];
  const segments = pasteSegments(cells, true, 10, { row: 0, col: 3 }, "ab\ncd");
  assert.deepEqual(segments, [
    { row: 0, col: 3, text: "ab" },
    { row: 1, col: 3, text: "cd" },
  ]);
});

test("an unformatted screen has nothing to skip, so the text is typed straight through", () => {
  const cells = row("_-_-_");
  const segments = pasteSegments(
    cells,
    false,
    cells.length,
    { row: 0, col: 0 },
    "abcde",
  );
  assert.deepEqual(segments, [{ row: 0, col: 0, text: "abcde" }]);
});

test("text running off the end of the screen is truncated rather than wrapping around", () => {
  const cells = row("___");
  const segments = pasteSegments(
    cells,
    true,
    cells.length,
    { row: 0, col: 0 },
    "12345",
  );
  assert.deepEqual(segments, [{ row: 0, col: 0, text: "123" }]);
});
