/**
 * The panel the others are reached from, and the help behind F1. Between them
 * they are the navigation: every other panel is one number away.
 */

import { PANELS, Panel, panelIdForOption, keyLegend } from "./panel.js";
import { keyLabel } from "./keymap.js";

/** @extends {Panel<import('./panel.js').PanelDeps>} */
export class MenuPage extends Panel {
  /** @param {import('./panel.js').PanelDeps} deps */
  constructor(deps) {
    super("menu", deps);
  }

  /**
   * @override
   * @returns {string} */
  title() {
    return "TN3270 Primary Option Menu";
  }

  /**
   * @override
   * @returns {string} */
  prompt() {
    return "Option ===> ";
  }

  /**
   * @override
   * @returns {number} */
  labelWidth() {
    return 12;
  }

  /**
   * @override
   * @returns {import('./panel.js').PanelLine[]} */
  lines() {
    return [
      ...PANELS.filter((panel) => panel.option !== "").map((panel) => ({
        option: panel.option,
        text: panel.name,
        value: panel.blurb,
      })),
      { option: "X", text: "Exit", value: "Back to the session" },
    ];
  }

  /**
   * @override
   * @returns {string[]} */
  notes() {
    return [
      "Type an option number here, or =0 to =3 from any panel to jump straight to it.",
    ];
  }

  /**
   * @override
   * @returns {string[]} */
  keys() {
    return keyLegend(this.deps, [
      ["PF1", "Help"],
      ["PF3", "Exit"],
      ["PF12", "Cancel"],
    ]);
  }

  /**
   * @override
   * @returns {void} */
  activate() {
    const option = this.lines()[this.selected]?.option ?? "";
    if (option === "X") {
      this.close();
      return;
    }
    const id = panelIdForOption(option);
    if (id !== null) this.deps.go(id);
  }
}

/**
 * A panel answers to the keymap, so the help names whatever keys carry these
 * commands rather than the ones they started out on.
 *
 * @type {readonly { commands: string[], what: string }[]}
 */
const PANEL_KEYS = Object.freeze([
  {
    commands: ["Enter"],
    what: "Run the command line, or pick the cursor's line",
  },
  { commands: ["PF1"], what: "This panel" },
  { commands: ["PF3"], what: "Exit: leave the panel the way you came in" },
  { commands: ["PF4"], what: "Menu: back to the primary option menu" },
  {
    commands: ["PF7", "PF8"],
    what: "Backward and forward through a long list",
  },
  {
    commands: ["PF12"],
    what: "Cancel: leave without applying what was typed",
  },
  {
    commands: ["Tab", "Newline"],
    what: "On to the next field; back one with Shift",
  },
  { commands: ["Up", "Down"], what: "Move the cursor a line at a time" },
  { commands: ["Attn"], what: "Out of the panel, whatever it was doing" },
  { commands: ["Left", "Right"], what: "Change the value the cursor is on" },
  { commands: ["Copy"], what: "Copy, in a panel as on the screen" },
  { commands: ["Paste"], what: "Paste, in a panel as on the screen" },
]);

/** @type {readonly { key: string, what: string }[]} */
const COMMANDS = Object.freeze([
  { key: "0 to 3, H", what: "Open that panel from the menu" },
  { key: "=0 to =3", what: "Jump to that panel from any panel" },
  { key: "END, X", what: "Leave this panel" },
  { key: "CANCEL", what: "Leave it without applying what was typed" },
  { key: "RETURN", what: "All the way back to the primary option menu" },
  { key: "HELP, ?", what: "This panel" },
]);

/** @type {readonly { key: string, what: string }[]} */
const SHORTCUTS = Object.freeze([
  ...PANELS.filter((panel) => panel.shortcut !== "").map((panel) => ({
    key: `Alt-${keyLabel(panel.shortcut)}`,
    what: panel.blurb,
  })),
  {
    key: "Ctrl-B then 1-4",
    what: "Aim the keyboard at that session; Shift lays out panes",
  },
]);

/** @extends {Panel<import('./panel.js').PanelDeps>} */
export class HelpPage extends Panel {
  /** @param {import('./panel.js').PanelDeps} deps */
  constructor(deps) {
    super("help", deps);
  }

  /**
   * @override
   * @returns {string} */
  title() {
    return "TN3270 Panel Help";
  }

  /**
   * @override
   * @returns {number} */
  labelWidth() {
    return 18;
  }

  /**
   * @override
   * @returns {import('./panel.js').PanelLine[]} */
  lines() {
    /** @type {import('./panel.js').PanelLine[]} */
    const lines = [];
    /**
     * @param {string} heading
     * @param {readonly { key: string, what: string }[]} entries
     */
    const section = (heading, entries) => {
      if (lines.length > 0) lines.push({ gap: true });
      lines.push({ text: heading, gap: true });
      for (const entry of entries)
        lines.push({ text: `  ${entry.key}`, value: entry.what });
    };
    section(
      "Keys in a panel",
      PANEL_KEYS.map((entry) => ({
        key: entry.commands
          .map((commandId) => this.deps.keyName(commandId))
          .filter((name) => name !== "")
          .join(" / "),
        what: entry.what,
      })).filter((entry) => entry.key !== ""),
    );
    section("Command line", COMMANDS);
    section("From the session", SHORTCUTS);
    return lines;
  }

  /**
   * @override
   * @returns {string[]} */
  keys() {
    return keyLegend(this.deps, [
      ["PF3", "Exit"],
      ["PF4", "Menu"],
      ["PF7", "Bkwd"],
      ["PF8", "Fwd"],
    ]);
  }
}
