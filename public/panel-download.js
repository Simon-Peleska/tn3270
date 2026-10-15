export const downloadLayout = {
  title: "TN3270 Download Data Set",
  lineCommands: false,

  /** @param {import('./panels.js').Panels} panel @param {import('./panels.js').PanelView} view */
  render(panel, view) {
    view.say(1, 2, "Command ===> ", "green");
    view.field("command", 1, 15, 20, "");
    view.say(3, 2, "Data set ===>", "green");
    view.field("hostFile", 3, 16, 56, panel.downloadHostFile);
    view.say(4, 2, "Command  ===>", "green");
    view.field("hostCommand", 4, 16, 30, panel.downloadCommand);
    view.say(
      6,
      2,
      "IND$FILE sends the data set as text, saved by the browser.",
      "turquoise",
    );
    view.say(
      7,
      2,
      "Quote a full name: 'USER.DATA(MEMBER)'. Unquoted, TSO puts",
      "turquoise",
    );
    view.say(8, 2, "your prefix in front.", "turquoise");
    view.say(
      9,
      2,
      "The command is typed on the screen behind this panel: from ISPF",
      "turquoise",
    );
    view.say(
      10,
      2,
      "keep TSO in front, from READY drop it. \\e005B is the $.",
      "turquoise",
    );
    view.say(
      11,
      2,
      "SDSF output: save it with XDC first, then download that data set.",
      "turquoise",
    );
    view.say(
      13,
      2,
      "Enter downloads. CANCEL stops a download that is running.",
      "turquoise",
    );
  },

  /** @param {import('./panels.js').Panels} panel @param {Record<string, string>} values */
  input(panel, values) {
    if (values.command?.trim()) return;
    void panel.download(
      (values.hostFile ?? "").trim(),
      (values.hostCommand ?? "").trim(),
    );
  },

  /** @param {import('./panels.js').Panels} panel @param {string} command @returns {boolean} */
  command(panel, command) {
    if (!panel.downloading || (command !== "CANCEL" && command !== "CAN"))
      return false;
    panel.deps.cancelDownload();
    panel.message = "Canceling...";
    return true;
  },
};
