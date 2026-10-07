export const logonLayout = {
  title: "TN3270 Logon",
  lineCommands: false,

  /** @param {import('./panels.js').Panels} panel @param {import('./panels.js').PanelView} view */
  render(panel, view) {
    view.say(2, 2, "Log on to the host", "turquoise");
    view.say(4, 2, "User     ===>", "green");
    view.field("user", 4, 16, 20, panel.logonUser);
    view.say(5, 2, "Password ===>", "green");
    view.secret("password", 5, 16, 40);
  },

  /** @param {import('./panels.js').Panels} panel @param {Record<string, string>} values */
  input(panel, values) {
    void panel.logon((values.user ?? "").trim(), values.password ?? "");
  },
};
