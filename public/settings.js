import { THEMES } from "./themes.js";
export { THEMES } from "./themes.js";
/** @typedef {import('./themes.js').Theme} Theme */

/**
 * All but the last are vendored in `public/fonts/`; the last is the machine's.
 * @type {readonly { name: string, family: string }[]}
 */
export const FONTS = Object.freeze([
  { name: "Fira Mono", family: '"Fira Mono", monospace' },
  { name: "IBM 3270", family: '"IBM 3270", monospace' },
  { name: "IBM Plex Mono", family: '"IBM Plex Mono", monospace' },
  { name: "European Teletext", family: '"European Teletext", monospace' },
  { name: "DejaVu Sans Mono", family: '"DejaVu Sans Mono", monospace' },
  { name: "Liberation Mono", family: '"Liberation Mono", monospace' },
  { name: "JetBrains Mono", family: '"JetBrains Mono", monospace' },
  { name: "Inconsolata", family: '"Inconsolata", monospace' },
  { name: "Courier Prime", family: '"Courier Prime", monospace' },
  {
    name: "System monospace",
    family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
]);

/**
 * What a browser that never changed anything gets. Only what differs from it is
 * saved, so a default changed in a later version reaches every setting the user
 * left alone. The model and the screen size are null until one is chosen here,
 * which leaves them to the server.
 *
 * @type {Readonly<import('./store.js').StoredSettings>}
 */
export const DEFAULT_SETTINGS = Object.freeze({
  theme: "Host On-Demand",
  font: "Fira Mono",
  model: null,
  screenSize: null,
  // The size "fit to window" measures at, and the optional display cap.
  fitFontSize: 16,
  forceMaxFontSize: false,
  fieldBackground: true,
});

export const MIN_FIT_FONT_SIZE = 8;
export const MAX_FIT_FONT_SIZE = 32;

// An oversize on top of the model is what makes b3270 negotiate IBM-DYNAMIC,
// and 62x160 is the biggest screen an IBM host will bind.
const DYNAMIC_ROWS = 62;
const DYNAMIC_COLS = 160;
export const DYNAMIC_OVERSIZE = `${DYNAMIC_COLS}x${DYNAMIC_ROWS}`;

/**
 * A fit is measured from the window it was made in, so what is worth saving is
 * the choice, not the cells that window happened to come to.
 *
 * @param {string} oversize
 * @returns {'model' | 'fit' | 'dynamic'}
 */
export function sizeMode(oversize) {
  if (oversize === DYNAMIC_OVERSIZE) return "dynamic";
  return oversize === "" ? "model" : "fit";
}

/**
 * The way back from `sizeMode`: null for a fit, which only a measurement of the
 * window it is going into can answer.
 *
 * @param {'model' | 'fit' | 'dynamic'} mode
 * @returns {string | null}
 */
export function modeOversize(mode) {
  if (mode === "fit") return null;
  return mode === "dynamic" ? DYNAMIC_OVERSIZE : "";
}

/**
 * @param {string} oversize `<cols>x<rows>`, not '' and not the dynamic one
 * @returns {string} rows first, the way a screen model is named
 */
export function describeFit(oversize) {
  const [cols, rows] = oversize.split("x");
  return `Fit to window - ${rows}x${cols}`;
}

export class Settings {
  /** @param {(changed: Partial<import('./store.js').StoredSettings>) => void} persist */
  constructor(persist) {
    this.persist = persist;
    /** @type {import('./store.js').StoredSettings} What is saved in this browser.
     * The model is asked for again by every tab, which starts its own sessions. */
    this.values = { ...DEFAULT_SETTINGS };
    /** @type {number} The model the server has confirmed. */
    this.model = 2;
    /** @type {string} `<cols>x<rows>`, or '' for the model's own size. */
    this.oversize = "";
    /** @type {import('../server/indications.js').ModelInfo[]} */
    this.models = [];
    /** @type {boolean} */
    this.connected = false;
    /** @type {string} */
    this.host = "";
    /** @type {boolean} Host comes from the server's config: not editable here. */
    this.hostLocked = false;
  }

  /** @returns {Theme} */
  theme() {
    return (
      THEMES.find((entry) => entry.name === this.values.theme) ?? THEMES[0]
    );
  }

  /** @returns {{ name: string, family: string }} */
  font() {
    return FONTS.find((entry) => entry.name === this.values.font) ?? FONTS[0];
  }

  /**
   * Whether the size in force was measured from the window, not asked for by name.
   *
   * @returns {boolean}
   */
  fitsWindow() {
    return sizeMode(this.oversize) === "fit";
  }

  /**
   * Matched by name, so reordering the lists cannot scramble an old choice.
   *
   * @param {Partial<import('./store.js').StoredSettings>} saved
   * @returns {void}
   */
  restoreSaved(saved) {
    const theme = THEMES.find((entry) => entry.name === saved.theme);
    if (theme !== undefined) this.values.theme = theme.name;
    const font = FONTS.find((entry) => entry.name === saved.font);
    if (font !== undefined) this.values.font = font.name;
    if (typeof saved.fieldBackground === "boolean")
      this.values.fieldBackground = saved.fieldBackground;
    if (typeof saved.forceMaxFontSize === "boolean")
      this.values.forceMaxFontSize = saved.forceMaxFontSize;
    if (typeof saved.model === "number") this.values.model = saved.model;
    if (
      saved.screenSize === "model" ||
      saved.screenSize === "fit" ||
      saved.screenSize === "dynamic"
    ) {
      this.values.screenSize = saved.screenSize;
    }
    if (typeof saved.fitFontSize === "number") {
      this.values.fitFontSize = Math.max(
        MIN_FIT_FONT_SIZE,
        Math.min(MAX_FIT_FONT_SIZE, saved.fitFontSize),
      );
    }
  }

  /** @returns {void} */
  save() {
    /** @type {Record<string, unknown>} */
    const defaults = DEFAULT_SETTINGS;
    /** @type {Record<string, unknown>} */
    const changed = {};
    for (const [name, value] of Object.entries(this.values))
      if (value !== defaults[name]) changed[name] = value;
    console.info("settings saved", changed);
    this.persist(changed);
  }

  /**
   * @param {(keyof import('./store.js').StoredSettings)[]} names
   * @returns {void}
   */
  reset(names) {
    for (const name of names)
      Object.assign(this.values, { [name]: DEFAULT_SETTINGS[name] });
    this.save();
  }

  /**
   * b3270 silently refuses an oversize below the model, and buffers 16383 cells.
   *
   * @param {{ cols: number, rows: number }} fit
   * @param {number} model
   * @returns {string}
   */
  fitSize(fit, model) {
    const info = this.models.find((entry) => entry.model === model);
    const minCols = info?.columns ?? 80;
    const minRows = info?.rows ?? 24;
    let rows = Math.max(minRows, fit.rows);
    const cols = Math.max(
      minCols,
      Math.min(fit.cols, Math.floor(16383 / rows)),
    );

    // A pane too narrow for the model shrinks the text, which buys more rows.
    if (cols > fit.cols) {
      rows = Math.round(((fit.rows + 1) * cols) / fit.cols) - 1;
      rows = Math.max(minRows, Math.min(rows, Math.floor(16383 / cols)));
    }
    return `${cols}x${rows}`;
  }

  /** @returns {number[]} the models the server offers, or the usual four */
  modelChoices() {
    return this.models.length > 0
      ? this.models.map((info) => info.model)
      : [2, 3, 4, 5];
  }

  /** @returns {string} the screen size in force */
  describeSize() {
    const mode = sizeMode(this.oversize);
    if (mode === "dynamic") return `Dynamic - ${DYNAMIC_ROWS}x${DYNAMIC_COLS}`;
    if (mode === "model") return this.describeModel(this.model);
    return describeFit(this.oversize);
  }

  /**
   * @param {number} model
   * @returns {string}
   */
  describeModel(model) {
    const info = this.models.find((entry) => entry.model === model);
    return info
      ? `Model ${model} - ${info.rows}x${info.columns}`
      : `Model ${model}`;
  }
}
