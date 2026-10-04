import { macroCommand } from "./keymap.js";

export const macrosLayout = {
  title: "TN3270 Macros",
  valueCol: 27,
  bottomReserve: 2,
  cursorOnCommand: true,

  /** @param {import('./panels.js').Panels} panel */
  opened(panel) {
    if (panel.deps.macros.macros.length === 0) macrosLayout.command(panel, "N");
  },

  /** @param {import('./panels.js').Panels} _panel @param {import('./panels.js').PanelView} view */
  render(_panel, view) {
    view.field("command", 2, 1, 3, "");
    view.say(
      2,
      5,
      "S=Run N=New R=Rename E=Edit K=Edit Keybind D=Delete",
      "turquoise",
    );
  },

  /** @param {import('./panels.js').Panels} panel @returns {import('./panels.js').Item[]} */
  items(panel) {
    const { macros, keymap } = panel.deps;
    return macros.macros.map((macro, index) => ({
      key: `macro:${macro.name}`,
      label: `${index + 1}. ${macro.name}`,
      value: `${macro.steps
        .flatMap((step) => [
          ...step.text.toUpperCase(),
          ...(step.action ? [step.action.toUpperCase()] : []),
        ])
        .join(", ")
        .slice(0, 30)
        .padEnd(
          34,
        )}${keymap.combosFor(macroCommand(macro.name)).length ? `Keybind ${keymap.labelFor(macroCommand(macro.name))}` : ""}`,
      s: () => run(panel, macro),
      e: () => panel.push(`macro:${macro.name}`),
      k: () => panel.push(`keys:${macroCommand(macro.name)}`),
      editOn: "r",
      edit: {
        value: macro.name,
        commit: (text) => {
          if (!text.trim())
            return panel.problem("E5020", "A macro needs a name");
          macros.rename(macros.macros.indexOf(macro), text.trim());
          return null;
        },
      },
      d: () => macros.remove(macros.macros.indexOf(macro)),
    }));
  },

  /** @param {import('./panels.js').Panels} panel @param {string} command @returns {boolean} */
  command(panel, command) {
    const { macros } = panel.deps;
    if (/^\d+$/.test(command)) {
      const macro = macros.macros[Number(command) - 1];
      if (macro === undefined)
        panel.message = panel.problem("E5041", `There is no macro ${command}`);
      else run(panel, macro);
      return true;
    }
    if (command !== "N") return false;
    const name = macros.suggestedName();
    macros.macros.push({ name, steps: [] });
    macros.deps.persist(macros.macros);
    panel.push(`macro:${name}`);
    return true;
  },
};

/** @param {import('./panels.js').Panels} panel @param {import('./macros.js').Macro} macro */
function run(panel, macro) {
  panel.close();
  panel.deps.macros.play(macro);
}

export const macroEditLayout = {
  /** @param {import('./panels.js').Panels} panel */
  lineCommands(panel) {
    return !panel.macroCapture;
  },

  /** @param {import('./panels.js').Panels} panel @param {string} id */
  opened(panel, id) {
    const macro = panel.deps.macros.macros.find(
      (entry) => entry.name === id.slice(6),
    );
    if (macro?.steps.length === 0) panel.startMacroCapture(0);
  },

  /** @param {import('./panels.js').Panels} panel @param {import('./panels.js').PanelView} view */
  render(panel, view) {
    if (panel.macroCapture) {
      view.say(2, 3, "F5=Done  Shift+F5=PF5", "turquoise");
      return;
    }
    view.field("command", 2, 1, 1, "");
    view.say(2, 3, "E=Edit A=Add C=Cursor Move D=Delete F5=Exit", "turquoise");
  },

  /** @param {import('./panels.js').Panels} panel @param {string} id @returns {string} */
  title(panel, id) {
    return `TN3270 Macro - ${id.slice(6)}`;
  },

  /** @param {import('./panels.js').Panels} panel @param {string} id @returns {import('./panels.js').Item[]} */
  items(panel, id) {
    const { macros } = panel.deps;
    const macro = macros.macros.find((entry) => entry.name === id.slice(6));
    if (macro === undefined) return [];
    /** @type {import('./panels.js').Item[]} */
    const items = macro.steps.map((step, index) => ({
      key: String(index),
      label: `Step ${index + 1}`,
      value: step.text || `${step.action}${step.args.join("")}`,
      e: () => panel.startMacroCapture(index, true),
      a: () => panel.startMacroCapture(index + 1),
      c: () => panel.openMacroCursor(index + 1),
      d: () => {
        const removedAt = macro.steps.indexOf(step);
        macro.steps.splice(removedAt, 1);
        macros.deps.persist(macros.macros);
        panel.focus =
          macro.steps.length === 0
            ? "line:new"
            : `line:${Math.min(removedAt, macro.steps.length - 1)}`;
      },
      edit: {
        value: step.text || `${step.action}${step.args.join("")}`,
        open: panel.macroCapture,
        commit: (text) => {
          if (text === (step.text || `${step.action}${step.args.join("")}`))
            return null;
          if (text === "") {
            macro.steps.splice(macro.steps.indexOf(step), 1);
            macros.deps.persist(macros.macros);
            return null;
          }
          if ([...text].length !== 1)
            return panel.problem("E5024", "Press one key per step");
          step.text = text;
          step.action = "";
          step.args = [];
          macros.deps.persist(macros.macros);
          return null;
        },
      },
    }));
    if (panel.macroCapture) {
      if (panel.macroInsertAt !== null)
        items.splice(panel.macroInsertAt, 0, {
          key: "insert",
          label: "New step",
          edit: {
            value: "",
            open: true,
            commit: (text) =>
              text === ""
                ? null
                : panel.problem("E5025", "Press one key per step"),
          },
        });
      return items;
    }

    items.push({
      key: "new",
      label: "New step",
      a: () => panel.startMacroCapture(macro.steps.length),
      c: () => panel.openMacroCursor(macro.steps.length),
    });
    return items;
  },

  /** @param {import('./panels.js').Panels} panel @param {string} command @param {string} id */
  command(panel, command, id) {
    if (command !== "C") return false;
    panel.openMacroCursor(
      panel.deps.macros.macros.find((macro) => macro.name === id.slice(6))
        ?.steps.length ?? 0,
    );
    return true;
  },
};

export const macroCursorLayout = {
  title: "TN3270 Add Cursor Move",

  /** @param {import('./panels.js').Panels} _panel @param {import('./panels.js').PanelView} view */
  render(_panel, view) {
    view.say(1, 1, "X", "green");
    view.field("x", 1, 3, 3, "");
    view.say(1, 9, "Y", "green");
    view.field("y", 1, 11, 3, "");
    view.say(2, 1, "Enter=Add  Click a host cell below", "turquoise");
  },

  /** @param {import('./panels.js').Panels} panel @param {Record<string, string>} values */
  input(panel, values) {
    const x = Number(values.x?.trim());
    const y = Number(values.y?.trim());
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 1 ||
      x > panel.host.cols ||
      y < 1 ||
      y >= panel.host.rows
    ) {
      panel.message = panel.problem("E5023", "Enter a valid X and Y");
      return;
    }
    panel.addMacroCursorMove(y - 1, x - 1);
  },
};
