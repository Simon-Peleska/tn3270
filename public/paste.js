/**
 * Splits pasted text into runs to type, one per stretch of editable cells:
 * b3270's PasteString drops a character that lands on a protected cell, so no
 * segment may span one.
 *
 * A pasted line is laid out like the screen only when every protected cell it
 * covers already holds the character pasted onto it; then those characters are
 * the screen's own text and are eaten. One mismatch anywhere in the line and
 * none of them are: the text flows across the protected cells instead, its own
 * blanks typed into fields like any other character. A newline moves one row
 * down, to the column the paste started at.
 *
 * @param {{ ch: string | null, editable: boolean }[]} cells row-major, length rows*cols
 * @param {boolean} fieldsFormatted false types straight through
 * @param {number} cols
 * @param {{ row: number, col: number }} cursor 0-based, where the paste starts
 * @param {string} text
 * @returns {{ row: number, col: number, text: string }[]} a cursor move and
 *   literal text per segment, in order
 */
export function pasteSegments(cells, fieldsFormatted, cols, cursor, text) {
  const total = cells.length;
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  const startCol = cursor.col;
  /** @param {number} pos */
  const isEditable = (pos) =>
    !fieldsFormatted || (cells[pos]?.editable ?? false);

  /** @type {{ row: number, col: number, text: string }[]} */
  const segments = [];
  let pos = cursor.row * cols + cursor.col;

  for (const line of normalized.split("\n")) {
    if (pos >= total) break;

    let laidOutLikeTheScreen = true;
    for (let i = 0; i < line.length && pos + i < total; i++) {
      if (!isEditable(pos + i) && cells[pos + i].ch !== line[i]) {
        laidOutLikeTheScreen = false;
        break;
      }
    }

    let chunk = "";
    let i = 0;
    while (i < line.length && pos < total) {
      if (isEditable(pos)) {
        chunk += line[i];
        i++;
        pos++;
        continue;
      }
      if (chunk !== "") {
        const start = pos - chunk.length;
        segments.push({
          row: Math.floor(start / cols),
          col: start % cols,
          text: chunk,
        });
        chunk = "";
      }
      if (laidOutLikeTheScreen) i++;
      pos++;
    }
    if (chunk !== "") {
      const start = pos - chunk.length;
      segments.push({
        row: Math.floor(start / cols),
        col: start % cols,
        text: chunk,
      });
    }

    pos = (Math.floor(pos / cols) + 1) * cols + startCol;
  }
  return segments;
}

/**
 * A paste as it goes to the server: split here, against the screen this page
 * shows, so the server only types what it is given.
 *
 * @param {{ cells: { ch: string | null, editable: boolean }[], cols: number,
 *   fieldsFormatted: boolean, cursor: { row: number, col: number } | null } | null} screen
 *   null when no screen is shown yet
 * @param {string} text
 * @returns {import('../server/protocol.js').PasteMessage}
 */
export function pasteMessage(screen, text) {
  const segments =
    screen === null || screen.cursor === null
      ? []
      : pasteSegments(
          screen.cells,
          screen.fieldsFormatted,
          screen.cols,
          screen.cursor,
          text,
        );
  return { type: "paste", text, segments };
}
