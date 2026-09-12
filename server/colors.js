/**
 * Which of the terminal's sixteen ANSI slots each 3270 host colour maps onto.
 * The host only names a colour; what RGB that is comes from the theme, as a
 * shell's `red` does. So this names a slot (0-15), never an RGB value.
 *
 * neutralBlack/black and neutralWhite/white shared a slot in the old x3270
 * palette already.
 *
 * @type {Readonly<Record<string, number>>}
 */
const HOST_COLOR_ANSI = Object.freeze({
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

/** An unstyled 3270 field is green on black, like the hardware. */
export const DEFAULT_FOREGROUND_ANSI = 2;
export const DEFAULT_BACKGROUND_ANSI = 0;

/** A 3278 has no palette to theme, so its green stays a fixed RGB. */
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
  // b3270 spells it "gray"; the British spelling must not silently mis-render.
  if (name === 'grey') return HOST_COLOR_ANSI['gray'] ?? fallback;
  return fallback;
}

/**
 * Graphic renditions that map onto SGR. b3270 also emits `wide`, `order`,
 * `selectable` and others, which describe the character, not how to draw it.
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
 * @param {string | null} gr comma-separated list from b3270
 * @returns {number[]} SGR parameters, ascending, no duplicates
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
