/**
 * Keyboard → 3270 actions. ghostty's `onData` is never used: it would VT-encode
 * the keypress only for this to decode it back, and PA1, Clear, Attn and Reset
 * have no VT equivalent at all.
 *
 * @typedef {{ action: string, args?: string[] }} KeyAction
 */

/**
 * Keys that mean the same however the modifiers fall.
 * @type {Readonly<Record<string, KeyAction>>}
 */
const PLAIN_KEYS = Object.freeze({
  // A 3270's Enter sits where a PC's right Control is, and the PC's Enter
  // position is its newline key. x3270 binds them this way; muscle memory.
  Enter: { action: 'Newline' },
  Tab: { action: 'Tab' },
  Backspace: { action: 'Backspace' },
  Delete: { action: 'Delete' },
  ArrowUp: { action: 'Up' },
  ArrowDown: { action: 'Down' },
  ArrowLeft: { action: 'Left' },
  ArrowRight: { action: 'Right' },
  Home: { action: 'Home' },
  End: { action: 'End' },
  // Shift+Insert is paste, handled before mapKey ever sees it.
  Insert: { action: 'ToggleInsert' },
  // Not Clear: CICS/IMS menus bind Attn to "back to the menu", which is what
  // an operator expects of Escape.
  Escape: { action: 'Attn' },
});

/**
 * The keys a 3270 keyboard has and a PC does not.
 * @type {Readonly<Record<string, KeyAction>>}
 */
const CTRL_KEYS = Object.freeze({
  r: { action: 'Reset' },
  a: { action: 'Attn' },
  // Not c: Ctrl+C is copy, handled before mapKey ever sees it.
  e: { action: 'EraseEOF' },
  d: { action: 'Dup' },
  f: { action: 'FieldMark' },
  s: { action: 'SysReq' },
  u: { action: 'EraseInput' },
  1: { action: 'PA', args: ['1'] },
  2: { action: 'PA', args: ['2'] },
  3: { action: 'PA', args: ['3'] },
});

/**
 * These send an Attention Identifier: the keyboard unlocks and the host draws a
 * whole new screen. A real 3270 keyboard physically cannot repeat one, and TSO
 * or ISPF mid-response to the first can be left locked on a blank screen by a
 * second, so auto-repeat must not fire them.
 * @type {ReadonlySet<string>}
 */
const AID_ACTIONS = new Set(['Enter', 'Clear', 'PF', 'PA', 'Attn', 'SysReq']);

/**
 * A keydown as a 3270 action, or as text to type.
 *
 * @param {KeyboardEvent} event
 * @returns {{ kind: 'action', action: string, args: string[] } | { kind: 'text', value: string } | null}
 */
export function mapKey(event) {
  if (event.altKey || event.metaKey) return null;

  // The right Control key is the 3270's Enter.
  if (event.code === 'ControlRight') {
    return event.repeat ? null : { kind: 'action', action: 'Enter', args: [] };
  }

  if (event.ctrlKey) {
    const bound = CTRL_KEYS[event.key.toLowerCase()];
    if (!bound) return null;
    if (event.repeat && AID_ACTIONS.has(bound.action)) return null;
    return { kind: 'action', action: bound.action, args: bound.args ?? [] };
  }

  // F1-F12 are PF1-PF12; with Shift, PF13-PF24, exactly as on a 3270.
  const functionKey = /^F([1-9]|1[0-2])$/.exec(event.key);
  if (functionKey !== null) {
    if (event.repeat) return null;
    const base = Number(functionKey[1]);
    return { kind: 'action', action: 'PF', args: [String(event.shiftKey ? base + 12 : base)] };
  }

  if (event.key === 'Tab' && event.shiftKey) return { kind: 'action', action: 'BackTab', args: [] };

  const plain = PLAIN_KEYS[event.key];
  if (plain) {
    if (event.repeat && AID_ACTIONS.has(plain.action)) return null;
    return { kind: 'action', action: plain.action, args: plain.args ?? [] };
  }

  // A single character is text; anything longer is a named key, unbound.
  if ([...event.key].length === 1) return { kind: 'text', value: event.key };

  return null;
}
