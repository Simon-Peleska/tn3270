import test from "node:test";
import assert from "node:assert/strict";
import { fullRepaint, delta } from "../server/vt.js";
import {
  ansiColorIndex,
  DEFAULT_FOREGROUND_ANSI,
  DEFAULT_BACKGROUND_ANSI,
} from "../server/colors.js";
import { loadGhostty, render } from "./ghostty.js";
import { startTracedSession, waitUntil, settle } from "./helpers.js";

// Host colours are indexed, so the palette here is sixteen distinct values and
// the checks are on which slot each cell resolved through, not on any RGB.

const ghostty = await loadGhostty();

/** @type {number[]} packed 0xRRGGBB, one distinct value per ANSI slot */
const TEST_PALETTE = Array.from(
  { length: 16 },
  (_, index) => (index + 1) * 0x101010,
);

/**
 * @param {number} index 0-15
 * @returns {[number, number, number]}
 */
function paletteRgb(index) {
  const packed = TEST_PALETTE[index] ?? 0;
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

/**
 * @param {import('../server/screen.js').ScreenModel} screen
 * @param {ReturnType<typeof render>} rendered
 * @returns {void}
 */
function assertGridMatches(screen, rendered) {
  for (let row = 0; row < screen.rows; row++) {
    const expected = screen.rowText(row);
    assert.equal(rendered.text[row], expected, `row ${row + 1} differs`);
  }

  for (let row = 0; row < screen.rows; row++) {
    for (let col = 0; col < screen.cols; col++) {
      const cell = screen.cellAt(row, col);
      if (cell.ch === " " || cell.ch === "") continue;
      const fg = paletteRgb(
        ansiColorIndex(cell.fg ?? screen.defaultFg, DEFAULT_FOREGROUND_ANSI),
      );
      const bg = paletteRgb(
        ansiColorIndex(cell.bg ?? screen.defaultBg, DEFAULT_BACKGROUND_ANSI),
      );
      const actual = rendered.cell(row, col);
      assert.deepEqual(
        [
          actual.fg_r,
          actual.fg_g,
          actual.fg_b,
          actual.bg_r,
          actual.bg_g,
          actual.bg_b,
        ],
        [fg[0], fg[1], fg[2], bg[0], bg[1], bg[2]],
        `colours at row ${row + 1} col ${col + 1} differ`,
      );
    }
  }
}

test("a full repaint of a real screen round-trips through ghostty unchanged", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(
    () => screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );

  const oiaText = "X Not Connected".padEnd(screen.cols, " ");
  const rendered = render(
    ghostty,
    screen.cols,
    screen.rows + 1,
    fullRepaint(screen, oiaText),
    TEST_PALETTE,
  );

  assertGridMatches(screen, rendered);
  assert.equal(
    rendered.text[screen.rows],
    oiaText,
    "the OIA row should sit below the screen",
  );
});

test("a delta applied on top of a repaint agrees with the model", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(
    () => screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );

  const blankOia = "".padEnd(screen.cols, " ");
  const terminal = ghostty.createTerminal(screen.cols, screen.rows + 1, {
    palette: TEST_PALETTE,
  });
  terminal.write(fullRepaint(screen, blankOia));

  const changed = 4;
  for (let col = 0; col < 5; col++) {
    const cell = screen.cellAt(changed, col);
    cell.ch = "ABCDE"[col] ?? " ";
    cell.fg = "turquoise";
  }
  terminal.write(delta(screen, [changed], blankOia, false));

  for (let row = 0; row < screen.rows; row++) {
    const line = terminal.getLine(row) ?? [];
    let text = "";
    for (let col = 0; col < screen.cols; col++) {
      const codepoint = line[col]?.codepoint ?? 0;
      text += codepoint === 0 ? " " : String.fromCodePoint(codepoint);
    }
    assert.equal(
      text,
      screen.rowText(row),
      `row ${row + 1} differs after the delta`,
    );
  }

  const turquoise = paletteRgb(
    ansiColorIndex("turquoise", DEFAULT_FOREGROUND_ANSI),
  );
  const painted = terminal.getLine(changed)?.[0];
  assert.ok(painted, "the changed row should have been repainted");
  assert.deepEqual([painted.fg_r, painted.fg_g, painted.fg_b], turquoise);
});

test("a keystroke moves the cursor and the delta carries it", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { session } = fixture;
  const { screen } = session;
  await settle(session);

  const before = screen.cursor.col;
  // The field in this trace is nondisplay, so the advancing cursor is the whole effect.
  session.b3270.runActions([{ action: "String", args: ["hello"] }]);
  await settle(session);
  assert.equal(
    screen.cursor.col,
    before + 5,
    "five characters should advance the cursor five columns",
  );

  const bytes = delta(screen, screen.takeDirtyRows(), "", false);
  const terminal = ghostty.createTerminal(screen.cols, screen.rows + 1);
  terminal.write(fullRepaint(screen, ""));
  terminal.write(bytes);

  const cursor = terminal.getCursor();
  assert.equal(cursor.y, screen.cursor.row);
  assert.equal(cursor.x, screen.cursor.col);
});

test("writing the last cell of the last row does not scroll the screen", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(
    () => screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );

  // Only autowrap being off keeps this from scrolling the whole screen up by one.
  const bottom = screen.rows - 1;
  screen.cellAt(bottom, screen.cols - 1).ch = "Z";
  screen.cellAt(0, 0).ch = "A";

  const rendered = render(
    ghostty,
    screen.cols,
    screen.rows + 1,
    fullRepaint(screen, ""),
  );

  assert.equal(
    rendered.text[0]?.[0],
    "A",
    "the top row must still be the top row",
  );
  assert.equal(rendered.text[bottom]?.[screen.cols - 1], "Z");
});

test("the cursor lands where the model says it is", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(() => screen.cursor.enabled, "the cursor to be enabled");

  const rendered = render(
    ghostty,
    screen.cols,
    screen.rows + 1,
    fullRepaint(screen, ""),
  );
  assert.equal(rendered.cursor.y, screen.cursor.row);
  assert.equal(rendered.cursor.x, screen.cursor.col);
});
