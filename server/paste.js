/**
 * Splits pasted text into runs to type, jumping protected stretches. A run
 * matching the text lined up against it is consumed instead of skipped when
 * skipping would overflow, or when the pasted line ends inside it. A newline
 * moves one row down, to the column the paste started at.
 *
 * @param {{ ch: string, editable: boolean }[]} cells row-major, length rows*cols
 * @param {boolean} fieldsFormatted false types straight through
 * @param {number} cols
 * @param {{ row: number, col: number }} cursor 0-based, where the paste starts
 * @param {string} text
 * @returns {{ row: number, col: number, text: string }[]} a cursor move and
 *   literal text per segment, in order
 */
export function pasteSegments(cells, fieldsFormatted, cols, cursor, text) {
  const total = cells.length;
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');
  const startCol = cursor.col;
  /** @param {number} pos */
  const isEditable = (pos) => !fieldsFormatted || (cells[pos]?.editable ?? false);

  // Editable cells remaining from each position, so a matching run can tell
  // whether skipping it would leave the rest of the paste nowhere to go.
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

    // The line ran out inside the run, so skipping would drop its tail into a
    // field it was never meant for.
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
