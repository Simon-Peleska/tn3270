/**
 * Keyboard → 3270 actions, as a table instead of a chain of `if`s: the keymap
 * dialog needs to list, add and remove bindings, and a table is the only shape
 * that lets it do that without duplicating the translation logic here.
 *
 * The terminal is a renderer only: we never use ghostty's `onData`, because it
 * would VT-encode the keypress and force us to decode it back, and 3270 keys
 * like PA1, Clear, Attn and Reset have no VT equivalent at all. Mapping the
 * KeyboardEvent directly is both lossless and shorter.
 *
 * The defaults below follow IBM Personal Communications' (PCOMM) default 3270
 * keyboard layout, not x3270's Ctrl-letter mnemonics: Esc is Attn, Pause is
 * Clear, Caps Lock is Reset, and Alt reaches the PA keys. Every one of them is
 * just a starting point the keymap dialog can change.
 *
 * @typedef {{ code: string, shift: boolean, ctrl: boolean, alt: boolean }} Combo
 *   a physical key (`KeyboardEvent.code`, so left/right Ctrl and Shift+1 vs the
 *   `!` a French keyboard types there both stay distinct) plus the three
 *   modifiers this app lets a binding use. Meta is never one of them: Cmd/Win
 *   combinations stay the browser's.
 * @typedef {{ id: string, label: string }} Command
 * @typedef {Record<string, Combo[]>} Bindings command id -> its combos, zero or
 *   more; a command with none is bound to nothing, on purpose or otherwise
 */

/**
 * The commands a combo can be bound to. PF and PA are 24 and 3 separate
 * commands, not one parameterised action, because each needs its own combo
 * list. `DeleteField` and `DeleteWord` are actions b3270 accepts (see
 * `server/protocol.js`) that no default keyboard reaches; the dialog lets
 * someone bind them if they want to. `Copy` and `Paste` are not 3270 actions
 * at all — see CLIENT_COMMANDS below — but they are keys someone binds the
 * same way, so they live in the same table.
 *
 * @type {readonly Command[]}
 */
export const COMMANDS = Object.freeze([
  { id: 'Enter', label: 'Enter (AID)' },
  { id: 'Newline', label: 'Newline' },
  { id: 'Tab', label: 'Tab' },
  { id: 'BackTab', label: 'Back tab' },
  { id: 'Backspace', label: 'Backspace' },
  { id: 'Delete', label: 'Delete' },
  { id: 'DeleteField', label: 'Delete field' },
  { id: 'DeleteWord', label: 'Delete word' },
  { id: 'Up', label: 'Cursor up' },
  { id: 'Down', label: 'Cursor down' },
  { id: 'Left', label: 'Cursor left' },
  { id: 'Right', label: 'Cursor right' },
  { id: 'Home', label: 'Home' },
  { id: 'EraseEOF', label: 'Erase EOF' },
  { id: 'EraseInput', label: 'Erase input' },
  { id: 'FieldMark', label: 'Field mark' },
  { id: 'Dup', label: 'Dup' },
  { id: 'ToggleInsert', label: 'Toggle insert' },
  { id: 'Reset', label: 'Reset' },
  { id: 'Attn', label: 'Attn' },
  { id: 'SysReq', label: 'Sys req' },
  { id: 'Clear', label: 'Clear' },
  { id: 'Copy', label: 'Copy' },
  { id: 'Paste', label: 'Paste' },
  ...Array.from({ length: 24 }, (_, index) => ({ id: `PF${index + 1}`, label: `PF${index + 1}` })),
  ...Array.from({ length: 3 }, (_, index) => ({ id: `PA${index + 1}`, label: `PA${index + 1}` })),
]);

/**
 * Commands that are this browser's clipboard, not a 3270 action: `mapKey`
 * hands them back unresolved into a protocol action so the caller can reach
 * `navigator.clipboard` itself, exactly where that code already lived.
 * @type {ReadonlySet<string>}
 */
export const CLIENT_COMMANDS = new Set(['Copy', 'Paste']);

/**
 * @param {string} code
 * @param {{ shift?: boolean, ctrl?: boolean, alt?: boolean }} [modifiers]
 * @returns {Combo}
 */
function combo(code, { shift = false, ctrl = false, alt = false } = {}) {
  return { code, shift, ctrl, alt };
}

/**
 * The out-of-the-box bindings. `Dup`'s real PCOMM key, Shift-Insert, is given
 * to `Paste` instead — pasting there is the behaviour this app has always had,
 * and there is no reason to make `Dup` win it back by default. Someone who
 * wants PCOMM's Dup back can bind it in the dialog, same as any other change.
 *
 * @type {Readonly<Bindings>}
 */
export const DEFAULT_BINDINGS = Object.freeze({
  // Pressing Control itself sets event.ctrlKey, so the binding needs it too.
  Enter: [combo('ControlRight', { ctrl: true })],
  Newline: [combo('Enter')],
  Tab: [combo('Tab')],
  BackTab: [combo('Tab', { shift: true })],
  Backspace: [combo('Backspace')],
  Delete: [combo('Delete')],
  Up: [combo('ArrowUp')],
  Down: [combo('ArrowDown')],
  Left: [combo('ArrowLeft')],
  Right: [combo('ArrowRight')],
  Home: [combo('Home')],
  EraseEOF: [combo('End')],
  EraseInput: [combo('End', { alt: true })],
  FieldMark: [combo('Home', { shift: true })],
  ToggleInsert: [combo('Insert')],
  Reset: [combo('CapsLock')],
  Attn: [combo('Escape')],
  SysReq: [combo('Escape', { shift: true })],
  Clear: [combo('Pause')],
  Copy: [combo('KeyC', { ctrl: true }), combo('Insert', { ctrl: true })],
  Paste: [combo('Insert', { shift: true })],
  PA1: [combo('Insert', { alt: true })],
  PA2: [combo('Home', { alt: true })],
  PA3: [combo('PageUp', { shift: true })],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`PF${index + 1}`, [combo(`F${index + 1}`)]])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`PF${index + 13}`, [combo(`F${index + 1}`, { shift: true })]])),
});

/**
 * These send an Attention Identifier: the keyboard unlocks and the host draws a
 * whole new screen. A real 3270 keyboard physically cannot repeat one, and TSO
 * or ISPF mid-response to the first can be left locked on a blank screen by a
 * second, so auto-repeat must not fire them.
 *
 * @param {string} commandId
 * @returns {boolean}
 */
function isAidCommand(commandId) {
  return commandId === 'Enter' || commandId === 'Clear' || commandId === 'Attn' || commandId === 'SysReq'
    || /^PF\d+$/.test(commandId) || /^PA\d+$/.test(commandId);
}

/**
 * @param {Combo} value
 * @returns {string} a key a Map can use, order-independent in the modifiers
 */
export function serializeCombo(value) {
  return `${value.ctrl ? 'C' : ''}${value.shift ? 'S' : ''}${value.alt ? 'A' : ''}:${value.code}`;
}

/**
 * @param {KeyboardEvent} event
 * @returns {Combo}
 */
export function comboFromEvent(event) {
  return combo(event.code, { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey });
}

/** @type {Readonly<Record<string, string>>} */
const CODE_LABELS = Object.freeze({
  ControlLeft: 'LCtrl', ControlRight: 'RCtrl', ShiftLeft: 'LShift', ShiftRight: 'RShift',
  AltLeft: 'LAlt', AltRight: 'RAlt', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Escape: 'Esc', CapsLock: 'CapsLock', Pause: 'Pause', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space',
});

/**
 * A human-readable name for a `KeyboardEvent.code`. Letters and digits get
 * their printed character (`KeyA` -> `A`); anything named above gets that
 * name; everything else — punctuation codes mostly — is shown as its raw code,
 * which is not pretty but is unambiguous and never needs a table entry.
 *
 * @param {string} code
 * @returns {string}
 */
export function codeLabel(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODE_LABELS[code] ?? code;
}

/**
 * @param {Combo} value
 * @returns {string} e.g. "Ctrl+Shift+F1"
 */
export function comboLabel(value) {
  const mods = [value.ctrl && 'Ctrl', value.shift && 'Shift', value.alt && 'Alt'].filter(Boolean);
  return [...mods, codeLabel(value.code)].join('+');
}

/**
 * @param {Bindings} bindings
 * @returns {Map<string, string>} every combo across every command, keyed for
 *   `mapKey` to look up in one step
 */
export function buildLookup(bindings) {
  /** @type {Map<string, string>} */
  const lookup = new Map();
  for (const [commandId, combos] of Object.entries(bindings)) {
    for (const value of combos) lookup.set(serializeCombo(value), commandId);
  }
  return lookup;
}

/**
 * @param {string} commandId
 * @returns {{ action: string, args: string[] }} the 3270 protocol action a
 *   command sends; never called for a CLIENT_COMMANDS id
 */
function commandToAction(commandId) {
  const pf = /^PF(\d+)$/.exec(commandId);
  if (pf) return { action: 'PF', args: [pf[1] ?? '1'] };
  const pa = /^PA(\d+)$/.exec(commandId);
  if (pa) return { action: 'PA', args: [pa[1] ?? '1'] };
  return { action: commandId, args: [] };
}

/**
 * Translate a keydown into a 3270 action, a client-side command, or text to
 * type — or nothing, when the combination belongs to the browser.
 *
 * @param {KeyboardEvent} event
 * @param {Map<string, string>} lookup from `buildLookup`
 * @returns {{ kind: 'action', action: string, args: string[] }
 *   | { kind: 'client', command: string }
 *   | { kind: 'text', value: string } | null}
 */
export function mapKey(event, lookup) {
  if (event.metaKey) return null;

  const commandId = lookup.get(serializeCombo(comboFromEvent(event)));
  if (commandId !== undefined) {
    if (event.repeat && isAidCommand(commandId)) return null;
    if (CLIENT_COMMANDS.has(commandId)) return { kind: 'client', command: commandId };
    const { action, args } = commandToAction(commandId);
    return { kind: 'action', action, args };
  }

  // Nothing claims this combination: give it back to the browser rather than
  // typing garbage or falling through to the key's unmodified meaning.
  if (event.ctrlKey || event.altKey) return null;

  // A single character is text; anything longer is a named key nothing binds.
  if ([...event.key].length === 1) return { kind: 'text', value: event.key };

  return null;
}
