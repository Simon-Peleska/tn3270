/**
 * Keymap export/import: `KEY=action` lines with Host On-Demand's `S-`/`C-`/`A-`
 * modifier prefixes, but this app's own action words on the right of `=`.
 *
 * @typedef {import('./keymap.js').Bindings} Bindings
 * @typedef {import('./keymap.js').Combo} Combo
 */

import { COMMANDS, KEY_LABELS, keyLabel, normalizeKey } from "./keymap.js";
import { actionToKeyword, keywordToAction } from "./macro-xml.js";

/**
 * The file names a key exactly as the Keys panel does, so what a user reads
 * there is what they can type here. Only keys with no character of their own
 * need a name; every other key writes itself, so `C-?=redo` means the key that
 * prints `?` wherever it sits. The inverse is the one direction `keymap.js` has
 * no use for.
 *
 * @type {Readonly<Record<string, string>>}
 */
const KEY_NAME_TO_CODE = Object.freeze({
  Space: " ",
  ...Object.fromEntries(
    Object.entries(KEY_LABELS).map(([code, name]) => [name, code]),
  ),
});

/**
 * @param {string} name
 * @returns {string} a combo's key
 */
function nameToKey(name) {
  const known = KEY_NAME_TO_CODE[name];
  if (known !== undefined) return known;
  // A letter written in either case names the same key.
  return [...name].length === 1 ? normalizeKey(name) : name;
}

/**
 * @param {Combo} combo
 * @returns {string} e.g. "C-S-F1"
 */
function comboToKey(combo) {
  const mods = `${combo.ctrl ? "C-" : ""}${combo.shift ? "S-" : ""}${combo.alt ? "A-" : ""}`;
  return mods + keyLabel(combo.key);
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
    if (rest.startsWith("C-")) {
      ctrl = true;
      rest = rest.slice(2);
    } else if (rest.startsWith("S-")) {
      shift = true;
      rest = rest.slice(2);
    } else if (rest.startsWith("A-")) {
      alt = true;
      rest = rest.slice(2);
    } else break;
  }
  return { key: nameToKey(rest), shift, ctrl, alt };
}

/**
 * Commands the browser answers itself, so `macro-xml.js` has no host action to
 * name them by. The keyword is what a user writes in the file.
 *
 * @type {Readonly<Record<string, string>>}
 */
const OWN_KEYWORDS = Object.freeze({
  Copy: "copy",
  Paste: "paste",
  Undo: "undo",
  Redo: "redo",
  Menu: "menu",
  Settings: "settings",
  Macros: "macros",
  Recorder: "recorder",
  Keys: "keys",
});

/** @type {Readonly<Record<string, string>>} */
const OWN_COMMANDS = Object.freeze(
  Object.fromEntries(
    Object.entries(OWN_KEYWORDS).map(([command, keyword]) => [
      keyword,
      command,
    ]),
  ),
);

/**
 * @param {string} commandId
 * @returns {string}
 */
function commandToKeyword(commandId) {
  const own = OWN_KEYWORDS[commandId];
  if (own !== undefined) return own;
  const pf = /^PF(\d+)$/.exec(commandId);
  if (pf) return /** @type {string} */ (actionToKeyword("PF", [pf[1] ?? "1"]));
  const pa = /^PA(\d+)$/.exec(commandId);
  if (pa) return /** @type {string} */ (actionToKeyword("PA", [pa[1] ?? "1"]));
  return actionToKeyword(commandId, []) ?? commandId.toLowerCase();
}

/**
 * @param {string} keyword lowercased
 * @returns {string | null} null when nothing recognises it
 */
function keywordToCommand(keyword) {
  const own = OWN_COMMANDS[keyword];
  if (own !== undefined) return own;
  const mapped = keywordToAction(keyword);
  if (mapped === null) return null;
  if (mapped.action === "PF") return `PF${mapped.args[0] ?? "1"}`;
  if (mapped.action === "PA") return `PA${mapped.args[0] ?? "1"}`;
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
  return `${lines.join("\n")}\n`;
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
    if (line === "" || line.startsWith("#")) continue;
    // The last one, so the `=` key can be bound: `C-==undo`.
    const sep = line.lastIndexOf("=");
    if (sep === -1) continue;
    const commandId = keywordToCommand(
      line
        .slice(sep + 1)
        .trim()
        .toLowerCase(),
    );
    if (commandId === null) continue;
    const combo = keyToCombo(line.slice(0, sep).trim());
    (bindings[commandId] ??= []).push(combo);
  }
  return bindings;
}
