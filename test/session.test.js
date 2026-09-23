import test from "node:test";
import assert from "node:assert/strict";
import { Session, SessionRegistry } from "../server/session.js";
import { AppError } from "../server/errors.js";
import { keyboardLocked } from "../public/oia.js";
import {
  testConfig,
  collectingViewer,
  waitUntil,
  settle,
  startTracedSession,
} from "./helpers.js";

test("the first viewer controls and the rest observe", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const first = collectingViewer("first");
  const second = collectingViewer("second");
  session.attach(first);
  session.attach(second);

  assert.equal(first.role, "controller");
  assert.equal(second.role, "observer");
});

test("a viewer joining mid-stream gets a repaint matching what the first viewer sees", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;

  const early = collectingViewer("early");
  session.attach(early);
  await waitUntil(
    () => session.screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );

  const late = collectingViewer("late");
  session.attach(late);

  const repaint = late.paints[0];
  assert.ok(
    repaint !== undefined,
    "the late viewer should receive a repaint on attach",
  );
  assert.equal(
    repaint.full,
    true,
    "the repaint must build the screen up from scratch",
  );
  assert.ok(
    late.grid.rowText(0).includes("_____"),
    "the repaint must contain the current screen",
  );

  const hello = late.messages[0];
  assert.equal(hello?.type, "hello");
  assert.equal(hello?.type === "hello" ? hello.rows : 0, session.screen.rows);
});

test("every attached viewer receives the same delta", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await waitUntil(
    () => session.screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );

  const a = collectingViewer("a");
  const b = collectingViewer("b");
  session.attach(a);
  session.attach(b);
  const beforeA = a.paints.length;
  const beforeB = b.paints.length;

  session.b3270.runActions([{ action: "String", args: ["hello"] }]);
  await waitUntil(() => a.paints.length > beforeA, "a delta to be broadcast");
  await waitUntil(
    () => b.paints.length > beforeB,
    "the observer to get it too",
  );

  assert.deepEqual(a.paints.slice(beforeA), b.paints.slice(beforeB));
});

test("an observer cannot type, and is told why in place", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  const observer = collectingViewer("observer");
  session.attach(controller);
  session.attach(observer);

  session.handleClientMessage(observer, { type: "text", value: "nope" });

  const last = observer.messages.at(-1);
  assert.equal(last?.type, "error");
  assert.equal(last?.type === "error" ? last.code : "", "E3006");
});

test("a session counts as untouched until someone types at it", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const viewer = collectingViewer("viewer");
  session.attach(viewer);

  /** @returns {boolean} what the last status told the browsers */
  const reported = () => {
    const status = viewer.messages.filter((m) => m.type === "status").at(-1);
    return status?.type === "status" ? status.touched : false;
  };

  session.handleClientMessage(viewer, { type: "refresh" });
  session.handleClientMessage(viewer, { type: "oversize", value: "100x40" });
  assert.equal(session.touched, false);

  session.handleClientMessage(viewer, { type: "text", value: "abc" });
  assert.equal(session.touched, true);
  assert.equal(
    reported(),
    true,
    "the browsers must be told the moment it changes",
  );
});

test("the keyboard locking is pushed to every viewer the moment it happens", async (t) => {
  const fixture = await startTracedSession("test/traces/fields.trc");
  t.after(() => fixture.close());
  const { session } = fixture;

  const viewer = collectingViewer("viewer");
  session.attach(viewer);
  await waitUntil(
    () => session.screen.fieldsFormatted,
    "the field map to arrive",
  );

  // The first input broadcasts a status of its own, because it is what makes the
  // session touched. The lock under test is the one after that, with nothing
  // else going on that would force a broadcast.
  session.handleClientMessage(viewer, { type: "text", value: "a" });
  await settle(session);
  assert.equal(session.oia.keyboardLocked, false, "the keyboard starts open");
  const before = viewer.messages.length;

  session.handleClientMessage(viewer, { type: "action", action: "Enter" });
  await waitUntil(() => session.oia.keyboardLocked, "the keyboard to lock");

  const pushed = viewer.messages
    .slice(before)
    .filter((message) => message.type === "status");
  assert.ok(
    pushed.length > 0,
    "a lock the browser has to wait on must be a status, not only a drawn OIA",
  );
  const last = pushed.at(-1);
  assert.equal(
    last?.type === "status" && keyboardLocked(last.lock),
    true,
    "and it must carry the lock the browser derives from",
  );
});

test("control passes on when the controller leaves", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const first = collectingViewer("first");
  const second = collectingViewer("second");
  session.attach(first);
  session.attach(second);
  session.detach(first);

  assert.equal(
    second.role,
    "controller",
    "the session must not be left read-only",
  );
});

test("allowMultipleControllers makes every viewer a controller", async (t) => {
  const session = new Session(
    testConfig({
      sessions: { allowMultipleControllers: true, idleTimeoutMs: 0 },
    }),
  );
  t.after(() => session.close());
  await session.ready;

  const a = collectingViewer("a");
  const b = collectingViewer("b");
  session.attach(a);
  session.attach(b);

  assert.equal(a.role, "controller");
  assert.equal(b.role, "controller");
});

test("the controller can turn sharing off, refusing a second viewer but not itself", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  session.attach(controller);
  session.handleClientMessage(controller, {
    type: "sharing",
    allowView: false,
    allowEdit: false,
  });

  assert.throws(
    () => session.attach(collectingViewer("second")),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E3007");
      return true;
    },
  );

  session.detach(controller);
  const rejoined = collectingViewer("rejoined");
  session.attach(rejoined);
  assert.equal(
    rejoined.role,
    "controller",
    "the first viewer back in is never locked out by its own setting",
  );
});

test("an observer cannot change the sharing settings", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  const observer = collectingViewer("observer");
  session.attach(controller);
  session.attach(observer);

  session.handleClientMessage(observer, {
    type: "sharing",
    allowView: false,
    allowEdit: true,
  });

  assert.equal(session.allowSharing, true, "an observer cannot touch it");
  assert.equal(session.allowSharedEditing, false);
  const error = observer.messages.at(-1);
  assert.equal(error?.type, "error");
  assert.equal(error?.type === "error" ? error.code : "", "E3006");
});

test("turning shared editing on promotes every viewer, and off demotes everyone but the controller who did it", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  const observer = collectingViewer("observer");
  session.attach(controller);
  session.attach(observer);
  assert.equal(observer.role, "observer");

  session.handleClientMessage(controller, {
    type: "sharing",
    allowView: true,
    allowEdit: true,
  });
  assert.equal(session.allowSharedEditing, true);
  assert.equal(
    observer.role,
    "controller",
    "already attached, not just the next to join",
  );

  const third = collectingViewer("third");
  session.attach(third);
  assert.equal(
    third.role,
    "controller",
    "a new viewer types too, once shared editing is on",
  );

  session.handleClientMessage(controller, {
    type: "sharing",
    allowView: true,
    allowEdit: false,
  });
  assert.equal(
    observer.role,
    "observer",
    "demoted the moment shared editing is turned off",
  );
  assert.equal(third.role, "observer");
  assert.equal(
    controller.role,
    "controller",
    "the one who turned it off keeps control",
  );
});

test("hello and status report the session's sharing settings", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  session.attach(controller);
  const hello = controller.messages[0];
  assert.equal(hello?.type, "hello");
  assert.equal(hello?.type === "hello" ? hello.allowSharing : null, true);
  assert.equal(
    hello?.type === "hello" ? hello.allowSharedEditing : null,
    false,
  );

  session.handleClientMessage(controller, {
    type: "sharing",
    allowView: false,
    allowEdit: false,
  });
  const status = controller.messages.at(-1);
  assert.equal(status?.type, "status");
  assert.equal(status?.type === "status" ? status.allowSharing : null, false);
});

test("only the controller can allow or deny automation, and every viewer is told", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  const observer = collectingViewer("observer");
  session.attach(controller);
  session.attach(observer);

  const hello = controller.messages[0];
  assert.equal(
    hello?.type === "hello" ? hello.allowAutomation : null,
    false,
    "automation is off unless config says otherwise",
  );

  session.handleClientMessage(observer, { type: "automation", allowed: true });
  assert.equal(session.allowAutomation, false, "an observer cannot touch it");
  const refusal = observer.messages.at(-1);
  assert.equal(refusal?.type === "error" ? refusal.code : "", "E3006");

  session.handleClientMessage(controller, {
    type: "automation",
    allowed: true,
  });
  assert.equal(
    session.allowAutomation,
    true,
    "the config is where a session starts, not a ceiling",
  );
  for (const viewer of [controller, observer]) {
    const status = viewer.messages.at(-1);
    assert.equal(status?.type, "status");
    assert.equal(
      status?.type === "status" ? status.allowAutomation : null,
      true,
      `${viewer.id} must be told`,
    );
  }

  session.handleClientMessage(controller, {
    type: "automation",
    allowed: false,
  });
  assert.equal(session.allowAutomation, false, "and it closes again");
});

test("a config with automation on starts every session open to it, for automation with no browser on it", async (t) => {
  const session = new Session(
    testConfig({ sessions: { allowAutomation: true, idleTimeoutMs: 0 } }),
  );
  t.after(() => session.close());
  await session.ready;

  assert.equal(session.allowAutomation, true);
});

test("the viewer ceiling is enforced", async (t) => {
  const session = new Session(
    testConfig({ sessions: { maxViewersPerSession: 1, idleTimeoutMs: 0 } }),
  );
  t.after(() => session.close());
  await session.ready;

  session.attach(collectingViewer("a"));
  assert.throws(
    () => session.attach(collectingViewer("b")),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E3003");
      return true;
    },
  );
});

test("a session survives its viewers leaving and rejoining", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await waitUntil(
    () => session.screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );

  const viewer = collectingViewer("reload");
  session.attach(viewer);
  session.detach(viewer);
  assert.equal(
    session.closed,
    false,
    "the host connection must outlive the browser",
  );

  const rejoined = collectingViewer("rejoined");
  session.attach(rejoined);
  assert.ok(
    rejoined.grid.rowText(0).includes("_____"),
    "the same screen must come straight back",
  );
});

test("changing the model resizes the grid and tells every viewer before repainting", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;
  assert.equal(session.screen.rows, 43, "the fixture starts on a model 4");

  const controller = collectingViewer("controller");
  const observer = collectingViewer("observer");
  session.attach(controller);
  session.attach(observer);

  session.handleClientMessage(controller, { type: "model", model: 2 });
  await waitUntil(
    () => session.screen.rows === 24,
    "the grid to become a model 2",
  );

  for (const viewer of [controller, observer]) {
    const at = viewer.messages.findIndex(
      (message) => message.type === "screen",
    );
    assert.notEqual(at, -1, `${viewer.id} must be told the new size`);
    assert.deepEqual(viewer.messages[at], {
      type: "screen",
      model: 2,
      rows: 24,
      cols: 80,
      oversize: "",
    });

    // A repaint is meaningless to a viewer still holding a 43-row grid.
    const next = viewer.messages[at + 1];
    assert.ok(
      next?.type === "paint" && next.full,
      `${viewer.id} must be repainted immediately after being resized`,
    );
  }
});

test("a host that only ever erases the default screen shrinks the grid to match", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const viewer = collectingViewer("viewer");
  session.attach(viewer);

  // A host that never sends Erase/Write Alternate stays at 24x80, which b3270
  // reports as an erase indication's logical-rows, not as a new screen-mode.
  session.handleIndication({
    kind: "screen-mode",
    body: { model: 4, rows: 43, columns: 80, color: true },
  });
  await waitUntil(
    () => session.screen.rows === 43,
    "the grid to grow to the model 4 size",
  );

  const before = viewer.messages.length;
  session.handleIndication({
    kind: "erase",
    body: { "logical-rows": 24, "logical-columns": 80 },
  });

  const at = viewer.messages.findIndex(
    (message, i) => i >= before && message.type === "screen",
  );
  assert.notEqual(
    at,
    -1,
    "the viewer must be told the grid shrank to what the host actually uses",
  );
  assert.deepEqual(viewer.messages[at], {
    type: "screen",
    model: 4,
    rows: 24,
    cols: 80,
    oversize: "",
  });

  const next = viewer.messages[at + 1];
  assert.ok(
    next?.type === "paint" && next.full,
    "the viewer must be repainted immediately after being resized",
  );
});

test("changing the model under a live connection drops it and reopens the same host", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session, host } = fixture;
  await waitUntil(
    () => session.screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );
  const expectedHost = `127.0.0.1:${host.port}`;
  assert.equal(session.lastHost, expectedHost);

  const controller = collectingViewer("controller");
  session.attach(controller);
  session.handleClientMessage(controller, { type: "model", model: 2 });

  // b3270 refuses a model change while connected.
  await waitUntil(
    () => session.screen.rows === 24,
    "the grid to become a model 2",
  );
  await waitUntil(
    () => session.oia.connectionState !== "not-connected",
    "the host connection to come back",
  );
  assert.equal(session.model, 2);
  assert.equal(session.lastHost, expectedHost);
});

test("reconnecting without naming a host reuses the one the session knows", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session, host } = fixture;
  await waitUntil(
    () => session.oia.connectionState !== "not-connected",
    "the first connection",
  );

  const controller = collectingViewer("controller");
  session.attach(controller);
  session.handleClientMessage(controller, { type: "disconnect" });
  await waitUntil(
    () => session.oia.connectionState === "not-connected",
    "the disconnect",
  );

  session.handleClientMessage(controller, { type: "connect", host: null });
  await waitUntil(
    () => session.oia.connectionState !== "not-connected",
    "the reconnection",
  );
  assert.equal(session.lastHost, `127.0.0.1:${host.port}`);
});

test("a refresh repaints only the viewer who asked, even an observer", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await waitUntil(
    () => session.screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );

  const controller = collectingViewer("controller");
  const observer = collectingViewer("observer");
  session.attach(controller);
  session.attach(observer);
  assert.equal(observer.role, "observer");

  const before = controller.paints.length;
  session.handleClientMessage(observer, { type: "refresh" });

  assert.equal(
    controller.paints.length,
    before,
    "nobody else may be disturbed",
  );
  const last = observer.paints.at(-1);
  assert.equal(last?.full, true, "the asker gets a full repaint");
  assert.ok(
    observer.grid.rowText(0).includes("_____"),
    "and it is the host screen, not an error",
  );
  assert.ok(
    observer.messages.every((message) => message.type !== "error"),
    "an observer asking for its own screen back is not an input",
  );
});

test("a Backspace action deletes the character behind the cursor, not just moves over it", async (t) => {
  // b3270's own Backspace only moves left. The field is nondisplay, so the
  // deletion can only be checked through the cursor.
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);

  const controller = collectingViewer("controller");
  session.attach(controller);

  const before = screen.cursor.col;
  session.handleClientMessage(controller, { type: "text", value: "hello" });
  await settle(session);
  assert.equal(screen.cursor.col, before + 5);

  session.handleClientMessage(controller, {
    type: "action",
    action: "Backspace",
  });
  await settle(session);
  assert.equal(
    screen.cursor.col,
    before + 4,
    "one character should have been deleted",
  );

  session.handleClientMessage(controller, {
    type: "action",
    action: "Backspace",
  });
  await settle(session);
  assert.equal(
    screen.cursor.col,
    before + 3,
    "backspacing again deletes the next character back",
  );
});

test("a Backspace at the very start of a field does nothing, rather than locking the keyboard", async (t) => {
  // Left from a field's first cell lands on the attribute byte behind it, where
  // Delete is a protected-field error that locks the keyboard.
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);
  // Without the field map Backspace cannot know it is at a field start; waiting is not optional.
  await waitUntil(() => screen.fieldsFormatted, "the field map to load");

  const controller = collectingViewer("controller");
  session.attach(controller);

  const before = { ...screen.cursor };
  session.handleClientMessage(controller, {
    type: "action",
    action: "Backspace",
  });
  await settle(session);

  assert.deepEqual(screen.cursor, before, "the cursor must not move");
  assert.equal(session.oia.keyboardLocked, false, "the keyboard must not lock");
});

test("typing on the attribute byte just left of a field nudges the cursor into it, rather than locking the keyboard", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);
  await waitUntil(() => screen.fieldsFormatted, "the field map to load");

  const controller = collectingViewer("controller");
  session.attach(controller);
  const start = { ...screen.cursor };

  // The cell before the field is its attribute byte: protected, so typing there locks the keyboard.
  session.handleClientMessage(controller, {
    type: "action",
    action: "MoveCursor1",
    args: [String(start.row + 1), String(start.col)],
  });
  await settle(session);

  session.handleClientMessage(controller, { type: "text", value: "x" });
  await settle(session);
  assert.equal(
    session.oia.keyboardLocked,
    false,
    "typing on the attribute byte must not lock the keyboard",
  );
  assert.equal(
    screen.cursor.col,
    start.col + 1,
    "the character should land in the field, advancing the cursor past it",
  );

  session.handleClientMessage(controller, {
    type: "action",
    action: "MoveCursor1",
    args: [String(start.row + 1), String(start.col + 1)],
  });
  session.handleClientMessage(controller, { type: "copyField" });
  await settle(session);

  const fieldContent = controller.messages.find(
    (message) => message.type === "fieldContent",
  );
  assert.equal(
    fieldContent?.type === "fieldContent" ? fieldContent.text : null,
    "x",
  );
});

test("BackNewline walks up to the first field of the row above, where Newline walks down", async (t) => {
  // fields.trc: fields at column 11 of rows 2, 4 and 6; the cursor starts in the first.
  const fixture = await startTracedSession("test/traces/fields.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);
  await waitUntil(() => screen.fieldsFormatted, "the field map to load");

  const controller = collectingViewer("controller");
  session.attach(controller);
  assert.deepEqual(
    { row: screen.cursor.row, col: screen.cursor.col },
    { row: 2, col: 11 },
  );

  session.handleClientMessage(controller, {
    type: "action",
    action: "Newline",
  });
  await settle(session);
  assert.deepEqual(
    { row: screen.cursor.row, col: screen.cursor.col },
    { row: 4, col: 11 },
    "Newline moves down a field",
  );

  session.handleClientMessage(controller, {
    type: "action",
    action: "BackNewline",
  });
  await settle(session);
  assert.deepEqual(
    { row: screen.cursor.row, col: screen.cursor.col },
    { row: 2, col: 11 },
    "BackNewline moves back up",
  );

  session.handleClientMessage(controller, {
    type: "action",
    action: "BackNewline",
  });
  await settle(session);
  assert.deepEqual(
    { row: screen.cursor.row, col: screen.cursor.col },
    { row: 6, col: 11 },
    "BackNewline wraps past the top",
  );
  assert.equal(
    session.oia.keyboardLocked,
    false,
    "moving the cursor must not lock the keyboard",
  );
});

test("BackNewline on a screen with no fields falls back to the start of the row above", async (t) => {
  const fixture = await startTracedSession("test/traces/fields.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);

  const controller = collectingViewer("controller");
  session.attach(controller);
  session.handleClientMessage(controller, {
    type: "action",
    action: "MoveCursor1",
    args: ["5", "20"],
  });
  await settle(session);

  screen.applyFields(new Array(screen.cells.length).fill(false), false);
  session.handleClientMessage(controller, {
    type: "action",
    action: "BackNewline",
  });
  await settle(session);

  assert.deepEqual(
    { row: screen.cursor.row, col: screen.cursor.col },
    { row: 3, col: 0 },
  );
});

test("a hints request answers with one letter per editable field, using the cached field map", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);

  const controller = collectingViewer("controller");
  session.attach(controller);
  await waitUntil(
    () => session.screen.cells.some((cell) => cell.editable),
    "the field map to be read",
  );

  session.handleClientMessage(controller, { type: "hints" });
  await settle(session);

  const hints = controller.messages.find((message) => message.type === "hints");
  assert.ok(hints?.type === "hints", "a hints message should have been sent");
  assert.ok(hints.hints.length > 0, "the screen has editable fields to hint");
  const letters = hints.hints.map((hint) => hint.letter);
  assert.equal(
    new Set(letters).size,
    letters.length,
    "no letter should be handed to two fields",
  );
});

test("clicking a cell moves the cursor there", async (t) => {
  // MoveCursor1 is 1-origin, which is how the browser sends the clicked cell.
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);

  const controller = collectingViewer("controller");
  session.attach(controller);

  session.handleClientMessage(controller, {
    type: "action",
    action: "MoveCursor1",
    args: ["5", "12"],
  });
  await settle(session);

  assert.equal(session.screen.cursor.row, 4);
  assert.equal(session.screen.cursor.col, 11);
});

test("pasted text is typed literally, backslashes and all", async (t) => {
  // String() reads a backslash as an escape ("\b" is a backspace); PasteString does not.
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);

  const controller = collectingViewer("controller");
  session.attach(controller);
  const before = session.screen.cursor.col;

  session.handleClientMessage(controller, { type: "paste", text: "a\\b" });
  await settle(session);

  assert.equal(session.screen.cursor.col, before + 3);
});

test("pasting more than a field holds is truncated at its edge, not spilled into the protected field after it", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);
  await waitUntil(() => screen.fieldsFormatted, "the field map to load");

  const controller = collectingViewer("controller");
  session.attach(controller);
  const start = { ...screen.cursor };

  // The field runs from the cursor to the end of the row; past it is protected.
  const fieldWidth = screen.cols - start.col;
  session.handleClientMessage(controller, {
    type: "paste",
    text: "x".repeat(fieldWidth + 3),
  });
  await settle(session);
  assert.equal(
    session.oia.keyboardLocked,
    false,
    "landing on the protected field must not lock the keyboard",
  );

  // b3270's screen indications do not report what a scripted paste typed, so read the field back.
  session.handleClientMessage(controller, {
    type: "action",
    action: "MoveCursor1",
    args: [String(start.row + 1), String(start.col + 1)],
  });
  session.handleClientMessage(controller, { type: "copyField" });
  await settle(session);

  const fieldContent = controller.messages.find(
    (message) => message.type === "fieldContent",
  );
  assert.equal(
    fieldContent?.type === "fieldContent" ? fieldContent.text : null,
    "x".repeat(fieldWidth),
  );
});

test("a paste crossing the gaps between short fields lands whole, with nothing eaten by the attribute bytes", async (t) => {
  // three-fields.trc: ___ ___ ___ on row 1, each gap a field attribute byte.
  for (const [text, expected] of [
    ["123456789", " 123 456 789"],
    ["123 456 789", " 123 456 789"],
    ["123456 789", " 123 456  78"],
  ]) {
    const fixture = await startTracedSession("test/traces/three-fields.trc");
    t.after(() => fixture.close());
    const { session } = fixture;
    await settle(session);
    await waitUntil(() => session.screen.fieldsFormatted, "the field map");

    const controller = collectingViewer("controller");
    session.attach(controller);
    session.handleClientMessage(controller, { type: "paste", text });
    await settle(session);

    assert.equal(
      session.screen.rowText(0).slice(0, 12),
      expected,
      `pasting ${JSON.stringify(text)}`,
    );
  }
});

test("undo takes the typing back out a step at a time, and redo puts it back", async (t) => {
  const fixture = await startTracedSession("test/traces/three-fields.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);
  await waitUntil(() => session.screen.fieldsFormatted, "the field map");

  const controller = collectingViewer("controller");
  session.attach(controller);
  const row = () => session.screen.rowText(0).slice(0, 12);
  /** @param {string} action */
  const press = (action) =>
    session.handleClientMessage(controller, { type: "action", action });

  session.handleClientMessage(controller, { type: "text", value: "abc" });
  await waitUntil(() => row() === " abc        ", "the typing to land");
  session.handleClientMessage(controller, { type: "paste", text: "456789" });
  await waitUntil(() => row() === " abc 456 789", "the paste to land");

  // One thing the user did is one step, however many actions it took.
  await waitUntil(() => session.undoStack.length === 2, "two steps of history");

  press("Undo");
  await waitUntil(() => row() === " abc        ", "the paste to come back out");
  press("Undo");
  await waitUntil(
    () => row() === "            ",
    "the typing to come back out",
  );

  press("Undo");
  await settle(session);
  assert.equal(row(), "            ", "an empty history is a no-op");

  press("Redo");
  await waitUntil(() => row() === " abc        ", "the typing to come back");
  press("Redo");
  await waitUntil(() => row() === " abc 456 789", "the paste to come back");
});

test("an AID key ends the history: what was typed before it cannot be undone", async (t) => {
  const fixture = await startTracedSession("test/traces/three-fields.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);
  await waitUntil(() => session.screen.fieldsFormatted, "the field map");

  const controller = collectingViewer("controller");
  session.attach(controller);
  const row = () => session.screen.rowText(0).slice(0, 12);

  session.handleClientMessage(controller, { type: "text", value: "abc" });
  await waitUntil(() => session.undoStack.length === 1, "a step of history");

  session.handleClientMessage(controller, { type: "action", action: "Enter" });
  assert.equal(session.undoStack.length, 0, "the screen went to the host");

  session.handleClientMessage(controller, { type: "action", action: "Undo" });
  await settle(session);
  assert.equal(row(), " abc        ", "the typing stands");
});

test("a b3270 resource set in the config reaches the emulator", async (t) => {
  const session = new Session(
    testConfig({
      b3270: { path: "b3270", model: 2, settings: { oversize: "90x30" } },
    }),
  );
  t.after(() => session.close());
  await session.ready;

  assert.equal(session.screen.rows, 30);
  assert.equal(session.screen.cols, 90);
});

test("fitting the screen to the window grows it while disconnected, and off puts it back", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;
  assert.equal(session.screen.rows, 43, "the fixture starts on a model 4");

  const controller = collectingViewer("controller");
  session.attach(controller);

  session.handleClientMessage(controller, {
    type: "oversize",
    value: "120x50",
  });
  await waitUntil(
    () => session.screen.rows === 50,
    "the grid to grow to what the browser asked for",
  );
  assert.equal(session.screen.cols, 120);

  const at = controller.messages.findIndex(
    (message) => message.type === "screen",
  );
  assert.notEqual(at, -1, "the viewer must be told the new size");
  assert.deepEqual(controller.messages[at], {
    type: "screen",
    model: 4,
    rows: 50,
    cols: 120,
    oversize: "120x50",
  });

  session.handleClientMessage(controller, { type: "oversize", value: "" });
  await waitUntil(
    () => session.screen.rows === 43,
    "the model's own size to come back",
  );
  assert.equal(session.screen.cols, 80);
});

test("a model too wide for the fitted screen falls back to its own size", async (t) => {
  // b3270 refuses a model bigger than the standing oversize, so the two are reconciled first.
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  session.attach(controller);

  session.handleClientMessage(controller, {
    type: "oversize",
    value: "100x50",
  });
  await waitUntil(() => session.screen.cols === 100, "the fitted screen");

  session.handleClientMessage(controller, { type: "model", model: 5 });
  await waitUntil(() => session.screen.cols === 132, "the model 5 screen");
  assert.equal(session.screen.rows, 27);
  assert.equal(
    session.oversize,
    "",
    "a screen the model outgrew is no screen size at all",
  );
});

test("fitting the screen under a live connection drops it and reopens the same host", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session, host } = fixture;
  await waitUntil(
    () => session.screen.rowText(0).includes("_____"),
    "the screen to be drawn",
  );
  const expectedHost = `127.0.0.1:${host.port}`;

  const controller = collectingViewer("controller");
  session.attach(controller);
  session.handleClientMessage(controller, {
    type: "oversize",
    value: "100x50",
  });

  // The host learns the screen size only at connect time.
  await waitUntil(
    () => session.screen.cols === 100,
    "the grid to become the size asked for",
  );
  await waitUntil(
    () => session.oia.connectionState !== "not-connected",
    "the host connection to come back",
  );
  assert.equal(session.oversize, "100x50");
  assert.equal(session.lastHost, expectedHost);
});

test("the registry refuses to exceed maxSessions", async () => {
  const registry = new SessionRegistry(
    testConfig({ sessions: { maxSessions: 1, idleTimeoutMs: 0 } }),
  );
  await registry.create();
  await assert.rejects(
    () => registry.create(),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E3002");
      return true;
    },
  );
  registry.closeAll();
});

test("an unknown session id is a stable error, not a crash", () => {
  const registry = new SessionRegistry(testConfig());
  assert.throws(
    () => registry.get("nope"),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "E3001");
      return true;
    },
  );
});

test("a closed session removes itself from the registry", async () => {
  const registry = new SessionRegistry(testConfig());
  const session = await registry.create();
  await session.ready;
  assert.equal(registry.list().length, 1);
  session.close();
  assert.equal(registry.list().length, 0);
});

test("the field map is read on every session, and rides the paint as a flag", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;

  const viewer = collectingViewer("viewer");
  session.attach(viewer);

  // Nobody asks for this: Backspace needs it on every session, tint or no tint.
  await waitUntil(
    () => session.screen.cells.some((cell) => cell.editable),
    "the field map to be read",
  );
  await settle(session);

  const editable = viewer.paints
    .flatMap((paint) => paint.rows)
    .flatMap((row) => row.runs)
    .filter((run) => run.editable === true);
  assert.ok(
    editable.length > 0,
    "the browser tints the fields now, so it has to be told which they are",
  );
  assert.ok(
    editable.every((run) => run.bg === undefined),
    "a tint is the browser's to choose; the server names only what the host said",
  );
});

test("recording captures the screen and each step, and stops cleanly", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  session.attach(controller);

  session.handleClientMessage(controller, {
    type: "recorder",
    action: "start",
  });
  assert.notEqual(
    session.recording,
    null,
    "a recording should now be in progress",
  );

  session.handleClientMessage(controller, { type: "text", value: "abc" });
  session.handleClientMessage(controller, { type: "action", action: "Enter" });

  const steps = controller.messages
    .filter((m) => m.type === "recorderStep")
    .map((m) => (m.type === "recorderStep" ? m.step : null));
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], {
    screen: session.recording?.steps[0].screen,
    action: "String",
    args: ["abc"],
  });
  assert.deepEqual(steps[1], {
    screen: session.recording?.steps[1].screen,
    action: "Enter",
    args: [],
  });
  assert.ok(
    Array.isArray(steps[0]?.screen),
    "a step carries the whole screen, not just the keystroke",
  );

  session.handleClientMessage(controller, { type: "recorder", action: "stop" });
  assert.equal(session.recording, null, "stopping clears the recording");

  session.handleClientMessage(controller, { type: "text", value: "ignored" });
  const after = controller.messages.filter((m) => m.type === "recorderStep");
  assert.equal(
    after.length,
    2,
    "nothing more should have been recorded once stopped",
  );
});

test("nothing is recorded while nobody has started a recording", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  session.attach(controller);

  session.handleClientMessage(controller, { type: "text", value: "abc" });
  session.handleClientMessage(controller, { type: "action", action: "Enter" });

  assert.equal(
    controller.messages.some((m) => m.type === "recorderStep"),
    false,
  );
});

test("an observer cannot start or stop a recording", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  const observer = collectingViewer("observer");
  session.attach(controller);
  session.attach(observer);

  session.handleClientMessage(observer, { type: "recorder", action: "start" });

  assert.equal(session.recording, null, "an observer cannot touch it");
  const last = observer.messages.at(-1);
  assert.equal(last?.type, "error");
  assert.equal(last?.type === "error" ? last.code : "", "E3006");
});

test("a run of keystrokes into a password field collapses to a single marker", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer("controller");
  session.attach(controller);

  session.handleClientMessage(controller, {
    type: "recorder",
    action: "start",
  });
  // Set directly; readbuffer.test.js covers the attribute-bit detection behind it.
  session.passwordField = true;

  session.handleClientMessage(controller, { type: "text", value: "s" });
  session.handleClientMessage(controller, { type: "text", value: "ec" });
  session.handleClientMessage(controller, { type: "text", value: "ret" });

  const steps = /** @type {import('../server/protocol.js').RecorderStep[]} */ (
    session.recording?.steps ?? []
  );
  assert.equal(steps.length, 1, "the whole run collapses into one entry");
  assert.equal(steps[0].password, true);
  assert.equal(
    steps[0].action,
    undefined,
    "no action and no args, so nothing typed ever leaks out",
  );
  assert.equal(steps[0].args, undefined);

  // The Enter that submits the field is not its content, and replay needs it.
  session.handleClientMessage(controller, { type: "action", action: "Enter" });
  assert.equal(steps.length, 2);
  assert.equal(steps[1].action, "Enter");

  session.passwordField = false;
  session.handleClientMessage(controller, { type: "text", value: "next" });
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[2], {
    screen: steps[2].screen,
    action: "String",
    args: ["next"],
  });
});

test("a session with no viewers left is closed once the idle timeout passes", async (t) => {
  const session = new Session(testConfig({ sessions: { idleTimeoutMs: 30 } }));
  t.after(() => session.close());
  await session.ready;

  const viewer = collectingViewer("only");
  session.attach(viewer);
  assert.equal(
    session.idleTimer,
    null,
    "a session being watched is not on the clock",
  );

  session.detach(viewer);
  await waitUntil(() => session.closed, "the idle session to be reaped");
});

test("a viewer reattaching inside the idle window stops the session being reaped", async (t) => {
  const session = new Session(
    testConfig({ sessions: { idleTimeoutMs: 30000 } }),
  );
  t.after(() => session.close());
  await session.ready;

  const first = collectingViewer("first");
  session.attach(first);
  session.detach(first);
  assert.notEqual(
    session.idleTimer,
    null,
    "the last viewer leaving starts the clock",
  );

  session.attach(collectingViewer("reconnected"));
  assert.equal(session.idleTimer, null);
  assert.equal(session.closed, false);
});

test("the hello tells a viewer how long a dropped session is held for", async (t) => {
  const session = new Session(
    testConfig({ sessions: { idleTimeoutMs: 45000 } }),
  );
  t.after(() => session.close());
  await session.ready;

  const viewer = collectingViewer("only");
  session.attach(viewer);

  const hello = viewer.messages[0];
  assert.equal(hello?.type, "hello");
  assert.equal(hello?.type === "hello" ? hello.idleTimeoutMs : 0, 45000);
});
