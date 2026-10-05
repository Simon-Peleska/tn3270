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
 * @param {{ ch: string }[]} cells row-major
 * @param {number[]} inputCells where the editable cells are, ascending
 * @param {boolean} fieldsFormatted an unformatted screen has no fields to track
 * @param {number} cols
 * @param {{ row: number, col: number }} cursor
 * @returns {Snapshot | null} null when there is nothing to track
 */
export function editableSnapshot(
  cells,
  inputCells,
  fieldsFormatted,
  cols,
  cursor,
) {
  if (!fieldsFormatted) return null;

  /** @type {{ start: number, text: string }[]} */
  const found = [];
  let previous = -2;
  for (const pos of inputCells) {
    const ch = cells[pos]?.ch ?? " ";
    const open = found[found.length - 1];
    if (open !== undefined && pos === previous + 1) open.text += ch;
    else found.push({ start: pos, text: ch });
    previous = pos;
  }
  const head = found[0];
  const tail = found[found.length - 1];
  if (
    found.length > 1 &&
    head?.start === 0 &&
    tail !== undefined &&
    tail.start + tail.text.length === cells.length
  ) {
    found.shift();
    tail.text += head.text;
  }
  /** @type {Run[]} */
  const runs = found.map(({ start, text }) => ({
    row: Math.floor(start / cols),
    col: start % cols,
    text,
  }));

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
