import test from "node:test";
import { keyboardLocked } from "../public/oia.js";
import assert from "node:assert/strict";
import { Session } from "../server/session.js";
import { Macros } from "../public/macros.js";
import { RecordingHost } from "./recordinghost.js";
import { availableParallelism } from "node:os";
import { collectingViewer, testConfig, waitUntil } from "./helpers.js";
import { rng } from "../3270/test/rng.js";

/**
 * @typedef {{ row: number, col: number, length: number, text?: string }} Field
 * @typedef {import('../server/protocol.js').RecorderStep} RecorderStep
 */

/**
 * A 24x80 screen with a title on row 0 and the given input fields, each
 * behind a protected label.
 *
 * @param {string} title
 * @param {Field[]} fields
 * @param {{ row: number, col: number }} cursor
 * @returns {RecorderStep}
 */
function screen(title, fields, cursor) {
  /** @type {Map<number, import('../server/protocol.js').PaintRun[]>} */
  const rows = new Map([[0, [{ col: 1, text: title }]]]);
  const lines = Array.from({ length: 24 }, () => " ".repeat(80).split(""));
  [...title].forEach((ch, i) => (lines[0][1 + i] = ch));
  for (const field of fields) {
    const text = (field.text ?? "").padEnd(field.length);
    const runs = rows.get(field.row) ?? [];
    runs.push({ col: field.col - 4, text: "==> " });
    runs.push({ col: field.col, text, editable: true });
    rows.set(field.row, runs);
    [...("==> " + text)].forEach(
      (ch, i) => (lines[field.row][field.col - 4 + i] = ch),
    );
  }
  return {
    screen: lines.map((line) => line.join("")),
    cursor,
    paint: {
      type: "paint",
      full: true,
      color: false,
      fieldsFormatted: true,
      size: { rows: 24, cols: 80 },
      rows: [...rows].map(([row, runs]) => ({ row, runs })),
      cursor: { ...cursor, on: true },
    },
  };
}

/** @param {RecorderStep[]} steps */
async function startHost(steps) {
  return RecordingHost.listen({
    name: "host",
    recordedAt: "2026-10-04T00:00:00.000Z",
    steps,
  });
}

/**
 * A session on the host's first screen, with its field map read.
 * @param {RecordingHost} host
 */
async function startSession(host) {
  const session = new Session(
    testConfig({ emulator: { model: host.script.model } }),
  );
  const viewer = collectingViewer("viewer");
  session.attach(viewer);
  session.connect(`127.0.0.1:${host.port}`);
  await waitUntil(() => idle(session), "the first screen");
  return { session, viewer };
}

/**
 * Nothing queued, nothing running, the field map read, and the host done
 * answering: where a person at the keyboard would look and type again.
 *
 * @param {Session} session
 */
function idle(session) {
  return (
    session.inputQueue.length === 0 &&
    session.input === null &&
    session.edit === null &&
    session.screen.fieldsFormatted &&
    !["twait", "syswait", "not-connected", "connecting"].includes(
      session.oia.lock,
    )
  );
}

/** @param {Session} session */
function snapshot(session) {
  const { cursor } = session.screen;
  return {
    text: session
      .screenLines()
      .map((line) => line.trimEnd())
      .join("\n"),
    cursor: `${cursor.row}:${cursor.col}`,
  };
}

/**
 * @param {Session} session
 * @param {import('./helpers.js').collectingViewer extends (...args: any) => infer V ? V : never} viewer
 * @param {import('../public/recorder.js').Recording} recording
 */
async function playRecording(session, viewer, recording) {
  macrosFor(session, viewer).playRecording(recording);
  await waitUntil(() => idle(session), "the recording to finish");
}

/**
 * The page's macro list, sending to the session as app.js does.
 *
 * @param {Session} session
 * @param {ReturnType<typeof collectingViewer>} viewer
 */
function macrosFor(session, viewer) {
  return new Macros({
    dispatch: (message) => session.handleClientMessage(viewer, message),
    persist() {},
    keymap: /** @type {any} */ ({}),
  });
}

test("a macro types into the field the host's answer brought", async (t) => {
  const host = await startHost([
    {
      ...screen("MENU", [{ row: 2, col: 12, length: 20 }], { row: 2, col: 12 }),
      action: "Enter",
    },
    {
      ...screen(
        "LIST",
        [
          { row: 3, col: 12, length: 20 },
          { row: 9, col: 22, length: 30, text: "OLD.NAME" },
        ],
        { row: 3, col: 12 },
      ),
      final: true,
    },
  ]);
  t.after(() => host.close());
  const { session, viewer } = await startSession(host);
  t.after(() => session.close());

  await playRecording(session, viewer, {
    name: "macro",
    recordedAt: "2026-10-04T00:00:00.000Z",
    steps: [
      {
        screen: [],
        cursor: { row: 0, col: 0 },
        action: "PasteString",
        args: ["1.3.4"],
      },
      { screen: [], cursor: { row: 0, col: 0 }, action: "Enter" },
      { screen: [], cursor: { row: 0, col: 0 }, action: "Newline" },
      {
        screen: [],
        cursor: { row: 0, col: 0 },
        action: "PasteString",
        args: ["Test"],
      },
      { screen: [], cursor: { row: 0, col: 0 }, action: "EraseEOF" },
    ],
  });

  assert.equal(session.screen.rowText(9).slice(18, 34), "==> Test        ");
  assert.equal(snapshot(session).cursor, "9:26");
});

const FUZZ_ACTIONS = [
  "Tab",
  "BackTab",
  "Home",
  "End",
  "FieldEnd",
  "FieldStart",
  "Up",
  "Down",
  "Left",
  "Right",
  "PreviousWord",
  "NextWord",
  "Newline",
  "BackNewline",
  "Backspace",
  "Delete",
  "DeleteField",
  "DeleteWord",
  "EraseEOF",
  "EraseInput",
  "ToggleInsert",
  "Dup",
  "FieldMark",
  "CursorSelect",
  "Reset",
];
const FUZZ_CHARS = "abcXYZ019 .-/";

/**
 * What a person might send: mostly typing and moving about, now and then a
 * paste, a click, or an AID key the host answers.
 *
 * @param {import('../3270/test/rng.js').Rng} r
 * @param {number} count
 * @returns {import('../server/protocol.js').ClientMessage[]}
 */
function fuzzInputs(r, count) {
  const word = () =>
    Array.from({ length: 1 + r.int(6) }, () => r.pick([...FUZZ_CHARS])).join(
      "",
    );
  /** @type {import('../server/protocol.js').ClientMessage[]} */
  const inputs = [];
  for (let i = 0; i < count; i++) {
    const roll = r.next();
    if (roll < 0.35)
      inputs.push({ type: "text", value: r.pick([...FUZZ_CHARS]) });
    else if (roll < 0.45)
      inputs.push({
        type: "paste",
        text: Array.from({ length: 1 + r.int(3) }, word).join(
          r.pick(["\n", " ", "\n\n"]),
        ),
      });
    else if (roll < 0.52)
      inputs.push({
        type: "action",
        action: "MoveCursor1",
        args: [String(1 + r.int(24)), String(1 + r.int(80))],
      });
    else if (roll < 0.6)
      inputs.push({
        type: "action",
        action: r.pick(["Enter", "Enter", "Clear"]),
      });
    else if (roll < 0.64)
      inputs.push({
        type: "action",
        action: "PF",
        args: [r.pick(["3", "7", "8"])],
      });
    else
      inputs.push({ type: "action", action: r.pick(FUZZ_ACTIONS), args: [] });
  }
  return inputs;
}

/** Three screens, Enter going deeper and PF3 coming back, as ISPF does. */
function fuzzHostSteps() {
  const menu = screen("MENU", [{ row: 1, col: 14, length: 60 }], {
    row: 1,
    col: 14,
  });
  const list = screen(
    "LIST",
    [
      { row: 1, col: 14, length: 60 },
      { row: 4, col: 24, length: 44, text: "USER.TEST.DATA" },
      { row: 5, col: 24, length: 6 },
      { row: 8, col: 6, length: 1, text: "/" },
      { row: 9, col: 6, length: 1 },
      { row: 23, col: 70, length: 9 },
    ],
    { row: 1, col: 14 },
  );
  const edit = screen(
    "EDIT",
    [
      { row: 1, col: 14, length: 50 },
      { row: 1, col: 72, length: 4, text: "CSR" },
      ...Array.from({ length: 10 }, (_, i) => ({
        row: 4 + i,
        col: 12,
        length: 68,
        text: `LINE ${i + 1} OF THE MEMBER`,
      })),
    ],
    { row: 4, col: 12 },
  );
  return [
    { ...menu, action: "Enter" },
    { ...list, action: "Enter" },
    { ...edit, action: "PF", args: ["3"] },
    { ...list, action: "PF", args: ["3"] },
    { ...menu, action: "Enter" },
    { ...list, final: /** @type {true} */ (true) },
  ];
}

/**
 * Types each input and waits for the screen to settle before the next, as a
 * person at the keyboard does, pressing Reset when the keyboard locks up. The
 * session's recorder and the page's macro recorder both watch.
 *
 * @param {Session} session
 * @param {ReturnType<typeof collectingViewer>} viewer
 * @param {import('../server/protocol.js').ClientMessage[]} inputs
 */
async function recordByHand(session, viewer, inputs) {
  const macros = macrosFor(session, viewer);
  /** @param {import('../server/protocol.js').ClientMessage} message */
  const send = (message) => {
    macros.record(message);
    session.handleClientMessage(viewer, message);
  };
  session.handleClientMessage(viewer, { type: "recorder", action: "start" });
  macros.startRecording();
  for (const input of inputs) {
    send(input);
    await waitUntil(() => idle(session), `${JSON.stringify(input)} to settle`);
    if (keyboardLocked(session.oia.lock)) {
      send({ type: "action", action: "Reset" });
      await waitUntil(() => idle(session), "the Reset to settle");
    }
  }
  session.handleClientMessage(viewer, { type: "recorder", action: "stop" });
  macros.stopRecording();
  const steps = viewer.messages.flatMap((message) =>
    message.type === "recorderStep" ? [message.step] : [],
  );
  return {
    recording: { name: "fuzz", recordedAt: "2026-10-04T00:00:00.000Z", steps },
    macro: { name: "fuzz", steps: macros.pending ?? [] },
  };
}

/**
 * Types the inputs by hand on one connection, then plays back what the
 * recorder and the macro recorder made of them, each on a connection of its
 * own. All three should end on the same screen.
 *
 * @param {RecordingHost} host
 * @param {import('../server/protocol.js').ClientMessage[]} inputs
 */
async function recordAndReplay(host, inputs) {
  const live = await startSession(host);
  const { recording, macro } = await recordByHand(
    live.session,
    live.viewer,
    inputs,
  );
  const typed = snapshot(live.session);
  live.session.close();

  const [replayed, macroPlayed] = await Promise.all([
    (async () => {
      const replay = await startSession(host);
      await playRecording(replay.session, replay.viewer, recording);
      replay.session.close();
      return snapshot(replay.session);
    })(),
    (async () => {
      const played = await startSession(host);
      macrosFor(played.session, played.viewer).play(macro);
      await waitUntil(() => idle(played.session), "the macro to finish");
      played.session.close();
      return snapshot(played.session);
    })(),
  ]);

  return {
    expected: { recording: typed, macro: typed },
    actual: { recording: replayed, macro: macroPlayed },
    recording,
    macro,
  };
}

/**
 * Drops one input at a time while the replay still goes wrong, so a failure
 * reads as the few keys that cause it.
 *
 * @param {RecordingHost} host
 * @param {import('../server/protocol.js').ClientMessage[]} inputs
 */
async function shrink(host, inputs) {
  let smallest = inputs;
  for (let i = smallest.length - 1; i >= 0; i--) {
    const fewer = smallest.filter((_, at) => at !== i);
    const { expected, actual } = await recordAndReplay(host, fewer);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) smallest = fewer;
  }
  return smallest;
}

test("a recording or macro played back ends where typing it by hand did", async (t) => {
  const runs = Number(process.env["MACRO_FUZZ_RUNS"] ?? 25);
  const firstSeed = Number(process.env["MACRO_FUZZ_SEED"] ?? 1);
  t.mock.method(console, "info", () => {});
  const host = await startHost(fuzzHostSteps());
  t.after(() => host.close());

  // Each seed gets its own sessions and connections, so a batch runs at once.
  const seeds = Array.from({ length: runs }, (_, i) => firstSeed + i);
  const batch = availableParallelism();
  const failed = [];
  for (let at = 0; at < seeds.length; at += batch) {
    const outcomes = await Promise.all(
      seeds.slice(at, at + batch).map(async (seed) => {
        const inputs = fuzzInputs(rng(seed), 20);
        const { expected, actual } = await recordAndReplay(host, inputs);
        return {
          seed,
          inputs,
          same: JSON.stringify(expected) === JSON.stringify(actual),
        };
      }),
    );
    failed.push(...outcomes.filter((outcome) => !outcome.same));
  }

  for (const { seed, inputs } of failed) {
    const smallest = await shrink(host, inputs);
    const again = await recordAndReplay(host, smallest);
    assert.deepEqual(
      again.actual,
      again.expected,
      `seed ${seed} (MACRO_FUZZ_SEED=${seed} MACRO_FUZZ_RUNS=1), shrunk to ${JSON.stringify(smallest)}\nrecorded steps: ${JSON.stringify(again.recording.steps.map((step) => [step.action, ...(step.args ?? [])]))}\nmacro steps: ${JSON.stringify(again.macro.steps)}`,
    );
  }
});
