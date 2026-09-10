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
