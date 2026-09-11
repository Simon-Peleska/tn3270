/**
 * Pull the field under the cursor out of a `ReadBuffer(Ascii,Field)` result.
 *
 * b3270 answers with a handful of `key: value` lines and then the field's
 * content as one line of space-separated hex byte pairs, prefixed with its
 * attribute byte, e.g.:
 *   Start1: 2 8
 *   StartOffset: 87
 *   Cursor1: 2 24
 *   CursorOffset: 103
 *   Contents: SF(c0=cd,41=f4) 20 20 68 65 6c 6c 6f 00 00 ...
 *
 * `c0` is x3270's fixed tag for the 3270 attribute byte itself; its 0x20 bit
 * is the protected flag, and a cell nobody has typed into reads back as a
 * null byte rather than a space.
 *
 * @param {string[]} lines
 * @returns {string | null} the field's content, blanks trimmed off both ends
 *   — or null if there was no field under the cursor, or it was protected
 */
export function editableFieldText(lines) {
  const contents = lines.find((line) => line.startsWith('Contents: '));
  if (contents === undefined) return null;

  const [attributeToken, ...byteTokens] = contents.slice('Contents: '.length).split(' ');
  const attribute = /^SF\(c0=([0-9a-f]{2})/.exec(attributeToken ?? '');
  if (attribute === null) return null;
  if ((Number.parseInt(attribute[1], 16) & 0x20) !== 0) return null;

  const bytes = byteTokens.map((token) => Number.parseInt(token, 16) || 0x20);
  return Buffer.from(bytes).toString('utf8').trim();
}

/**
 * Work out which cells the operator may type into, from a whole-screen
 * `ReadBuffer(Ascii)` result: one line per row, one token per cell, e.g.
 *   SF(c0=f0) 55 73 65 72 3a 20 SF(c0=cd,41=f4) 00 00 00 ...
 *
 * `SA(...)` tokens carry an extended attribute for the cell that follows and
 * take up no column of their own; everything else is one cell. A field
 * attribute holds for every cell after it until the next one, wrapping round
 * the end of the buffer — so the state row 0 starts in is whatever the *last*
 * attribute on the screen says. An attribute's own cell always shows as a
 * blank and can never be typed into.
 *
 * @param {string[]} lines one per row, as b3270 returned them
 * @param {number} rows
 * @param {number} cols
 * @returns {boolean[]} row-major, length rows*cols, true where typing is allowed
 */
export function fieldMap(lines, rows, cols) {
  /** @type {Array<number | null>} */
  const attributes = new Array(rows * cols).fill(null);
  /** @type {number | null} */
  let lastAttribute = null;

  for (let row = 0; row < rows; row++) {
    let at = row * cols;
    for (const token of (lines[row] ?? '').split(' ')) {
      if (token === '' || token.startsWith('SA(')) continue;
      if (at >= (row + 1) * cols) break;
      const attribute = /^SF\(c0=([0-9a-f]{2})/.exec(token);
      if (attribute !== null) {
        lastAttribute = Number.parseInt(attribute[1], 16);
        attributes[at] = lastAttribute;
      }
      at++;
    }
  }

  // An unformatted screen has no fields at all. It is technically all
  // unprotected, but tinting every cell on it would be nonsense, so leave it.
  if (lastAttribute === null) return new Array(rows * cols).fill(false);

  let isProtected = (lastAttribute & 0x20) !== 0;
  /** @type {boolean[]} */
  const editable = new Array(rows * cols);
  for (let i = 0; i < editable.length; i++) {
    const attribute = attributes[i] ?? null;
    if (attribute !== null) {
      isProtected = (attribute & 0x20) !== 0;
      editable[i] = false;
    } else {
      editable[i] = !isProtected;
    }
  }
  return editable;
}
