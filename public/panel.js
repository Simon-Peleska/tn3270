/**
 * The frame every dialog is drawn in, copied from the panels TSO/ISPF puts on a
 * 3270: an action bar across the top, a title, a command line you type an option
 * into, the body, and the PF keys along the bottom. The pages own their own
 * contents; everything about the shape of a panel lives here.
 */

/** @typedef {import('./settings.js').Theme} Theme */

export const ESC = "\x1b";

/**
 * The panels the action bar lists, in the order their numbers run. The menu has
 * no number of its own: you get back to it with F4, or by naming it. The
 * shortcut is the Alt+code that opens the panel from the session, and the label
 * beside it is how the help panel spells that key.
 *
 * @type {readonly { id: string, option: string, name: string, blurb: string, shortcut: string, shortcutLabel: string }[]}
 */
export const PANELS = Object.freeze([
  {
    id: "menu",
    option: "",
    name: "Menu",
    blurb: "The panel every other one is reached from",
    shortcut: "Space",
    shortcutLabel: "Alt-Space",
  },
  {
    id: "settings",
    option: "0",
    name: "Settings",
    blurb: "Colours, font, screen size and sharing",
    shortcut: "Comma",
    shortcutLabel: "Alt-,",
  },
  {
    id: "macros",
    option: "1",
    name: "Macros",
    blurb: "Record, play back and trade keystroke macros",
    shortcut: "KeyM",
    shortcutLabel: "Alt-M",
  },
  {
    id: "recorder",
    option: "2",
    name: "Recorder",
    blurb: "Capture screens and keys as a script",
    shortcut: "KeyR",
    shortcutLabel: "Alt-R",
  },
  {
    id: "keymap",
    option: "3",
    name: "Keys",
    blurb: "What each key and key combination does",
    shortcut: "KeyK",
    shortcutLabel: "Alt-K",
  },
  {
    id: "help",
    option: "H",
    name: "Help",
    blurb: "The keys and commands panels answer to",
    shortcut: "",
    shortcutLabel: "",
  },
]);

/**
 * @param {string} option
 * @returns {string | null} the panel id, or null when nothing has that number
 */
export function panelIdForOption(option) {
  const wanted = option.trim().toUpperCase();
  const found = PANELS.find(
    (panel) => panel.option !== "" && panel.option === wanted,
  );
  return found?.id ?? null;
}

/**
 * @param {string} hex `#rrggbb`
 * @returns {[number, number, number]}
 */
function rgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * @param {string} from
 * @param {string} to
 * @param {number} amount 0 = from, 1 = to
 * @returns {string} `#rrggbb`
 */
function mix(from, to, amount) {
  const a = rgb(from);
  const b = rgb(to);
  const channel = (/** @type {number} */ index) =>
    Math.round(a[index] + (b[index] - a[index]) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/**
 * @param {number} row 1-based
 * @param {number} col 1-based
 * @returns {string}
 */
function at(row, col) {
  return `${ESC}[${row};${col}H`;
}

/**
 * ghostty-web reads 0x000000 as "not set" and falls back to grey.
 *
 * @param {Theme} theme
 * @returns {Record<string, string>}
 */
export function terminalColors(theme) {
  /** @type {Record<string, string>} */
  const colors = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    colors[key] = value.toLowerCase() === "#000000" ? "#010101" : value;
  }
  return colors;
}

/**
 * @param {string} fg `#rrggbb`
 * @param {string} bg `#rrggbb`
 * @param {boolean} [bold]
 * @returns {string}
 */
export function paint(fg, bg, bold = false) {
  const [fr, fg2, fb] = rgb(fg);
  let [br, bg2, bb] = rgb(bg);
  // The renderer skips a (0, 0, 0) fill, taking it for the cleared canvas.
  if (br === 0 && bg2 === 0 && bb === 0) [br, bg2, bb] = [1, 1, 1];
  return `${ESC}[0${bold ? ";1" : ""};38;2;${fr};${fg2};${fb};48;2;${br};${bg2};${bb}m`;
}

/**
 * @param {number} index
 * @param {number} step
 * @param {number} length
 * @returns {number}
 */
export function cycle(index, step, length) {
  return (index + step + length) % length;
}

/**
 * @param {Theme} theme
 * @returns {{ background: string, foreground: string, dim: string, field: string, chosen: string, warn: string }}
 */
function panelColors(theme) {
  const colors = theme.colors;
  const background = colors["background"] ?? "#000000";
  const foreground = colors["foreground"] ?? "#00ff00";
  const field = colors["field"] ?? mix(background, foreground, 0.12);
  return {
    background,
    foreground,
    dim: mix(background, foreground, 0.55),
    field,
    chosen: mix(field, foreground, 0.3),
    warn: rgb(background)[0] > 128 ? "#a02c00" : "#ffcc00",
  };
}

// Column 1 is left clear the way a 3270 panel leaves room for its attribute byte.
const OPTION_LEFT = 4;
export const TEXT_LEFT = 8;
const ROW_TITLE = 3;
export const ROW_COMMAND = 4;
const ROW_MESSAGE = 5;
export const BODY_TOP = 7;

/**
 * The same for every panel and every paint, so it is built once.
 *
 * @type {{ text: string, spans: { id: string, name: string, start: number, end: number }[] }} 1-based columns
 */
export const ACTION_BAR = (() => {
  let text = " ";
  /** @type {{ id: string, name: string, start: number, end: number }[]} */
  const spans = [];
  for (const panel of PANELS) {
    const start = text.length + 1;
    text += panel.name;
    spans.push({ id: panel.id, name: panel.name, start, end: text.length });
    text += "  ";
  }
  return { text, spans };
})();

/**
 * How many body lines a panel of this height holds.
 *
 * @param {number} rows
 * @returns {number}
 */
export function bodyHeight(rows) {
  return Math.max(1, rows - BODY_TOP - 1);
}

/**
 * @param {string} label
 * @param {number} width
 * @returns {string} `Theme . . . . . . .`, the leader every ISPF form uses
 */
export function dotted(label, width) {
  if (label.length + 2 > width) return label.slice(0, width).padEnd(width);
  return `${label} ${". ".repeat(Math.ceil((width - label.length) / 2))}`.slice(
    0,
    width,
  );
}

/**
 * @typedef {object} PanelLine
 * @property {string} [option] what to type on the command line to pick this line
 * @property {string} [text]
 * @property {string} [value] shown to the right of the text
 * @property {boolean} [dots] dot leaders between text and value, as a form panel has
 * @property {boolean} [field] draw the value as a typeable field rather than plain text
 * @property {boolean} [gap] a heading or a spacer: the cursor steps over it
 * @property {number} [cursor] where in the value field the cursor belongs
 * @property {boolean} [selected] the line the cursor sits on
 */

/**
 * @typedef {object} PanelView
 * @property {(bytes: string) => void} write
 * @property {() => { cols: number, rows: number }} geometry
 * @property {Theme} theme
 * @property {string} panel the id of the panel being drawn
 * @property {string} title
 * @property {string} [prompt] `Option ===> ` on a menu, `Command ===> ` elsewhere
 * @property {string} command what has been typed on the command line
 * @property {boolean} onCommand whether the cursor sits on the command line
 * @property {PanelLine[]} body already windowed by the page
 * @property {number} [first] index of body[0] in the whole list, for the More: flags
 * @property {number} [total]
 * @property {number} [labelWidth]
 * @property {string} [message] a short message, shown against the title
 * @property {string[]} [notes]
 * @property {string[]} keys the PF key legend along the bottom
 */

/**
 * @param {PanelView} view
 * @returns {void}
 */
function drawPanel(view) {
  const { cols, rows } = view.geometry();
  const { background, foreground, dim, field, chosen, warn } = panelColors(
    view.theme,
  );
  const labelWidth = view.labelWidth ?? 24;
  const prompt = view.prompt ?? "Command ===> ";
  const first = view.first ?? 0;
  const total = view.total ?? view.body.length;

  /** @type {string[]} */
  const out = [paint(foreground, background), `${ESC}[2J`];
  /**
   * Autowrap is off, so anything past the last column is cut, not wrapped.
   * @param {number} row
   * @param {number} col
   * @param {string} style
   * @param {string} text
   */
  const place = (row, col, style, text) => {
    if (row < 1 || row > rows || col > cols) return;
    out.push(at(row, col), style, text.slice(0, cols - col + 1));
  };

  place(1, 1, paint(dim, background), ACTION_BAR.text);
  for (const span of ACTION_BAR.spans) {
    if (span.id === view.panel)
      place(1, span.start, paint(background, foreground, true), span.name);
  }
  place(2, 1, paint(dim, background), "─".repeat(cols));

  const title = view.title.slice(0, cols - 4);
  place(
    ROW_TITLE,
    Math.max(1, Math.floor((cols - title.length) / 2) + 1),
    paint(foreground, background, true),
    title,
  );
  if (view.message !== undefined && view.message !== "") {
    const text = view.message.slice(0, Math.max(0, cols - 22));
    place(
      ROW_TITLE,
      Math.max(1, cols - text.length),
      paint(warn, background, true),
      text,
    );
  }

  const commandLeft = 2 + prompt.length;
  const commandWidth = Math.max(4, cols - commandLeft - 11);
  place(ROW_COMMAND, 2, paint(foreground, background), prompt);
  place(
    ROW_COMMAND,
    commandLeft,
    paint(foreground, view.onCommand ? chosen : field),
    view.command.slice(-commandWidth).padEnd(commandWidth),
  );
  const more = `${first > 0 ? "-" : " "}${first + view.body.length < total ? "+" : " "}`;
  if (more !== "  ")
    place(ROW_COMMAND, cols - 8, paint(dim, background), `More: ${more}`);

  let row = ROW_MESSAGE;
  for (const note of view.notes ?? []) {
    place(row, 2, paint(dim, background), note);
    row += 1;
  }

  view.body.forEach((line, index) => {
    const bodyRow = BODY_TOP + index;
    if (bodyRow >= rows) return;
    const style = paint(
      line.selected === true ? foreground : dim,
      background,
      line.selected === true,
    );
    if (line.option !== undefined)
      place(
        bodyRow,
        OPTION_LEFT,
        paint(foreground, background, true),
        line.option.padStart(2),
      );
    const text = line.text ?? "";
    if (text !== "")
      place(
        bodyRow,
        TEXT_LEFT,
        style,
        line.dots === true ? dotted(text, labelWidth) : text.padEnd(labelWidth),
      );
    const value = line.value ?? "";
    if (value === "") return;
    const valueLeft = TEXT_LEFT + labelWidth + 1;
    if (line.field === true) {
      place(
        bodyRow,
        valueLeft,
        paint(foreground, line.selected === true ? chosen : field),
        ` ${value} `,
      );
    } else {
      place(
        bodyRow,
        valueLeft,
        paint(line.selected === true ? foreground : dim, background),
        value,
      );
    }
  });

  place(rows, 2, paint(dim, background), view.keys.join("  "));

  // The cursor is the panel's, and it has to be put back after the paint or it
  // sits wherever the last write left it.
  const onIndex = view.body.findIndex((line) => line.selected === true);
  const cursorRow = view.onCommand ? ROW_COMMAND : BODY_TOP + onIndex;
  const cursorCol = view.onCommand
    ? Math.min(
        cols,
        commandLeft + Math.min(view.command.length, commandWidth - 1),
      )
    : TEXT_LEFT + labelWidth + 2 + (view.body[onIndex]?.cursor ?? 0);
  out.push(
    at(
      Math.max(1, Math.min(rows, cursorRow)),
      Math.max(1, Math.min(cols, cursorCol)),
    ),
    `${ESC}[?25h`,
  );

  view.write(out.join(""));
}

/**
 * The PF keys an ISPF panel answers to. Escape is not one of them, but every
 * browser habit says it closes a dialog, so it ends the panel like F3.
 *
 * @param {KeyboardEvent} event
 * @returns {'help' | 'end' | 'return' | 'cancel' | 'backward' | 'forward' | 'up' | 'down' | 'left' | 'right' | 'tab' | 'submit' | null}
 */
function panelAction(event) {
  if (event.ctrlKey || event.metaKey) return null;
  switch (event.key) {
    case "F1":
      return "help";
    case "F3":
    case "Escape":
      return "end";
    case "F4":
      return "return";
    case "F7":
    case "PageUp":
      return "backward";
    case "F8":
    case "PageDown":
      return "forward";
    case "F12":
      return "cancel";
    case "Enter":
      return "submit";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "Tab":
      return "tab";
    default:
      return null;
  }
}

/**
 * @param {string} text
 * @param {KeyboardEvent} event
 * @returns {string | null} the text after the key, or null when it was not for it
 */
export function typeKey(text, event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === "Backspace") return text.slice(0, -1);
  if (event.key.length === 1) return text + event.key;
  return null;
}

/**
 * @typedef {{ kind: 'none' } | { kind: 'jump', option: string } | { kind: 'end' } |
 *   { kind: 'cancel' } | { kind: 'return' } | { kind: 'help' } |
 *   { kind: 'select', option: string } | { kind: 'word', word: string }} PanelCommand
 */

/**
 * What was typed on the command line. `=n` jumps to a panel from anywhere, a
 * bare number picks a line on this one, and the rest are ISPF's own verbs.
 *
 * @param {string} input
 * @returns {PanelCommand}
 */
export function parseCommand(input) {
  const text = input.trim().toUpperCase();
  if (text === "") return { kind: "none" };
  if (text.startsWith("=")) return { kind: "jump", option: text.slice(1) };
  if (text === "END" || text === "EXIT" || text === "X") return { kind: "end" };
  if (text === "CAN" || text === "CANCEL") return { kind: "cancel" };
  if (text === "RET" || text === "RETURN" || text === "MENU")
    return { kind: "return" };
  if (text === "HELP" || text === "?") return { kind: "help" };
  if (/^[0-9]+$/.test(text)) return { kind: "select", option: text };
  return { kind: "word", word: text };
}

/**
 * @typedef {object} PanelDeps
 * @property {(bytes: string) => void} write
 * @property {() => { cols: number, rows: number }} geometry
 * @property {() => Theme} [theme] the panel's own theme wins where a page has one
 * @property {() => void} end this panel is finished: back where it was opened from
 * @property {(id: string) => void} go open another panel
 */

/**
 * What every panel does the same way: the command line, the cursor, scrolling
 * and the PF keys. A page says what its lines are and what picking one does.
 *
 * @template {PanelDeps} D the page's own dependencies, on top of a panel's
 */
export class Panel {
  /**
   * @param {string} id
   * @param {D} deps
   */
  constructor(id, deps) {
    this.id = id;
    this.deps = deps;
    /** @type {string} the Alt+key code that opens this panel, '' for none */
    this.toggleKey = PANELS.find((panel) => panel.id === id)?.shortcut ?? "";
    /** @type {boolean} */
    this.open = false;
    /** @type {string} what has been typed on the command line */
    this.command = "";
    /** @type {boolean} The cursor starts on the command line, as ISPF's does. */
    this.onCommand = true;
    /** @type {number} index into lines() */
    this.selected = 0;
    /** @type {number} index of the first line on screen */
    this.scroll = 0;
    /** @type {string} the short message shown against the title */
    this.message = "";
  }

  /** @returns {PanelLine[]} */
  lines() {
    return [];
  }

  /** @returns {string} */
  title() {
    return "";
  }

  /** @returns {string[]} */
  keys() {
    return ["F1=Help", "F3=Exit", "F4=Menu", "F7=Bkwd", "F8=Fwd", "F12=Cancel"];
  }

  /** @returns {string[]} */
  notes() {
    return [];
  }

  /** @returns {number} */
  labelWidth() {
    return 24;
  }

  /** @returns {string} */
  prompt() {
    return "Command ===> ";
  }

  /** @returns {Theme} */
  panelTheme() {
    return /** @type {Theme} */ (this.deps.theme?.());
  }

  /** @returns {void} Enter on the line the cursor is on. */
  activate() {}

  /**
   * @param {number} _step -1 or 1
   * @returns {void} Left or Right on the line the cursor is on.
   */
  change(_step) {}

  /**
   * @param {string} _word a command line word this panel may know
   * @returns {boolean} true when it was one
   */
  word(_word) {
    return false;
  }

  /**
   * @param {KeyboardEvent} _event
   * @returns {boolean} true when the page's own field took the key
   */
  typed(_event) {
    return false;
  }

  /**
   * @param {string} _text typed or pasted
   * @returns {boolean} true when the page's own field took it
   */
  insert(_text) {
    return false;
  }

  /**
   * @param {KeyboardEvent} _event
   * @returns {boolean} true when a modal state of the page took the key first
   */
  override(_event) {
    return false;
  }

  /**
   * A page opening on something other than its first line sets that between the
   * reset and the draw, so the panel is painted once and already right.
   *
   * @returns {void}
   */
  reset() {
    this.open = true;
    this.command = "";
    this.onCommand = true;
    this.message = "";
    this.scroll = 0;
    this.selected = 0;
  }

  /** @returns {void} */
  show() {
    this.reset();
    this.draw();
  }

  /** @returns {void} Leave without asking for the screen back: another panel follows. */
  hide() {
    this.open = false;
  }

  /** @returns {void} */
  close() {
    if (!this.open) return;
    this.hide();
    this.deps.end();
  }

  /** @returns {void} F12, which in ISPF throws away what was typed. */
  cancel() {
    this.close();
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  say(message) {
    this.message = message;
    this.draw();
  }

  /**
   * The command line and the lines that can be picked, as one list the cursor
   * walks round; -1 is the command line.
   *
   * @returns {number[]}
   */
  stops() {
    /** @type {number[]} */
    const stops = [-1];
    this.lines().forEach((line, index) => {
      if (line.gap !== true) stops.push(index);
    });
    return stops;
  }

  /**
   * @param {number} step
   * @returns {void}
   */
  move(step) {
    const stops = this.stops();
    const current = this.onCommand
      ? 0
      : Math.max(0, stops.indexOf(this.selected));
    const next = stops[cycle(current, step, stops.length)] ?? -1;
    this.onCommand = next === -1;
    if (next >= 0) this.selected = next;
    this.draw();
  }

  /**
   * @param {number} step -1 for F7, 1 for F8
   * @returns {void}
   */
  scrollBy(step) {
    const height = bodyHeight(this.deps.geometry().rows);
    const last = Math.max(0, this.lines().length - height);
    this.scroll = Math.max(0, Math.min(this.scroll + step * height, last));
    const first = this.stops().find(
      (index) => index >= this.scroll && index < this.scroll + height,
    );
    if (first !== undefined) {
      this.onCommand = false;
      this.selected = first;
    }
    this.draw();
  }

  /**
   * @param {string} option
   * @returns {boolean} true when a line carries that number
   */
  pick(option) {
    const index = this.lines().findIndex((line) => line.option === option);
    if (index === -1) return false;
    this.selected = index;
    this.onCommand = false;
    this.activate();
    return true;
  }

  /** @returns {void} */
  submit() {
    const parsed = parseCommand(this.command);
    const typed = this.command;
    this.command = "";
    if (parsed.kind === "none") {
      this.activate();
      return;
    }
    if (parsed.kind === "end") {
      this.close();
      return;
    }
    if (parsed.kind === "cancel") {
      this.cancel();
      return;
    }
    if (parsed.kind === "return") {
      this.deps.go("menu");
      return;
    }
    if (parsed.kind === "help") {
      this.deps.go("help");
      return;
    }
    if (parsed.kind === "jump") {
      const id = panelIdForOption(parsed.option);
      if (id === null) this.say(`No panel is numbered ${parsed.option}`);
      else this.deps.go(id);
      return;
    }
    if (parsed.kind === "select") {
      if (!this.pick(parsed.option))
        this.say(`No line is numbered ${parsed.option}`);
      return;
    }
    // A word this panel knows, a panel named in the action bar, or nothing.
    if (this.word(parsed.word)) return;
    const named = PANELS.find(
      (panel) => panel.name.toUpperCase() === parsed.word,
    );
    if (named !== undefined) this.deps.go(named.id);
    else if (!this.pick(parsed.word))
      this.say(`${typed.trim()} is not a command here`);
  }

  /**
   * @param {KeyboardEvent} event
   * @returns {boolean} true when the panel consumed the key
   */
  handleKey(event) {
    if (!this.open) return false;
    if (this.override(event)) return true;
    // Reload, devtools, copy and paste belong to the browser even here.
    if (event.ctrlKey || event.metaKey) return false;

    const action = panelAction(event);
    if (action === "help") {
      this.deps.go("help");
      return true;
    }
    if (action === "end") {
      this.close();
      return true;
    }
    if (action === "return") {
      this.deps.go("menu");
      return true;
    }
    if (action === "cancel") {
      this.cancel();
      return true;
    }
    if (action === "up" || action === "down" || action === "tab") {
      this.move(action === "up" ? -1 : 1);
      return true;
    }
    if (action === "backward" || action === "forward") {
      this.scrollBy(action === "backward" ? -1 : 1);
      return true;
    }
    if (action === "left" || action === "right") {
      if (!this.onCommand) {
        this.change(action === "left" ? -1 : 1);
        this.draw();
      }
      return true;
    }
    if (action === "submit") {
      this.message = "";
      this.submit();
      return true;
    }
    if (!this.onCommand && this.typed(event)) return true;

    const typed = typeKey(this.command, event);
    if (typed !== null) {
      this.command = typed;
      this.onCommand = true;
      this.message = "";
      this.draw();
    }
    // Swallow the rest: the host must not see keys aimed at a panel.
    return true;
  }

  /**
   * @param {string} text what the clipboard holds
   * @returns {void}
   */
  paste(text) {
    const line = text.split(/[\r\n]/)[0] ?? "";
    if (line === "") return;
    if (this.onCommand || !this.insert(line)) {
      this.command += line;
      this.onCommand = true;
    }
    this.draw();
  }

  /** @returns {string} what the cursor is on, for a copy with nothing selected */
  copy() {
    if (this.onCommand) return this.command;
    const line = this.lines()[this.selected];
    return line === undefined ? "" : (line.value ?? line.text ?? "");
  }

  /**
   * @param {number} row 1-based terminal row
   * @param {number} col 1-based terminal column
   * @returns {void} where a click in the panel puts the cursor
   */
  clicked(row, col) {
    if (row === 1) {
      const hit = ACTION_BAR.spans.find(
        (span) => col >= span.start && col <= span.end,
      );
      if (hit !== undefined) this.deps.go(hit.id);
      return;
    }
    if (row === ROW_COMMAND) {
      this.onCommand = true;
      this.draw();
      return;
    }
    if (row < BODY_TOP) return;
    const index = row - BODY_TOP;
    const line = this.lines()[this.scroll + index];
    if (line === undefined || line.gap === true) return;
    this.onCommand = false;
    this.selected = this.scroll + index;
    this.draw();
  }

  /** @returns {void} */
  draw() {
    const lines = this.lines();
    const height = bodyHeight(this.deps.geometry().rows);
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + height)
      this.scroll = this.selected - height + 1;
    this.scroll = Math.max(
      0,
      Math.min(this.scroll, Math.max(0, lines.length - height)),
    );

    const body = lines
      .slice(this.scroll, this.scroll + height)
      .map((line, index) => ({
        ...line,
        selected: !this.onCommand && this.scroll + index === this.selected,
      }));

    drawPanel({
      write: this.deps.write,
      geometry: this.deps.geometry,
      theme: this.panelTheme(),
      panel: this.id,
      title: this.title(),
      prompt: this.prompt(),
      command: this.command,
      onCommand: this.onCommand,
      body,
      first: this.scroll,
      total: lines.length,
      labelWidth: this.labelWidth(),
      message: this.message,
      notes: this.notes(),
      keys: this.keys(),
    });
  }
}
