// task.c's parse_command(): s3270's action syntax, as scripts and its REST interface send it.
// `Ascii(0,0,1,5) Enter` is two actions; `String "a b"` passes everything after the name as
// space-separated arguments; `!` or `#` starts a comment that runs to the end.

const FAIL = [
  "Action name must begin with an alphanumeric character",
  "Syntax error in action name",
  'Syntax error: ")" or "," expected',
  "Extra data after parameters",
  'Syntax error: ")" expected',
  'Syntax error: unclosed "',
];

const isSpace = (/** @type {string} */ c) => /[ \t\n\v\f\r]/.test(c);
const isAlnum = (/** @type {string} */ c) => /[A-Za-z0-9]/.test(c);

/**
 * Like s3270, the actions before a syntax error still count: it runs them, then fails.
 * @param {string} text
 * @returns {{ actions: { action: string, args: string[] }[], error: string | null }}
 */
export function parseCommand(text) {
  /** @type {{ action: string, args: string[] }[]} */
  const actions = [];
  let at = 0;
  while (at < text.length) {
    const parsed = parseOne(text, at);
    if (typeof parsed === "string") return { actions, error: parsed };
    if (parsed.action !== null)
      actions.push({ action: parsed.action, args: parsed.args });
    at = parsed.next;
  }
  return { actions, error: null };
}

/**
 * One action from `start` on. Errors give the column just past the offending character, counted
 * from `start` like s3270 counts them.
 * @param {string} text @param {number} start
 * @returns {string | { action: string | null, args: string[], next: number }}
 */
function parseOne(text, start) {
  let state = "gnd";
  // Whether the arguments are in parentheses, rather than separated by spaces.
  let paren = false;
  let name = "";
  /** @type {string[]} */
  const args = [];
  let arg = "";
  const push = () => {
    args.push(arg);
    arg = "";
  };
  const fail = (/** @type {number} */ n, /** @type {number} */ end) =>
    `${FAIL[n - 1]} at column ${end - start}`;

  let i = start;
  for (; i < text.length; i++) {
    const c = text.charAt(i);
    switch (state) {
      case "gnd":
        if (isSpace(c)) continue;
        if (isAlnum(c)) {
          state = "name";
          name = c;
        } else if (c === "!" || c === "#") state = "comment";
        else return fail(1, i + 1);
        break;
      case "comment":
        break;
      case "name":
        if (c === "(") {
          state = "lparen";
          paren = true;
        } else if (isSpace(c)) state = "name-space";
        else if (isAlnum(c) || c === "_" || c === "-") name += c;
        else return fail(2, i + 1);
        break;
      case "name-space":
        if (isSpace(c)) continue;
        if (c === "(") {
          state = "lparen";
          paren = true;
        } else if (c === '"') state = "qparm";
        else {
          state = "parm";
          arg += c;
        }
        break;
      case "lparen":
      case "lparen-comma":
        if (isSpace(c)) continue;
        if (c === '"') state = "qparm";
        else if (c === ",") {
          push();
          state = "lparen-comma";
        } else if (c === ")") {
          if (state === "lparen-comma") push();
          return done(i + 1);
        } else {
          state = "parm";
          arg += c;
        }
        break;
      case "parm":
        if (isSpace(c)) {
          push();
          state = "parmx";
        } else if (paren && c === ")") {
          push();
          return done(i + 1);
        } else if (paren && c === ",") {
          push();
          state = "lparen-comma";
        } else arg += c;
        break;
      case "qparm":
        if (c === '"') {
          push();
          state = "parmx";
        } else if (c === "\\") state = "bsl";
        else arg += c;
        break;
      // A backslash is kept, except that \" is a quote, and \\" ends the argument with one.
      case "bsl":
        if (c !== '"') arg += "\\";
        if (c === "\\") state = "bsl2";
        else {
          arg += c;
          state = "qparm";
        }
        break;
      case "bsl2":
        if (c === '"') {
          push();
          state = "parmx";
        } else {
          arg += "\\";
          if (c !== "\\") {
            arg += c;
            state = "qparm";
          }
        }
        break;
      case "parmx":
        if (isSpace(c)) continue;
        if (!paren) {
          if (c === '"') state = "qparm";
          else {
            arg += c;
            state = "parm";
          }
        } else if (c === ",") state = "lparen-comma";
        else if (c === ")") return done(i + 1);
        else return fail(3, i + 1);
        break;
    }
  }

  switch (state) {
    case "gnd":
    case "comment":
      return { action: null, args: [], next: text.length };
    case "name":
    case "name-space":
      break;
    case "parm":
      if (paren) return fail(5, text.length + 1);
      push();
      break;
    case "parmx":
      if (paren) return fail(5, text.length + 1);
      break;
    case "qparm":
    case "bsl":
    case "bsl2":
      return fail(6, text.length + 1);
    default:
      return fail(5, text.length + 1);
  }
  return { action: name, args, next: text.length };

  /** @param {number} next just past the ")" */
  function done(next) {
    while (next < text.length && isSpace(text.charAt(next))) next++;
    return { action: name, args, next };
  }
}

/**
 * json_run.c's hjson_split(): a JSON command is an action string, one `{action, args}` object or
 * an array of them.
 * @param {string} body
 * @returns {{ actions: { action: string, args: string[] }[], error: string | null }}
 */
export function parseJsonCommand(body) {
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    return {
      actions: [],
      error: `JSON parse error: ${/** @type {Error} */ (err).message}`,
    };
  }
  if (typeof json === "string") return parseCommand(json);
  if (Array.isArray(json)) {
    const actions = [];
    for (const [i, element] of json.entries()) {
      const one = jsonAction(element);
      if (typeof one === "string")
        return { actions: [], error: `Element ${i}: ${one}` };
      actions.push(one);
    }
    return { actions, error: null };
  }
  if (typeof json === "object" && json !== null) {
    const one = jsonAction(json);
    if (typeof one === "string") return { actions: [], error: one };
    return { actions: [one], error: null };
  }
  return { actions: [], error: "Not a string, object or array" };
}

/** @param {unknown} json @returns {string | { action: string, args: string[] }} */
function jsonAction(json) {
  if (typeof json !== "object" || json === null || Array.isArray(json))
    return "Not an object";
  const { action, args = [], ...unknown } = /** @type {any} */ (json);
  if (action === undefined) return "Missing object member 'action'";
  if (typeof action !== "string") return "Invalid 'action' type";
  if (!Array.isArray(args)) return "Invalid 'args' type";
  if (args.some((arg) => typeof arg === "object" && arg !== null))
    return "Invalid 'args' element type";
  const extra = Object.keys(unknown)[0];
  if (extra !== undefined) return `Unknown object member '${extra}'`;
  return { action, args: args.map((arg) => (arg === null ? "" : String(arg))) };
}
