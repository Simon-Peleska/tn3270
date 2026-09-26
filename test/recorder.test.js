import test from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../public/recorder.js";

test("steps arriving after Stop stay in the recording until the server confirms it", () => {
  /** @type {import('../server/protocol.js').ClientMessage[]} */
  const sent = [];
  /** @type {string[]} */
  const exports = [];
  /** @type {import('../public/recorder.js').Recording[][]} */
  const saved = [];
  const recorder = new Recorder({
    dispatch: (message) => sent.push(message),
    exportFile: (_filename, content) => exports.push(content),
    persist: (values) => saved.push(structuredClone(values)),
  });
  recorder.start();
  recorder.stop();
  const step = {
    screen: ["screen"],
    paint: {
      type: /** @type {const} */ ("paint"),
      full: true,
      color: true,
      fieldsFormatted: false,
      size: { rows: 1, cols: 6 },
      rows: [{ row: 0, runs: [{ col: 0, text: "screen", fg: "red" }] }],
      cursor: { row: 0, col: 0, on: true },
    },
    cursor: { row: 0, col: 0 },
    action: "MoveCursor1",
    args: ["5", "12"],
  };
  recorder.record(step);
  const final = {
    screen: ["final"],
    cursor: { row: 0, col: 5 },
    final: /** @type {const} */ (true),
  };
  recorder.record(final);
  assert.deepEqual(recorder.recordings[0].steps, [step, final]);
  recorder.exportRecording(recorder.recordings[0]);
  assert.deepEqual(JSON.parse(exports[0]).steps[0].cursor, { row: 0, col: 0 });
  assert.equal(JSON.parse(exports[0]).steps[0].paint.rows[0].runs[0].fg, "red");
  assert.equal(JSON.parse(exports[0]).steps[1].final, true);
  assert.equal(recorder.stopping, true);
  recorder.stopped();
  assert.deepEqual(
    saved.map((recordings) => recordings[0]?.steps.length),
    [0, 2],
  );
  const reloaded = new Recorder({
    dispatch: () => {},
    exportFile: () => {},
    persist: () => {},
  });
  reloaded.load(saved.at(-1) ?? []);
  assert.deepEqual(reloaded.recordings[0]?.steps, [step, final]);
  recorder.record({
    screen: [],
    cursor: { row: 4, col: 11 },
    action: "Left",
    args: [],
  });
  assert.deepEqual(recorder.recordings[0].steps, [step, final]);
  assert.deepEqual(sent, [
    { type: "recorder", action: "start" },
    { type: "recorder", action: "stop" },
  ]);
});

test("an exported recording can be imported without losing its screen or colliding with an existing one", () => {
  /** @type {import('../public/recorder.js').Recording[][]} */
  const saved = [];
  const recorder = new Recorder({
    dispatch: () => {},
    exportFile: () => {},
    persist: (recordings) => saved.push(structuredClone(recordings)),
  });
  const exported = {
    name: "Imported",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: [
      {
        screen: ["hello"],
        cursor: { row: 0, col: 2 },
        paint: {
          type: "paint",
          full: true,
          color: true,
          fieldsFormatted: false,
          size: { rows: 1, cols: 5 },
          rows: [{ row: 0, runs: [{ col: 0, text: "hello", fg: "red" }] }],
          cursor: { row: 0, col: 2, on: true },
        },
        final: true,
      },
    ],
  };

  const first = recorder.importRecording(JSON.stringify(exported));
  assert.equal(first.name, "Imported");
  assert.equal(first.steps[0]?.paint?.rows[0]?.runs[0]?.fg, "red");
  const second = recorder.importRecording(JSON.stringify(exported));
  assert.notEqual(second.recordedAt, first.recordedAt);
  assert.equal(recorder.recordings.length, 2);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.at(-1), recorder.recordings);

  assert.throws(() => recorder.importRecording("{"), /valid JSON/);
  assert.throws(
    () =>
      recorder.importRecording(
        JSON.stringify({ ...exported, steps: [{ screen: 1 }] }),
      ),
    /invalid step/,
  );
  assert.equal(recorder.recordings.length, 2);
});
