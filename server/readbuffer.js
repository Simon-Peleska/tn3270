const FIELD_ATTRIBUTE = /^SF\(c0=([0-9a-f]{2})/;

/**
 * From `ReadBuffer(Ascii,Field)`: `Contents: SF(c0=cd,41=f4) 68 69 00 00 ...`
 * `c0` is the 3270 field attribute byte and 0x20 its protected bit; an untyped
 * cell reads back null rather than blank.
 *
 * @param {string[]} lines
 * @returns {string | null} trimmed content, or null if the field is protected
 *   or there is none under the cursor
 */
export function editableFieldText(lines) {
  const contents = lines.find((line) => line.startsWith("Contents: "));
  if (contents === undefined) return null;

  const [attributeToken, ...byteTokens] = contents
    .slice("Contents: ".length)
    .split(" ");
  const attribute = FIELD_ATTRIBUTE.exec(attributeToken ?? "");
  if (attribute === null) return null;
  if ((Number.parseInt(attribute[1], 16) & 0x20) !== 0) return null;

  const bytes = byteTokens.map((token) => Number.parseInt(token, 16) || 0x20);
  return Buffer.from(bytes).toString("utf8").trim();
}

/**
 * From a whole-screen `ReadBuffer(Ascii)`, one line per row, one token per cell:
 * `SF(c0=f0) 55 73 65 72 SF(c0=cd,41=f4) 00 00 ...`
 *
 * 0x20 is the protected bit, 0x0c the non-display (password) intensity bits.
 * `SA(...)` tokens take up no column. A field attribute holds until the next
 * one, wrapping past the end of the buffer, and its own cell is never typeable.
 *
 * @param {string[]} lines one per row, as b3270 returned them
 * @param {number} rows
 * @param {number} cols
 * @returns {{ editable: boolean[], hidden: boolean[], formatted: boolean }}
 *   `editable`/`hidden` are row-major, length rows*cols
 */
export function fieldMap(lines, rows, cols) {
  /** @type {Array<number | null>} */
  const attributes = new Array(rows * cols).fill(null);
  /** @type {number | null} */
  let lastAttribute = null;

  for (let row = 0; row < rows; row++) {
    let at = row * cols;
    for (const token of (lines[row] ?? "").split(" ")) {
      if (token === "" || token.startsWith("SA(")) continue;
      if (at >= (row + 1) * cols) break;
      const attribute = FIELD_ATTRIBUTE.exec(token);
      if (attribute !== null) {
        lastAttribute = Number.parseInt(attribute[1], 16);
        attributes[at] = lastAttribute;
      }
      at++;
    }
  }

  // An unformatted screen is all unprotected, but tinting every cell is wrong.
  if (lastAttribute === null) {
    return {
      editable: new Array(rows * cols).fill(false),
      hidden: new Array(rows * cols).fill(false),
      formatted: false,
    };
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
  return { editable, hidden, formatted: true };
}
