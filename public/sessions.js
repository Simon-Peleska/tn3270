/**
 * Up to four host sessions in one tab: Ctrl+1-4 puts the keyboard on one, and
 * Ctrl+Shift+1-4 splits the page into that many panes. The browser-free parts
 * live here so tests can drive them.
 */

export const MAX_SESSIONS = 4;

/**
 * `code`, not `key`: Shift-2 prints `"` on a German keyboard and `@` on a US
 * one, so a binding by character could not be the same key everywhere.
 *
 * @param {KeyboardEvent} event
 * @returns {{ action: 'switch', index: number } | { action: 'layout', panes: number } | null}
 */
export function sessionKey(event) {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  const digit = /^Digit([1-9])$/.exec(event.code ?? "");
  const number = Number(digit?.[1] ?? 0);
  if (number < 1 || number > MAX_SESSIONS) return null;
  if (event.shiftKey) return { action: "layout", panes: number };
  return { action: "switch", index: number - 1 };
}

/**
 * Sessions travel in the URL fragment in slot order (`#id1,,id3`); an empty
 * entry keeps later digits pointing at the same session.
 *
 * @param {string} hash with or without its leading `#`
 * @returns {(string | null)[]} exactly MAX_SESSIONS entries
 */
export function parseSessionHash(hash) {
  const parts = hash.replace(/^#/, "").split(",");
  return Array.from(
    { length: MAX_SESSIONS },
    (_, index) => parts[index]?.trim() || null,
  );
}

/**
 * @param {readonly (string | null)[]} ids
 * @returns {string}
 */
export function sessionHash(ids) {
  return ids
    .map((id) => id ?? "")
    .join(",")
    .replace(/,+$/, "");
}

/**
 * Always halves of a 2x2, as fractions of the page.
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} Share
 * @type {readonly (readonly Share[])[]}
 */
const PANE_SHARES = [
  [{ x: 0, y: 0, width: 1, height: 1 }],
  [
    { x: 0, y: 0, width: 0.5, height: 1 },
    { x: 0.5, y: 0, width: 0.5, height: 1 },
  ],
  [
    { x: 0, y: 0, width: 0.5, height: 1 },
    { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  ],
  [
    { x: 0, y: 0, width: 0.5, height: 0.5 },
    { x: 0, y: 0.5, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  ],
];

/**
 * @param {number} panes
 * @returns {readonly Share[]} one share of the page per pane, in session order
 */
export function paneShares(panes) {
  return PANE_SHARES[panes - 1];
}

/**
 * A share of a page, in whole CSS pixels.
 *
 * @param {Share} share
 * @param {{ width: number, height: number }} page
 * @returns {Share}
 */
export function paneBox(share, page) {
  return {
    x: Math.round(share.x * page.width),
    y: Math.round(share.y * page.height),
    width: Math.round(share.width * page.width),
    height: Math.round(share.height * page.height),
  };
}
