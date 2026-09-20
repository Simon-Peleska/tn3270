/**
 * Keymap export/import: `KEY=action` lines with Host On-Demand's `S-`/`C-`/`A-`
 * modifier prefixes, but this app's own action words on the right of `=`.
 *
 * @typedef {import('./keymap.js').Bindings} Bindings
 * @typedef {import('./keymap.js').Combo} Combo
 */

import { COMMANDS } from './keymap.js';
import { actionToKeyword, keywordToAction } from './macro-xml.js';

/** @type {Readonly<Record<string, string>>} */
const CODE_TO_KEY_NAME = Object.freeze({
  ...Object.fromEntries(Array.from({ length: 26 }, (_, index) => [`Key${String.fromCharCode(65 + index)}`, String.fromCharCode(65 + index)])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Digit${index}`, String(index)])),
  Escape: 'Esc', CapsLock: 'CapsLock', Pause: 'Pause', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  ControlLeft: 'LCtrl', ControlRight: 'RCtrl', ShiftLeft: 'LShift', ShiftRight: 'RShift', AltLeft: 'LAlt', AltRight: 'RAlt',
});

/** @type {Readonly<Record<string, string>>} */
const KEY_NAME_TO_CODE = Object.freeze(
  Object.fromEntries(Object.entries(CODE_TO_KEY_NAME).map(([code, name]) => [name, code])),
);

/**
 * @param {string} code a KeyboardEvent.code
 * @returns {string}
 */
function codeToKeyName(code) {
  return CODE_TO_KEY_NAME[code] ?? code;
}

/**
 * @param {string} name
 * @returns {string} a KeyboardEvent.code
 */
function keyNameToCode(name) {
  return KEY_NAME_TO_CODE[name] ?? name;
}

/**
 * @param {Combo} combo
 * @returns {string} e.g. "C-S-F1"
 */
function comboToKey(combo) {
  const mods = `${combo.ctrl ? 'C-' : ''}${combo.shift ? 'S-' : ''}${combo.alt ? 'A-' : ''}`;
  return mods + codeToKeyName(combo.code);
}

/**
 * @param {string} text without the trailing `=...`
 * @returns {Combo}
 */
function keyToCombo(text) {
  let rest = text;
  let ctrl = false;
  let shift = false;
  let alt = false;
  for (;;) {
    if (rest.startsWith('C-')) { ctrl = true; rest = rest.slice(2); } else if (rest.startsWith('S-')) { shift = true; rest = rest.slice(2); } else if (rest.startsWith('A-')) { alt = true; rest = rest.slice(2); } else break;
  }
  return { code: keyNameToCode(rest), shift, ctrl, alt };
}

/**
 * @param {string} commandId
 * @returns {string}
 */
function commandToKeyword(commandId) {
  if (commandId === 'Copy') return 'copy';
  if (commandId === 'Paste') return 'paste';
  const pf = /^PF(\d+)$/.exec(commandId);
  if (pf) return /** @type {string} */ (actionToKeyword('PF', [pf[1] ?? '1']));
  const pa = /^PA(\d+)$/.exec(commandId);
  if (pa) return /** @type {string} */ (actionToKeyword('PA', [pa[1] ?? '1']));
  return actionToKeyword(commandId, []) ?? commandId.toLowerCase();
}

/**
 * @param {string} keyword lowercased
 * @returns {string | null} null when nothing recognises it
 */
function keywordToCommand(keyword) {
  if (keyword === 'copy') return 'Copy';
  if (keyword === 'paste') return 'Paste';
  const mapped = keywordToAction(keyword);
  if (mapped === null) return null;
  if (mapped.action === 'PF') return `PF${mapped.args[0] ?? '1'}`;
  if (mapped.action === 'PA') return `PA${mapped.args[0] ?? '1'}`;
  return mapped.action;
}

/**
 * @param {Bindings} bindings
 * @returns {string}
 */
export function keymapToText(bindings) {
  /** @type {string[]} */
  const lines = [];
  for (const command of COMMANDS) {
    for (const combo of bindings[command.id] ?? []) {
      lines.push(`${comboToKey(combo)}=${commandToKeyword(command.id)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string} text
 * @returns {Bindings} unrecognised lines are skipped, not an error
 */
export function parseKeymapText(text) {
  /** @type {Bindings} */
  const bindings = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep === -1) continue;
    const commandId = keywordToCommand(line.slice(sep + 1).trim().toLowerCase());
    if (commandId === null) continue;
    const combo = keyToCombo(line.slice(0, sep).trim());
    (bindings[commandId] ??= []).push(combo);
  }
  return bindings;
}
