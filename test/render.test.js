import test from "node:test";
import assert from "node:assert/strict";
import { startTracedSession, waitUntil } from "./helpers.js";

// The assertions of x3270's b3270/Test/testRender.py, against our ScreenModel.

test("reverse.trc: the reverse-video field gets a red background, the field before it does not", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(
    () => screen.rowText(0).includes("_____"),
    "the underscore field to be drawn",
  );

  // The trace puts a reverse/red attribute at row 1 column 2; the field follows it.
  const beforeField = screen.cellAt(0, 1);
  assert.equal(
    beforeField.bg,
    null,
    "the attribute cell should not have an explicit background",
  );

  const inField = screen.cellAt(0, 2);
  assert.equal(
    inField.bg,
    "red",
    "the reverse-video field should render with a red background",
  );
  assert.equal(inField.ch, "_");

  assert.ok(
    screen.rowText(1).startsWith(" Field:"),
    `row 2 was ${JSON.stringify(screen.rowText(1))}`,
  );
  assert.equal(screen.cellAt(1, 1).bg, null);
});

test("invisible_underscore.trc: nothing on the screen is underlined", async (t) => {
  const fixture = await startTracedSession(
    "test/traces/invisible_underscore.trc",
  );
  t.after(() => fixture.close());

  const { screen } = fixture.session;
  await waitUntil(
    () => screen.rowText(0).includes("Field:"),
    "the field label to be drawn",
  );

  for (let row = 0; row < screen.rows; row++) {
    for (let col = 0; col < screen.cols; col++) {
      const gr = screen.cellAt(row, col).gr;
      assert.ok(
        gr === null || !gr.includes("underline"),
        `cell ${row},${col} should not be underlined but was ${String(gr)}`,
      );
    }
  }
});

test("the screen model matches the model 4 geometry the traces were recorded at", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());

  await waitUntil(
    () => fixture.session.screen.rows === 43,
    "the model 4 screen mode",
  );
  assert.equal(fixture.session.screen.rows, 43);
  assert.equal(fixture.session.screen.cols, 80);
  assert.equal(fixture.session.screen.color, true);
});

test("a malformed data stream does not bring the session down", async (t) => {
  const fixture = await startTracedSession("test/traces/short_sba.trc");
  t.after(() => fixture.close());

  // The trace ends mid-order, which b3270 reports without dying.
  await waitUntil(
    () => fixture.session.screen.rows > 0,
    "the session to stay up",
  );
  assert.equal(fixture.session.closed, false);
});
