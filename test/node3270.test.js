import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../server/session.js";
import { FakeHost } from "./fakehost.js";
import {
  collectingViewer,
  settle,
  startTracedSession,
  testConfig,
  waitUntil,
} from "./helpers.js";

/**
 * The error a viewer is shown when connecting to a TLS fake host fails.
 * @param {import('node:test').TestContext} t @param {Record<string, unknown>} settings
 */
async function tlsConnectError(t, settings) {
  const host = await FakeHost.listen("test/traces/fields.trc", 0, {
    tls: true,
  });
  const session = new Session(testConfig({ emulator: { settings } }));
  t.after(async () => {
    session.close();
    await host.close();
  });
  await session.ready;
  const viewer = collectingViewer("viewer");
  session.attach(viewer);
  session.connect(`127.0.0.1:${host.port}`);
  await waitUntil(
    () => viewer.messages.some((m) => m.type === "error"),
    "the connect to fail",
  );
  return viewer.messages.find((m) => m.type === "error");
}

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

test("node3270 refuses a TLS host whose certificate it does not trust", async (t) => {
  const error = await tlsConnectError(t, { caFile: null });
  assert.equal(error?.type === "error" ? error.code : "", "E2005");
  assert.match(
    error?.type === "error" ? error.message : "",
    /Host certificate verification failed/,
  );
});

test("node3270 says so when its caFile cannot be read", async (t) => {
  const error = await tlsConnectError(t, { caFile: "test/tls/missing.crt" });
  assert.match(
    error?.type === "error" ? error.message : "",
    /caFile test\/tls\/missing\.crt: .*ENOENT/,
  );
});
