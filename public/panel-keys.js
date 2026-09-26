import {
  COMMANDS,
  comboLabel,
  isMacroCommand,
  macroCommand,
  parseCombo,
  serializeCombo,
} from "./keymap.js";

/** @param {import('./panels.js').Panels} panel */
function commands(panel) {
  return [
    ...COMMANDS,
    ...panel.deps.macros.macros.map((macro) => ({
      id: macroCommand(macro.name),
      label: `Macro ${macro.name}`,
    })),
  ];
}

export const keysLayout = {
  title: "TN3270 Keys",
  bottomReserve: 2,
  messageBottomOffset: 2,

  /** @param {import('./panels.js').Panels} _panel @param {import('./panels.js').PanelView} view */
  render(_panel, view) {
    view.say(1, 1, "A=Add E=Edit D=Delete R=Reset", "turquoise");
    view.say(3, 3, "Reset all", "green");
    view.field("resetAll", 3, 13, 1, "N");
    view.say(3, 15, "[Y/N]", "turquoise");
  },

  /** @param {import('./panels.js').Panels} panel @returns {import('./panels.js').Item[]} */
  items(panel) {
    const { keymap } = panel.deps;
    return commands(panel).map((command) => ({
      key: command.id,
      label: command.label,
      value: keymap.combosFor(command.id).map(comboLabel).join(", "),
      a: () => {
        panel.push(`keys:${command.id}`);
        panel.editing.add("new");
      },
      e: () => panel.push(`keys:${command.id}`),
      d: () => keymap.unbind(command.id),
      r: isMacroCommand(command.id)
        ? undefined
        : () => keymap.resetCommand(command.id),
    }));
  },

  /** @param {import('./panels.js').Panels} panel @param {Record<string, string>} values */
  input(panel, values) {
    if (values.resetAll?.trim().toUpperCase() === "Y")
      panel.deps.keymap.resetAll();
  },

  /** @param {import('./panels.js').Panels} panel @param {string} command @returns {boolean} */
  command(panel, command) {
    if (command !== "RESET") return false;
    panel.deps.keymap.resetAll();
    return true;
  },
};

export const bindingsLayout = {
  listTop: 3,

  /** @param {import('./panels.js').Panels} panel @param {string} id @returns {string} */
  title(panel, id) {
    const command = id.slice(5);
    return `TN3270 Keys - ${commands(panel).find((entry) => entry.id === command)?.label ?? command}`;
  },

  /** @param {import('./panels.js').Panels} _panel @param {import('./panels.js').PanelView} view */
  render(_panel, view) {
    view.say(1, 1, "A=Add E=Edit D=Delete", "turquoise");
  },

  /** @param {import('./panels.js').Panels} panel @param {string} frameId @returns {import('./panels.js').Item[]} */
  items(panel, frameId) {
    const id = frameId.slice(5);
    const { keymap } = panel.deps;
    /** @param {string} text @param {(combo: import('./keymap.js').Combo) => void} take */
    const bind = (text, take) => {
      const combo = parseCombo(text);
      if (combo === null)
        return panel.problem("E5018", `No key is called ${text.trim()}`);
      take(combo);
      return null;
    };
    /** @type {import('./panels.js').Item[]} */
    const items = keymap.combosFor(id).map((combo) => {
      const serial = serializeCombo(combo);
      const index = () =>
        keymap
          .combosFor(id)
          .findIndex((each) => serializeCombo(each) === serial);
      return {
        key: serial,
        label: "",
        value: comboLabel(combo),
        edit: {
          value: comboLabel(combo),
          commit: (text) =>
            bind(text, (picked) => keymap.setCombo(id, index(), picked)),
        },
        d: () => keymap.removeCombo(id, index()),
      };
    });
    items.push({
      key: "new",
      label: "",
      value: "New keybind",
      a: () => panel.editing.add("new"),
      edit: {
        value: "",
        commit: (text) =>
          text.trim()
            ? bind(text, (picked) =>
                keymap.setCombo(id, keymap.combosFor(id).length, picked),
              )
            : null,
      },
    });
    return items;
  },

  /** @param {import('./panels.js').Panels} panel @param {string} command @param {string} id @returns {boolean} */
  command(panel, command, id) {
    if (command !== "RESET") return false;
    panel.deps.keymap.resetCommand(id.slice(5));
    return true;
  },
};
