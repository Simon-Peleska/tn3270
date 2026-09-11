/**
 * Keyboard → 3270 actions.
 *
 * The terminal is a renderer only: we never use ghostty's `onData`, because it
 * would VT-encode the keypress and force us to decode it back, and 3270 keys
 * like PA1, Clear, Attn and Reset have no VT equivalent at all. Mapping the
 * KeyboardEvent directly is both lossless and shorter.
 */

/**
 * @typedef {{ action: string, args?: string[] }} KeyAction
 */

/**
 * Keys that mean the same thing however the modifiers fall.
 * @type {Readonly<Record<string, KeyAction>>}
 */
const PLAIN_KEYS = Object.freeze({
  // A 3270 keyboard's Enter sits where a PC's right Control is, and the key in
  // the PC's Enter position is the newline key. x3270 binds them that way and
  // so do we: muscle memory from a real terminal has to keep working.
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
  // Not Clear: menu-driven CICS/IMS applications commonly bind Attn to "back
  // to the menu", and that is what operators actually expect Escape to do.
  Escape: { action: 'Attn' },
});

/**
 * Control-key combinations. A 3270 keyboard has keys a PC does not, so the ones
 * that matter get a Ctrl binding.
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
 * Every one of these sends an Attention Identifier, the same as Enter: it
 * unlocks the keyboard and asks the host for a whole new screen. Holding the
 * key down must not fire a stream of them at the host — a real 3270 keyboard
 * physically cannot repeat an AID key, and a host mid-response to the first
 * one (TSO and ISPF especially) can be left keyboard-locked on a blank screen
 * by a second one arriving on top of it.
 * @type {ReadonlySet<string>}
 */
const AID_ACTIONS = new Set(['Enter', 'Clear', 'PF', 'PA', 'Attn', 'SysReq']);

/**
 * Translate a keydown into a 3270 action, or into text to type.
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

  // F1-F12 are PF1-PF12; with Shift they are PF13-PF24, exactly as on a 3270.
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

  // A single character is text; anything longer is a named key we do not bind.
  if ([...event.key].length === 1) return { kind: 'text', value: event.key };

  return null;
}
