/**
 * IBM Host On-Demand macro XML, the "basic" format (`usevars="false"`): no
 * quoting or escaping of string values, keystrokes written as plain text with
 * `[keyword]` tokens spliced in for the ones that are not literal characters.
 *
 * A handful of this app's actions (`DeleteField`, `DeleteWord`, the
 * mode-setting `Insert`) have no Host On-Demand keyword at all, and mouse
 * clicks are a different HOD action (`<mouseclick>`) that recording here does
 * not attempt to produce. Those get invented keyword names, clearly not from
 * IBM's own vocabulary, so a round trip through this app still works; a real
 * Host On-Demand macro will simply never contain them.
 *
 * @typedef {{ text: string, action: string, args: string[] }} MacroStep one
 *   typed run of characters followed by at most one 3270 action
 * @typedef {{ name: string, steps: MacroStep[] }} Macro
 */

/** @type {Readonly<Record<string, string>>} */
const ACTION_TO_KEYWORD = Object.freeze({
  Enter: 'enter',
  Clear: 'clear',
  Reset: 'reset',
  Tab: 'tab',
  BackTab: 'backtab',
  Home: 'home',
  End: 'end',
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
  Newline: 'newline',
  Backspace: 'backspace',
  Delete: 'delete',
  DeleteField: 'deletefield',
  DeleteWord: 'deleteword',
  EraseEOF: 'eraseeof',
  EraseInput: 'eraseinput',
  Insert: 'setinsert',
  ToggleInsert: 'insert',
  Attn: 'attn',
  SysReq: 'sysreq',
  Dup: 'dup',
  FieldMark: 'fieldmark',
  CursorSelect: 'cursel',
});

/** @type {Readonly<Record<string, string>>} keyword -> action, the reverse of the above */
const KEYWORD_TO_ACTION = Object.freeze(
  Object.fromEntries(Object.entries(ACTION_TO_KEYWORD).map(([action, keyword]) => [keyword, action])),
);

/**
 * @param {string} action
 * @param {string[]} args
 * @returns {string | null} the `[keyword]` token, or null for an action with
 *   nothing to write into an `<input>` value (a mouse click has its own HOD
 *   action, not a keystroke)
 */
function actionToKeyword(action, args) {
  if (action === 'PF' || action === 'PA') return `${action.toLowerCase()}${args[0] ?? '1'}`;
  return ACTION_TO_KEYWORD[action] ?? null;
}

/**
 * @param {string} keyword lowercased, without the brackets
 * @returns {{ action: string, args: string[] } | null} null when the keyword
 *   is not one this app recognises, so it is left as literal text instead
 */
function keywordToAction(keyword) {
  const pf = /^pf(\d+)$/.exec(keyword);
  if (pf !== null) return { action: 'PF', args: [pf[1] ?? '1'] };
  const pa = /^pa(\d+)$/.exec(keyword);
  if (pa !== null) return { action: 'PA', args: [pa[1] ?? '1'] };
  const action = KEYWORD_TO_ACTION[keyword];
  return action === undefined ? null : { action, args: [] };
}

/**
 * @param {string} text
 * @returns {string} safe inside a double-quoted XML attribute
 */
function escapeXmlAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param {string} text
 * @returns {string}
 */
function unescapeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/**
 * @param {MacroStep} step
 * @returns {string} the basic-format `value` of one `<input>` element
 */
function stepToValue(step) {
  const keyword = step.action === '' ? null : actionToKeyword(step.action, step.args);
  return step.text + (keyword === null ? '' : `[${keyword}]`);
}

/**
 * Split a basic-format `<input value="...">` back into steps. A `[word]` this
 * app does not recognise is left as literal text rather than dropped, so an
 * unsupported real Host On-Demand action still types something recognisable
 * instead of vanishing silently.
 *
 * @param {string} value already entity-unescaped
 * @returns {MacroStep[]}
 */
function parseValue(value) {
  /** @type {MacroStep[]} */
  const steps = [];
  const token = /\[([a-zA-Z0-9]+)\]/g;
  let lastIndex = 0;
  let textBuf = '';
  let match;
  while ((match = token.exec(value)) !== null) {
    const mapped = keywordToAction(match[1].toLowerCase());
    if (mapped === null) continue;
    textBuf += value.slice(lastIndex, match.index);
    steps.push({ text: textBuf, action: mapped.action, args: mapped.args });
    textBuf = '';
    lastIndex = token.lastIndex;
  }
  textBuf += value.slice(lastIndex);
  if (textBuf !== '' || steps.length === 0) steps.push({ text: textBuf, action: '', args: [] });
  return steps;
}

/**
 * @param {Macro} macro
 * @returns {string} one `<HAScript>` document
 */
function macroToXml(macro) {
  const inputs = macro.steps
    .map((step) => `<input value="${escapeXmlAttr(stepToValue(step))}" row="0" col="0" movecursor="true" xlatehostkeys="true" encrypted="false"/>`)
    .join('');
  return `<HAScript name="${escapeXmlAttr(macro.name)}" description="" author="" timestamp="" invisible="false" usevars="false" promptall="false">`
    + `<screen entryscreen="true" exitscreen="true" transient="false">`
    + `<description><oia status="NOTINHIBITED" optional="false" invertmatch="false"/></description>`
    + `<actions>${inputs}</actions>`
    + `<nextscreens timeout="0"></nextscreens>`
    + `</screen></HAScript>`;
}

/**
 * @param {Macro[]} macros
 * @returns {string} a single macro is one `<HAScript>` document, matching what
 *   Host On-Demand itself writes; more than one is wrapped in `<Macros>`, this
 *   app's own convenience for a batch export — not part of IBM's format.
 */
export function macrosToXml(macros) {
  if (macros.length === 1) return `<?xml version="1.0" encoding="UTF-8"?>\n${macroToXml(macros[0])}\n`;
  const body = macros.map(macroToXml).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Macros>\n${body}\n</Macros>\n`;
}

/**
 * Tolerant of exactly what a real Host On-Demand export looks like (one bare
 * `<HAScript>`), this app's own `<Macros>`-wrapped batch, or several
 * `<HAScript>` documents simply concatenated — all three reduce to the same
 * scan, since only the `<HAScript>...</HAScript>` blocks themselves matter.
 *
 * @param {string} xml
 * @returns {Macro[]}
 */
export function parseMacrosXml(xml) {
  /** @type {Macro[]} */
  const macros = [];
  const script = /<HAScript\b([^>]*)>([\s\S]*?)<\/HAScript>/gi;
  let scriptMatch;
  while ((scriptMatch = script.exec(xml)) !== null) {
    const nameMatch = /\bname\s*=\s*"([^"]*)"/i.exec(scriptMatch[1] ?? '');
    const name = nameMatch ? unescapeXmlEntities(nameMatch[1] ?? '') : 'Imported macro';
    const body = scriptMatch[2] ?? '';

    /** @type {MacroStep[]} */
    const steps = [];
    const input = /<input(?=[\s/>])([^>]*?)\/?>/gi;
    let inputMatch;
    while ((inputMatch = input.exec(body)) !== null) {
      const valueMatch = /\bvalue\s*=\s*"([^"]*)"/i.exec(inputMatch[1] ?? '');
      if (valueMatch === null) continue;
      steps.push(...parseValue(unescapeXmlEntities(valueMatch[1] ?? '')));
    }
    macros.push({ name, steps });
  }
  return macros;
}
