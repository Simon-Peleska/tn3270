import { FONTS, MIN_FIT_FONT_SIZE, MAX_FIT_FONT_SIZE } from "./settings.js";
import { CODE_PAGE_CHARTS } from "./codepages.js";

/** @param {import('./panels.js').PanelView} view @param {string} codePage */
export function drawCodePageChart(view, codePage) {
  const number =
    codePage === "bracket"
      ? "037"
      : /^cp\d+$/i.test(codePage)
        ? codePage.slice(2)
        : null;
  const label =
    number === null
      ? codePage
      : `EBCDIC ${number}${codePage === "bracket" ? " (bracket)" : ""}`;
  view.say(1, 34, `Code page: ${label}`, "turquoise");
  const chart = CODE_PAGE_CHARTS[codePage];
  if (chart === undefined) {
    view.say(4, 34, "No single-byte chart for this code page", "yellow");
    return;
  }
  view.say(3, 36, "0 1 2 3 4 5 6 7 8 9 A B C D E F", "turquoise");
  for (let row = 0; row < 12; row += 1) {
    view.say(4 + row, 34, (row + 4).toString(16).toUpperCase(), "turquoise");
    for (let col = 0; col < 16; col += 1) {
      const glyph = chart[row * 16 + col];
      if (glyph !== " ") view.say(4 + row, 36 + col * 2, glyph, "white");
    }
  }
}

export const fontLayout = {
  title: "TN3270 Font",
  listTop: 6,

  /** @param {import('./panels.js').Panels} panel @param {import('./panels.js').PanelView} view */
  render(panel, view) {
    view.say(1, 1, "Font Size", "green");
    view.field(
      "fontSize",
      1,
      11,
      2,
      String(panel.deps.settings.values.fitFontSize),
    );
    view.say(1, 13, "px", "turquoise");
    view.say(2, 1, "Force max font size", "green");
    view.field(
      "forceMaxFontSize",
      2,
      21,
      1,
      panel.deps.settings.values.forceMaxFontSize ? "Y" : "N",
    );
    view.say(2, 23, "[Y/N]", "turquoise");
    view.say(4, 1, "S=Select", "turquoise");
    drawCodePageChart(view, panel.deps.codePage());
  },

  /** @param {import('./panels.js').Panels} panel @returns {import('./panels.js').Item[]} */
  items(panel) {
    const { settings } = panel.deps;
    return FONTS.map((font) => ({
      key: font.name,
      label: font.name === "Fira Mono" ? "Fira Mono (Default)" : font.name,
      current: font.name === settings.font().name,
      s: () => {
        settings.values.font = font.name;
        settings.save();
        panel.deps.applyFont(settings.font());
      },
    }));
  },

  /** @param {import('./panels.js').Panels} panel @param {Record<string, string>} values */
  input(panel, values) {
    const { settings } = panel.deps;
    let size = settings.values.fitFontSize;
    if (values.fontSize !== undefined) {
      size = Number(values.fontSize.trim());
      if (
        !Number.isInteger(size) ||
        size < MIN_FIT_FONT_SIZE ||
        size > MAX_FIT_FONT_SIZE
      ) {
        panel.message = panel.problem(
          "E5017",
          `Font size must be ${MIN_FIT_FONT_SIZE}-${MAX_FIT_FONT_SIZE}px`,
        );
        return;
      }
    }
    let force = settings.values.forceMaxFontSize;
    if (values.forceMaxFontSize !== undefined) {
      const answer = values.forceMaxFontSize.trim().toUpperCase();
      if (answer !== "Y" && answer !== "N") {
        panel.message = panel.problem(
          "E5022",
          "Force max font size must be Y or N",
        );
        return;
      }
      force = answer === "Y";
    }
    const sizeChanged = size !== settings.values.fitFontSize;
    if (!sizeChanged && force === settings.values.forceMaxFontSize) return;
    settings.values.fitFontSize = size;
    settings.values.forceMaxFontSize = force;
    settings.save();
    panel.deps.applyFont(settings.font());
    if (sizeChanged) panel.refit();
  },
};
