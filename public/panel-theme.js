import { THEMES } from "./settings.js";

export const themeLayout = {
  title: "TN3270 Theme",
  listTop: 5,

  /** @param {import('./panels.js').Panels} panel @param {import('./panels.js').PanelView} view */
  render(panel, view) {
    view.say(1, 1, "Field background", "green");
    view.field(
      "background",
      1,
      18,
      1,
      panel.deps.settings.values.fieldBackground ? "Y" : "N",
    );
    view.say(1, 20, "[Y/N]", "turquoise");
    view.say(3, 1, "S=Select", "turquoise");
    view.say(6, 35, "Normal", "turquoise");
    view.say(6, 42, "Intensified", "white", "highlight");
    view.say(6, 54, "Underlined", "white", "underline");
    view.say(6, 65, "Reverse", "white", "reverse");
    view.field("preview", 7, 35, 40, "Editable Field");
    /** @type {[string, string][][]} */
    const palette = [
      [
        ["Black", "black"],
        ["Red", "red"],
        ["Green", "green"],
        ["Yellow", "yellow"],
      ],
      [
        ["Deep blue", "deepBlue"],
        ["Purple", "purple"],
        ["Turquoise", "turquoise"],
        ["White", "neutralWhite"],
      ],
      [
        ["Gray", "gray"],
        ["Orange", "orange"],
        ["Pale green", "paleGreen"],
        ["Blue", "blue"],
      ],
      [
        ["Pink", "pink"],
        ["Pale cyan", "paleTurquoise"],
      ],
    ];

    palette.forEach((row, rowIndex) => {
      row.forEach(([label, color], index) =>
        view.say(8 + rowIndex, 35 + index * 11, label, color),
      );
    });
  },

  /** @param {import('./panels.js').Panels} panel @returns {import('./panels.js').Item[]} */
  items(panel) {
    const { settings } = panel.deps;
    return THEMES.map((theme) => ({
      key: theme.name,
      label:
        theme.name === "Host On-Demand"
          ? `${theme.name} (Default)`
          : theme.name,
      current: settings.theme().name === theme.name,
      s: () => {
        settings.values.theme = theme.name;
        settings.save();
        panel.deps.applyTheme(settings.theme());
      },
    }));
  },

  /** @param {import('./panels.js').Panels} panel @param {Record<string, string>} values */
  input(panel, values) {
    if (values.background === undefined) return;
    const answer = values.background.trim().toUpperCase();
    if (answer !== "Y" && answer !== "N") {
      panel.message = panel.problem("E5021", "Field background must be Y or N");
      return;
    }
    const enabled = answer === "Y";
    const { settings } = panel.deps;
    if (settings.values.fieldBackground === enabled) return;
    settings.values.fieldBackground = enabled;
    settings.save();
    panel.deps.applyFieldBackground(enabled);
  },
};
