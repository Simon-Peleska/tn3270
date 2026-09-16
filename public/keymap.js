/**
 * Keyboard → 3270 actions.
 *
 * The terminal is a renderer only: we never use ghostty's `onData`, because it
 * would VT-encode the keypress and force us to decode it back, and 3270 keys
 * like PA1, Clear, Attn and Reset have no VT equivalent at all. Mapping the
 * KeyboardEvent directly is both lossless and shorter.
 *
 * The bindings follow IBM Personal Communications' (PCOMM) default 3270
 * keyboard layout, not x3270's Ctrl-letter mnemonics: Esc is Attn, Pause is
 * Clear, Caps Lock is Reset, and Alt reaches the PA keys.
 *
 * @typedef {{ action: string, args?: string[] }} KeyAction
 */

/**
 * Keys that mean the same thing however Shift/Alt fall, once the
 * modifier-specific keys below have had their turn.
 * @type {Readonly<Record<string, KeyAction>>}
 */
const PLAIN_KEYS = Object.freeze({
  // A 3270 keyboard's Enter sits where a PC's right Control is, and the key in
  // the PC's Enter position is the newline key. PCOMM binds them that way and
  // so do we: muscle memory from a real terminal has to keep working.
  Enter: { action: 'Newline' },
  Tab: { action: 'Tab' },
  Backspace: { action: 'Backspace' },
  Delete: { action: 'Delete' },
  ArrowUp: { action: 'Up' },
  ArrowDown: { action: 'Down' },
  ArrowLeft: { action: 'Left' },
  ArrowRight: { action: 'Right' },
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
 * @param {KeyboardEvent} event
 * @param {string} action
 * @param {string[]} [args]
 * @returns {{ kind: 'action', action: string, args: string[] } | null}
 */
function act(event, action, args = []) {
  if (event.repeat && AID_ACTIONS.has(action)) return null;
  return { kind: 'action', action, args };
}

/**
 * Translate a keydown into a 3270 action, or into text to type.
 *
 * @param {KeyboardEvent} event
 * @returns {{ kind: 'action', action: string, args: string[] } | { kind: 'text', value: string } | null}
 */
export function mapKey(event) {
  if (event.metaKey) return null;

  // The right Control key is the 3270's Enter. Holding it down must not fire a
  // stream of AIDs at the host, so a key repeat is dropped.
  if (event.code === 'ControlRight') {
    return event.repeat ? null : { kind: 'action', action: 'Enter', args: [] };
  }

  // PCOMM leaves plain Ctrl unbound; give it back to the browser rather than
  // typing garbage or falling through to a key's unmodified meaning. Ctrl-C
  // and Ctrl-V are copy/paste, handled before mapKey ever sees them.
  if (event.ctrlKey) return null;

  // Caps Lock has no place on a 3270 keyboard, so PCOMM repurposes it as Reset.
  if (event.key === 'CapsLock') return { kind: 'action', action: 'Reset', args: [] };

  if (event.key === 'Escape') {
    return event.shiftKey ? act(event, 'SysReq') : act(event, 'Attn');
  }

  if (event.key === 'Pause') return act(event, 'Clear');

  // F1-F12 are PF1-PF12; with Shift they are PF13-PF24, exactly as on a 3270.
  const functionKey = /^F([1-9]|1[0-2])$/.exec(event.key);
  if (functionKey !== null) {
    const base = Number(functionKey[1]);
    return act(event, 'PF', [String(event.shiftKey ? base + 12 : base)]);
  }

  if (event.key === 'Tab' && event.shiftKey) return { kind: 'action', action: 'BackTab', args: [] };

  // The Insert/Home/End/PageUp cluster carries PCOMM's PA keys on Alt, plus
  // Dup and FieldMark on Shift, alongside each key's own unmodified action.
  // Shift-Insert never actually reaches here: app.js intercepts it first as a
  // clipboard paste, PCOMM's Dup binding below is what is left if that changes.
  if (event.key === 'Insert') {
    if (event.altKey) return act(event, 'PA', ['1']);
    return event.shiftKey
      ? { kind: 'action', action: 'Dup', args: [] }
      : { kind: 'action', action: 'ToggleInsert', args: [] };
  }
  if (event.key === 'Home') {
    if (event.altKey) return act(event, 'PA', ['2']);
    return event.shiftKey
      ? { kind: 'action', action: 'FieldMark', args: [] }
      : { kind: 'action', action: 'Home', args: [] };
  }
  if (event.key === 'End') {
    return event.altKey
      ? { kind: 'action', action: 'EraseInput', args: [] }
      : { kind: 'action', action: 'EraseEOF', args: [] };
  }
  if (event.key === 'PageUp') {
    return event.shiftKey ? act(event, 'PA', ['3']) : null;
  }

  // Every other Alt combination is left to the browser/OS, same as Ctrl above.
  if (event.altKey) return null;

  const plain = PLAIN_KEYS[event.key];
  if (plain) return { kind: 'action', action: plain.action, args: plain.args ?? [] };

  // A single character is text; anything longer is a named key we do not bind.
  if ([...event.key].length === 1) return { kind: 'text', value: event.key };

  return null;
}
