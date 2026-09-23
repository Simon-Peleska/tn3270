import { Grid } from "../public/grid.js";
import {
  DEFAULT_BINDINGS,
  buildLookup,
  commandForEvent,
  comboLabel,
} from "../public/keymap.js";

/**
 * The frontend only ever reads a handful of fields off a keyboard event, so a
 * plain object is a faithful stand-in and none of the key tests need a browser.
 * A key that prints no character reports the same name as its position, so only
 * a letter or a digit has to be given both.
 *
 * @param {{ key?: string, code?: string, ctrlKey?: boolean, altKey?: boolean,
 *   metaKey?: boolean, shiftKey?: boolean, repeat?: boolean }} init
 * @returns {KeyboardEvent}
 */
export function key(init) {
  const pressed = init.key ?? "";
  return /** @type {KeyboardEvent} */ ({
    key: pressed,
    code: init.code ?? ([...pressed].length === 1 ? "" : pressed),
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    repeat: init.repeat ?? false,
  });
}

/**
 * The 3270 Enter, which is the AID key: right Ctrl by default, not the key
 * marked Enter, which is Newline.
 *
 * @returns {KeyboardEvent}
 */
export function enterKey() {
  return key({ key: "Control", code: "ControlRight", ctrlKey: true });
}

/**
 * A panel reads its keys through the keymap, so a panel under test is given one.
 *
 * @param {import('../public/keymap.js').Bindings} bindings
 * @returns {{ keyCommand: (event: KeyboardEvent) => string | null,
 *   keyName: (commandId: string) => string }}
 */
export function keymapDeps(bindings) {
  const lookup = buildLookup(bindings);
  return {
    keyCommand: (event) => commandForEvent(event, lookup),
    keyName: (commandId) => {
      const first = bindings[commandId]?.[0];
      return first === undefined ? "" : comboLabel(first);
    },
  };
}

export const defaultKeymapDeps = keymapDeps(DEFAULT_BINDINGS);

/**
 * The panel never draws itself: it asks the page to draw the whole pane, which
 * hands it a grid back. Here that is this, on demand.
 *
 * @param {{ drawInto: (grid: Grid) => void }} page
 * @returns {Grid} 80x25, the overlay of a model 2 pane
 */
export function drawn(page) {
  const grid = new Grid(25, 80, null);
  page.drawInto(grid);
  return grid;
}

/**
 * The grid cuts anything past the last column rather than wrapping it, so an
 * overrun is silent. This catches it where it is written instead of where it
 * lands, by recording every `put` the page makes.
 *
 * @param {{ drawInto: (grid: Grid) => void }} page
 * @returns {{ col: number, text: string }[]}
 */
export function recordedPuts(page) {
  /** @type {{ col: number, text: string }[]} */
  const puts = [];
  const grid = new Grid(25, 80, null);
  const put = grid.put.bind(grid);
  grid.put = (row, col, text, style) => {
    puts.push({ col, text });
    put(row, col, text, style);
  };
  page.drawInto(grid);
  return puts;
}
