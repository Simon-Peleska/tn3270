import test from "node:test";
import assert from "node:assert/strict";
import { fullPaint, paintDelta } from "../server/paint.js";
import { Grid } from "../public/grid.js";
import { startTracedSession, waitUntil, settle } from "./helpers.js";

// The load-bearing test of the paint protocol: real b3270 output, encoded by the
// server and decoded by the same Grid the browser runs, compared cell for cell
// against the model. Nothing here knows what a colour looks like — the names go
// out and the same names must come back.

/**
 * @param {import('../server/screen.js').ScreenModel} screen
 * @param {Grid} grid
 * @returns {void}
 */
function assertGridMatches(screen, grid) {
  assert.equal(grid.rows, screen.rows);
  assert.equal(grid.cols, screen.cols);

  for (let row = 0; row < screen.rows; row++) {
    for (let col = 0; col < screen.cols; col++) {
      const cell = screen.cellAt(row, col);
      assert.deepEqual(
        grid.cellAt(row, col),
        {
          ch: cell.ch === "" ? " " : cell.ch,
          fg: cell.fg,
          bg: cell.bg,
          gr: cell.gr,
          editable: cell.editable,
        },
        `row ${row + 1} col ${col + 1} differs`,
      );
    }
  }

  assert.deepEqual(grid.cursor, {
    row: screen.cursor.row,
    col: screen.cursor.col,
    visible: screen.cursor.enabled,
  });
}

/**
 * @param {import('../server/screen.js').ScreenModel} screen
 * @returns {Grid}
 */
function paintedGrid(screen) {
  const grid = new Grid(1, 1);
  grid.applyPaint(fullPaint(screen));
  return grid;
}

test("a full paint of a real screen arrives in the browser's grid unchanged", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(
    () => screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );

  const grid = paintedGrid(screen);

  assertGridMatches(screen, grid);
  assert.equal(grid.color, screen.color);
  assert.equal(grid.defaultFg, screen.defaultFg);
  assert.equal(grid.defaultBg, screen.defaultBg);
});

test("the host's colours cross the wire as its own words", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(
    () => screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );

  const runs = fullPaint(screen).rows.flatMap((row) => row.runs);

  // Without this the cell-for-cell check above could be comparing nulls to nulls.
  assert.ok(
    runs.some((run) => run.fg === "red"),
    "this trace paints in red, so a run must say so",
  );
  assert.ok(
    runs.some((run) => run.bg !== undefined),
    "this trace reverses a field, so a run must name a background",
  );
  for (const run of runs) {
    if (run.fg !== undefined) assert.match(run.fg, /^[a-zA-Z]+$/);
    if (run.bg !== undefined) assert.match(run.bg, /^[a-zA-Z]+$/);
  }
});

test("a rendition of several words crosses the wire whole", async (t) => {
  const fixture = await startTracedSession("test/traces/fields.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(() => screen.fieldsFormatted, "the field map to arrive");

  const combined = fullPaint(screen)
    .rows.flatMap((row) => row.runs.map((run) => ({ row: row.row, run })))
    .find((found) => found.run.gr?.includes(",") === true);
  assert.ok(
    combined,
    "this trace combines renditions, which is what a bitmask would have flattened",
  );
  assert.ok((combined.run.gr?.split(",").length ?? 0) >= 2);
  for (const word of combined.run.gr?.split(",") ?? [])
    assert.match(word, /^[a-z]+$/, "b3270's own word, not a number");

  const grid = paintedGrid(screen);
  assert.equal(
    grid.cellAt(combined.row, combined.run.col)?.gr,
    combined.run.gr,
  );
});

test("every row is sent whole, so a run never has to say what it leaves behind", async (t) => {
  const fixture = await startTracedSession("test/traces/fields.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(() => screen.fieldsFormatted, "the field map to arrive");

  for (const row of fullPaint(screen).rows) {
    assert.equal(
      row.runs[0]?.col,
      0,
      `row ${row.row + 1} must start at column 0`,
    );
    let col = 0;
    for (const run of row.runs) {
      assert.equal(
        run.col,
        col,
        `row ${row.row + 1} has a gap before ${run.col}`,
      );
      col += run.text.length;
    }
    assert.equal(col, screen.cols, `row ${row.row + 1} stops short`);
  }
});

test("an editable field is marked as one all the way to the grid", async (t) => {
  const fixture = await startTracedSession("test/traces/fields.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(() => screen.fieldsFormatted, "the field map to arrive");

  const grid = paintedGrid(screen);
  let editable = 0;
  for (let row = 0; row < grid.rows; row++)
    for (let col = 0; col < grid.cols; col++)
      if (grid.cellAt(row, col)?.editable === true) editable += 1;

  assert.ok(editable > 0, "this trace has input fields");
  assertGridMatches(screen, grid);
});

test("a delta on top of a full paint keeps the grid agreeing with the model", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(
    () => screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );

  const grid = paintedGrid(screen);
  const untouched = grid.rowText(0);

  const changed = 4;
  for (let col = 0; col < 5; col++) {
    const cell = screen.cellAt(changed, col);
    cell.ch = "ABCDE"[col] ?? " ";
    cell.fg = "turquoise";
    cell.gr = null;
  }
  grid.applyPaint(paintDelta(screen, [changed]));

  assertGridMatches(screen, grid);
  assert.equal(grid.rowText(changed).slice(0, 5), "ABCDE");
  assert.equal(grid.cellAt(changed, 0)?.fg, "turquoise");
  assert.equal(
    grid.rowText(0),
    untouched,
    "a delta must not disturb other rows",
  );
});

test("a keystroke moves the cursor and the delta carries it", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { session } = fixture;
  const { screen } = session;
  await settle(session);

  const grid = paintedGrid(screen);
  const before = screen.cursor.col;
  // The field in this trace is nondisplay, so the advancing cursor is the whole effect.
  session.b3270.runActions([{ action: "String", args: ["hello"] }]);
  await settle(session);
  assert.equal(
    screen.cursor.col,
    before + 5,
    "five characters should advance the cursor five columns",
  );

  grid.applyPaint(paintDelta(screen, screen.takeDirtyRows()));

  assert.equal(grid.cursor?.row, screen.cursor.row);
  assert.equal(grid.cursor?.col, screen.cursor.col);
});

test("a cursor off the end of the screen is clamped onto it", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await settle(fixture.session);

  screen.cursor.row = screen.rows + 5;
  screen.cursor.col = -3;

  assert.deepEqual(fullPaint(screen).cursor, {
    row: screen.rows - 1,
    col: 0,
    on: screen.cursor.enabled,
  });
});
