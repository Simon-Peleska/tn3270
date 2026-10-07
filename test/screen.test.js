import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { ScreenModel } from "../server/screen.js";
import { Session } from "../server/session.js";
import { OiaModel } from "../server/oia.js";
import { AppError } from "../server/errors.js";
import { Session as Emulator } from "../3270/src/index.js";
import { collectingViewer, testConfig, waitUntil } from "./helpers.js";

// The characters and colours come from the emulator's render, which
// render.test.js and roundtrip.test.js check against real traces; this is the
// bookkeeping around it.

function newScreen(model = "3279-2") {
  const emulator = new Emulator({ model });
  emulator.indications(() => {});
  return new ScreenModel(emulator.s, 24, 80);
}

test("a screen indication dirties only the rows it changes", () => {
  const screen = newScreen();
  screen.takeDirtyRows();
  screen.applyScreen({ rows: [1] });
  assert.deepEqual(
    screen.takeDirtyRows(),
    [0],
    "only the touched row should be sent",
  );
});

test("out-of-range rows are ignored", () => {
  const screen = newScreen();
  screen.takeDirtyRows();
  screen.applyScreen({ rows: [99, 0] });
  assert.deepEqual(screen.takeDirtyRows(), []);
});

test("cursor fields are individually optional and fall back to the previous value", () => {
  const screen = newScreen();
  screen.applyScreen({ cursor: { enabled: true, row: 5, column: 10 } });
  assert.deepEqual(screen.cursor, { row: 4, col: 9, enabled: true });

  screen.applyScreen({ cursor: { enabled: false } });
  assert.deepEqual(screen.cursor, { row: 4, col: 9, enabled: false });
});

test("a cursor move is reported on its own, and standing still is not one", () => {
  const screen = newScreen();
  screen.takeDirtyRows();
  screen.takeCursorMoved();

  // A Tab is the whole of what some keys do, so it has to travel by itself.
  screen.applyScreen({ cursor: { enabled: true, row: 3, column: 7 } });
  assert.deepEqual(screen.takeDirtyRows(), [], "a cursor move touches no row");
  assert.equal(screen.takeCursorMoved(), true);
  assert.equal(screen.takeCursorMoved(), false, "and is reported only once");

  screen.applyScreen({ cursor: { enabled: true, row: 3, column: 7 } });
  assert.equal(screen.takeCursorMoved(), false);
});

test("erase forgets the fields, adopts the new defaults and homes the cursor", () => {
  const screen = newScreen();
  screen.applyFields(
    new Uint8Array(24 * 80).fill(1),
    new Uint8Array(24 * 80),
    true,
  );
  screen.applyScreen({ cursor: { enabled: true, row: 5, column: 5 } });
  screen.takeDirtyRows();

  screen.applyErase({
    "logical-rows": 24,
    "logical-columns": 80,
    fg: "blue",
    bg: "neutralBlack",
  });

  assert.equal(screen.cellAt(1, 0).editable, false);
  assert.deepEqual(screen.inputCells, []);
  assert.equal(screen.defaultFg, "blue");
  assert.equal(screen.defaultBg, "neutralBlack");
  assert.deepEqual(screen.cursor, { row: 0, col: 0, enabled: true });
  assert.equal(screen.takeDirtyRows().length, 24);
});

test("a screen-mode change resizes and dirties the whole screen", () => {
  const screen = newScreen();
  screen.takeDirtyRows();

  screen.applyScreenMode({
    model: 4,
    rows: 43,
    columns: 80,
    color: true,
    oversize: false,
    extended: true,
  });

  assert.equal(screen.rows, 43);
  assert.equal(screen.cols, 80);
  assert.equal(screen.takeDirtyRows().length, 43);
});

test("a blank screen is all default colours, in colour and in monochrome", () => {
  for (const model of ["3279-2", "3278-2"]) {
    const cell = newScreen(model).cellAt(0, 0);
    assert.deepEqual(
      { fg: cell.fg, bg: cell.bg, gr: cell.gr, ch: cell.ch },
      { fg: null, bg: null, gr: null, ch: " " },
      model,
    );
  }
});

test("reading outside the screen is a stable error, not undefined", () => {
  const screen = newScreen();
  for (const [row, col] of [
    [99, 0],
    [0, 80],
    [-1, 0],
  ]) {
    assert.throws(
      () => screen.cellAt(row, col),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "E3004");
        return true;
      },
    );
  }
});

test("a plain-telnet host is dropped with an error the viewers see", async (t) => {
  const host = createServer((socket) => socket.write("login: "));
  await new Promise((resolve) =>
    host.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  const session = new Session(
    testConfig({ emulator: { model: 2, tls: false } }),
  );
  t.after(() => {
    session.close();
    host.close();
  });
  await session.ready;
  const viewer = collectingViewer("viewer");
  session.attach(viewer);

  const port = /** @type {import("node:net").AddressInfo} */ (host.address())
    .port;
  session.connect(`127.0.0.1:${port}`);
  await waitUntil(
    () =>
      viewer.messages.some(
        (m) => m.type === "error" && m.message.startsWith("N1203 "),
      ),
    "the N1203 error to reach the viewer",
  );
});

test("the OIA reflects the connection state", () => {
  const oia = new OiaModel();
  assert.equal(oia.connected, false);

  oia.applyConnection({ state: "connected-tn3270e", host: "mainframe:23" });
  assert.equal(oia.connected, true);
  assert.equal(oia.host, "mainframe:23");
  assert.equal(oia.connectionState, "connected-tn3270e");
});
