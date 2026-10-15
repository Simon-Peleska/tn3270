import { TRANSFER_WAYS, wayLabel } from "./transfers.js";

export const transferLayout = {
  title: "TN3270 Transfer Data Set",
  lineCommands: false,

  /** @param {import('./panels.js').Panels} panel @param {import('./panels.js').PanelView} view */
  render(panel, view) {
    view.say(1, 2, "Command ===> ", "green");
    view.field("command", 1, 15, 20, "");
    view.say(3, 2, "Option   ===>", "green");
    view.field("option", 3, 16, 1, panel.transferOption);
    TRANSFER_WAYS.forEach((way, index) =>
      view.say(4 + index, 4, `${way.option}  ${wayLabel(way)}`, "turquoise"),
    );
    view.say(9, 2, "Data set ===>", "green");
    view.field("hostFile", 9, 16, 56, panel.transferHostFile);
    view.say(10, 2, "Command  ===>", "green");
    view.field("hostCommand", 10, 16, 30, panel.transferCommand);
    view.say(
      12,
      2,
      "IND$FILE moves the data set as text. Quote a full name:",
      "turquoise",
    );
    view.say(
      13,
      2,
      "'USER.DATA(MEMBER)'. Unquoted, TSO puts your prefix in front.",
      "turquoise",
    );
    view.say(
      14,
      2,
      "The command is typed on the screen behind this panel: from ISPF",
      "turquoise",
    );
    view.say(
      15,
      2,
      "keep TSO in front, from READY drop it. \\e005B is the $.",
      "turquoise",
    );
    view.say(
      16,
      2,
      "SDSF output: save it with XDC first, then download that data set.",
      "turquoise",
    );
    view.say(
      17,
      2,
      "Into an open edit: upload to a scratch data set, then type",
      "turquoise",
    );
    view.say(
      18,
      2,
      "COPY 'dsname' on the command line and A or B on a line.",
      "turquoise",
    );
    view.say(
      20,
      2,
      "Enter transfers. CANCEL stops a transfer that is running.",
      "turquoise",
    );
  },

  /** @param {import('./panels.js').Panels} panel @param {Record<string, string>} values */
  input(panel, values) {
    if (values.command?.trim()) return;
    void panel.transfer(
      (values.option ?? "").trim(),
      (values.hostFile ?? "").trim(),
      (values.hostCommand ?? "").trim(),
    );
  },

  /** @param {import('./panels.js').Panels} panel @param {string} command @returns {boolean} */
  command(panel, command) {
    if (!panel.transferring || (command !== "CANCEL" && command !== "CAN"))
      return false;
    panel.deps.cancelTransfer();
    panel.message = "Canceling...";
    return true;
  },
};
