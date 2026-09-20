/**
 * Keyboard → 3270 actions as a table the keymap dialog can edit. Defaults
 * follow IBM PCOMM's 3270 layout, not x3270's Ctrl-letter mnemonics.
 *
 * @typedef {{ code: string, shift: boolean, ctrl: boolean, alt: boolean }} Combo
 * @typedef {{ id: string, label: string }} Command
 * @typedef {Record<string, Combo[]>} Bindings
 */

/** @type {readonly Command[]} */
export const COMMANDS = Object.freeze([
  { id: 'Enter', label: 'Enter (AID)' },
  { id: 'Newline', label: 'Newline' },
  { id: 'BackNewline', label: 'Back newline' },
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

/** @type {ReadonlySet<string>} */
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
 * PCOMM's Dup key, Shift-Insert, goes to Paste here instead.
 * @type {Readonly<Bindings>}
 */
export const DEFAULT_BINDINGS = Object.freeze({
  // Pressing Control itself sets event.ctrlKey, so the binding needs it too.
  Enter: [combo('ControlRight', { ctrl: true })],
  Newline: [combo('Enter')],
  BackNewline: [combo('Enter', { shift: true })],
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
 * AID keys must not auto-repeat: a second one mid-response can leave the host locked.
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
 * @returns {string}
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
 * A saved keymap is the whole map, not a diff, so commands added to the app
 * later need filling in. An empty combo list is a deliberate unbinding.
 *
 * @param {Bindings} saved
 * @returns {Bindings}
 */
export function withDefaults(saved) {
  const taken = new Set(Object.values(saved).flat().map(serializeCombo));
  /** @type {Bindings} */
  const filled = { ...saved };
  for (const [commandId, combos] of Object.entries(DEFAULT_BINDINGS)) {
    if (commandId in saved) continue;
    filled[commandId] = combos.filter((value) => !taken.has(serializeCombo(value)));
  }
  return filled;
}

/**
 * @param {Bindings} bindings
 * @returns {Map<string, string>}
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
 * @returns {{ action: string, args: string[] }} never called for a CLIENT_COMMANDS id
 */
function commandToAction(commandId) {
  const pf = /^PF(\d+)$/.exec(commandId);
  if (pf) return { action: 'PF', args: [pf[1] ?? '1'] };
  const pa = /^PA(\d+)$/.exec(commandId);
  if (pa) return { action: 'PA', args: [pa[1] ?? '1'] };
  return { action: commandId, args: [] };
}

/**
 * @param {KeyboardEvent} event
 * @param {Map<string, string>} lookup
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

  // Unclaimed Ctrl/Alt combos belong to the browser.
  if (event.ctrlKey || event.altKey) return null;

  // One character is text; longer is a named key nothing binds.
  if ([...event.key].length === 1) return { kind: 'text', value: event.key };

  return null;
}
