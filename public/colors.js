/**
 * A host colour names an ANSI slot (0-15), never an RGB value; the theme does.
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
  // b3270 spells it "gray"; the British spelling must not silently mis-render.
  gray: 8,
  grey: 8,
  orange: 9,
  paleGreen: 10,
  blue: 12,
  pink: 13,
  paleTurquoise: 14,
});

/** An unstyled 3270 field is green on black, like the hardware. */
export const DEFAULT_FOREGROUND_ANSI = 2;
export const DEFAULT_BACKGROUND_ANSI = 0;

/** A 3278 has no palette to theme, so its green stays a fixed colour. */
export const MONO_FOREGROUND = "#00ff00";
export const DEFAULT_BACKGROUND = "#000000";

/**
 * @param {string | null} name
 * @param {number} fallback ANSI colour index, 0-15
 * @returns {number}
 */
export function ansiColorIndex(name, fallback) {
  if (name === null) return fallback;
  return HOST_COLOR_ANSI[name] ?? fallback;
}

/** Most cells carry no rendition at all, and the renderer asks per cell. */
const NO_FLAGS = Object.freeze({
  bold: false,
  underline: false,
  blink: false,
  reverse: false,
});

/**
 * b3270's other renditions (`wide`, `order`, `selectable`) describe the
 * character, not how to draw it, so they are dropped here.
 *
 * @param {string | null} gr comma-separated list from b3270
 * @returns {{ bold: boolean, underline: boolean, blink: boolean, reverse: boolean }}
 */
export function grFlags(gr) {
  if (gr === null || gr === "") return NO_FLAGS;
  const words = gr.split(",").map((word) => word.trim());
  return {
    bold: words.includes("highlight"),
    underline: words.includes("underline"),
    blink: words.includes("blink"),
    reverse: words.includes("reverse"),
  };
}
