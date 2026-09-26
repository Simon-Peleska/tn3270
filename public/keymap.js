/**
 * Keyboard → 3270 actions as a table the Keys panel can edit. Defaults
 * follow IBM PCOMM's 3270 layout, not x3270's Ctrl-letter mnemonics.
 *
 * @typedef {{ key: string, shift: boolean, ctrl: boolean, alt: boolean }} Combo
 * @typedef {{ id: string, label: string }} Command
 * @typedef {Record<string, Combo[]>} Bindings
 */

/** @type {readonly Command[]} */
export const COMMANDS = Object.freeze([
  { id: "Enter", label: "Enter (AID)" },
  { id: "Newline", label: "Newline" },
  { id: "BackNewline", label: "Back newline" },
  { id: "Tab", label: "Tab" },
  { id: "BackTab", label: "Back tab" },
  { id: "Backspace", label: "Backspace" },
  { id: "Delete", label: "Delete" },
  { id: "DeleteField", label: "Delete field" },
  { id: "DeleteWord", label: "Delete word" },
  { id: "Up", label: "Cursor up" },
  { id: "Down", label: "Cursor down" },
  { id: "Left", label: "Cursor left" },
  { id: "Right", label: "Cursor right" },
  { id: "Home", label: "Home" },
  { id: "EraseEOF", label: "Erase EOF" },
  { id: "EraseInput", label: "Erase input" },
  { id: "FieldMark", label: "Field mark" },
  { id: "Dup", label: "Dup" },
  { id: "ToggleInsert", label: "Toggle insert" },
  { id: "Reset", label: "Reset" },
  { id: "Attn", label: "Attn" },
  { id: "SysReq", label: "Sys req" },
  { id: "Clear", label: "Clear" },
  { id: "Copy", label: "Copy" },
  { id: "Paste", label: "Paste" },
  { id: "SelectUp", label: "Select up" },
  { id: "SelectDown", label: "Select down" },
  { id: "SelectLeft", label: "Select left" },
  { id: "SelectRight", label: "Select right" },
  { id: "Undo", label: "Undo typing" },
  { id: "Redo", label: "Redo typing" },
  { id: "Menu", label: "Menu panel" },
  { id: "ToggleKeyboard", label: "Toggle keyboard" },
  { id: "OpenChars", label: "Character picker" },
  { id: "ToggleRecording", label: "Record / stop" },
  { id: "AnswerYes", label: "Allow sharing request" },
  { id: "AnswerNo", label: "Deny sharing request" },
  { id: "AskEdit", label: "Ask to edit" },
  { id: "StopSharing", label: "Stop sharing" },
  { id: "StopEditing", label: "Stop editing" },
  { id: "Settings", label: "Settings panel" },
  { id: "Macros", label: "Macros panel" },
  { id: "Recorder", label: "Recorder panel" },
  { id: "Keys", label: "Keys panel" },
  ...Array.from({ length: 24 }, (_, index) => ({
    id: `PF${index + 1}`,
    label: `PF${index + 1}`,
  })),
  ...Array.from({ length: 3 }, (_, index) => ({
    id: `PA${index + 1}`,
    label: `PA${index + 1}`,
  })),
]);

/**
 * Commands this browser answers itself: the clipboard, and the panels, which
 * are drawn over the session rather than sent to the host.
 *
 * @type {ReadonlySet<string>}
 */
export const CLIENT_COMMANDS = new Set([
  "Copy",
  "Paste",
  "SelectUp",
  "SelectDown",
  "SelectLeft",
  "SelectRight",
  "Menu",
  "ToggleKeyboard",
  "OpenChars",
  "ToggleRecording",
  "AnswerYes",
  "AnswerNo",
  "AskEdit",
  "StopSharing",
  "StopEditing",
  "Settings",
  "Macros",
  "Recorder",
  "Keys",
]);

/**
 * A panel command, and the panel it opens.
 * @type {Readonly<Record<string, string>>}
 */
export const PANEL_COMMANDS = Object.freeze({
  Menu: "menu",
  Settings: "settings",
  Macros: "macros",
  Recorder: "recorder",
  Keys: "keymap",
});

/**
 * A macro's key is bound like any other command's, under the macro's name, so
 * one keystroke still means one command.
 *
 * @param {string} name
 * @returns {string}
 */
export function macroCommand(name) {
  return `Macro:${name}`;
}

/**
 * @param {string} commandId
 * @returns {boolean}
 */
export function isMacroCommand(commandId) {
  return commandId.startsWith("Macro:");
}

/**
 * @param {string} key one character, or a `KeyboardEvent.code` for keys that
 *   print none
 * @param {{ shift?: boolean, ctrl?: boolean, alt?: boolean }} [modifiers]
 * @returns {Combo}
 */
function combo(key, { shift = false, ctrl = false, alt = false } = {}) {
  return { key, shift, ctrl, alt };
}

/**
 * PCOMM's Dup key, Shift-Insert, goes to Paste here instead.
 * @type {Readonly<Bindings>}
 */
export const DEFAULT_BINDINGS = Object.freeze({
  // Pressing Control itself sets event.ctrlKey, so the binding needs it too.
  // A browser never sees Fn: laptops send Fn+Enter as the keypad Enter.
  Enter: [
    combo("ControlRight", { ctrl: true }),
    combo("Enter", { ctrl: true }),
    combo("NumpadEnter"),
  ],
  Newline: [combo("Enter")],
  BackNewline: [combo("Enter", { shift: true })],
  Tab: [combo("Tab")],
  BackTab: [combo("Tab", { shift: true })],
  Backspace: [combo("Backspace")],
  Delete: [combo("Delete")],
  Up: [combo("ArrowUp")],
  Down: [combo("ArrowDown")],
  Left: [combo("ArrowLeft")],
  Right: [combo("ArrowRight")],
  Home: [combo("Home")],
  EraseEOF: [combo("End")],
  EraseInput: [combo("End", { alt: true })],
  FieldMark: [combo("Home", { shift: true })],
  ToggleInsert: [combo("Insert")],
  Reset: [combo("CapsLock")],
  Attn: [combo("Escape")],
  SysReq: [combo("Escape", { shift: true })],
  Clear: [combo("Pause")],
  Copy: [combo("C", { ctrl: true }), combo("Insert", { ctrl: true })],
  Paste: [combo("Insert", { shift: true })],
  SelectUp: [combo("ArrowUp", { shift: true })],
  SelectDown: [combo("ArrowDown", { shift: true })],
  SelectLeft: [combo("ArrowLeft", { shift: true })],
  SelectRight: [combo("ArrowRight", { shift: true })],
  // Bound, so the browser never sees them: Ctrl+R would reload the page.
  Undo: [combo("Z", { ctrl: true })],
  Redo: [combo("R", { ctrl: true })],
  Menu: [combo("M", { ctrl: true }), combo(" ", { alt: true })],
  ToggleKeyboard: [combo("K", { ctrl: true })],
  OpenChars: [combo("C", { alt: true })],
  ToggleRecording: [combo("E", { ctrl: true })],
  AnswerYes: [combo("Y", { ctrl: true })],
  AnswerNo: [combo("N", { ctrl: true })],
  AskEdit: [combo("E", { ctrl: true, shift: true })],
  StopSharing: [combo("S", { ctrl: true, shift: true })],
  StopEditing: [combo("X", { ctrl: true, shift: true })],
  Settings: [combo(",", { alt: true })],
  Macros: [combo("M", { alt: true })],
  Recorder: [combo("R", { alt: true })],
  Keys: [combo("K", { alt: true })],
  PA1: [combo("Insert", { alt: true })],
  PA2: [combo("Home", { alt: true })],
  PA3: [combo("PageUp", { shift: true })],
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `PF${index + 1}`,
      [combo(`F${index + 1}`)],
    ]),
  ),
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `PF${index + 13}`,
      [combo(`F${index + 1}`, { shift: true })],
    ]),
  ),
});

/**
 * Held down, a PF or PA key pages on as fast as the host answers (the server
 * drops a repeat while the last one is still out). Enter, Clear, Attn and
 * SysReq must never auto-repeat: nobody means to send those twice.
 *
 * @param {string} commandId
 * @returns {boolean}
 */
function repeatsAsPaging(commandId) {
  return /^PF\d+$/.test(commandId) || /^PA\d+$/.test(commandId);
}

/**
 * @param {string} commandId
 * @returns {boolean}
 */
function neverRepeats(commandId) {
  return (
    commandId === "Enter" ||
    commandId === "Clear" ||
    commandId === "Attn" ||
    commandId === "SysReq"
  );
}

/**
 * @param {Combo} value
 * @returns {string}
 */
export function serializeCombo(value) {
  return `${value.ctrl ? "C" : ""}${value.shift ? "S" : ""}${value.alt ? "A" : ""}:${value.key}`;
}

/**
 * A key is the character it prints, not the place it sits. `KeyboardEvent.code`
 * names a position on a US board: the key marked Z is `KeyY` on a German one,
 * and `?` is `Shift+Slash` there but `Shift+Minus` here. Only keys that print
 * nothing — F3, Home, the arrows — have no character to go by, and those keep
 * their position, which is the same everywhere.
 *
 * @param {KeyboardEvent} event
 * @returns {string} one character, or a `KeyboardEvent.code`
 */
export function keyIdentity(event) {
  if ([...event.key].length !== 1) return event.code;
  return normalizeKey(event.key);
}

/**
 * Uppercase so Shift is carried by the flag alone, except where a letter has no
 * single-character uppercase: German ß uppercases to SS.
 *
 * @param {string} character one character
 * @returns {string}
 */
function normalizeKey(character) {
  const upper = character.toUpperCase();
  return [...upper].length === 1 ? upper : character;
}

/**
 * Windows sends AltGr as Ctrl+Alt, so `\` on a German board arrives looking like
 * Ctrl+Alt+\. The character already says what AltGr made of the key, so the two
 * flags it fakes are dropped. Every place that asks whether Ctrl or Alt is held
 * asks here.
 *
 * @param {KeyboardEvent} event
 * @returns {{ ctrl: boolean, alt: boolean }}
 */
function heldModifiers(event) {
  if (event.getModifierState?.("AltGraph") === true)
    return { ctrl: false, alt: false };
  return { ctrl: event.ctrlKey, alt: event.altKey };
}

/**
 * @param {KeyboardEvent} event
 * @returns {Combo}
 */
function comboFromEvent(event) {
  return combo(keyIdentity(event), {
    shift: event.shiftKey,
    ...heldModifiers(event),
  });
}

/**
 * What still works in a key field: moving, editing, Enter and leaving. Any
 * other key is the one being picked.
 */
const FIELD_COMMANDS = new Set([
  "Enter",
  "Newline",
  "BackNewline",
  "Tab",
  "BackTab",
  "Backspace",
  "Delete",
  "DeleteField",
  "DeleteWord",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "EraseEOF",
  "EraseInput",
  "ToggleInsert",
  "Reset",
  "Attn",
  "PF3",
  "PF12",
]);

/**
 * Picks a key pressed into a key field. A modifier going down is only on the
 * way to the key, so `Ctrl+Enter` can be pressed as it is typed; a modifier
 * counts on its own only when it is let go with nothing pressed in between.
 */
export class ComboCapture {
  constructor() {
    /** @type {Combo | null} the modifier held last, if nothing came after it */
    this.lone = null;
  }

  /**
   * @param {KeyboardEvent} event
   * @param {Map<string, string>} lookup
   * @returns {Combo | 'held' | null} the key picked, a modifier waiting for
   *   its keyup, or null for a key the field handles as usual
   */
  keydown(event, lookup) {
    this.lone = null;
    const pressed = comboFromEvent(event);
    const types = [...event.key].length === 1 && !pressed.ctrl && !pressed.alt;
    const command = lookup.get(serializeCombo(pressed));
    if (types || (command !== undefined && FIELD_COMMANDS.has(command)))
      return null;
    if (MODIFIER_KEYS[pressed.key] === undefined) return pressed;
    this.lone = pressed;
    return "held";
  }

  /**
   * @param {KeyboardEvent} event
   * @returns {Combo | null} the modifier, if it was let go on its own
   */
  keyup(event) {
    const lone = this.lone;
    this.lone = null;
    return lone !== null && lone.key === event.code ? lone : null;
  }
}

/**
 * Keys that print nothing, so a combo names them by position.
 * @type {Readonly<Record<string, string>>}
 */
const KEY_LABELS = Object.freeze({
  ControlLeft: "LCtrl",
  ControlRight: "RCtrl",
  ShiftLeft: "LShift",
  ShiftRight: "RShift",
  AltLeft: "LAlt",
  AltRight: "RAlt",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  CapsLock: "CapsLock",
  Pause: "Pause",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Enter: "Enter",
  NumpadEnter: "NumEnter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
});

/**
 * @param {string} key a combo's key: one character, or a `KeyboardEvent.code`
 * @returns {string}
 */
export function keyLabel(key) {
  if (key === " ") return "Space";
  if ([...key].length === 1) return key;
  return KEY_LABELS[key] ?? key;
}

/**
 * Pressing a modifier sets its own flag, so right Ctrl would read "Ctrl+RCtrl".
 * @type {Readonly<Record<string, string>>}
 */
const MODIFIER_KEYS = Object.freeze({
  ControlLeft: "ctrl",
  ControlRight: "ctrl",
  ShiftLeft: "shift",
  ShiftRight: "shift",
  AltLeft: "alt",
  AltRight: "alt",
});

/**
 * @param {Combo} value
 * @returns {string} e.g. "Ctrl+Shift+F1"
 */
export function comboLabel(value) {
  const held = MODIFIER_KEYS[value.key];
  const mods = [
    value.ctrl && held !== "ctrl" && "Ctrl",
    value.shift && held !== "shift" && "Shift",
    value.alt && held !== "alt" && "Alt",
  ].filter(Boolean);
  return [...mods, keyLabel(value.key)].join("+");
}

/**
 * Keys with no character and no label of their own, which a combo names by
 * their `KeyboardEvent.code`.
 * @type {readonly string[]}
 */
const OTHER_CODES = Object.freeze([
  "ScrollLock",
  "PrintScreen",
  "ContextMenu",
  "NumLock",
  ...Array.from({ length: 10 }, (_, digit) => `Numpad${digit}`),
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
]);

/**
 * @param {string} name one character, a label, or a `KeyboardEvent.code`
 * @returns {string | null} a combo's key
 */
function keyFromName(name) {
  if (name === "") return null;
  if ([...name].length === 1) return normalizeKey(name);
  const lower = name.toLowerCase();
  if (lower === "space") return " ";
  for (const [code, label] of Object.entries(KEY_LABELS))
    if (label.toLowerCase() === lower || code.toLowerCase() === lower)
      return code;
  return OTHER_CODES.find((code) => code.toLowerCase() === lower) ?? null;
}

/**
 * The way back from `comboLabel`, for a key typed in by name: `Ctrl+Shift+F1`,
 * `RCtrl`, `Alt+M`, `Space`, in any case.
 *
 * @param {string} text
 * @returns {Combo | null} null when no key is called that
 */
export function parseCombo(text) {
  const trimmed = text.trim();
  // The last + comes before the key, unless the key is + itself.
  const keyStart = trimmed.endsWith("+")
    ? trimmed.length - 1
    : trimmed.lastIndexOf("+") + 1;
  const key = keyFromName(trimmed.slice(keyStart));
  if (key === null) return null;
  const value = combo(key);
  for (const word of trimmed.slice(0, keyStart).split("+")) {
    const modifier = word.trim().toLowerCase();
    if (modifier === "ctrl") value.ctrl = true;
    else if (modifier === "shift") value.shift = true;
    else if (modifier === "alt") value.alt = true;
    else if (modifier !== "") return null;
  }
  // Pressing a modifier sets its own flag, as comboFromEvent sees it.
  const held = MODIFIER_KEYS[key];
  if (held === "ctrl") value.ctrl = true;
  if (held === "shift") value.shift = true;
  if (held === "alt") value.alt = true;
  return value;
}

/**
 * A map saved before keys were known by their character holds a
 * `KeyboardEvent.code`. Letters, digits and Space say which character that was;
 * a punctuation position does not, since the character depended on the layout
 * it was bound on, so it is left alone to be shown and pressed again.
 *
 * @param {Combo} value
 * @returns {Combo}
 */
function fromStored(value) {
  if (typeof value.key === "string") return value;
  const code = /** @type {{ code?: string }} */ (value).code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  const digit = /^Digit([0-9])$/.exec(code);
  const key = letter?.[1] ?? digit?.[1] ?? (code === "Space" ? " " : code);
  return { key, shift: value.shift, ctrl: value.ctrl, alt: value.alt };
}

/**
 * A saved keymap is the whole map, not a diff, so commands added to the app
 * later need filling in. An empty combo list is a deliberate unbinding.
 *
 * @param {Bindings} stored
 * @returns {Bindings}
 */
export function withDefaults(stored) {
  /** @type {Bindings} */
  const saved = {};
  for (const [commandId, combos] of Object.entries(stored)) {
    saved[commandId] = combos.map(fromStored);
  }

  const taken = new Set(Object.values(saved).flat().map(serializeCombo));
  /** @type {Bindings} */
  const filled = { ...saved };
  for (const [commandId, combos] of Object.entries(DEFAULT_BINDINGS)) {
    if (commandId in saved) continue;
    filled[commandId] = combos.filter(
      (value) => !taken.has(serializeCombo(value)),
    );
  }
  return filled;
}

/**
 * What is saved: only the commands the user changed, so a default changed in a
 * later version reaches every command they left alone. `withDefaults` is the
 * way back.
 *
 * @param {Bindings} bindings
 * @returns {Bindings}
 */
export function changedBindings(bindings) {
  /** @type {Bindings} */
  const changed = {};
  for (const [commandId, combos] of Object.entries(bindings)) {
    const defaults = DEFAULT_BINDINGS[commandId] ?? [];
    const same =
      JSON.stringify(combos.map(serializeCombo)) ===
      JSON.stringify(defaults.map(serializeCombo));
    if (!same) changed[commandId] = combos;
  }
  return changed;
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
  if (pf) return { action: "PF", args: [pf[1] ?? "1"] };
  const pa = /^PA(\d+)$/.exec(commandId);
  if (pa) return { action: "PA", args: [pa[1] ?? "1"] };
  return { action: commandId, args: [] };
}

/**
 * @param {KeyboardEvent} event
 * @param {Map<string, string>} lookup
 * @returns {string | null} the command this key carries, whatever is listening
 */
export function commandForEvent(event, lookup) {
  return lookup.get(serializeCombo(comboFromEvent(event))) ?? null;
}

/**
 * @param {KeyboardEvent} event
 * @param {Map<string, string>} lookup
 * @returns {{ kind: 'action', action: string, args: string[], repeat?: true }
 *   | { kind: 'client', command: string }
 *   | { kind: 'text', value: string } | null}
 */
export function mapKey(event, lookup) {
  if (event.metaKey) return null;

  const commandId = commandForEvent(event, lookup);
  if (commandId !== null) {
    if (event.repeat && repeatsAsPaging(commandId)) {
      const { action, args } = commandToAction(commandId);
      return { kind: "action", action, args, repeat: true };
    }
    if (event.repeat && neverRepeats(commandId)) return null;
    if (CLIENT_COMMANDS.has(commandId) || isMacroCommand(commandId))
      return { kind: "client", command: commandId };
    const { action, args } = commandToAction(commandId);
    return { kind: "action", action, args };
  }

  // Unclaimed Ctrl/Alt combos belong to the browser.
  const { ctrl, alt } = heldModifiers(event);
  if (ctrl || alt) return null;

  // One character is text; longer is a named key nothing binds.
  if ([...event.key].length === 1) return { kind: "text", value: event.key };

  return null;
}

/**
 * @param {KeyboardEvent} event
 * @param {Map<string, string>} lookup
 * @returns {{ kind: 'exit' } | { kind: 'action', action: string, args: string[] } | { kind: 'text', value: string } | null}
 */
export function macroInputForEvent(event, lookup) {
  if (event.repeat) return null;
  if (event.code === "F5" && !event.ctrlKey && !event.altKey && !event.metaKey)
    return event.shiftKey
      ? { kind: "action", action: "PF", args: ["5"] }
      : { kind: "exit" };
  const mapped = mapKey(event, lookup);
  if (mapped?.kind === "action" || mapped?.kind === "text") return mapped;
  return null;
}

/**
 * @param {Bindings} bindings
 * @returns {Bindings}
 */
function cloneBindings(bindings) {
  /** @type {Bindings} */
  const copy = {};
  for (const [commandId, combos] of Object.entries(bindings))
    copy[commandId] = combos.map((value) => ({ ...value }));
  return copy;
}

/**
 * The bindings in force, and every change the Keys panel makes to them. One
 * keystroke is one command: a key bound anywhere is taken from where it was.
 */
export class Keymap {
  /** @param {(changed: Bindings) => void} persist */
  constructor(persist) {
    this.persist = persist;
    /** @type {Bindings} */
    this.bindings = cloneBindings(DEFAULT_BINDINGS);
    /** @type {Map<string, string>} */
    this.lookupCache = buildLookup(this.bindings);
  }

  /** @returns {Map<string, string>} */
  lookup() {
    return this.lookupCache;
  }

  /**
   * @param {Bindings} bindings as saved
   * @returns {void}
   */
  setBindings(bindings) {
    this.bindings = cloneBindings(withDefaults(bindings));
    this.lookupCache = buildLookup(this.bindings);
  }

  /** @returns {void} */
  save() {
    this.lookupCache = buildLookup(this.bindings);
    this.persist(changedBindings(this.bindings));
  }

  /**
   * @param {string} commandId
   * @returns {Combo[]}
   */
  combosFor(commandId) {
    return this.bindings[commandId] ?? [];
  }

  /**
   * @param {string} commandId
   * @returns {string} the first key bound to it, '' when nothing is
   */
  labelFor(commandId) {
    const first = this.combosFor(commandId)[0];
    return first === undefined ? "" : comboLabel(first);
  }

  /**
   * @param {string} commandId
   * @param {Combo} value
   * @returns {void}
   */
  takeFromOthers(commandId, value) {
    const key = serializeCombo(value);
    for (const [otherId, combos] of Object.entries(this.bindings)) {
      if (otherId === commandId) continue;
      const kept = combos.filter((each) => serializeCombo(each) !== key);
      if (kept.length !== combos.length) this.bindings[otherId] = kept;
    }
  }

  /**
   * @param {string} commandId
   * @param {number} index where it goes; past the end adds it
   * @param {Combo} value
   * @returns {void}
   */
  setCombo(commandId, index, value) {
    this.takeFromOthers(commandId, value);
    const key = serializeCombo(value);
    const combos = this.combosFor(commandId).slice();
    const placed = Math.min(index, combos.length);
    combos[placed] = value;
    // The same key twice on one command is once.
    this.bindings[commandId] = combos.filter(
      (each, at) => at === placed || serializeCombo(each) !== key,
    );
    this.save();
  }

  /**
   * @param {string} commandId
   * @param {number} index
   * @returns {void}
   */
  removeCombo(commandId, index) {
    this.bindings[commandId] = this.combosFor(commandId).filter(
      (_, at) => at !== index,
    );
    this.save();
  }

  /**
   * An empty list is saved, so a command unbound stays unbound; a macro's has
   * no default to come back to, so it simply goes.
   *
   * @param {string} commandId
   * @returns {void}
   */
  unbind(commandId) {
    if (isMacroCommand(commandId)) delete this.bindings[commandId];
    else this.bindings[commandId] = [];
    this.save();
  }

  /**
   * A renamed macro keeps its keys.
   *
   * @param {string} from
   * @param {string} to
   * @returns {void}
   */
  renameCommand(from, to) {
    const combos = this.bindings[from];
    if (combos === undefined) return;
    delete this.bindings[from];
    this.bindings[to] = combos;
    this.save();
  }

  /**
   * Its default keys are taken back from whatever they were given to since.
   *
   * @param {string} commandId
   * @returns {void}
   */
  resetCommand(commandId) {
    const defaults = DEFAULT_BINDINGS[commandId] ?? [];
    for (const value of defaults) this.takeFromOthers(commandId, value);
    this.bindings[commandId] = defaults.map((value) => ({ ...value }));
    this.save();
  }

  /** @returns {void} */
  resetAll() {
    this.bindings = cloneBindings(DEFAULT_BINDINGS);
    this.save();
  }
}
