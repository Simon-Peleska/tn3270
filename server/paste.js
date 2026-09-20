/**
 * Splits pasted text into the runs to type onto the screen, honouring field
 * protection: a protected run is jumped over rather than typed into. The
 * exception is a run that already reads exactly what the pasted text has
 * lined up against it — that stretch is left alone but still consumed from
 * the input, as if it had been typed. A short incidental match (a single
 * digit that happens to coincide) is far more likely a coincidence than an
 * intentional literal, and skipping it costs nothing when there is room to
 * spare — so a run the pasted text covers end to end is left untouched and
 * not consumed unless the input would otherwise overflow the screen. A match
 * the pasted line ends inside is always consumed, because there skipping is
 * not free: the text would land in the next field down, which is a different
 * field than the one it was copied from.
 *
 * A newline in the text jumps to the column the paste started at, one row
 * down; running off the end of a line without one just keeps going into
 * whatever comes next, the same as typing would. Leading and trailing
 * newlines are dropped first, since they carry no field to jump to.
 *
 * @param {{ ch: string, editable: boolean }[]} cells row-major, length rows*cols
 * @param {boolean} fieldsFormatted whether the screen has any fields at all —
 *   an unformatted one has nothing to skip, so the text is typed straight through
 * @param {number} cols
 * @param {{ row: number, col: number }} cursor where the paste starts, 0-based
 * @param {string} text the raw pasted text
 * @returns {{ row: number, col: number, text: string }[]} segments to type in
 *   order, each one a cursor move followed by the literal text to place there
 */
export function pasteSegments(cells, fieldsFormatted, cols, cursor, text) {
  const total = cells.length;
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');
  const startCol = cursor.col;
  /** @param {number} pos */
  const isEditable = (pos) => !fieldsFormatted || (cells[pos]?.editable ?? false);

  // How many editable cells remain from each position to the end of the
  // screen, so a matching run can tell whether skipping it (rather than
  // consuming it) would leave some of the paste with nowhere left to go.
  const editableSuffixCount = new Array(total + 1).fill(0);
  for (let p = total - 1; p >= 0; p--) editableSuffixCount[p] = editableSuffixCount[p + 1] + (isEditable(p) ? 1 : 0);

  /** @type {{ row: number, col: number, text: string }[]} */
  const segments = [];
  let pos = cursor.row * cols + cursor.col;
  let segmentStart = { row: cursor.row, col: cursor.col };
  let chunk = '';

  for (let i = 0; i < normalized.length && pos < total; ) {
    if (normalized[i] === '\n') {
      if (chunk !== '') segments.push({ ...segmentStart, text: chunk });
      chunk = '';
      const row = Math.floor(pos / cols) + 1;
      pos = row * cols + startCol;
      segmentStart = { row, col: startCol };
      i++;
      continue;
    }

    if (isEditable(pos)) {
      chunk += normalized[i];
      i++;
      pos++;
      continue;
    }

    let runLength = 0;
    while (pos + runLength < total && !isEditable(pos + runLength)) runLength++;
    const newline = normalized.indexOf('\n', i);
    const lineEnd = newline === -1 ? normalized.length : newline;
    const width = Math.min(runLength, lineEnd - i);
    const pasted = normalized.slice(i, i + width);
    const onScreen = cells.slice(pos, pos + width).map((cell) => cell.ch).join('');
    const matches = pasted === onScreen;

    // The line ran out inside the run: whatever matched is the tail of a line
    // that has nowhere else to go, since the only editable cells left on this
    // side of the newline are on a later row. Skipping it would drop the text
    // into a field it was never meant for, so it is always consumed here.
    if (matches && width < runLength) {
      i += width;
      pos += width;
      continue;
    }

    const wouldOverflowIfSkipped = normalized.length - i > editableSuffixCount[pos + runLength];
    if (matches && wouldOverflowIfSkipped) i += runLength;
    pos += runLength;
  }
  if (chunk !== '') segments.push({ ...segmentStart, text: chunk });
  return segments;
}
