/**
 * Several host sessions in one browser tab, switched tmux-style with Ctrl-B and
 * a digit, and laid out side by side with Ctrl-B and a shifted digit.
 *
 * Each session is a b3270 of its own on the server. b3270 *is* one terminal —
 * one screen, one host connection, one keyboard — and has no notion of a second
 * one, so there is nothing to multiplex: the tab simply keeps up to
 * MAX_SESSIONS of them attached at once and decides which one the terminal on
 * screen is showing.
 *
 * This file holds the parts of that with no browser in them, so they can be
 * driven from a test exactly as a keyboard drives them.
 */

export const MAX_SESSIONS = 4;

/** Ctrl-<this> arms the switcher. Free on a 3270 keyboard; see keymap.js. */
const PREFIX_KEY = 'b';

/**
 * Pressing Ctrl on the way to the digit is a keydown of its own, and cancelling
 * the switcher because the operator reached for Ctrl-2 would be absurd.
 * @type {ReadonlySet<string>}
 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

/**
 * Which digit key was pressed, whatever it prints. Shift-2 is `"` on a German
 * keyboard and `@` on a US one, so the character is no use here — but `code`
 * names the physical key, and that is what the operator means by "2".
 *
 * @param {KeyboardEvent} event
 * @returns {number} 1-9, or 0 when this was not a digit key
 */
function digitOf(event) {
  const code = event.code ?? '';
  if (code.startsWith('Digit')) return Number(code.slice('Digit'.length)) || 0;
  if (event.key.length === 1 && event.key >= '1' && event.key <= '9') return Number(event.key);
  return 0;
}

export class SessionPrefix {
  constructor() {
    /** @type {boolean} Ctrl-B has been seen and the next key picks a session. */
    this.armed = false;
  }

  /**
   * Decide what a keystroke means to the switcher; the caller does the work, so
   * this stays a small state machine rather than half the application.
   *
   * @param {KeyboardEvent} event
   * @returns {{ action: 'ignore' | 'arm' | 'cancel' } | { action: 'switch', index: number }
   *   | { action: 'layout', panes: number }}
   */
  handleKey(event) {
    if (this.armed) {
      if (MODIFIER_KEYS.has(event.key)) return { action: 'ignore' };
      this.armed = false;
      const digit = digitOf(event);
      if (digit >= 1 && digit <= MAX_SESSIONS) {
        // Shift is the layout: the same digit says how many sessions to show at
        // once rather than which one of them to type at.
        if (event.shiftKey) return { action: 'layout', panes: digit };
        return { action: 'switch', index: digit - 1 };
      }
      // Anything else was aimed at the switcher and missed. It is swallowed
      // rather than passed on, so a slip of the hand cannot type into a host.
      return { action: 'cancel' };
    }
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === PREFIX_KEY) {
      this.armed = true;
      return { action: 'arm' };
    }
    return { action: 'ignore' };
  }
}

/**
 * The sessions a tab is holding travel in the URL fragment, in slot order:
 * `#id1,,id3`. A slot nobody has opened is an empty entry rather than a missing
 * one, so the digit the operator types keeps pointing at the same session even
 * when the slot before it was never used — and sharing the address still shares
 * every session, which is the whole sharing mechanism.
 *
 * @param {string} hash with or without its leading `#`
 * @returns {(string | null)[]} exactly MAX_SESSIONS entries
 */
export function parseSessionHash(hash) {
  const parts = hash.replace(/^#/, '').split(',');
  /** @type {(string | null)[]} */
  const ids = [];
  for (let index = 0; index < MAX_SESSIONS; index++) {
    const part = (parts[index] ?? '').trim();
    ids.push(part === '' ? null : part);
  }
  return ids;
}

/**
 * @param {readonly (string | null)[]} ids
 * @returns {string}
 */
export function sessionHash(ids) {
  return ids.slice(0, MAX_SESSIONS).map((id) => id ?? '').join(',').replace(/,+$/, '');
}

/**
 * The bar shown while the switcher is armed: which session is on screen, which
 * others are running, and which digits are still free.
 *
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
  return `Ctrl-B  ${slots.join(' ')}   + opens a session, Shift-1..4 splits the screen`;
}

/**
 * Where each pane sits, as CSS `grid-area` lines into a fixed 2x2 grid: one
 * session fills it, two split it down the middle, three give the first session
 * the whole left half and stack the other two on the right, and four make
 * quarters — 1 and 2 on the left, 3 and 4 on the right.
 *
 * The grid is always 2x2 so a layout change is nothing but new areas on the
 * panes already there, which keeps the browser from rebuilding the boxes the
 * terminals are drawn in.
 *
 * @type {readonly (readonly string[])[]}
 */
const PANE_AREAS = [
  ['1 / 1 / 3 / 3'],
  ['1 / 1 / 3 / 2', '1 / 2 / 3 / 3'],
  ['1 / 1 / 3 / 2', '1 / 2 / 2 / 3', '2 / 2 / 3 / 3'],
  ['1 / 1 / 2 / 2', '2 / 1 / 3 / 2', '1 / 2 / 2 / 3', '2 / 2 / 3 / 3'],
];

/**
 * @param {number} panes how many sessions are on screen at once
 * @returns {readonly string[]} one `grid-area` per pane, in session order
 */
export function paneAreas(panes) {
  return PANE_AREAS[Math.min(Math.max(panes, 1), MAX_SESSIONS) - 1];
}
