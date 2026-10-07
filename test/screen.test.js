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
  return new ScreenModel(emulator.s);
}

test("a screen indication dirties only the rows it changes", () => {
  const screen = newScreen();
  screen.takeDirtyRows();
  screen.markRows([1]);
  assert.deepEqual(
    screen.takeDirtyRows(),
    [0],
    "only the touched row should be sent",
  );
});

test("out-of-range rows are ignored", () => {
  const screen = newScreen();
  screen.takeDirtyRows();
  screen.markRows([99, 0]);
  assert.deepEqual(screen.takeDirtyRows(), []);
});

test("the size and the cursor are the emulator's, counted from 0", () => {
  const screen = newScreen("3279-4");
  assert.equal(screen.rows, 43);
  assert.equal(screen.cols, 80);

  screen.emulator.savedBaddr = 4 * 80 + 9;
  assert.deepEqual(screen.cursor, { row: 4, col: 9, enabled: true });
});

test("a cursor move is reported on its own, and standing still is not one", () => {
  const screen = newScreen();
  screen.takeDirtyRows();
  screen.takeCursorMoved();

  // A Tab is the whole of what some keys do, so it has to travel by itself.
  screen.emulator.savedBaddr = 2 * 80 + 6;
  assert.deepEqual(screen.takeDirtyRows(), [], "a cursor move touches no row");
  assert.equal(screen.takeCursorMoved(), true);
  assert.equal(screen.takeCursorMoved(), false, "and is reported only once");
});

test("a colour screen names its default colours, a monochrome one has none", () => {
  const colour = newScreen("3279-2");
  assert.equal(colour.defaultFg, "blue");
  assert.equal(colour.defaultBg, "neutralBlack");
  const mono = newScreen("3278-2");
  assert.equal(mono.defaultFg, null);
  assert.equal(mono.defaultBg, null);
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
