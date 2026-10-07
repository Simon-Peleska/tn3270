// Port of x3270's Common/split_host.c: the host syntax Open() takes.

const PREFIXES = "ACLNPSBYT";

/**
 * @typedef {{prefixes: string, lu: string | null, host: string, port: string | null, accept: string | null}} HostSpec
 */

/**
 * new_split_host(): "[prefix:...][lu@]host[:port][=accept]", where \ quotes any character
 * and [ ] quote ':' and '@', as in [::1]:23. Prefixes come back upper case, e.g. "LY".
 * @param {string} raw
 * @returns {HostSpec | {error: string}}
 */
export function splitHost(raw) {
  /** @param {string} why */
  const error = (why) => ({
    error: `Hostname syntax error in '${raw}': ${why}`,
  });
  const text = raw.trim();
  if (!text) return error("empty string");

  /** @type {{ch: string, quoted: boolean}[]} */
  const chars = [];
  let escaped = false;
  let bracketed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) return error("contains whitespace");
    if (escaped) {
      chars.push({ ch, quoted: true });
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (bracketed) {
      if (ch === "[") return error("nested '['");
      if (ch === "]") {
        const next = text[i + 1];
        if (next !== undefined && next !== "@" && next !== ":")
          return error("text following ']'");
        bracketed = false;
      } else chars.push({ ch, quoted: ch === ":" || ch === "@" });
    } else if (ch === "[") {
      const before = chars.at(-1);
      if (before && (before.quoted || (before.ch !== ":" && before.ch !== "@")))
        return error("text preceding '['");
      bracketed = true;
    } else chars.push({ ch, quoted: false });
  }
  if (escaped) return error("dangling '\\'");
  if (bracketed) return error("missing ']'");
  if (!chars.length) return error("empty hostname");

  let prefixes = "";
  /** @param {number} i */
  const isPrefix = (i) =>
    i + 1 < chars.length &&
    PREFIXES.includes(chars[i].ch.toUpperCase()) &&
    chars[i + 1].ch === ":" &&
    !chars[i + 1].quoted;
  let i = 0;
  while (isPrefix(i)) {
    prefixes += chars[i].ch.toUpperCase();
    i += 2;
  }

  /** @type {string | null} */ let lu = null;
  /** @type {string | null} */ let host = null;
  /** @type {string | null} */ let port = null;
  let part = "";
  let colons = 0;
  let equals = 0;
  for (; i < chars.length; i++) {
    const { ch, quoted } = chars[i];
    if (quoted || (ch !== "@" && ch !== ":" && ch !== "=")) {
      part += ch;
    } else if (ch === "@") {
      if (!part) return error("empty LU name");
      if (colons) return error("'@' after ':'");
      if (equals) return error("'@' after '='");
      if (lu !== null) return error("double '@'");
      lu = part;
      part = "";
      while (isPrefix(i + 1) && !chars[i + 1].quoted) {
        prefixes += chars[i + 1].ch.toUpperCase();
        i += 2;
      }
    } else if (ch === ":") {
      if (colons) return error("double ':'");
      if (!part) return error("empty hostname");
      if (equals) return error("':' after '='");
      colons++;
      host = part;
      part = "";
    } else {
      if (equals) return error("double '='");
      if (!part) return error("empty accept name");
      equals++;
      if (colons) port = part;
      else host = part;
      part = "";
    }
  }
  if (!part) {
    if (equals) return error("empty accept name");
    if (colons) return error("empty port");
    return error("empty hostname");
  }
  if (equals) return { prefixes, lu, host: host ?? "", port, accept: part };
  if (colons)
    return { prefixes, lu, host: host ?? "", port: part, accept: null };
  return { prefixes, lu, host: part, port: null, accept: null };
}
