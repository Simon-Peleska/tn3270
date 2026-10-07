import { ALIASES, APL2UC, CODE_PAGES } from "./codepages.js";
import { NodeError } from "./errors.js";

// Port of the single-byte parts of x3270's Common/unicode.c. Tables are built
// once per code page and shared by every session that uses it.

export const CS_BASE = 0x00;
export const CS_APL = 0x01;
export const CS_DBCS = 0x03;
export const CS_MASK = 0x03;
export const CS_GE = 0x04;

const UNDERLINED_APL = [
  0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x51, 0x52, 0x53, 0x54,
  0x55, 0x56, 0x57, 0x58, 0x59, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
];

/**
 * @typedef {{
 *   name: string, hostCodepage: string, cgcsgid: number, kybdtype: string,
 *   base: Uint32Array, apl: Uint32Array, toEbcdic: Map<number, number>, aplToEbcdic: Map<number, number>
 * }} CodePage
 */

/** @type {Map<string, CodePage>} */
const cache = new Map();

/** @param {string} requested x3270 code page name, alias or number ("bracket", "1140", "cp037", ...) */
export function codePage(requested) {
  let name = String(requested).toLowerCase();
  if (/^\d+$/.test(name)) name = `cp${name}`;
  name = /** @type {Record<string, string>} */ (ALIASES)[name] ?? name;
  const cached = cache.get(name);
  if (cached) return cached;
  const entry = /** @type {Record<string, typeof CODE_PAGES.cp037>} */ (
    CODE_PAGES
  )[name];
  if (!entry) throw new NodeError("N9001", `unknown code page ${requested}`);

  const base = new Uint32Array(256);
  base[0x40] = 0x20;
  for (let i = 0; i < entry.code.length; i++) base[0x41 + i] = entry.code[i];
  base[0x1e] = 0x3b;
  base[0x1c] = 0x2a;
  base[0xff] = 0x25cf;
  base[0x3f] = 0x25a0;

  const apl = new Uint32Array(256);
  for (let c = 1; c < 256; c++) apl[c] = APL2UC[c];
  UNDERLINED_APL.forEach((c, i) => {
    if (!apl[c]) apl[c] = 0x41 + i;
  });

  const toEbcdic = new Map([[0x20, 0x40]]);
  for (let i = 0; i < entry.code.length; i++) {
    if (entry.code[i] && !toEbcdic.has(entry.code[i]))
      toEbcdic.set(entry.code[i], 0x41 + i);
  }
  const aplToEbcdic = new Map();
  for (let c = 0x70; c <= 0xfe; c++) {
    if (APL2UC[c] && !aplToEbcdic.has(APL2UC[c])) aplToEbcdic.set(APL2UC[c], c);
  }

  let cgcsgid = Number(entry.cgcsgid);
  if (cgcsgid <= 0xffff) cgcsgid = (0x02b90000 | cgcsgid) >>> 0;
  const page = {
    name,
    hostCodepage: entry.hostCodepage,
    cgcsgid,
    kybdtype: entry.kybdtype,
    base,
    apl,
    toEbcdic,
    aplToEbcdic,
  };
  cache.set(name, page);
  return page;
}

/** ebcdic_to_unicode(): 0 when there is no translation. @param {CodePage} cp @param {number} c @param {number} cs */
export function ebcdicToUnicode(cp, c, cs) {
  if (cs & CS_GE || (cs & CS_MASK) === CS_APL) return cp.apl[c];
  if (cs !== CS_BASE) return 0;
  return cp.base[c];
}

/** unicode_to_ebcdic_ge(): returns the EBCDIC code, with 0x100 set when it needs GE; 0 if none. @param {CodePage} cp @param {number} u @param {boolean} preferApl */
export function unicodeToEbcdic(cp, u, preferApl = false) {
  const cur = cp.toEbcdic.get(u) ?? 0;
  const apl = cp.aplToEbcdic.get(u) ?? 0;
  if (apl && (!cur || preferApl)) return apl | 0x100;
  return cur;
}

/** An underlined APL letter, which x3270 shows as the plain letter underlined. @param {number} c */
export function aplUnderlined(c) {
  return !APL2UC[c] && UNDERLINED_APL.includes(c);
}
