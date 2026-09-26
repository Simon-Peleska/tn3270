const OPTIONS = [
  { id: "1", screen: "theme", label: "Theme" },
  { id: "2", screen: "size", label: "Screen size" },
  { id: "3", screen: "font", label: "Font" },
  { id: "4", screen: "keymap", label: "Keys" },
  { id: "5", screen: "macros", label: "Macros" },
  { id: "6", screen: "recorder", label: "Recordings" },
  { id: "7", screen: "admin", label: "Sessions" },
];

export const settingsLayout = {
  title: "TN3270 Settings",

  /** @param {import('./panels.js').Panels} panel @param {import('./panels.js').PanelView} view */
  render(panel, view) {
    view.say(1, 2, "Command ===> ", "green");
    view.field("command", 1, 15, 1, "");
    OPTIONS.forEach((line, index) => {
      view.say(3 + index, 2, `${line.id}.`, "neutralWhite");
      view.say(3 + index, 5, line.label, "turquoise");
    });
    const { settings } = panel.deps;
    if (settings.connected) return;
    view.say(11, 3, "Host ===>", "green");
    if (settings.hostLocked)
      view.say(11, 14, "(set by the server)", "turquoise");
    else view.field("host", 11, 14, view.cols - 15, settings.host);
  },

  /** @param {import('./panels.js').Panels} panel @param {Record<string, string>} values */
  input(panel, values) {
    if (panel.deps.settings.connected || !values.host?.trim()) return;
    panel.deps.settings.host = values.host.trim();
    panel.connect(panel.deps.settings.host);
  },

  /** @param {import('./panels.js').Panels} panel @param {string} command @returns {boolean} */
  command(panel, command) {
    if (command === "RESET") {
      const { settings } = panel.deps;
      settings.reset([
        "theme",
        "font",
        "fitFontSize",
        "forceMaxFontSize",
        "fieldBackground",
      ]);
      panel.deps.applyTheme(settings.theme());
      panel.deps.applyFont(settings.font());
      panel.deps.applyFieldBackground(settings.values.fieldBackground);
      panel.refit();
      return true;
    }
    const option = OPTIONS.find((entry) => entry.id === command);
    if (option === undefined) return false;
    panel.push(option.screen);
    return true;
  },
};
