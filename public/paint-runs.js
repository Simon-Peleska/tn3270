/**
 * @param {readonly { ch: string | null, fg: string | null, bg: string | null, gr: string | null, editable: boolean }[]} cells
 * @param {number} row
 * @param {number} cols
 * @returns {import('../server/protocol.js').PaintRow}
 */
export function paintRow(cells, row, cols) {
  /** @type {import('../server/protocol.js').PaintRun[]} */
  const runs = [];
  /** @type {import('../server/protocol.js').PaintRun | null} */
  let run = null;
  let last = cells[row * cols];

  for (let col = 0; col < cols; col++) {
    const cell = cells[row * cols + col];
    if (cell === undefined) break;
    if (
      run === null ||
      last === undefined ||
      cell.fg !== last.fg ||
      cell.bg !== last.bg ||
      cell.gr !== last.gr ||
      cell.editable !== last.editable
    ) {
      run = { col, text: "" };
      if (cell.fg !== null) run.fg = cell.fg;
      if (cell.bg !== null) run.bg = cell.bg;
      if (cell.gr !== null) run.gr = cell.gr;
      if (cell.editable) run.editable = true;
      runs.push(run);
    }
    run.text += cell.ch || " ";
    last = cell;
  }

  return { row, runs };
}
