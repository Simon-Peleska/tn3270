/**
 * Several host sessions in one tab, switched tmux-style with Ctrl-B and a digit
 * and laid out side by side with Ctrl-B and a shifted digit. Each is a b3270 of
 * its own — b3270 *is* one terminal, with nothing to multiplex — so the tab
 * keeps up to MAX_SESSIONS attached and decides which are on screen.
 *
 * The parts with no browser in them live here, so a test can drive them exactly
 * as a keyboard does.
 */

export const MAX_SESSIONS = 4;

/** Ctrl-<this> arms the switcher. Free on a 3270 keyboard; see keymap.js. */
const PREFIX_KEY = 'b';

/**
 * Ctrl on the way to the digit is a keydown of its own; cancelling because the
 * operator reached for it would be absurd.
 * @type {ReadonlySet<string>}
 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

/**
 * Which digit key was pressed, whatever it prints: Shift-2 is `"` on a German
 * keyboard and `@` on a US one, so only `code` names what the operator means.
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
   * What a keystroke means to the switcher. The caller does the work, so this
   * stays a small state machine rather than half the application.
   *
   * @param {KeyboardEvent} event
   * @param {readonly string[]} [hintLetters] the letters Ctrl-B's field hints
   *   currently offer, empty when hint mode is off or none are showing yet —
   *   letters and digits never collide, so this rides the same prefix.
   * @returns {{ action: 'ignore' | 'arm' | 'cancel' } | { action: 'switch', index: number }
   *   | { action: 'layout', panes: number } | { action: 'hint', letter: string }}
   */
  handleKey(event, hintLetters = []) {
    if (this.armed) {
      if (MODIFIER_KEYS.has(event.key)) return { action: 'ignore' };
      this.armed = false;
      const digit = digitOf(event);
      if (digit >= 1 && digit <= MAX_SESSIONS) {
        // Shift makes the digit a count of panes, not a session to type at.
        if (event.shiftKey) return { action: 'layout', panes: digit };
        return { action: 'switch', index: digit - 1 };
      }
      if (hintLetters.includes(event.key)) return { action: 'hint', letter: event.key };
      // Aimed at the switcher and missed; swallowed, so a slip of the hand
      // cannot type into a host.
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
 * The tab's sessions travel in the URL fragment, in slot order: `#id1,,id3`. An
 * unopened slot is an empty entry rather than a missing one, so a digit keeps
 * pointing at the same session; sharing the address shares them all.
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
 * The bar shown while the switcher is armed: what is on screen, what else is
 * running, and which digits are free.
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
 * Where each pane sits in a fixed 2x2 grid: one fills it, two split it down the
 * middle, three give the first the left half and stack the rest on the right,
 * four make quarters. Always 2x2, so a layout change is new areas on the panes
 * already there and the browser never rebuilds the boxes the terminals sit in.
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
