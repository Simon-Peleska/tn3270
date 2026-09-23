// The Operator Information Area: the status line below a 3270 screen. The
// server sends the facts; the layout is the browser's, because the buttons at
// the right end of this row are the browser's too.

/**
 * b3270's `lock` values in operator wording; anything else shows as "X <value>".
 * @type {Readonly<Record<string, string>>}
 */
const LOCK_TEXT = Object.freeze({
  "not-connected": "X Not Connected",
  system: "X SYSTEM",
  wait: "X Wait",
  field: "X Protected",
  protected: "X Protected",
  numeric: "X Numeric",
  overflow: "X Overflow",
  dbcs: "X DBCS",
  minus: "X -f",
  deleted: "X Deleted",
  oerr: "X Operator Error",
  inhibit: "X Inhibit",
  disabled: "X Disabled",
  scrolled: "X Scrolled",
});

/**
 * @typedef {object} OiaState
 * @property {string} connection b3270's own word for it
 * @property {boolean} connected
 * @property {string | null} host
 * @property {string} lock b3270's own word for why the keyboard is locked
 * @property {boolean} insert
 * @property {boolean} typeahead
 */

/**
 * b3270 says `unlocked` for a keyboard that is free, and nothing at all before
 * it has an opinion. Everything else is a reason it is locked.
 *
 * @param {string} lock
 * @returns {boolean}
 */
export function keyboardLocked(lock) {
  return lock !== "" && lock !== "unlocked";
}

/**
 * Connection left, lock middle, cursor position right. The position is 1-based,
 * as a real OIA shows it; the cursor is not.
 *
 * @param {OiaState} state
 * @param {{ row: number, col: number }} cursor 0-based
 * @param {number} width columns this line may use, buttons already deducted
 * @returns {string} exactly `width` characters
 */
export function renderOia(state, cursor, width) {
  if (width <= 0) return "";

  const left = state.connected ? (state.host ?? "connected") : state.connection;
  const lock = keyboardLocked(state.lock)
    ? (LOCK_TEXT[state.lock] ?? `X ${state.lock}`)
    : "";
  const flags = [state.insert ? "Insert" : "", state.typeahead ? "TA" : ""]
    .filter(Boolean)
    .join(" ");
  const position = `${String(cursor.row + 1).padStart(2, "0")}/${String(cursor.col + 1).padStart(3, "0")}`;
  const right = [flags, position].filter(Boolean).join("  ");

  let line = left.slice(0, width);
  const centreStart = Math.max(
    line.length + 2,
    Math.floor((width - lock.length) / 2),
  );
  if (lock && centreStart + lock.length <= width - right.length - 2) {
    line = line.padEnd(centreStart, " ") + lock;
  } else if (lock) {
    line = `${line}  ${lock}`;
  }

  if (right.length + 1 <= width) {
    line =
      line
        .slice(0, width - right.length - 1)
        .padEnd(width - right.length, " ") + right;
  }
  return line.slice(0, width).padEnd(width, " ");
}
