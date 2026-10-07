/**
 * A host that lives in the page. It takes the same messages the server does —
 * `text`, `action`, `paste` — and answers with the same paint, so a screen
 * drawn here is typed into, tabbed through and submitted exactly like one from
 * a mainframe. What the screen says and what an AID key does with it belong to
 * the application behind it (`panels.js`); this is only the terminal's side:
 * fields, the cursor and insert mode.
 */

import { Grid } from "./grid.js";
import { paintRow } from "./paint-runs.js";
import { pasteSegments } from "./paste.js";

/**
 * @typedef {object} Text protected text
 * @property {number} row 0-based
 * @property {number} col 0-based
 * @property {string} text
 * @property {string | null} fg a host colour name, or the screen default
 * @property {string | null} [bg]
 * @property {string | null} [gr]
 * @property {boolean} [editable]
 *
 * @typedef {object} Field an input field, one row long
 * @property {string} name
 * @property {number} row 0-based
 * @property {number} col 0-based
 * @property {number} width
 * @property {string} value what the application puts in it
 * @property {string[]} [fgByPosition] foreground colors for individual cells
 * @property {boolean} [hidden] typed into but never shown, like a password
 *
 * @typedef {object} HostScreen
 * @property {Text[]} texts
 * @property {Field[]} fields in screen order
 * @property {string} [cursor] the field the cursor starts in, else the first
 * @property {boolean} [color]
 * @property {boolean} [fieldsFormatted]
 * @property {string} [defaultFg]
 * @property {string} [defaultBg]
 *
 * @typedef {object} HostApplication
 * @property {(rows: number, cols: number) => HostScreen} screen asked for
 *   afresh whenever the screen is needed, so it always shows the state as it is
 * @property {(aid: string, values: Record<string, string>) => void} aid
 *   Enter, PF1-PF24, PA1-PA3, Clear, Attn or SysReq, with every field's value
 */

const FIELD_STYLE = Object.freeze({
  fg: "turquoise",
  gr: "underline",
  editable: true,
});

const AIDS = new Set(["Enter", "PF", "PA", "Clear", "Attn", "SysReq"]);

export class LocalHost {
  /** @param {HostApplication} app */
  constructor(app) {
    this.app = app;
    this.rows = 24;
    this.cols = 80;
    /** @type {{ row: number, col: number }} */
    this.cursor = { row: 0, col: 0 };
    this.insert = false;
    /** @type {Map<string, string[]>} what was typed since the last AID, by field */
    this.typed = new Map();
    /** @type {boolean} the next screen puts the cursor where it asks for it */
    this.fresh = true;
  }

  /**
   * A host rewrites its screen after every AID: what was typed is gone, and the
   * cursor goes where the new screen says.
   *
   * @returns {void}
   */
  restart() {
    this.typed.clear();
    this.fresh = true;
  }

  /** @returns {HostScreen} */
  layout() {
    const screen = this.app.screen(this.rows, this.cols);
    if (this.fresh) {
      this.fresh = false;
      const field =
        screen.fields.find((each) => each.name === screen.cursor) ??
        screen.fields[0];
      this.cursor =
        field === undefined
          ? { row: 0, col: 0 }
          : { row: field.row, col: field.col };
    }
    return screen;
  }

  /**
   * @param {Field} field
   * @returns {string[]} one character per cell
   */
  chars(field) {
    return (
      this.typed.get(field.name) ?? [
        ...field.value.slice(0, field.width).padEnd(field.width),
      ]
    );
  }

  /**
   * @param {Field[]} fields
   * @returns {Field | undefined} the field under the cursor
   */
  fieldAtCursor(fields) {
    const { row, col } = this.cursor;
    return fields.find(
      (field) =>
        field.row === row && col >= field.col && col < field.col + field.width,
    );
  }

  /**
   * @param {Field[]} fields
   * @param {number} step 1 for the next field's start, -1 for the one before
   * @returns {void}
   */
  tab(fields, step) {
    if (fields.length === 0) return;
    const here = this.cursor.row * this.cols + this.cursor.col;
    const start = (/** @type {Field} */ field) =>
      field.row * this.cols + field.col;
    const ordered = [...fields].sort((a, b) => start(a) - start(b));
    const target =
      step > 0
        ? (ordered.find((field) => start(field) > here) ?? ordered[0])
        : (ordered.findLast((field) => start(field) < here) ?? ordered.at(-1));
    if (target !== undefined)
      this.cursor = { row: target.row, col: target.col };
  }

  /**
   * @param {Field[]} fields
   * @param {string} ch
   * @returns {void}
   */
  type(fields, ch) {
    const field = this.fieldAtCursor(fields);
    if (field === undefined) return;
    const chars = this.chars(field);
    const at = this.cursor.col - field.col;
    if (this.insert) {
      // A full field has no room to push into; a terminal refuses the key.
      if (chars.at(-1) !== " ") return;
      chars.splice(at, 0, ch);
      chars.pop();
    } else {
      chars[at] = ch;
    }
    this.typed.set(field.name, chars);
    if (at + 1 < field.width) this.cursor.col += 1;
    else this.tab(fields, 1);
  }

  /**
   * @param {Field} field
   * @param {string[]} chars
   * @returns {void}
   */
  write(field, chars) {
    this.typed.set(field.name, chars);
  }

  /**
   * The field under the cursor, made to say `text`, with the cursor after it.
   *
   * @param {string} text
   * @returns {void}
   */
  fill(text) {
    const field = this.fieldAtCursor(this.layout().fields);
    if (field === undefined) return;
    const chars = [...text.slice(0, field.width).padEnd(field.width)];
    this.write(field, chars);
    this.cursor.col = field.col + Math.min(text.length, field.width - 1);
  }

  /**
   * @param {number} step cells forward, or back when negative; wraps the screen
   * @returns {void}
   */
  step(step) {
    const total = this.rows * this.cols;
    const at =
      (this.cursor.row * this.cols + this.cursor.col + step + total) % total;
    this.cursor = { row: Math.floor(at / this.cols), col: at % this.cols };
  }

  /**
   * @param {import('../server/protocol.js').ClientMessage} message
   * @returns {void}
   */
  receive(message) {
    const fields = [...this.layout().fields].sort(
      (a, b) => a.row - b.row || a.col - b.col,
    );
    if (message.type === "text") {
      for (const ch of message.value) this.type(fields, ch);
      return;
    }
    if (message.type === "paste") {
      const grid = this.grid();
      const segments = pasteSegments(
        grid.cells,
        grid.fieldsFormatted,
        grid.cols,
        this.cursor,
        message.text,
      );
      for (const segment of segments) {
        this.cursor = { row: segment.row, col: segment.col };
        for (const ch of segment.text) this.type(fields, ch);
      }
      return;
    }
    if (message.type !== "action") return;

    const action = message.action;
    const args = message.args ?? [];
    if (AIDS.has(action)) {
      const aid =
        action === "PF" || action === "PA" ? `${action}${args[0]}` : action;
      /** @type {Record<string, string>} */
      const values = {};
      for (const field of fields)
        values[field.name] = this.chars(field).join("").trimEnd();
      this.restart();
      this.app.aid(aid, values);
      return;
    }

    const field = this.fieldAtCursor(fields);
    const at = field === undefined ? 0 : this.cursor.col - field.col;
    const chars = field === undefined ? [] : this.chars(field);
    const blank = () => /** @type {string[]} */ (Array(chars.length).fill(" "));

    if (action === "Tab") this.tab(fields, 1);
    else if (action === "BackTab") {
      if (field !== undefined && at > 0) this.cursor.col = field.col;
      else this.tab(fields, -1);
    } else if (action === "Newline") {
      const below = fields.find((each) => each.row > this.cursor.row);
      const target = below ?? fields[0];
      if (target !== undefined)
        this.cursor = { row: target.row, col: target.col };
    } else if (action === "BackNewline") {
      const above = fields.findLast((each) => each.row < this.cursor.row);
      const row = above?.row ?? fields.at(-1)?.row;
      const target = fields.find((each) => each.row === row);
      if (target !== undefined)
        this.cursor = { row: target.row, col: target.col };
    } else if (action === "Home") {
      const first = fields[0];
      if (first !== undefined) this.cursor = { row: first.row, col: first.col };
    } else if (action === "FieldStart") {
      if (field !== undefined) this.cursor.col = field.col;
    } else if (action === "FieldEnd") {
      if (field === undefined) return;
      const typed = chars.join("").trimEnd().length;
      this.cursor.col = field.col + Math.min(typed, field.width - 1);
    } else if (action === "Up") this.step(-this.cols);
    else if (action === "Down") this.step(this.cols);
    else if (action === "Left") this.step(-1);
    else if (action === "Right") this.step(1);
    else if (action === "NextWord") {
      let to = at;
      while (to < chars.length && chars[to] !== " ") to += 1;
      while (to < chars.length && chars[to] === " ") to += 1;
      if (field === undefined || to === chars.length) this.tab(fields, 1);
      else this.cursor.col = field.col + to;
    } else if (action === "PreviousWord") {
      if (field === undefined || at === 0) {
        this.tab(fields, -1);
        return;
      }
      let from = at;
      while (from > 0 && chars[from - 1] === " ") from -= 1;
      while (from > 0 && chars[from - 1] !== " ") from -= 1;
      this.cursor.col = field.col + from;
    } else if (action === "MoveCursor1") {
      const row = Number(args[0]) - 1;
      const col = Number(args[1]) - 1;
      if (row >= 0 && row < this.rows && col >= 0 && col < this.cols)
        this.cursor = { row, col };
    } else if (action === "Backspace") {
      if (field === undefined || at === 0) return;
      chars.splice(at - 1, 1);
      chars.push(" ");
      this.write(field, chars);
      this.cursor.col -= 1;
    } else if (action === "Delete") {
      if (field === undefined) return;
      chars.splice(at, 1);
      chars.push(" ");
      this.write(field, chars);
    } else if (action === "EraseEOF") {
      if (field === undefined) return;
      this.write(field, [...chars.slice(0, at), ...blank().slice(at)]);
    } else if (action === "DeleteField") {
      if (field === undefined) return;
      this.write(field, blank());
      this.cursor.col = field.col;
    } else if (action === "DeleteWord") {
      if (field === undefined) return;
      let from = at;
      while (from > 0 && chars[from - 1] === " ") from -= 1;
      while (from > 0 && chars[from - 1] !== " ") from -= 1;
      chars.splice(from, at - from);
      this.write(field, [...chars, ...blank()].slice(0, field.width));
      this.cursor.col = field.col + from;
    } else if (action === "EraseInput") {
      for (const each of fields) this.write(each, Array(each.width).fill(" "));
      const first = fields[0];
      if (first !== undefined) this.cursor = { row: first.row, col: first.col };
    } else if (action === "ToggleInsert") this.insert = !this.insert;
    else if (action === "Insert") this.insert = true;
    else if (action === "Reset") this.insert = false;
  }

  /**
   * The screen as cells: what copy reads and what a paste is split against.
   *
   * @returns {Grid}
   */
  grid() {
    const screen = this.layout();
    const grid = new Grid(this.rows, this.cols);
    grid.color = screen.color ?? true;
    grid.defaultFg = screen.defaultFg ?? null;
    grid.defaultBg = screen.defaultBg ?? null;
    for (const text of screen.texts)
      grid.put(text.row, text.col, text.text, {
        fg: text.fg,
        bg: text.bg,
        gr: text.gr,
        editable: text.editable,
      });
    for (const field of screen.fields) {
      const shown = field.hidden
        ? "".padEnd(field.width)
        : this.chars(field).join("");
      grid.put(field.row, field.col, shown, FIELD_STYLE);
      if (field.fgByPosition === undefined) continue;
      for (
        let index = 0;
        index < Math.min(field.width, field.fgByPosition.length);
        index += 1
      ) {
        const cell = grid.cellAt(field.row, field.col + index);
        if (cell !== null) cell.fg = field.fgByPosition[index] ?? cell.fg;
      }
    }
    grid.fieldsFormatted = screen.fieldsFormatted ?? true;
    grid.cursor = { ...this.cursor, visible: true };
    return grid;
  }

  /**
   * A full paint the size the application was given, every cell in it, so
   * nothing underneath shows through.
   *
   * @param {number} rows
   * @param {number} cols
   * @returns {import('../server/protocol.js').PaintMessage}
   */
  paint(rows, cols) {
    if (rows !== this.rows || cols !== this.cols) {
      this.rows = rows;
      this.cols = cols;
      this.cursor = {
        row: Math.min(this.cursor.row, rows - 1),
        col: Math.min(this.cursor.col, cols - 1),
      };
    }
    const grid = this.grid();
    /** @type {import('../server/protocol.js').PaintRow[]} */
    const paintRows = [];
    for (let row = 0; row < rows; row++)
      paintRows.push(paintRow(grid.cells, row, cols));
    /** @type {import('../server/protocol.js').PaintMessage} */
    const paint = {
      type: "paint",
      full: true,
      color: grid.color,
      fieldsFormatted: grid.fieldsFormatted,
      rows: paintRows,
      cursor: { ...this.cursor, on: true },
    };
    if (grid.defaultFg !== null) paint.defaultFg = grid.defaultFg;
    if (grid.defaultBg !== null) paint.defaultBg = grid.defaultBg;
    return paint;
  }
}
