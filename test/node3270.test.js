import test from "node:test";
import assert from "node:assert/strict";
import {
  collectingViewer,
  settle,
  startTracedSession,
  waitUntil,
} from "./helpers.js";

test("node3270 draws the host's screen for a viewer like b3270 would", async (t) => {
  const fixture = await startTracedSession("test/traces/fields.trc", {});
  t.after(() => fixture.close());
  const { session } = fixture;
  const viewer = collectingViewer("viewer");
  session.attach(viewer);

  await waitUntil(() => session.screen.fieldsFormatted, "the field map");
  assert.equal(session.screen.rows, 43);
  assert.equal(session.screen.rowText(2).slice(0, 11), " Name:     ");
  await settle(session);
  assert.equal(viewer.grid.rows, 43);
  assert.equal(viewer.grid.cellAt(2, 1)?.ch, "N");
});

test("node3270 sends typing and an AID to the host, and holds input until it answers", async (t) => {
  const fixture = await startTracedSession("test/traces/fields.trc", {});
  t.after(() => fixture.close());
  const { session, host } = fixture;
  const viewer = collectingViewer("viewer");
  session.attach(viewer);
  await waitUntil(() => session.screen.fieldsFormatted, "the field map");

  session.handleClientMessage(viewer, { type: "text", value: "abc" });
  session.handleClientMessage(viewer, { type: "action", action: "Enter" });
  await waitUntil(() => session.oia.keyboardLocked, "the keyboard to lock");
  // Enter's AID, then "abc" in EBCDIC.
  await waitUntil(
    () => host.received.includes("7d") && host.received.includes("818283"),
    "the AID record to reach the host",
  );

  session.handleClientMessage(viewer, { type: "text", value: "x" });
  session.handleClientMessage(viewer, { type: "action", action: "Tab" });
  session.handleClientMessage(viewer, { type: "text", value: "y" });
  assert.equal(session.inputQueue.length, 3, "all of it waits for the host");

  host.cursor = 0;
  await host.sendRecords(1);
  await settle(session);

  assert.equal(session.screen.rowText(2).slice(0, 14), " Name:     x  ");
  assert.equal(session.screen.rowText(4).slice(0, 14), " Note:     y  ");
});

test("node3270 keeps a quiet host connection alive with TELNET NOPs", async (t) => {
  const fixture = await startTracedSession("test/traces/fields.trc", {
    config: { emulator: { model: 4, settings: { nopSeconds: 1 } } },
  });
  t.after(() => fixture.close());
  const { session, host } = fixture;
  await waitUntil(() => session.screen.fieldsFormatted, "the field map");

  const before = host.received.length;
  await host.waitUntil(
    () => /^(..)*?fff1/.test(host.received.slice(before)),
    3000,
    "no NOP",
  );
});
