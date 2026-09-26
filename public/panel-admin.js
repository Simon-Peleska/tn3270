/** @type {import('./panels.js').PanelLayout} */
export const adminLayout = {
  title: "TN3270 Sessions",
  listTop: 6,
  valueCol: 38,

  render(panel, view) {
    view.say(1, 2, "Command ===>", "green");
    view.field("command", 1, 15, 8, "");
    view.say(3, 3, "J=Join in a new tab   R/Enter=Refresh", "turquoise");
    view.say(
      5,
      3,
      "User / IP (session)                Started",
      "neutralWhite",
    );
    if (panel.adminLoading) view.say(6, 2, "Loading sessions...", "turquoise");
    else if (panel.adminSessions.length === 0)
      view.say(6, 2, "No open sessions", "turquoise");
  },

  items(panel) {
    return panel.adminSessions.map((session) => ({
      key: session.id,
      label: `${session.startedBy.slice(0, 23)} (${session.id.slice(0, 8)})`,
      value: new Date(session.startedAt).toLocaleString(),
      j: () => panel.deps.joinSession(session.id),
    }));
  },

  input(panel, values) {
    if (values.command?.trim()) return;
    if (
      Object.entries(values).some(
        ([key, value]) => key.startsWith("line:") && value.trim(),
      )
    )
      return;
    void panel.refreshAdmin();
  },

  command(panel, command) {
    if (command !== "R") return false;
    void panel.refreshAdmin();
    return true;
  },
};
