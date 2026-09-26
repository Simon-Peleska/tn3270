import { textSteps } from "./macros.js";

export const recordingsLayout = {
  title: "TN3270 Recordings",
  valueCol: 27,

  /** @param {import('./panels.js').Panels} _panel @param {import('./panels.js').PanelView} view */
  render(_panel, view) {
    view.field("command", 2, 1, 1, "");
    view.say(
      2,
      3,
      "P=Play E=Export I=Import R=Rename M=Create Macro D=Delete",
      "turquoise",
    );
  },

  /** @param {import('./panels.js').Panels} panel @param {string} command @returns {boolean} */
  command(panel, command) {
    if (command !== "I") return false;
    panel.deps.importRecording();
    return true;
  },

  /** @param {import('./panels.js').Panels} panel @returns {import('./panels.js').Item[]} */
  items(panel) {
    const { recorder, macros } = panel.deps;
    return recorder.recordings.map((recording) => ({
      key: recording.recordedAt,
      label: recording.name.slice(0, 23),
      value: `${new Date(recording.recordedAt).toLocaleString("de-DE").padEnd(32)}${recording.steps.length} Steps`,
      p: () => panel.openPlayback(recording),
      e: () => recorder.exportRecording(recording),
      editOn: "r",
      m: () => {
        macros.pending = recording.steps
          .filter((step) => step.action)
          .flatMap((step) =>
            step.action === "String" || step.action === "PasteString"
              ? textSteps(step.args?.[0] ?? "")
              : [
                  {
                    text: "",
                    action: step.action ?? "",
                    args: step.args ?? [],
                  },
                ],
          );
        panel.push(`recording:${recording.recordedAt}`);
      },
      edit: {
        value: recording.name,
        commit: (text) => {
          if (!text.trim())
            return panel.problem("E5036", "A recording needs a name");
          recording.name = text.trim();
          recorder.save();
          return null;
        },
      },
      d: () => {
        recorder.recordings.splice(recorder.recordings.indexOf(recording), 1);
        recorder.save();
      },
    }));
  },
};

/**
 * @param {import('./panels.js').Panels} panel
 * @param {number} rows
 * @param {number} cols
 * @returns {import('./local-host.js').HostScreen}
 */
export function playbackScreen(panel, rows, cols) {
  const playback = panel.playback;
  if (playback === null) return { texts: [], fields: [] };
  const step = playback.recording.steps[playback.index];
  /** @type {import('./local-host.js').Text[]} */
  const texts = [];
  /** @type {import('./local-host.js').Field[]} */
  const fields = [];
  const recordedPaint = step?.paint?.full ? step.paint : null;
  if (recordedPaint !== null) {
    for (const row of recordedPaint.rows)
      for (const run of row.runs)
        texts.push({
          row: row.row,
          col: run.col,
          text: run.text,
          fg: run.fg ?? null,
          bg: run.bg ?? null,
          gr: run.gr ?? null,
          editable: run.editable ?? false,
        });
  } else {
    for (let row = 0; row < rows; row++)
      texts.push({
        row,
        col: 0,
        text: (step?.screen[row] ?? "").slice(0, cols).padEnd(cols),
        fg: "green",
      });
  }

  if (playback.overlay) {
    const count = playback.recording.steps.length;
    const state = playback.paused ? "Stopped" : "Playing";
    const args = step?.args ?? [];
    /** @type {string} */
    let input;
    if (step?.final === true) input = "Final frame";
    else if (step?.password === true) input = "Secret";
    else if (step?.action === "String")
      input = `Keys: ${JSON.stringify(args[0] ?? "")}`;
    else if (step?.action === "PasteString")
      input = `Paste: ${JSON.stringify(args[0] ?? "")}`;
    else if (step?.action === "MoveCursor1")
      input = `CursorMove X=${args[1] ?? "?"} Y=${args[0] ?? "?"}`;
    else if (step?.action) input = `${step.action}${args.join("")}`;
    else input = "No input";
    const infoTop =
      step?.cursor.row !== undefined && step.cursor.row >= rows - 5
        ? 0
        : Math.max(0, rows - 5);
    const lines = [
      `${playback.recording.name}  ${state}  ${playback.speed.toFixed(2)} steps/s  Step ${count === 0 ? 0 : playback.index + 1}/${count}`,
      input,
      `F2=Hide F3=Exit F7=Faster F8=Slower F9=${playback.direction === 1 ? "Reverse" : "Forward"} Enter=Pause/Play`,
      "Go to step: [       ] F10=Back F11=Next",
      panel.message,
    ];
    for (let row = 0; row < Math.min(lines.length, rows); row++)
      texts.push({
        row: infoTop + row,
        col: 0,
        text: lines[row].slice(0, cols).padEnd(cols),
        fg: "turquoise",
        gr: "highlight",
      });
    if (count > 0 && infoTop + 3 < rows && cols > 20)
      fields.push({
        name: "jump",
        row: infoTop + 3,
        col: 13,
        width: Math.min(7, cols - 13),
        value: playback.jumpDraft ?? String(playback.index + 1),
      });
  }
  return {
    texts,
    fields,
    cursor: "jump",
    color: recordedPaint?.color ?? true,
    fieldsFormatted: recordedPaint?.fieldsFormatted ?? true,
    defaultFg: recordedPaint?.defaultFg,
    defaultBg: recordedPaint?.defaultBg,
  };
}

export const createMacroLayout = {
  title: "TN3270 Create Macro",

  /** @param {import('./panels.js').Panels} panel @returns {import('./panels.js').Item[]} */
  items(panel) {
    const { macros } = panel.deps;
    return [
      {
        key: "name",
        label: "Macro name",
        edit: {
          value: macros.suggestedName(),
          open: true,
          commit: (text) => {
            macros.save(text.trim() || macros.suggestedName());
            panel.back();
            return null;
          },
        },
      },
    ];
  },
};

const PLAYBACK_SPEEDS = [
  0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 30,
];

/** @param {import('./panels.js').Panels} panel */
export function schedulePlayback(panel) {
  const playback = panel.playback;
  if (playback === null) return;
  if (playback.timer !== null) clearTimeout(playback.timer);
  playback.timer = null;
  if (playback.paused) return;
  playback.timer = setTimeout(() => {
    if (panel.playback !== playback) return;
    playback.timer = null;
    const next = playback.index + playback.direction;
    if (next < 0 || next >= playback.recording.steps.length) {
      playback.paused = true;
      panel.deps.redraw();
      return;
    }
    playback.index = next;
    if (
      playback.index === 0 ||
      playback.index === playback.recording.steps.length - 1
    )
      playback.paused = true;
    console.info("recording playback step", {
      name: playback.recording.name,
      step: playback.index + 1,
    });
    panel.deps.redraw();
    panel.schedulePlayback();
  }, 1000 / playback.speed);
}

/** @param {import('./panels.js').Panels} panel @param {string} key @returns {boolean} whether this key belongs to playback */
export function playbackKey(panel, key) {
  const playback = panel.playback;
  if (!panel.isRecordingPlayback() || playback === null) return false;
  if (
    ![
      "F2",
      "F3",
      "F7",
      "F8",
      "F9",
      "F10",
      "F11",
      "HostEnter",
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
    ].includes(key) &&
    !/^[0-9]$/.test(key)
  )
    return false;
  panel.message = "";
  if (key === "F3") {
    panel.back();
    return true;
  }
  if (key === "F2") {
    playback.overlay = !playback.overlay;
    playback.jumpDraft = null;
    playback.jumpCaret = 0;
    panel.host.restart();
  } else if (key === "F7" || key === "F8") {
    const at = PLAYBACK_SPEEDS.indexOf(playback.speed);
    const next = Math.max(
      0,
      Math.min(PLAYBACK_SPEEDS.length - 1, at + (key === "F7" ? 1 : -1)),
    );
    playback.speed = PLAYBACK_SPEEDS[next] ?? playback.speed;
    panel.schedulePlayback();
  } else if (key === "F9") {
    playback.direction = playback.direction === 1 ? -1 : 1;
    if (
      playback.recording.steps.length > 0 &&
      playback.direction === -1 &&
      playback.index === 0
    )
      playback.index = playback.recording.steps.length - 1;
    else if (
      playback.recording.steps.length > 0 &&
      playback.direction === 1 &&
      playback.index === playback.recording.steps.length - 1
    )
      playback.index = 0;
    panel.schedulePlayback();
  } else if (key === "F10" || key === "F11") {
    const change = key === "F10" ? -1 : 1;
    playback.index = Math.max(
      0,
      Math.min(playback.recording.steps.length - 1, playback.index + change),
    );
    if (
      playback.index ===
      (playback.direction === 1 ? playback.recording.steps.length - 1 : 0)
    )
      playback.paused = true;
    playback.jumpDraft = null;
    playback.jumpCaret = 0;
    panel.schedulePlayback();
  } else if (key === "HostEnter") {
    if (playback.recording.steps.length === 0) {
      playback.overlay = true;
      panel.message = panel.problem("E5027", "Recording has no steps");
      panel.deps.redraw();
      return true;
    }
    if (playback.overlay && playback.jumpDraft !== null) {
      const step = Number(playback.jumpDraft);
      if (
        !Number.isInteger(step) ||
        step < 1 ||
        step > playback.recording.steps.length
      ) {
        panel.message = panel.problem("E5026", "Enter a valid step number");
      } else {
        playback.index = step - 1;
        playback.jumpDraft = null;
        playback.jumpCaret = 0;
        if (
          playback.index ===
          (playback.direction === 1 ? playback.recording.steps.length - 1 : 0)
        )
          playback.paused = true;
        panel.schedulePlayback();
      }
    } else {
      if (playback.paused) {
        if (
          playback.direction === 1 &&
          playback.index >= playback.recording.steps.length - 1
        )
          playback.index = 0;
        if (playback.direction === -1 && playback.index === 0)
          playback.index = playback.recording.steps.length - 1;
      }
      playback.paused = !playback.paused;
      panel.schedulePlayback();
    }
  } else if (playback.overlay && /^[0-9]$/.test(key)) {
    const draft = playback.jumpDraft ?? "";
    if (draft.length < 6) {
      playback.jumpDraft =
        draft.slice(0, playback.jumpCaret) +
        key +
        draft.slice(playback.jumpCaret);
      playback.jumpCaret += 1;
    }
  } else if (
    playback.overlay &&
    ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
      key,
    )
  ) {
    if (playback.jumpDraft === null) {
      playback.jumpDraft = String(playback.index + 1);
      playback.jumpCaret = playback.jumpDraft.length;
    }
    const draft = playback.jumpDraft;
    const caret = playback.jumpCaret;
    if (key === "Backspace" && caret > 0) {
      playback.jumpDraft = draft.slice(0, caret - 1) + draft.slice(caret);
      playback.jumpCaret -= 1;
    } else if (key === "Delete") {
      playback.jumpDraft = draft.slice(0, caret) + draft.slice(caret + 1);
    } else if (key === "ArrowLeft") {
      playback.jumpCaret = Math.max(0, caret - 1);
    } else if (key === "ArrowRight") {
      playback.jumpCaret = Math.min(draft.length, caret + 1);
    } else if (key === "Home") playback.jumpCaret = 0;
    else if (key === "End") playback.jumpCaret = draft.length;
  } else return false;
  panel.deps.redraw();
  return true;
}

/** @param {import('./panels.js').Panels} panel @param {number} row @param {number} col */
export function playbackClick(panel, row, col) {
  const playback = panel.playback;
  if (!panel.isRecordingPlayback() || playback === null || !playback.overlay)
    return;
  const jump = panel.host
    .layout()
    .fields.find((field) => field.name === "jump");
  if (
    jump === undefined ||
    row !== jump.row ||
    col < jump.col ||
    col >= jump.col + jump.width
  )
    return;
  if (playback.jumpDraft === null)
    playback.jumpDraft = String(playback.index + 1);
  playback.jumpCaret = Math.min(col - jump.col, playback.jumpDraft.length);
  panel.deps.redraw();
}
