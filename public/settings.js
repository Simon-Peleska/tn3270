/**
 * The settings page, drawn as VT bytes into the terminal itself: there is
 * already a renderer and a keyboard aimed at it, and HTML would mean a second
 * focus model, a second set of bindings and a second thing to fit the window.
 */

export const ESC = '\x1b';

/**
 * @typedef {object} Theme
 * @property {string} name
 * @property {Record<string, string>} colors ghostty's chrome colours and the
 *   sixteen ANSI slots, plus `field`: what a typeable field is tinted. Picked
 *   per theme rather than blended, and it has to stand out from both
 *   `background` and `black`. Ghostty ignores the extra key.
 */

/** @type {readonly Theme[]} */
export const THEMES = Object.freeze([
  { name: '3270 Green', colors: {
    background: '#000000', foreground: '#00ff00', cursor: '#00ff00', cursorAccent: '#000000', selectionBackground: '#00ff00', selectionForeground: '#000000', field: '#003300',
    black: '#000000', red: '#00cc00', green: '#00ff00', yellow: '#00e600', blue: '#00b300', magenta: '#00cc00', cyan: '#00e600', white: '#00ff00',
    brightBlack: '#007700', brightRed: '#00ff00', brightGreen: '#00ff00', brightYellow: '#00ff00', brightBlue: '#00cc00', brightMagenta: '#00ff00', brightCyan: '#00ff00', brightWhite: '#00ff00',
  } },
  { name: 'Amber', colors: {
    background: '#100c00', foreground: '#ffb000', cursor: '#ffb000', cursorAccent: '#100c00', selectionBackground: '#ffb000', selectionForeground: '#100c00', field: '#2b1f00',
    black: '#000000', red: '#cc8400', green: '#cc8400', yellow: '#ffb000', blue: '#996300', magenta: '#cc8400', cyan: '#e69900', white: '#ffb000',
    brightBlack: '#7a5000', brightRed: '#ffb000', brightGreen: '#ffb000', brightYellow: '#ffb000', brightBlue: '#cc8400', brightMagenta: '#ffb000', brightCyan: '#ffb000', brightWhite: '#ffb000',
  } },
  { name: 'Ghostty Dark', colors: {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff', cursorAccent: '#1e1e1e', selectionBackground: '#d4d4d4', selectionForeground: '#1e1e1e', field: '#2d2d2d',
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
  } },
  // base02 is already this palette's black and base01 is far too bright for a
  // field, so this field colour is a lift of base02 rather than a named shade.
  { name: 'Solarized Dark', colors: {
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#93a1a1', selectionForeground: '#002b36', field: '#0f4a58',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  } },
  { name: 'Paper', colors: {
    background: '#f5f2e8', foreground: '#1a1a1a', cursor: '#1a1a1a', cursorAccent: '#f5f2e8', selectionBackground: '#1a1a1a', selectionForeground: '#f5f2e8', field: '#e8e2d0',
    black: '#1a1a1a', red: '#c0341d', green: '#4c7a1f', yellow: '#a86b00', blue: '#2050a0', magenta: '#8a3f8a', cyan: '#1a7a7a', white: '#d8d4c8',
    brightBlack: '#6b6b6b', brightRed: '#d8452a', brightGreen: '#5f9c2a', brightYellow: '#c98a1a', brightBlue: '#3a6fc4', brightMagenta: '#a854a8', brightCyan: '#2a9494', brightWhite: '#f5f2e8',
  } },
  // The dark variants take Gruvbox's *bright* palette for the plain slots: a
  // 3270 paints whole screens out of them and the muted set is too dim to read.
  { name: 'Gruvbox Dark', colors: {
    background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#ebdbb2', selectionForeground: '#282828', field: '#3c3836',
    black: '#282828', red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598', magenta: '#d3869b', cyan: '#8ec07c', white: '#ebdbb2',
    brightBlack: '#928374', brightRed: '#fe8019', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  } },
  { name: 'Gruvbox Dark Hard', colors: {
    background: '#1d2021', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#1d2021', selectionBackground: '#ebdbb2', selectionForeground: '#1d2021', field: '#282828',
    black: '#1d2021', red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598', magenta: '#d3869b', cyan: '#8ec07c', white: '#ebdbb2',
    brightBlack: '#928374', brightRed: '#fe8019', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  } },
  { name: 'Gruvbox Light', colors: {
    background: '#fbf1c7', foreground: '#3c3836', cursor: '#3c3836', cursorAccent: '#fbf1c7', selectionBackground: '#3c3836', selectionForeground: '#fbf1c7', field: '#ebdbb2',
    black: '#fbf1c7', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#7c6f64',
    brightBlack: '#928374', brightRed: '#9d0006', brightGreen: '#79740e', brightYellow: '#b57614', brightBlue: '#076678', brightMagenta: '#8f3f71', brightCyan: '#427b58', brightWhite: '#3c3836',
  } },
  { name: 'Dracula', colors: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#f8f8f2', selectionForeground: '#282a36', field: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  } },
  { name: 'Nord', colors: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#d8dee9', selectionForeground: '#2e3440', field: '#434c5e',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  } },
  { name: 'Catppuccin Mocha', colors: {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#cdd6f4', cursorAccent: '#1e1e2e', selectionBackground: '#cdd6f4', selectionForeground: '#1e1e2e', field: '#585b70',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  } },
  { name: 'One Dark', colors: {
    background: '#282c34', foreground: '#abb2bf', cursor: '#abb2bf', cursorAccent: '#282c34', selectionBackground: '#abb2bf', selectionForeground: '#282c34', field: '#3e4451',
    black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
  } },
  { name: 'Tokyo Night', colors: {
    background: '#1a1b26', foreground: '#a9b1d6', cursor: '#a9b1d6', cursorAccent: '#1a1b26', selectionBackground: '#a9b1d6', selectionForeground: '#1a1b26', field: '#292e42',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  } },
  { name: 'Monokai', colors: {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#272822', selectionBackground: '#f8f8f2', selectionForeground: '#272822', field: '#3e3d32',
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
    brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
  } },
]);

/**
 * The first three are vendored in `public/fonts/`; the rest resolve against
 * whatever the browser's machine has.
 * @type {readonly { name: string, family: string }[]}
 */
export const FONTS = Object.freeze([
  { name: 'IBM 3270', family: '"IBM 3270", monospace' },
  { name: 'Fira Mono', family: '"Fira Mono", monospace' },
  { name: 'IBM Plex Mono', family: '"IBM Plex Mono", monospace' },
  { name: 'System monospace', family: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  { name: 'Menlo / Consolas', family: 'Menlo, Consolas, monospace' },
  { name: 'DejaVu Sans Mono', family: '"DejaVu Sans Mono", monospace' },
  { name: 'Liberation Mono', family: '"Liberation Mono", monospace' },
  { name: 'Courier New', family: '"Courier New", Courier, monospace' },
  { name: 'JetBrains Mono', family: '"JetBrains Mono", monospace' },
]);

/**
 * @param {string} hex `#rrggbb`
 * @returns {[number, number, number]}
 */
export function rgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/**
 * Blend two colours, so "a little brighter than the page" still means that on
 * a light theme, where brighter would be wrong.
 *
 * @param {string} from
 * @param {string} to
 * @param {number} amount 0 = from, 1 = to
 * @returns {string} `#rrggbb`
 */
function mix(from, to, amount) {
  const a = rgb(from);
  const b = rgb(to);
  const channel = (/** @type {number} */ index) =>
    Math.round(a[index] + (b[index] - a[index]) * amount).toString(16).padStart(2, '0');
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
 * The SGR sequence selecting one pair of true colours.
 *
 * @param {string} fg `#rrggbb`
 * @param {string} bg `#rrggbb`
 * @param {boolean} [bold]
 * @returns {string}
 */
export function paint(fg, bg, bold = false) {
  const [fr, fg2, fb] = rgb(fg);
  const [br, bg2, bb] = rgb(bg);
  return `${ESC}[0${bold ? ';1' : ''};38;2;${fr};${fg2};${fb};48;2;${br};${bg2};${bb}m`;
}

/**
 * @param {number} index
 * @param {number} step
 * @param {number} length
 * @returns {number}
 */
function cycle(index, step, length) {
  return (index + step + length) % length;
}

const FIELD_WIDTH = 26;
const PANEL_WIDTH = 62;

// The font on screen floats to fill the window with the grid the host gave us,
// so measuring at that size would only answer with the grid already there.
// Asking at a size the operator picks is what makes the question mean
// something: how much screen do I get at text this big.
const DEFAULT_FIT_FONT_SIZE = 16;
const MIN_FIT_FONT_SIZE = 8;
const MAX_FIT_FONT_SIZE = 32;

/**
 * @typedef {object} SettingsDeps
 * @property {(bytes: string) => void} write
 * @property {() => { cols: number, rows: number }} geometry
 * @property {(theme: Theme) => void} applyTheme
 * @property {(font: { name: string, family: string }) => void} applyFont
 * @property {(model: number) => void} applyModel
 * @property {(value: string) => void} applyOversize `<cols>x<rows>`, or '' for the model's own size
 * @property {(fontSize: number) => { cols: number, rows: number } | null} windowFit
 *   the screen this session's pane would hold with text that many pixels tall
 * @property {(enabled: boolean) => void} applyHostColors
 * @property {(host: string | null) => void} connect
 * @property {() => void} restore called when the page closes, to get the host screen back
 * @property {(settings: import('./store.js').StoredSettings) => void} persist
 */

export class SettingsPage {
  /** @param {SettingsDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {boolean} */
    this.open = false;
    /** @type {number} Index into rows(), which is not a fixed list. */
    this.selected = 0;
    /** @type {number} */
    this.themeIndex = 0;
    /** @type {number} */
    this.fontIndex = 0;
    /** @type {number} The model the server has confirmed. */
    this.model = 2;
    /** @type {number} What the user has dialled up but not applied yet. */
    this.pendingModel = 2;
    /** @type {string} `<cols>x<rows>`, or '' for the model's own size. */
    this.oversize = '';
    /** @type {string} What the user has dialled up but not applied yet. */
    this.pendingOversize = '';
    /** @type {number} The text size "fit to window" measures at; not the font
     * size on screen, which floats with the window. */
    this.fitFontSize = DEFAULT_FIT_FONT_SIZE;
    /** @type {import('../server/b3270.js').ModelInfo[]} */
    this.models = [];
    /** @type {boolean} */
    this.connected = false;
    /** @type {boolean} Off drops host colour entirely, leaving the theme's two
     * tones plus reverse video. */
    this.hostColors = true;
    /** @type {string} */
    this.host = '';
    /** @type {boolean} The host comes from the server's config: shown, not
     * editable, and Enter reconnects to it directly. */
    this.hostLocked = false;
  }

  /** @returns {boolean} */
  showsConnect() {
    return !this.connected;
  }

  /**
   * The rows of the page, top to bottom, as they are both drawn and driven.
   * Two come and go, so they are built each time rather than counted off
   * against fixed indexes.
   *
   * @returns {{ key: string, label: string, value: string }[]}
   */
  rows() {
    /** @type {{ key: string, label: string, value: string }[]} */
    const rows = [];
    if (this.showsConnect()) {
      rows.push({
        key: 'host',
        label: 'Host',
        value: this.hostLocked
          ? '(set by the server)'
          : this.host + (this.selected === 0 ? '_' : ''),
      });
    }
    rows.push({ key: 'theme', label: 'Theme', value: this.theme().name });
    rows.push({ key: 'font', label: 'Font', value: this.font().name });
    rows.push({ key: 'model', label: 'Screen model', value: this.describeModel(this.pendingModel) });
    // A size to ask for, not one that follows the window: the host is told it
    // once, when the connection is made.
    rows.push({
      key: 'fit',
      label: 'Fit to window',
      value: this.pendingOversize === '' ? 'Off' : this.pendingOversize,
    });
    if (this.pendingOversize !== '') {
      rows.push({ key: 'fitSize', label: 'Text size', value: `${this.fitFontSize} px` });
    }
    rows.push({ key: 'hostColors', label: 'Host colors', value: this.hostColors ? 'On' : 'Off' });
    return rows;
  }

  /** @returns {number} */
  fieldCount() {
    return this.rows().length;
  }

  /**
   * @param {string} host
   * @returns {void}
   */
  setHost(host) {
    this.host = host;
    if (this.open) this.draw();
  }

  /**
   * @param {boolean} locked
   * @returns {void}
   */
  setHostLocked(locked) {
    this.hostLocked = locked;
    if (this.open) this.draw();
  }

  /** @returns {Theme} */
  theme() {
    return THEMES[this.themeIndex] ?? THEMES[0];
  }

  /** @returns {{ name: string, family: string }} */
  font() {
    return FONTS[this.fontIndex] ?? FONTS[0];
  }

  /**
   * By name, so reordering the lists later cannot scramble an old choice.
   *
   * @param {Partial<import('./store.js').StoredSettings>} saved
   * @returns {void}
   */
  restoreSaved(saved) {
    const theme = THEMES.findIndex((entry) => entry.name === saved.theme);
    if (theme !== -1) this.themeIndex = theme;
    const font = FONTS.findIndex((entry) => entry.name === saved.font);
    if (font !== -1) this.fontIndex = font;
    if (typeof saved.hostColors === 'boolean') this.hostColors = saved.hostColors;
    if (typeof saved.fitFontSize === 'number') {
      this.fitFontSize = Math.max(MIN_FIT_FONT_SIZE, Math.min(MAX_FIT_FONT_SIZE, saved.fitFontSize));
    }
  }

  /** @returns {void} */
  save() {
    this.deps.persist({
      theme: this.theme().name,
      font: this.font().name,
      model: this.model,
      hostColors: this.hostColors,
      fitFontSize: this.fitFontSize,
    });
  }

  /**
   * @param {number} model
   * @returns {void}
   */
  setModel(model) {
    this.model = model;
    this.pendingModel = model;
    if (this.open) this.draw();
  }

  /**
   * @param {string} value `<cols>x<rows>`, or '' for the model's own size
   * @returns {void}
   */
  setOversize(value) {
    this.oversize = value;
    this.pendingOversize = value;
    if (this.open) this.draw();
  }

  /**
   * A measured fit as b3270 wants it written. Never smaller than the model —
   * b3270 refuses an oversize below it and quietly hands back the model's own
   * screen — and never more than the 16383 cells it has a buffer for.
   *
   * @param {{ cols: number, rows: number }} fit
   * @param {number} model
   * @returns {string}
   */
  fitSize(fit, model) {
    const info = this.models.find((entry) => entry.model === model);
    const minCols = info?.columns ?? 80;
    const minRows = info?.rows ?? 24;
    let rows = Math.max(minRows, fit.rows);
    const cols = Math.max(minCols, Math.min(fit.cols, Math.floor(16383 / rows)));

    // A pane too narrow for the model draws it smaller than the text size asked
    // for, and smaller text is more rows; without them the screen would stop
    // short of the bottom. The OIA row goes back in to be scaled and out again.
    if (cols > fit.cols) {
      rows = Math.round(((fit.rows + 1) * cols) / fit.cols) - 1;
      rows = Math.max(minRows, Math.min(rows, Math.floor(16383 / cols)));
    }
    return `${cols}x${rows}`;
  }

  /** @returns {string} the screen this pane would hold, as b3270 writes it */
  fitToWindow() {
    const fit = this.deps.windowFit(this.fitFontSize);
    if (fit === null) return '';
    return this.fitSize(fit, this.pendingModel);
  }

  /** @returns {void} */
  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  /** @returns {void} */
  show() {
    this.open = true;
    this.selected = 0;
    this.pendingModel = this.model;
    this.pendingOversize = this.oversize;
    this.draw();
  }

  /** @returns {void} */
  close() {
    if (!this.open) return;
    this.open = false;
    this.deps.restore();
  }

  /**
   * @param {KeyboardEvent} event
   * @returns {boolean} true when the page consumed the key
   */
  handleKey(event) {
    if (event.altKey && event.code === 'Space') {
      this.toggle();
      return true;
    }
    if (!this.open) return false;
    // Reload, devtools and the rest belong to the browser even here.
    if (event.ctrlKey || event.metaKey) return false;

    if (event.key === 'Escape') {
      this.close();
      return true;
    }

    // A text field, not a value to cycle, so it takes its own keys first.
    const onConnectRow = this.rows()[this.selected]?.key === 'host';
    if (onConnectRow && !this.hostLocked) {
      if (event.key === 'Backspace') {
        this.host = this.host.slice(0, -1);
        this.draw();
        return true;
      }
      if (event.key.length === 1 && !event.altKey) {
        this.host += event.key;
        this.draw();
        return true;
      }
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const step = event.key === 'ArrowUp' ? -1 : 1;
      this.selected = (this.selected + step + this.fieldCount()) % this.fieldCount();
      this.draw();
      return true;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (!onConnectRow) this.change(event.key === 'ArrowLeft' ? -1 : 1);
      return true;
    }
    if (event.key === 'Enter') {
      if (onConnectRow) {
        this.deps.connect(this.hostLocked ? null : this.host.trim());
        return true;
      }
      if (this.pendingModel !== this.model) this.deps.applyModel(this.pendingModel);
      if (this.pendingOversize !== this.oversize) this.deps.applyOversize(this.pendingOversize);
      this.save();
      this.close();
      return true;
    }
    // Everything else is swallowed: the host must not see keystrokes aimed at a
    // page it cannot see.
    return true;
  }

  /**
   * Theme and font take effect as you scroll through them — the page is drawn
   * in the terminal being restyled, so it is its own preview. The screen size
   * costs a round trip to b3270 and a reconnection, so it waits for Enter.
   *
   * @param {number} step
   * @returns {void}
   */
  change(step) {
    const key = this.rows()[this.selected]?.key;
    if (key === 'theme') {
      this.themeIndex = cycle(this.themeIndex, step, THEMES.length);
      this.deps.applyTheme(this.theme());
      this.save();
    } else if (key === 'font') {
      this.fontIndex = cycle(this.fontIndex, step, FONTS.length);
      this.deps.applyFont(this.font());
      this.save();
    } else if (key === 'model') {
      const models = this.models.length > 0 ? this.models.map((info) => info.model) : [2, 3, 4, 5];
      const next = cycle(models.indexOf(this.pendingModel), step, models.length);
      this.pendingModel = models[next] ?? this.pendingModel;
    } else if (key === 'fit') {
      // Measured afresh: the window may have been resized since it was shown.
      this.pendingOversize = this.pendingOversize === '' ? this.fitToWindow() : '';
    } else if (key === 'fitSize') {
      // Stops at both ends rather than wrapping, so holding an arrow down lands
      // somewhere sensible.
      this.fitFontSize = Math.max(MIN_FIT_FONT_SIZE, Math.min(MAX_FIT_FONT_SIZE, this.fitFontSize + step));
      this.pendingOversize = this.fitToWindow();
      this.save();
    } else {
      this.hostColors = !this.hostColors;
      this.deps.applyHostColors(this.hostColors);
      this.save();
    }
    this.draw();
  }

  /**
   * @param {number} model
   * @returns {string}
   */
  describeModel(model) {
    const info = this.models.find((entry) => entry.model === model);
    return info ? `Model ${model} - ${info.rows}x${info.columns}` : `Model ${model}`;
  }

  /** @returns {void} */
  draw() {
    const { cols, rows } = this.deps.geometry();
    const colors = this.theme().colors;
    const background = colors['background'] ?? '#000000';
    const foreground = colors['foreground'] ?? '#00ff00';
    const dim = mix(background, foreground, 0.55);
    // Editable values sit on a brighter block, the way an unprotected field
    // looks on a real 3270.
    const field = colors['field'] ?? mix(background, foreground, 0.12);
    const chosen = mix(field, foreground, 0.3);
    const warn = rgb(background)[0] > 128 ? '#a02c00' : '#ffcc00';

    const fields = this.rows();

    const left = Math.max(1, Math.floor((cols - PANEL_WIDTH) / 2) + 1);
    const top = Math.max(1, Math.floor((rows - (18 + (fields.length - 4) * 2)) / 2) + 1);

    /** @type {string[]} */
    const out = [`${ESC}[?25l`, paint(foreground, background), `${ESC}[2J`];

    out.push(at(top, left), paint(foreground, background, true), 'TN3270 SETTINGS');
    out.push(at(top + 1, left), paint(dim, background), '='.repeat(PANEL_WIDTH));

    for (let index = 0; index < fields.length; index++) {
      const entry = fields[index];
      const row = top + 3 + index * 2;
      const active = index === this.selected;
      out.push(at(row, left), paint(active ? foreground : dim, background, active));
      out.push(`${active ? '>' : ' '} ${(entry?.label ?? '').padEnd(14)}`);
      out.push(paint(foreground, active ? chosen : field));
      out.push(` ${(entry?.value ?? '').padEnd(FIELD_WIDTH - 2)} `);
      out.push(paint(dim, background), active ? (entry?.key === 'host' ? '  Enter' : '  < >') : '');
    }

    let row = top + 3 + fields.length * 2 + 1;
    if (this.pendingModel !== this.model || this.pendingOversize !== this.oversize) {
      // Two lines: autowrap is off, so a longer sentence is cut at the edge.
      out.push(at(row, left), paint(warn, background, true));
      out.push('! Enter applies the new screen size.');
      out.push(at(row + 1, left), paint(warn, background));
      out.push(this.connected
        ? '  The host connection is dropped and reopened.'
        : '  The screen is erased.');
      row += 2;
    }

    out.push(at(row + 1, left), paint(dim, background));
    out.push("Saved in this browser. The host names a field's colour; this");
    out.push(at(row + 2, left));
    out.push('theme decides what that colour actually looks like.');

    out.push(at(rows, left), paint(dim, background));
    out.push('Up/Down field   Left/Right change   Enter apply   Esc close');

    this.deps.write(out.join(''));
  }
}
