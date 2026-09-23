import test from "node:test";
import assert from "node:assert/strict";
import { Grid, visibleCell, visibleCursor } from "../public/grid.js";

/**
 * @param {Partial<import('../server/protocol.js').PaintMessage>} fields
 * @returns {import('../server/protocol.js').PaintMessage}
 */
function paint(fields) {
  return {
    type: "paint",
    full: false,
    color: true,
    rows: [],
    cursor: { row: 0, col: 0, on: true },
    ...fields,
  };
}

test("a fresh grid is blanks all the way across", () => {
  const grid = new Grid(3, 8);
  assert.equal(grid.cells.length, 24);
  assert.equal(grid.rowText(0), "        ");
  assert.deepEqual(grid.cellAt(2, 7), {
    ch: " ",
    fg: null,
    bg: null,
    gr: null,
    editable: false,
  });
});

test("an overlay grid starts transparent instead of blank", () => {
  const overlay = new Grid(2, 4, null);
  assert.equal(overlay.cellAt(0, 0)?.ch, null);
  overlay.put(0, 1, "ab");
  assert.equal(overlay.cellAt(0, 0)?.ch, null);
  assert.equal(overlay.cellAt(0, 1)?.ch, "a");
  overlay.clear();
  assert.equal(overlay.cellAt(0, 1)?.ch, null);
});

test("put writes a styled run and leaves its neighbours alone", () => {
  const grid = new Grid(3, 10);

  grid.put(1, 2, "abc", { fg: "red", gr: "underline", editable: true });

  assert.equal(grid.rowText(1), "  abc     ");
  assert.deepEqual(grid.cellAt(1, 3), {
    ch: "b",
    fg: "red",
    bg: null,
    gr: "underline",
    editable: true,
  });
  assert.equal(grid.rowText(0), "          ");
  assert.equal(grid.rowText(2), "          ");
});

test("put overwrites the style of every cell it touches, defaults included", () => {
  const grid = new Grid(1, 6);
  grid.put(0, 0, "abcdef", { fg: "red", bg: "blue", gr: "blink" });
  grid.put(0, 2, "XY");

  assert.deepEqual(grid.cellAt(0, 2), {
    ch: "X",
    fg: null,
    bg: null,
    gr: null,
    editable: false,
  });
  assert.equal(grid.cellAt(0, 4)?.fg, "red");
});

test("put clips at the edges instead of wrapping", () => {
  const grid = new Grid(2, 5);

  grid.put(0, 3, "abcdef");
  assert.equal(grid.rowText(0), "   ab");
  assert.equal(grid.rowText(1), "     ");

  grid.put(1, -2, "wxyz");
  assert.equal(grid.rowText(1), "yz   ");

  grid.put(0, 9, "off");
  grid.put(7, 0, "off");
  assert.equal(grid.rowText(0), "   ab");
  assert.equal(grid.rowText(1), "yz   ");
});

test("cellAt is null off the grid rather than wrapping to a neighbour", () => {
  const grid = new Grid(2, 4);
  assert.equal(grid.cellAt(-1, 0), null);
  assert.equal(grid.cellAt(0, -1), null);
  assert.equal(grid.cellAt(0, 4), null);
  assert.equal(grid.cellAt(2, 0), null);
});

test("clear blanks every cell, its style and the cursor", () => {
  const grid = new Grid(2, 4);
  grid.put(0, 0, "ab", {
    fg: "red",
    bg: "blue",
    gr: "highlight",
    editable: true,
  });
  grid.cursor = { row: 0, col: 1, visible: true };

  grid.clear();

  assert.deepEqual(grid.cellAt(0, 0), {
    ch: " ",
    fg: null,
    bg: null,
    gr: null,
    editable: false,
  });
  assert.equal(grid.cursor, null);
});

test("resize reallocates to the new geometry and drops what was there", () => {
  const grid = new Grid(2, 4);
  grid.put(0, 0, "abcd");

  grid.resize(3, 6);

  assert.equal(grid.cells.length, 18);
  assert.equal(grid.rowText(0), "      ");
});

test("a full paint clears what it does not mention and takes the screen defaults", () => {
  const grid = new Grid(2, 10);
  grid.put(1, 0, "stale");

  grid.applyPaint(
    paint({
      full: true,
      color: false,
      defaultFg: "green",
      defaultBg: "neutralBlack",
      rows: [{ row: 0, runs: [{ col: 2, text: "hi" }] }],
      cursor: { row: 0, col: 3, on: true },
    }),
  );

  assert.equal(grid.rowText(0), "  hi      ");
  assert.equal(grid.rowText(1), "          ");
  assert.equal(grid.color, false);
  assert.equal(grid.defaultFg, "green");
  assert.equal(grid.defaultBg, "neutralBlack");
  assert.deepEqual(grid.cursor, { row: 0, col: 3, visible: true });
});

test("a delta paint leaves the rows it does not mention alone", () => {
  const grid = new Grid(2, 10);
  grid.applyPaint(
    paint({
      full: true,
      defaultFg: "green",
      rows: [
        { row: 0, runs: [{ col: 0, text: "keep me" }] },
        { row: 1, runs: [{ col: 0, text: "replace" }] },
      ],
      cursor: { row: 0, col: 0, on: true },
    }),
  );

  grid.applyPaint(
    paint({
      rows: [{ row: 1, runs: [{ col: 0, text: "done   " }] }],
      cursor: { row: 1, col: 6, on: false },
    }),
  );

  assert.equal(grid.rowText(0), "keep me   ");
  assert.equal(grid.rowText(1), "done      ");
  assert.equal(
    grid.defaultFg,
    "green",
    "a delta carries no defaults of its own",
  );
  assert.deepEqual(grid.cursor, { row: 1, col: 6, visible: false });
});

test("a paint's runs carry the colour names and renditions through untouched", () => {
  const grid = new Grid(1, 12);

  grid.applyPaint(
    paint({
      rows: [
        {
          row: 0,
          runs: [
            { col: 0, text: "Field:" },
            {
              col: 7,
              text: "____",
              fg: "red",
              bg: "deepBlue",
              gr: "underline,highlight",
              editable: true,
            },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(grid.cellAt(0, 0), {
    ch: "F",
    fg: null,
    bg: null,
    gr: null,
    editable: false,
  });
  assert.deepEqual(grid.cellAt(0, 7), {
    ch: "_",
    fg: "red",
    bg: "deepBlue",
    gr: "underline,highlight",
    editable: true,
  });
});

test("text copies a rectangle and trims each row's trailing blanks", () => {
  const grid = new Grid(4, 12);
  grid.put(0, 0, "NAME    SMITH");
  grid.put(1, 0, "CITY    OSLO");
  grid.put(2, 0, "ZIP");

  assert.equal(grid.text(0, 8, 2, 11), "SMIT\nOSLO\n");
  assert.equal(grid.text(0, 0, 1, 11), "NAME    SMIT\nCITY    OSLO");
});

test("text clips to the grid rather than running off it", () => {
  const grid = new Grid(2, 5);
  grid.put(0, 0, "abcde");
  grid.put(1, 0, "fghij");

  assert.equal(grid.text(-3, -3, 9, 9), "abcde\nfghij");
});

test("the overlay shows through only where it has no character", () => {
  const host = new Grid(2, 6);
  const overlay = new Grid(2, 6, null);
  host.put(0, 0, "hostly", { fg: "red", editable: true });
  overlay.put(0, 2, "OV", { fg: "#ffffff", bg: "#202020" });

  assert.equal(visibleCell(host, overlay, 0, 1)?.ch, "o");
  assert.equal(visibleCell(host, overlay, 0, 1)?.fg, "red");
  assert.deepEqual(visibleCell(host, overlay, 0, 2), {
    ch: "O",
    fg: "#ffffff",
    bg: "#202020",
    gr: null,
    editable: false,
  });
  assert.equal(visibleCell(host, overlay, 0, 4)?.ch, "l");
  assert.equal(visibleCell(host, overlay, 5, 0), null);
});

test("a blank in the overlay hides the host, an untouched cell does not", () => {
  const host = new Grid(1, 4);
  const overlay = new Grid(1, 4, null);
  host.put(0, 0, "abcd");
  overlay.put(0, 1, " ");

  assert.equal(visibleCell(host, overlay, 0, 1)?.ch, " ");
  assert.equal(visibleCell(host, overlay, 0, 2)?.ch, "c");
});

test("the overlay takes the cursor only once it has one of its own", () => {
  const host = new Grid(1, 4);
  const overlay = new Grid(1, 4, null);
  host.cursor = { row: 0, col: 1, visible: true };

  assert.deepEqual(visibleCursor(host, overlay), {
    row: 0,
    col: 1,
    visible: true,
  });

  overlay.cursor = { row: 0, col: 3, visible: true };
  assert.deepEqual(visibleCursor(host, overlay), {
    row: 0,
    col: 3,
    visible: true,
  });

  overlay.clear();
  assert.deepEqual(visibleCursor(host, overlay), {
    row: 0,
    col: 1,
    visible: true,
  });
});
