import { DYNAMIC_OVERSIZE, sizeMode } from "./settings.js";

export const sizeLayout = {
  title: "TN3270 Screen size",
  listTop: 3,

  /** @param {import('./panels.js').Panels} _panel @param {import('./panels.js').PanelView} view */
  render(_panel, view) {
    view.say(1, 1, "S=Select (resets the Session)", "turquoise");
  },

  /** @param {import('./panels.js').Panels} panel @returns {import('./panels.js').Item[]} */
  items(panel) {
    const { settings } = panel.deps;
    const mode = sizeMode(settings.oversize);
    return [
      ...settings.modelChoices().map((model) => ({
        key: `model${model}`,
        label:
          settings.describeModel(model) + (model === 2 ? " (Default)" : ""),
        current: mode === "model" && model === settings.model,
        s: () => panel.applySize(model, ""),
      })),
      {
        key: "dynamic",
        label: "Dynamic - 62x160",
        current: mode === "dynamic",
        s: () => panel.applySize(settings.model, DYNAMIC_OVERSIZE),
      },
      {
        key: "fit",
        label: "Fit to window (based on font size 2.Font)",
        current: mode === "fit",
        s: () =>
          panel.applySize(settings.model, panel.fitOversize(settings.model)),
      },
    ];
  },
};
