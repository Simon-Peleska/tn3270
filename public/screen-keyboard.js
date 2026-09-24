/**
 * The on-screen keyboard: the host keys a PC keyboard has no key for, as rows of
 * buttons drawn over the screen. Laid out here and nowhere else, so the keys
 * that are drawn and the keys that are clicked cannot drift apart.
 *
 * @typedef {{ label: string, action: string, args: string[] }} HostKey
 * @typedef {HostKey & { row: number, col: number, width: number }} PlacedKey
 */

/**
 * @param {string} label
 * @param {string} action
 * @param {string[]} [args]
 * @returns {HostKey}
 */
function hostKey(label, action, args = []) {
  return { label, action, args };
}

/** @type {readonly (readonly HostKey[])[]} */
export const KEY_ROWS = Object.freeze([
  [
    hostKey("Enter", "Enter"),
    hostKey("Clear", "Clear"),
    hostKey("PA1", "PA", ["1"]),
    hostKey("PA2", "PA", ["2"]),
    hostKey("PA3", "PA", ["3"]),
    hostKey("Attn", "Attn"),
    hostKey("SysReq", "SysReq"),
  ],
  [
    hostKey("Reset", "Reset"),
    hostKey("ErEOF", "EraseEOF"),
    hostKey("ErInput", "EraseInput"),
    hostKey("Insert", "ToggleInsert"),
    hostKey("Dup", "Dup"),
    hostKey("FldMark", "FieldMark"),
    hostKey("Home", "Home"),
    hostKey("BackTab", "BackTab"),
    hostKey("Tab", "Tab"),
    hostKey("NewLine", "Newline"),
  ],
  Array.from({ length: 12 }, (_, index) =>
    hostKey(`PF${index + 1}`, "PF", [String(index + 1)]),
  ),
  Array.from({ length: 12 }, (_, index) =>
    hostKey(`PF${index + 13}`, "PF", [String(index + 13)]),
  ),
]);

/**
 * The keyboard sits on the bottom rows of the screen, and moves to the top when
 * the cursor is under it, so what is being typed stays in view.
 *
 * @param {number} rows the host screen's rows
 * @param {number} cursorRow
 * @returns {number} the first screen row the keyboard covers
 */
export function keyboardTop(rows, cursorRow) {
  const bottom = rows - KEY_ROWS.length;
  return cursorRow >= bottom ? 0 : bottom;
}

/**
 * Each row shares the whole width out, one blank between two keys; the columns
 * that do not divide evenly go one each to some of the keys.
 *
 * @param {number} cols
 * @param {number} top from `keyboardTop`
 * @returns {PlacedKey[]}
 */
export function placeKeys(cols, top) {
  /** @type {PlacedKey[]} */
  const placed = [];
  KEY_ROWS.forEach((keys, index) => {
    const edge = (/** @type {number} */ position) =>
      Math.floor((position * (cols + 1)) / keys.length);
    keys.forEach((key, position) => {
      const col = edge(position);
      placed.push({
        ...key,
        row: top + index,
        col,
        width: edge(position + 1) - col - 1,
      });
    });
  });
  return placed;
}

/**
 * @param {PlacedKey[]} placed
 * @param {number} row
 * @param {number} col
 * @returns {PlacedKey | null} null on a gap between two keys
 */
export function keyAt(placed, row, col) {
  return (
    placed.find(
      (key) => key.row === row && col >= key.col && col < key.col + key.width,
    ) ?? null
  );
}

/**
 * @param {PlacedKey} key
 * @returns {string} the label centred in the key's width
 */
export function keyFace(key) {
  const label = key.label.slice(0, key.width);
  const left = Math.floor((key.width - label.length) / 2);
  return label.padStart(left + label.length).padEnd(key.width);
}
