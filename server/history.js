/**
 * Undo/redo of what has been typed into the editable fields. A snapshot is the
 * text of every editable run on the screen; putting one back is an erase and a
 * retype of each run that has changed since, so nothing the host drew is ever
 * written over.
 *
 * @typedef {{ row: number, col: number, text: string }} Run
 * @typedef {{ key: string, layout: string, runs: Run[],
 *   cursor: { row: number, col: number } }} Snapshot
 */

/**
 * A 3270 field can wrap past the last cell into the first, so the run there is
 * one run, taken from where it starts.
 *
 * @param {{ ch: string, editable: boolean }[]} cells row-major
 * @param {boolean} fieldsFormatted an unformatted screen has no fields to track
 * @param {number} cols
 * @param {{ row: number, col: number }} cursor
 * @returns {Snapshot | null} null when there is nothing to track
 */
export function editableSnapshot(cells, fieldsFormatted, cols, cursor) {
  if (!fieldsFormatted) return null;

  /** @type {Run[]} */
  const runs = [];
  let start = -1;
  let text = "";
  for (let pos = 0; pos < cells.length; pos++) {
    if (cells[pos]?.editable ?? false) {
      if (start === -1) {
        start = pos;
        text = "";
      }
      text += cells[pos].ch;
      continue;
    }
    if (start !== -1) {
      runs.push({ row: Math.floor(start / cols), col: start % cols, text });
      start = -1;
    }
  }
  if (start !== -1) {
    const head = runs[0];
    if (head !== undefined && head.row === 0 && head.col === 0) {
      runs.shift();
      text += head.text;
    }
    runs.push({ row: Math.floor(start / cols), col: start % cols, text });
  }

  return {
    key: runs.map((run) => `${run.row},${run.col}:${run.text}`).join("\n"),
    layout: runs
      .map((run) => `${run.row},${run.col},${run.text.length}`)
      .join(";"),
    runs,
    cursor: { row: cursor.row, col: cursor.col },
  };
}

/**
 * @param {Snapshot} snapshot
 * @param {{ ch: string, editable: boolean }[]} cells
 * @param {number} cols
 * @returns {Run[]} the runs to erase and retype, in order
 */
export function changedRuns(snapshot, cells, cols) {
  /** @type {Run[]} */
  const changed = [];
  for (const run of snapshot.runs) {
    const start = run.row * cols + run.col;
    /** @type {string | null} */
    let onScreen = "";
    for (let i = 0; i < run.text.length; i++) {
      const cell = cells[(start + i) % cells.length];
      if (cell === undefined || !cell.editable) {
        onScreen = null;
        break;
      }
      onScreen += cell.ch;
    }
    // A null means the field map moved under the snapshot: not ours to put back.
    if (onScreen !== null && onScreen !== run.text) changed.push(run);
  }
  return changed;
}
