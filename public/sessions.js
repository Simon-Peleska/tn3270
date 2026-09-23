/**
 * Several host sessions in one tab, switched tmux-style with Ctrl-B and a
 * digit. The browser-free parts live here so tests can drive them.
 */

export const MAX_SESSIONS = 4;

/** Ctrl-<this> arms the switcher. Free on a 3270 keyboard; see keymap.js. */
const PREFIX_KEY = "b";

/**
 * Reaching for a modifier must not cancel the armed switcher.
 * @type {ReadonlySet<string>}
 */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph"]);

/**
 * `code`, not `key`: Shift-2 prints `"` on a German keyboard and `@` on a US one.
 *
 * @param {KeyboardEvent} event
 * @returns {number} 1-9, or 0 when this was not a digit key
 */
function digitOf(event) {
  const code = event.code ?? "";
  if (code.startsWith("Digit")) return Number(code.slice("Digit".length)) || 0;
  if (event.key.length === 1 && event.key >= "1" && event.key <= "9")
    return Number(event.key);
  return 0;
}

export class SessionPrefix {
  constructor() {
    /** @type {boolean} Ctrl-B has been seen and the next key picks a session. */
    this.armed = false;
  }

  /**
   * @param {KeyboardEvent} event
   * @param {readonly string[]} [hintLetters] letters Ctrl-B's field hints offer
   * @returns {{ action: 'ignore' | 'arm' | 'cancel' } | { action: 'switch', index: number }
   *   | { action: 'layout', panes: number } | { action: 'hint', letter: string }}
   */
  handleKey(event, hintLetters = []) {
    if (this.armed) {
      if (MODIFIER_KEYS.has(event.key)) return { action: "ignore" };
      this.armed = false;
      const digit = digitOf(event);
      if (digit >= 1 && digit <= MAX_SESSIONS) {
        // Shift makes the digit a count of panes, not a session to type at.
        if (event.shiftKey) return { action: "layout", panes: digit };
        return { action: "switch", index: digit - 1 };
      }
      if (hintLetters.includes(event.key))
        return { action: "hint", letter: event.key };
      // Swallowed, so a missed switcher key cannot type into a host.
      return { action: "cancel" };
    }
    if (
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key.toLowerCase() === PREFIX_KEY
    ) {
      this.armed = true;
      return { action: "arm" };
    }
    return { action: "ignore" };
  }
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
  /** @type {(string | null)[]} */
  const ids = [];
  for (let index = 0; index < MAX_SESSIONS; index++) {
    const part = (parts[index] ?? "").trim();
    ids.push(part === "" ? null : part);
  }
  return ids;
}

/**
 * @param {readonly (string | null)[]} ids
 * @returns {string}
 */
export function sessionHash(ids) {
  return ids
    .slice(0, MAX_SESSIONS)
    .map((id) => id ?? "")
    .join(",")
    .replace(/,+$/, "");
}

/**
 * @param {readonly (string | null)[]} ids
 * @param {number} active
 * @returns {string}
 */
export function switcherText(ids, active) {
  /** @type {string[]} */
  const slots = [];
  for (let index = 0; index < MAX_SESSIONS; index++) {
    const number = index + 1;
    if (index === active) slots.push(`[${number}]`);
    else slots.push(ids[index] == null ? ` ${number}+` : ` ${number} `);
  }
  return `Ctrl-B  ${slots.join(" ")}   + opens a session, Shift-1..4 splits the screen`;
}

/**
 * Always halves of a 2x2, as fractions of the page: the renderer draws every
 * pane onto one canvas, so the split is arithmetic rather than CSS.
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
  return PANE_SHARES[Math.min(Math.max(panes, 1), MAX_SESSIONS) - 1];
}
