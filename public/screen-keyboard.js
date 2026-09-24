/**
 * The on-screen keyboard: the host keys a PC keyboard has no key for, as rows of
 * buttons drawn over the screen. Laid out here and nowhere else, so the keys
 * that are drawn and the keys that are clicked cannot drift apart.
 *
 * @typedef {{ label: string, action: string, args: string[], width: number }} HostKey
 * @typedef {HostKey & { row: number, col: number }} PlacedKey
 */

/** Every key is one or two cells of this many columns, so the rows line up. */
const CELL = 6;
const KEYBOARD_WIDTH = 12 * CELL;

/**
 * @param {string} label
 * @param {string} action
 * @param {string[]} [args]
 * @returns {HostKey}
 */
function hostKey(label, action, args = []) {
  const cells = `[${label}]`.length > CELL ? 2 : 1;
  return { label, action, args, width: cells * CELL };
}

/** @type {readonly (readonly HostKey[])[]} */
export const KEY_ROWS = Object.freeze([
  [
    hostKey("Enter", "Enter"),
    hostKey("Clear", "Clear"),
    hostKey("Reset", "Reset"),
    hostKey("PA1", "PA", ["1"]),
    hostKey("PA2", "PA", ["2"]),
    hostKey("PA3", "PA", ["3"]),
    hostKey("Attn", "Attn"),
    hostKey("SysReq", "SysReq"),
  ],
  [
    hostKey("ErEOF", "EraseEOF"),
    hostKey("ErInput", "EraseInput"),
    hostKey("Ins", "ToggleInsert"),
    hostKey("Dup", "Dup"),
    hostKey("FldMark", "FieldMark"),
    hostKey("Home", "Home"),
    hostKey("BackTab", "BackTab"),
    hostKey("Tab", "Tab"),
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
 * @param {number} cols
 * @param {number} top from `keyboardTop`
 * @returns {PlacedKey[]} centred in the pane
 */
export function placeKeys(cols, top) {
  const left = Math.max(0, Math.floor((cols - KEYBOARD_WIDTH) / 2));
  /** @type {PlacedKey[]} */
  const placed = [];
  KEY_ROWS.forEach((keys, index) => {
    let col = left;
    for (const key of keys) {
      placed.push({ ...key, row: top + index, col });
      col += key.width;
    }
  });
  return placed;
}

/**
 * @param {PlacedKey[]} placed
 * @param {number} row
 * @param {number} col
 * @returns {PlacedKey | null} null off the keyboard
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
 * @returns {string} `[label]`, like the buttons on the status row
 */
export function keyFace(key) {
  return `[${key.label}]`.padEnd(key.width);
}
