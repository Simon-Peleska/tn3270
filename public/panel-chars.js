import { drawCodePageChart } from "./panel-font.js";

/** @type {import('./panels.js').PanelLayout} */
export const charsLayout = {
  title: "TN3270 Characters",
  lineCommands: false,

  render(panel, view) {
    view.say(1, 2, "Hex code ===>", "green");
    view.field("hex", 1, 16, 2, "", ["turquoise", "yellow"]);
    view.say(3, 2, "Click a character,", "turquoise");
    view.say(4, 2, "or move the cursor", "turquoise");
    view.say(5, 2, "to it and Enter.", "turquoise");
    view.say(7, 2, "4", "turquoise");
    view.say(7, 3, "0", "yellow");
    view.say(7, 4, "-F", "turquoise");
    view.say(7, 6, "F", "yellow");
    view.say(7, 7, " in hex", "turquoise");
    drawCodePageChart(
      view,
      panel.deps.codePage(),
      panel.deps.chart(),
      "yellow",
    );
  },

  input(panel, values) {
    const hex = values.hex?.trim() ?? "";
    if (hex === "") {
      const { row, col } = panel.host.cursor;
      if (!panel.chooseCharacterAt(row, col))
        panel.message = panel.problem(
          "E5033",
          "Choose a character or type its hex code",
        );
      return;
    }
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
      panel.message = panel.problem("E5034", "Enter a two-digit hex code");
      return;
    }
    panel.chooseCharacterByte(Number.parseInt(hex, 16));
  },
};

/** @param {string} chart @param {number} byte @returns {string | null} */
export function printableCharacter(chart, byte) {
  if (chart === "" || byte < 0x40 || byte > 0xff) return null;
  const glyph = chart[byte - 0x40];
  if (byte === 0x40) return " ";
  // Blank, or a space of its own, like the required space at 0x41.
  return glyph !== undefined && !/\s/u.test(glyph) ? glyph : null;
}
