/** @type {import('./panels.js').PanelLayout} */
export const adminLayout = {
  title: "TN3270 Sessions",
  listTop: 6,
  valueCol: 38,

  render(panel, view) {
    view.say(1, 1, "Command ===>", "green");
    view.field("command", 1, 14, 1, "");
    const canKill = panel.adminSessions.some((session) =>
      panel.deps.ownsSession(session.id),
    );
    view.say(
      3,
      1,
      `J=Join ${canKill ? "K=Kill " : ""}R/Enter=Refresh`,
      "turquoise",
    );
    view.say(
      5,
      3,
      "User / IP (session)                Started",
      "neutralWhite",
    );
    if (panel.adminLoading && panel.adminSessions.length === 0)
      view.say(6, 3, "Loading sessions...", "turquoise");
    else if (panel.adminSessions.length === 0)
      view.say(6, 3, "No open sessions", "turquoise");
  },

  items(panel) {
    return panel.adminSessions.map((session) => ({
      key: session.id,
      label: `${session.startedBy.slice(0, 23)} (${session.id.slice(0, 8)})`,
      value: new Date(session.startedAt).toLocaleString(),
      j: () => panel.deps.joinSession(session.id),
      k: panel.deps.ownsSession(session.id)
        ? () => panel.terminateSession(session.id)
        : undefined,
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
