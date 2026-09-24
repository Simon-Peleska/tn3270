import test from "node:test";
import assert from "node:assert/strict";
import { Session, SessionRegistry } from "../server/session.js";
import { AppError } from "../server/errors.js";
import { keyboardLocked } from "../public/oia.js";
import { computeHints } from "../public/hints.js";
import { pasteMessage } from "../public/paste.js";
import {
  testConfig,
  collectingViewer,
  waitUntil,
  settle,
  startTracedSession,
  letIn,
} from "./helpers.js";

test("the first viewer controls and the rest observe", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const first = collectingViewer("first");
  const second = collectingViewer("second");
  session.attach(first);
  letIn(session, first, second);

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
  letIn(session, early, late);

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

  const hello = late.messages[1];
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
  letIn(session, a, b);
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
  letIn(session, controller, observer);

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

test("what is typed while the host has the keyboard runs, in order, once it answers", async (t) => {
  // fields.trc: Name at row 2 and Note at row 4, both from column 11.
  const fixture = await startTracedSession("test/traces/fields.trc");
  t.after(() => fixture.close());
  const { session, host } = fixture;
  const viewer = collectingViewer("viewer");
  session.attach(viewer);
  await waitUntil(() => session.screen.fieldsFormatted, "the field map");

  session.handleClientMessage(viewer, { type: "action", action: "Enter" });
  await waitUntil(() => session.oia.keyboardLocked, "the keyboard to lock");
  session.handleClientMessage(viewer, { type: "text", value: "x" });
  session.handleClientMessage(viewer, { type: "action", action: "Tab" });
  session.handleClientMessage(viewer, { type: "text", value: "y" });
  assert.equal(session.inputQueue.length, 3, "all of it waits for the host");

  // The host answers with the same screen again, which unlocks the keyboard.
  host.cursor = 0;
  await host.sendRecords(1);
  await settle(session);

  assert.equal(session.screen.rowText(2).slice(0, 14), " Name:     x  ");
  assert.equal(session.screen.rowText(4).slice(0, 14), " Note:     y  ");
});

test("a held-down PF key repeats only once the host has answered the last one", async (t) => {
  const fixture = await startTracedSession("test/traces/fields.trc");
  t.after(() => fixture.close());
  const { session, host } = fixture;
  const viewer = collectingViewer("viewer");
  session.attach(viewer);
  await waitUntil(() => session.screen.fieldsFormatted, "the field map");
  const pf8 = { type: "action", action: "PF", args: ["8"], repeat: true };

  session.handleClientMessage(viewer, {
    type: "action",
    action: "PF",
    args: ["8"],
  });
  await waitUntil(() => session.oia.keyboardLocked, "the keyboard to lock");
  session.handleClientMessage(viewer, pf8);
  session.handleClientMessage(viewer, pf8);
  assert.equal(
    session.inputQueue.length,
    0,
    "repeats while the host works are dropped",
  );

  host.cursor = 0;
  await host.sendRecords(1);
  await settle(session);

  session.handleClientMessage(viewer, pf8);
  assert.notEqual(session.inputTag, null, "a repeat into an empty line runs");
});

test("Reset while the host has the keyboard throws away what was typed ahead", async (t) => {
  const fixture = await startTracedSession("test/traces/fields.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  const viewer = collectingViewer("viewer");
  session.attach(viewer);
  await waitUntil(() => session.screen.fieldsFormatted, "the field map");

  session.handleClientMessage(viewer, { type: "action", action: "Enter" });
  await waitUntil(() => session.oia.keyboardLocked, "the keyboard to lock");
  session.handleClientMessage(viewer, { type: "text", value: "lost" });

  session.handleClientMessage(viewer, { type: "action", action: "Reset" });
  await waitUntil(() => !session.oia.keyboardLocked, "the keyboard to unlock");
  assert.equal(session.inputQueue.length, 0);

  session.handleClientMessage(viewer, { type: "text", value: "kept" });
  await settle(session);
  assert.equal(session.screen.rowText(2).slice(0, 16), " Name:     kept ");
});

test("a second viewer waits until the owner lets them in, and sees nothing before", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const owner = collectingViewer("owner");
  const guest = { ...collectingViewer("guest"), user: "alice" };
  session.attach(owner);
  session.attach(guest);

  assert.deepEqual(
    guest.messages.map((message) => message.type),
    ["waiting"],
    "no hello and no paint before the owner has said yes",
  );
  const status = owner.messages.at(-1);
  assert.deepEqual(status?.type === "status" ? status.requests : null, [
    { viewer: "guest", name: "alice", kind: "watch" },
  ]);

  session.handleClientMessage(owner, {
    type: "answer",
    viewer: "guest",
    allow: true,
  });
  assert.equal(guest.messages[1]?.type, "hello");
  assert.equal(guest.role, "observer");
  assert.ok(guest.paints.length > 0, "and the screen comes with it");
  const after = owner.messages.at(-1);
  assert.deepEqual(after?.type === "status" ? after.requests : null, []);
  assert.equal(after?.type === "status" ? after.guests : null, 1);
});

test("a viewer still waiting cannot get the screen by asking for a repaint", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const owner = collectingViewer("owner");
  const guest = collectingViewer("guest");
  session.attach(owner);
  session.attach(guest);
  session.handleClientMessage(guest, { type: "refresh" });
  session.handleClientMessage(guest, { type: "askEdit" });

  assert.deepEqual(guest.paints, []);
  const status = owner.messages.at(-1);
  assert.equal(status?.type === "status" ? status.requests.length : null, 1);
});

test("a viewer the owner says no to is sent away, named by address without a user", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const owner = { ...collectingViewer("owner"), user: "bob" };
  const guest = collectingViewer("guest");
  session.attach(owner);
  session.attach(guest);
  const status = owner.messages.at(-1);
  assert.equal(
    status?.type === "status" ? status.requests[0]?.name : null,
    "127.0.0.1",
  );

  session.handleClientMessage(owner, {
    type: "answer",
    viewer: "guest",
    allow: false,
  });
  assert.deepEqual(guest.messages.at(-1), {
    type: "refused",
    code: "E3008",
    message: "bob did not let you in.",
  });
  assert.equal(guest.closed, true);
  assert.equal(session.waiting.size, 0);
  assert.equal(session.viewers.size, 1);
});

test("a guest asks to edit, and only one guest edits at a time", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const owner = collectingViewer("owner");
  const first = collectingViewer("first");
  const second = collectingViewer("second");
  session.attach(owner);
  letIn(session, owner, first);
  letIn(session, owner, second);

  session.handleClientMessage(first, { type: "text", value: "x" });
  const refused = first.messages.at(-1);
  assert.equal(refused?.type === "error" ? refused.code : "", "E3006");

  session.handleClientMessage(first, { type: "askEdit" });
  const asked = owner.messages.at(-1);
  assert.deepEqual(asked?.type === "status" ? asked.requests : null, [
    { viewer: "first", name: "127.0.0.1", kind: "edit" },
  ]);
  const own = first.messages.at(-1);
  assert.equal(own?.type === "status" ? own.editRequested : null, true);

  session.handleClientMessage(owner, {
    type: "answer",
    viewer: "first",
    allow: true,
  });
  assert.equal(first.role, "controller");

  session.handleClientMessage(second, { type: "askEdit" });
  session.handleClientMessage(owner, {
    type: "answer",
    viewer: "second",
    allow: true,
  });
  assert.equal(second.role, "controller");
  assert.equal(first.role, "observer", "the first guest gives way");
  assert.ok(
    first.messages.some(
      (message) => message.type === "error" && message.code === "E3012",
    ),
    "and is told why",
  );
  assert.equal(owner.role, "controller", "the owner never gives way");
});

test("an owner can say no to editing and take editing back", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const owner = collectingViewer("owner");
  const guest = collectingViewer("guest");
  session.attach(owner);
  letIn(session, owner, guest);

  session.handleClientMessage(guest, { type: "askEdit" });
  session.handleClientMessage(owner, {
    type: "answer",
    viewer: "guest",
    allow: false,
  });
  assert.equal(guest.role, "observer");
  assert.ok(
    guest.messages.some(
      (message) => message.type === "error" && message.code === "E3011",
    ),
  );

  session.handleClientMessage(guest, { type: "askEdit" });
  session.handleClientMessage(owner, {
    type: "answer",
    viewer: "guest",
    allow: true,
  });
  const status = owner.messages.at(-1);
  assert.equal(status?.type === "status" ? status.editor : null, "127.0.0.1");

  session.handleClientMessage(owner, { type: "stopEditing" });
  assert.equal(guest.role, "observer");
  assert.equal(guest.closed, false, "still watching");
});

test("stopping sharing sends every guest away, waiting or watching, and their passes stop working", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const owner = collectingViewer("owner");
  const watching = collectingViewer("watching");
  const waiting = collectingViewer("waiting");
  session.attach(owner);
  letIn(session, owner, watching);
  session.attach(waiting);

  session.handleClientMessage(owner, { type: "stopSharing" });
  for (const guest of [watching, waiting]) {
    const last = guest.messages.at(-1);
    assert.equal(last?.type === "refused" ? last.code : "", "E3009");
    assert.equal(guest.closed, true);
  }
  assert.deepEqual([...session.viewers], [owner]);

  const back = { ...collectingViewer("back"), pass: watching.pass };
  session.attach(back);
  assert.equal(back.messages[0]?.type, "waiting", "it has to ask again");
});

test("a guest cannot answer requests or stop sharing", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const owner = collectingViewer("owner");
  const guest = collectingViewer("guest");
  const other = collectingViewer("other");
  session.attach(owner);
  letIn(session, owner, guest);
  session.handleClientMessage(guest, { type: "askEdit" });
  session.handleClientMessage(owner, {
    type: "answer",
    viewer: "guest",
    allow: true,
  });
  session.attach(other);

  session.handleClientMessage(guest, {
    type: "answer",
    viewer: "other",
    allow: true,
  });
  session.handleClientMessage(guest, { type: "stopSharing" });
  assert.equal(session.waiting.size, 1, "even an editing guest cannot");
  const error = guest.messages.at(-1);
  assert.equal(error?.type === "error" ? error.code : "", "E3010");
});

test("the pass from hello lets the owner and a guest back in without asking", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const owner = collectingViewer("owner");
  const guest = collectingViewer("guest");
  session.attach(owner);
  letIn(session, owner, guest);
  const hello = owner.messages[0];
  assert.equal(hello?.type === "hello" ? hello.owner : null, true);

  session.detach(owner);
  session.detach(guest);
  assert.equal(guest.role, "observer");

  const guestBack = { ...collectingViewer("guest2"), pass: guest.pass };
  session.attach(guestBack);
  assert.equal(guestBack.messages[0]?.type, "hello");
  assert.equal(guestBack.owner, false, "a guest's pass is not an owner's");

  const ownerBack = { ...collectingViewer("owner2"), pass: owner.pass };
  session.attach(ownerBack);
  assert.equal(ownerBack.owner, true);
  assert.equal(ownerBack.role, "controller");
});

test("when the owner leaves, guests keep watching and nobody is made owner", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const owner = collectingViewer("owner");
  const guest = collectingViewer("guest");
  session.attach(owner);
  letIn(session, owner, guest);
  session.detach(owner);

  assert.equal(guest.role, "observer");
  assert.equal(guest.owner, false);
  const stranger = collectingViewer("stranger");
  session.attach(stranger);
  assert.equal(
    stranger.messages[0]?.type,
    "waiting",
    "a stranger waits for the owner to come back",
  );
});

test("a viewer that gives up waiting takes its request with it", async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  const owner = collectingViewer("owner");
  const guest = collectingViewer("guest");
  session.attach(owner);
  session.attach(guest);
  session.detach(guest);

  const status = owner.messages.at(-1);
  assert.deepEqual(status?.type === "status" ? status.requests : null, []);
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
  letIn(session, controller, observer);

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
  letIn(session, controller, observer);
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
});

test("Ctrl+C in a password field copies nothing, because the page never sees what was typed", async (t) => {
  // reverse.trc's field is non-display, so b3270 shows it blank.
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  const { screen } = session;
  await settle(session);
  await waitUntil(() => screen.fieldsFormatted, "the field map to load");

  const controller = collectingViewer("controller");
  session.attach(controller);
  const start = { ...screen.cursor };
  session.handleClientMessage(controller, { type: "text", value: "secret" });
  await waitUntil(
    () => screen.cursor.col === start.col + 6,
    "the typing to land",
  );
  await settle(session);

  assert.equal(controller.grid.fieldText(start.row, start.col), "");
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

  const none = new Array(screen.cells.length).fill(false);
  screen.applyFields(none, none, false);
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

test("the field map reaches the page, which hints one letter per editable field", async (t) => {
  const fixture = await startTracedSession("test/traces/reverse.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);

  const controller = collectingViewer("controller");
  session.attach(controller);
  await waitUntil(
    () => controller.grid.cells.some((cell) => cell.editable),
    "the field map to reach the page",
  );

  const hints = computeHints(controller.grid.cells, controller.grid.cols);
  assert.ok(hints.length > 0, "the screen has editable fields to hint");
  const letters = hints.map((hint) => hint.letter);
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

  session.handleClientMessage(
    controller,
    pasteMessage(controller.grid, "a\\b"),
  );
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
  const paste = pasteMessage(controller.grid, "x".repeat(fieldWidth + 3));
  assert.deepEqual(paste.segments, [
    { row: start.row, col: start.col, text: "x".repeat(fieldWidth) },
  ]);
  session.handleClientMessage(controller, paste);
  await settle(session);
  assert.equal(
    session.oia.keyboardLocked,
    false,
    "landing on the protected field must not lock the keyboard",
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
    session.handleClientMessage(
      controller,
      pasteMessage(controller.grid, text),
    );
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
  session.handleClientMessage(
    controller,
    pasteMessage(controller.grid, "456789"),
  );
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

  // The replay never answers, so the Undo would wait on the host for ever.
  session.handleClientMessage(controller, { type: "action", action: "Reset" });
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
  await settle(session);

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
  letIn(session, controller, observer);

  session.handleClientMessage(observer, { type: "recorder", action: "start" });

  assert.equal(session.recording, null, "an observer cannot touch it");
  const last = observer.messages.at(-1);
  assert.equal(last?.type, "error");
  assert.equal(last?.type === "error" ? last.code : "", "E3006");
});

test("a run of keystrokes into a password field collapses to a single marker", async (t) => {
  // password-field.trc: an ordinary field at columns 2-4, a non-display one at 6-8.
  const fixture = await startTracedSession("test/traces/password-field.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);
  await waitUntil(() => session.screen.fieldsFormatted, "the field map");

  const controller = collectingViewer("controller");
  session.attach(controller);
  session.handleClientMessage(controller, {
    type: "recorder",
    action: "start",
  });
  session.handleClientMessage(controller, { type: "action", action: "Tab" });
  await waitUntil(
    () => session.screen.cursor.col === 5,
    "the cursor to reach the password field",
  );

  session.handleClientMessage(controller, { type: "text", value: "s" });
  session.handleClientMessage(controller, { type: "text", value: "e" });
  session.handleClientMessage(controller, { type: "text", value: "c" });
  await settle(session);

  const steps = /** @type {import('../server/protocol.js').RecorderStep[]} */ (
    session.recording?.steps ?? []
  );
  assert.equal(steps.length, 2, "the whole run collapses into one entry");
  assert.equal(steps[1].password, true);
  assert.equal(
    steps[1].action,
    undefined,
    "no action and no args, so nothing typed ever leaks out",
  );
  assert.equal(steps[1].args, undefined);

  // The Enter that submits the field is not its content, and replay needs it.
  session.handleClientMessage(controller, { type: "action", action: "Enter" });
  await waitUntil(() => steps.length === 3, "the Enter to be recorded");
  assert.equal(steps[2].action, "Enter");
});

test("tabbing into a password field is enough to redact what is typed there", async (t) => {
  // password-field.trc: an ordinary field at columns 2-4, a non-display one at
  // 6-8. Nothing but the cursor moves between them, which is the point: the
  // field map does not change, so nothing re-reads it.
  const fixture = await startTracedSession("test/traces/password-field.trc");
  t.after(() => fixture.close());
  const { session } = fixture;
  await settle(session);
  await waitUntil(() => session.screen.fieldsFormatted, "the field map");

  const controller = collectingViewer("controller");
  session.attach(controller);
  session.handleClientMessage(controller, {
    type: "recorder",
    action: "start",
  });

  session.handleClientMessage(controller, { type: "text", value: "ab" });
  await settle(session);

  session.handleClientMessage(controller, { type: "action", action: "Tab" });
  await waitUntil(
    () => session.screen.cursor.col === 5,
    "the cursor to reach the password field",
  );

  session.handleClientMessage(controller, { type: "text", value: "hunter2" });
  await settle(session);

  const steps = /** @type {import('../server/protocol.js').RecorderStep[]} */ (
    session.recording?.steps ?? []
  );
  assert.deepEqual(
    steps.map((step) => [step.action, ...(step.args ?? [])]),
    [["String", "ab"], ["Tab"], [undefined]],
    "the password keystrokes must reach the recording as a marker only",
  );
  assert.equal(steps.at(-1)?.password, true);
  assert.equal(
    JSON.stringify(session.recording).includes("hunter2"),
    false,
    "and the recording must not carry it anywhere at all",
  );
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
