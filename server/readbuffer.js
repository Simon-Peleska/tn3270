const FIELD_ATTRIBUTE = /^SF\(c0=([0-9a-f]{2})/;

/**
 * The field under the cursor, from a `ReadBuffer(Ascii,Field)` result: some
 * `key: value` lines, then the content as hex byte pairs behind its attribute
 * byte —  `Contents: SF(c0=cd,41=f4) 20 20 68 65 6c 6c 6f 00 00 ...`
 *
 * `c0` is x3270's tag for the 3270 attribute byte; its 0x20 bit is the
 * protected flag, and an untyped cell reads back null rather than blank.
 *
 * @param {string[]} lines
 * @returns {string | null} the content, blanks trimmed off both ends — or null
 *   if there was no field under the cursor, or it was protected
 */
export function editableFieldText(lines) {
  const contents = lines.find((line) => line.startsWith('Contents: '));
  if (contents === undefined) return null;

  const [attributeToken, ...byteTokens] = contents.slice('Contents: '.length).split(' ');
  const attribute = FIELD_ATTRIBUTE.exec(attributeToken ?? '');
  if (attribute === null) return null;
  if ((Number.parseInt(attribute[1], 16) & 0x20) !== 0) return null;

  const bytes = byteTokens.map((token) => Number.parseInt(token, 16) || 0x20);
  return Buffer.from(bytes).toString('utf8').trim();
}

/**
 * Which cells the operator may type into, and which are non-display (a
 * password field's own attribute never shows what is typed there — 3270
 * intensity bits `11`, mask 0x0c), from a whole-screen `ReadBuffer(Ascii)`:
 * one line per row, one token per cell —
 *   `SF(c0=f0) 55 73 65 72 3a 20 SF(c0=cd,41=f4) 00 00 00 ...`
 *
 * `SA(...)` tokens carry an extended attribute for the cell after them and take
 * up no column; everything else is one cell. A field attribute holds until the
 * next one, wrapping round the end of the buffer — so row 0 starts in whatever
 * the *last* attribute on the screen says. An attribute's own cell is always
 * blank and never typeable.
 *
 * @param {string[]} lines one per row, as b3270 returned them
 * @param {number} rows
 * @param {number} cols
 * @returns {{ editable: boolean[], hidden: boolean[] }} both row-major, length
 *   rows*cols
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
      const attribute = FIELD_ATTRIBUTE.exec(token);
      if (attribute !== null) {
        lastAttribute = Number.parseInt(attribute[1], 16);
        attributes[at] = lastAttribute;
      }
      at++;
    }
  }

  // An unformatted screen is technically all unprotected, but tinting every
  // cell of it would be nonsense.
  if (lastAttribute === null) {
    return { editable: new Array(rows * cols).fill(false), hidden: new Array(rows * cols).fill(false) };
  }

  let isProtected = (lastAttribute & 0x20) !== 0;
  let isHidden = (lastAttribute & 0x0c) === 0x0c;
  /** @type {boolean[]} */
  const editable = new Array(rows * cols);
  /** @type {boolean[]} */
  const hidden = new Array(rows * cols);
  for (let i = 0; i < editable.length; i++) {
    const attribute = attributes[i] ?? null;
    if (attribute !== null) {
      isProtected = (attribute & 0x20) !== 0;
      isHidden = (attribute & 0x0c) === 0x0c;
      editable[i] = false;
      hidden[i] = false;
    } else {
      editable[i] = !isProtected;
      hidden[i] = isHidden;
    }
  }
  return { editable, hidden };
}
