/**
 * Which of the terminal's own sixteen ANSI slots each 3270 host colour maps
 * onto. The host only ever says a colour's *name* ("red", "turquoise", ...);
 * what RGB that turns into is the terminal's theme, exactly like a shell's
 * `red` is whatever the theme's palette says red is. So this table names an
 * SGR slot (0-15, the standard 30-37/90-97 set), never an RGB value.
 *
 * neutralBlack/black and neutralWhite/white share a slot because they were
 * already the same colour in the old x3270 palette.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const HOST_COLOR_ANSI = Object.freeze({
  neutralBlack: 0,
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  deepBlue: 4,
  purple: 5,
  turquoise: 6,
  neutralWhite: 7,
  white: 7,
  gray: 8,
  orange: 9,
  paleGreen: 10,
  blue: 12,
  pink: 13,
  paleTurquoise: 14,
});

/** An unstyled 3270 field is green on black, same as the real hardware. */
export const DEFAULT_FOREGROUND_ANSI = 2;
export const DEFAULT_BACKGROUND_ANSI = 0;

/** A 3278 (monochrome) terminal is green on black; it has no palette to speak
 * of, so this stays a fixed RGB rather than a themeable slot. */
export const MONO_FOREGROUND = /** @type {readonly [number, number, number]} */ ([0, 255, 0]);
export const DEFAULT_BACKGROUND = /** @type {readonly [number, number, number]} */ ([0, 0, 0]);

/**
 * @param {string | null} name
 * @param {number} fallback ANSI colour index, 0-15
 * @returns {number}
 */
export function ansiColorIndex(name, fallback) {
  if (name === null) return fallback;
  const exact = HOST_COLOR_ANSI[name];
  if (exact !== undefined) return exact;
  // b3270 spells it "gray"; accept the British spelling too rather than
  // silently rendering the wrong colour.
  if (name === 'grey') return HOST_COLOR_ANSI['gray'] ?? fallback;
  return fallback;
}

/**
 * Graphic rendition names that map onto SGR parameters. b3270 also emits
 * `wide`, `order`, `selectable`, `private-use`, `no-copy`, `left-half` and
 * `right-half`, which describe the character rather than how to draw it.
 *
 * @type {Readonly<Record<string, number>>}
 */
const GR_SGR = Object.freeze({
  highlight: 1,
  underline: 4,
  blink: 5,
  reverse: 7,
});

/**
 * @param {string | null} gr Comma-separated list from b3270.
 * @returns {number[]} SGR parameters, ascending, no duplicates.
 */
export function grToSgr(gr) {
  if (gr === null || gr === '') return [];
  /** @type {number[]} */
  const params = [];
  for (const part of gr.split(',')) {
    const code = GR_SGR[part.trim()];
    if (code !== undefined && !params.includes(code)) params.push(code);
  }
  return params.sort((a, b) => a - b);
}
