import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../server/session.js";
import { RecordingHost } from "./recordinghost.js";
import { collectingViewer, settle, testConfig, waitUntil } from "./helpers.js";

/**
 * A 24x80 screen: a protected label and, where `field` is given, an input
 * field after it.
 *
 * @param {string} label
 * @param {string} [field]
 * @returns {import('../server/protocol.js').RecorderStep}
 */
function step(label, field) {
  /** @type {import('../server/protocol.js').PaintRun[]} */
  const runs = [{ col: 1, text: label, fg: "red", gr: "highlight" }];
  if (field !== undefined)
    runs.push({ col: 8, text: field, fg: "green", editable: true });
  const screen = Array.from({ length: 24 }, () => " ".repeat(80));
  screen[2] = ` ${label}`.padEnd(8) + (field ?? "");
  return {
    screen: screen.map((line) => line.padEnd(80)),
    cursor: { row: 2, col: 8 },
    paint: {
      type: "paint",
      full: true,
      color: true,
      fieldsFormatted: true,
      size: { rows: 24, cols: 80 },
      rows: [{ row: 2, runs }],
      cursor: { row: 2, col: 8, on: true },
    },
  };
}

/** @param {import('../server/protocol.js').RecorderStep[]} steps */
async function startRecordedSession(steps) {
  /** @type {string[]} */
  const hostLog = [];
  const host = await RecordingHost.listen(
    { name: "test", recordedAt: "2026-10-04T00:00:00.000Z", steps },
    { log: (line) => hostLog.push(line) },
  );
  const session = new Session(
    testConfig({
      b3270: { model: host.script.model, settings: { codePage: "cp273" } },
    }),
  );
  await session.ready;
  session.connect(`127.0.0.1:${host.port}`);
  const viewer = collectingViewer("viewer");
  session.attach(viewer);
  return {
    host,
    hostLog,
    session,
    viewer,
    async close() {
      session.close();
      await host.close();
    },
  };
}

test("a recording's host draws its first screen, fields and colours included", async (t) => {
  const fixture = await startRecordedSession([
    { ...step("Ort:", "Köln      "), action: "Enter" },
    { ...step("Danke"), final: true },
  ]);
  t.after(() => fixture.close());
  const { session } = fixture;

  await waitUntil(
    () =>
      session.screen.rowText(2).includes("Köln") &&
      session.screen.cellAt(2, 8).editable,
    "the first screen and its input field",
  );
  assert.equal(session.screen.rowText(2).slice(0, 18), " Ort:   Köln      ");
  assert.equal(session.screen.cellAt(2, 1).editable, false);
  assert.equal(session.screen.cellAt(2, 1).fg, "red");
  assert.equal(session.screen.cellAt(2, 8).editable, true);
  assert.equal(session.screen.cellAt(2, 17).editable, true);
  assert.equal(session.screen.cellAt(2, 8).fg, "green");
  assert.deepEqual(
    [session.screen.cursor.row, session.screen.cursor.col],
    [2, 8],
  );
});

test("a recording's host answers the recorded AID key with the next screen", async (t) => {
  const fixture = await startRecordedSession([
    { ...step("Ort:", "          "), action: "String", args: ["Bonn"] },
    { ...step("Ort:", "Bonn      "), action: "Enter" },
    { ...step("Danke"), final: true },
  ]);
  t.after(() => fixture.close());
  const { session, viewer } = fixture;
  await waitUntil(() => session.screen.fieldsFormatted, "the first screen");

  session.handleClientMessage(viewer, { type: "action", action: "Enter" });
  await waitUntil(
    () => session.screen.rowText(2).startsWith(" Danke "),
    "the screen Enter brought",
  );
  await settle(session);
  assert.equal(session.oia.keyboardLocked, false);
});

test("a recording's host answers any other AID key with the same screen", async (t) => {
  const fixture = await startRecordedSession([
    { ...step("Ort:", "          "), action: "Enter" },
    { ...step("Danke"), final: true },
  ]);
  t.after(() => fixture.close());
  const { session, viewer, hostLog } = fixture;
  await waitUntil(() => session.screen.fieldsFormatted, "the first screen");

  session.handleClientMessage(viewer, {
    type: "action",
    action: "PF",
    args: ["3"],
  });
  await waitUntil(
    () => hostLog.some((line) => line.includes("screen 0 again")),
    "the host to answer PF3",
  );
  await settle(session);
  assert.equal(session.oia.keyboardLocked, false);
  assert.equal(session.screen.rowText(2).slice(0, 8), " Ort:   ");

  session.handleClientMessage(viewer, { type: "action", action: "Enter" });
  await waitUntil(
    () => session.screen.rowText(2).startsWith(" Danke "),
    "the recorded answer, still waiting",
  );
});

test("a recording's host keeps a non-display field non-display", async (t) => {
  const fixture = await startRecordedSession([
    {
      ...step("PW:", "          "),
      hidden: [{ row: 2, col: 8, length: 10 }],
      final: true,
    },
  ]);
  t.after(() => fixture.close());
  const { session } = fixture;

  await waitUntil(
    () => session.screen.cellAt(2, 8).editable,
    "the first screen and its input field",
  );
  assert.equal(session.screen.cursorHidden(), true);
});
