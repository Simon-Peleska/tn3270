/**
 * The session recorder: screens and keystrokes (password fields redacted),
 * exported as JSON for an s3270 script to replay. The Recorder panel drives it.
 */

/** @typedef {import('../server/protocol.js').RecorderStep} RecorderStep */
/** @typedef {{ name: string, recordedAt: string, steps: RecorderStep[] }} Recording */

/**
 * @typedef {object} RecorderDeps
 * @property {(message: import('../server/protocol.js').ClientMessage) => void} dispatch
 * @property {(filename: string, content: string) => void} exportFile
 * @property {(recordings: Recording[]) => void} persist
 */

export class Recorder {
  /** @param {RecorderDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {boolean} */
    this.active = false;
    /** @type {boolean} */
    this.stopping = false;
    /** @type {{ recordedAt: string, steps: RecorderStep[] } | null} */
    this.current = null;
    /** @type {Recording[]} */
    this.recordings = [];
  }

  /** @param {Recording[]} saved */
  load(saved) {
    this.recordings = saved;
    console.info("recordings loaded", { count: saved.length });
  }

  /** @returns {void} */
  save() {
    console.info("saving recordings", { count: this.recordings.length });
    this.deps.persist(this.recordings);
  }

  /** @returns {void} */
  start() {
    if (this.stopping) return;
    console.info("recorder started");
    this.active = true;
    this.current = { recordedAt: new Date().toISOString(), steps: [] };
    this.deps.dispatch({ type: "recorder", action: "start" });
  }

  /** @returns {void} */
  stop() {
    if (!this.active) return;
    console.info("recorder stopped", { steps: this.current?.steps.length });
    this.active = false;
    this.stopping = true;
    this.deps.dispatch({ type: "recorder", action: "stop" });
    if (this.current !== null) {
      this.recordings.push({
        ...this.current,
        name: `Recording ${this.recordings.length + 1}`,
      });
      this.save();
    }
  }

  /**
   * @param {RecorderStep} step
   * @returns {void}
   */
  record(step) {
    if (this.current === null || (!this.active && !this.stopping)) return;
    this.current.steps.push(step);
  }

  /** @returns {void} */
  stopped() {
    if (this.current !== null) this.save();
    this.stopping = false;
    this.current = null;
  }

  /** @returns {void} */
  exportRecording(recording = this.current) {
    if (recording === null) return;
    const filename = `recording-${recording.recordedAt.replace(/[:.]/g, "-")}.json`;
    console.info("recording exported", { filename });
    this.deps.exportFile(filename, JSON.stringify(recording, null, 2));
  }

  /** @param {string} content @returns {Recording} */
  importRecording(content) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("The file is not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("The file is not a recording");
    const value = /** @type {Record<string, unknown>} */ (parsed);
    if (
      typeof value.name !== "string" ||
      value.name.trim() === "" ||
      typeof value.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(value.recordedAt)) ||
      !Array.isArray(value.steps)
    )
      throw new Error("The recording needs a name, date, and steps");

    for (const step of value.steps) {
      if (step === null || typeof step !== "object" || Array.isArray(step))
        throw new Error("The recording contains an invalid step");
      if (
        !Array.isArray(step.screen) ||
        !step.screen.every(
          (/** @type {unknown} */ line) => typeof line === "string",
        ) ||
        step.cursor === null ||
        typeof step.cursor !== "object" ||
        !Number.isInteger(step.cursor.row) ||
        !Number.isInteger(step.cursor.col) ||
        step.cursor.row < 0 ||
        step.cursor.col < 0 ||
        (step.action !== undefined && typeof step.action !== "string") ||
        (step.args !== undefined &&
          (!Array.isArray(step.args) ||
            !step.args.every(
              (/** @type {unknown} */ arg) => typeof arg === "string",
            ))) ||
        (step.password !== undefined && step.password !== true) ||
        (step.final !== undefined && step.final !== true)
      )
        throw new Error("The recording contains an invalid step");

      const paint = step.paint;
      if (paint === undefined) continue;
      if (
        paint === null ||
        typeof paint !== "object" ||
        paint.type !== "paint" ||
        paint.full !== true ||
        typeof paint.color !== "boolean" ||
        typeof paint.fieldsFormatted !== "boolean" ||
        !Array.isArray(paint.rows) ||
        paint.size === null ||
        typeof paint.size !== "object" ||
        !Number.isInteger(paint.size.rows) ||
        !Number.isInteger(paint.size.cols) ||
        paint.size.rows < 1 ||
        paint.size.cols < 1
      )
        throw new Error("The recording contains an invalid screen paint");
      for (const row of paint.rows) {
        if (
          row === null ||
          typeof row !== "object" ||
          !Number.isInteger(row.row) ||
          !Array.isArray(row.runs)
        )
          throw new Error("The recording contains an invalid screen paint");
        for (const run of row.runs)
          if (
            run === null ||
            typeof run !== "object" ||
            !Number.isInteger(run.col) ||
            typeof run.text !== "string" ||
            (run.fg !== undefined && typeof run.fg !== "string") ||
            (run.bg !== undefined && typeof run.bg !== "string") ||
            (run.gr !== undefined && typeof run.gr !== "string") ||
            (run.editable !== undefined && typeof run.editable !== "boolean")
          )
            throw new Error("The recording contains an invalid screen paint");
      }
    }

    const recording = /** @type {Recording} */ (/** @type {unknown} */ (value));
    const imported = { ...recording };
    let timestamp = Date.parse(recording.recordedAt);
    while (
      this.recordings.some((entry) => entry.recordedAt === imported.recordedAt)
    ) {
      timestamp += 1;
      imported.recordedAt = new Date(timestamp).toISOString();
    }
    this.recordings.push(imported);
    this.save();
    console.info("recording imported", {
      name: imported.name,
      steps: imported.steps.length,
    });
    return imported;
  }
}
