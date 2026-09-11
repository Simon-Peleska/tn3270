/**
 * The settings page, drawn into the terminal itself.
 *
 * There is already a VT renderer on the screen and a keyboard aimed at it, so a
 * settings page made of HTML would mean a second focus model, a second set of
 * key bindings and a second thing to make fit the window. Writing VT into the
 * terminal we already have costs nothing extra and looks like the machine it is
 * pretending to be.
 *
 * While it is open the host's own bytes are dropped on the floor by app.js and
 * the screen is asked for again on close.
 */

const ESC = '\x1b';

/**
 * @typedef {object} Theme
 * @property {string} name
 * @property {Record<string, string>} colors the six terminal-chrome colours
 *   (background, foreground, cursor, ...), the sixteen standard ANSI slots
 *   (black..brightWhite), all passed straight to ghostty's renderer, plus
 *   `field`: the colour of a field you can type into, both on this settings
 *   page and — the server is told it, and paints them — on the host screen.
 *   Picked by hand from each theme's real palette (Gruvbox's `bg1`, Nord's
 *   `nord2`, ...) rather than computed, because a flat brightness blend looks
 *   right on some themes and grey on others. It has to stand out against
 *   `background`, which this page draws on, *and* against `black`, which is
 *   where a host's default background lands. Ghostty ignores the extra key.
 */

/**
 * The host only ever names a colour ("red", "turquoise", ...); what RGB that
 * turns into is this table, exactly like a shell's "red" is whatever the
 * theme's palette says red is — never a fixed value baked into the server.
 * `server/colors.js` picks which of these sixteen slots each host colour
 * name lands on.
 *
 * @type {readonly Theme[]}
 */
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
  // Solarized's own "background highlights" tone, base02, is already spoken for
  // as this palette's black, and the next shade up (base01) is a text colour
  // far too bright to fill a field with — so the field colour is the one value
  // here that is a lift of base02 rather than a shade Solarized names itself.
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
  // Gruvbox's own background ramp is bg0 (default bg) through bg4; bg1 is
  // what Gruvbox itself uses for a highlighted line or block.
  //
  // The dark variants take Gruvbox's *bright* palette for the plain slots
  // rather than its muted one. A shell mostly writes in its foreground colour
  // and reaches for a palette slot to make one word stand out; a 3270 paints
  // whole screens out of these slots, green above all (it is the default
  // foreground), and the muted set is too dim to read that way. Slot 9 keeps
  // Gruvbox's real orange, because that slot is the host colour named
  // "orange" and bright red is already slot 1.
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
 * The first three are served from `public/fonts/` and are therefore always
 * available; the rest resolve against whatever the browser's machine has.
 *
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
function rgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Blend two colours. The field backgrounds are derived from the theme rather
 * than fixed, so "slightly brighter than the page" still means that on a light
 * theme, where brighter would be wrong.
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
 * @param {string} fg
 * @param {string} bg
 * @param {boolean} [bold]
 * @returns {string}
 */
function paint(fg, bg, bold = false) {
  const [fr, fg2, fb] = rgb(fg);
  const [br, bg2, bb] = rgb(bg);
  return `${ESC}[0${bold ? ';1' : ''};38;2;${fr};${fg2};${fb};48;2;${br};${bg2};${bb}m`;
}

const FIELD_WIDTH = 26;
const PANEL_WIDTH = 62;

/**
 * @typedef {object} SettingsDeps
 * @property {(bytes: string) => void} write
 * @property {() => { cols: number, rows: number }} geometry
 * @property {(theme: Theme) => void} applyTheme
 * @property {(font: { name: string, family: string }) => void} applyFont
 * @property {(model: number) => void} applyModel
 * @property {(enabled: boolean) => void} applyHostColors
 * @property {(host: string | null) => void} connect
 * @property {() => void} restore called when the page closes, to get the host screen back
 * @property {(settings: { theme: string, font: string, model: number, hostColors: boolean }) => void} persist
 */

export class SettingsPage {
  /** @param {SettingsDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {boolean} */
    this.open = false;
    /** @type {number} 0 = theme, 1 = font, 2 = screen size, 3 = host colours */
    this.selected = 0;
    /** @type {number} */
    this.themeIndex = 0;
    /** @type {number} */
    this.fontIndex = 0;
    /** @type {number} The model the server has; the size field starts here. */
    this.model = 2;
    /** @type {number} What the user has dialled up but not applied yet. */
    this.pendingModel = 2;
    /** @type {import('../server/b3270.js').ModelInfo[]} */
    this.models = [];
    /** @type {boolean} */
    this.connected = false;
    /** @type {boolean} On shows the host's field colours, each mapped onto
     * this theme's own palette. Off drops host colour entirely, leaving only
     * the theme's two tones plus reverse video. */
    this.hostColors = true;
    /** @type {string} What the user has typed into the host field. */
    this.host = '';
    /** @type {boolean} The host comes from the server's own config; the field
     * is then shown but not editable, and Enter reconnects to it directly. */
    this.hostLocked = false;
  }

  /**
   * The connection row only makes sense — and only fits — while there is
   * nothing to disconnect from, exactly when the rest of the page also has
   * nothing else to show the user.
   *
   * @returns {boolean}
   */
  showsConnect() {
    return !this.connected;
  }

  /** @returns {number} */
  fieldCount() {
    return this.showsConnect() ? 5 : 4;
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
   * Take up saved values by name, so reordering the lists later cannot scramble
   * what somebody chose months ago.
   *
   * @param {{ theme?: string, font?: string, hostColors?: boolean }} saved
   * @returns {void}
   */
  restoreSaved(saved) {
    const theme = THEMES.findIndex((entry) => entry.name === saved.theme);
    if (theme !== -1) this.themeIndex = theme;
    const font = FONTS.findIndex((entry) => entry.name === saved.font);
    if (font !== -1) this.fontIndex = font;
    if (typeof saved.hostColors === 'boolean') this.hostColors = saved.hostColors;
  }

  /** @returns {void} */
  save() {
    this.deps.persist({
      theme: this.theme().name,
      font: this.font().name,
      model: this.model,
      hostColors: this.hostColors,
    });
  }

  /**
   * The server owns the model, so the page follows it rather than remembering
   * its own idea of the size.
   *
   * @param {number} model
   * @returns {void}
   */
  setModel(model) {
    this.model = model;
    this.pendingModel = model;
    if (this.open) this.draw();
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

    // The connection row is a text field, not a value to cycle, so it takes
    // its own keys ahead of the generic ones below.
    const onConnectRow = this.showsConnect() && this.selected === 0;
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
      // Nothing to cycle on the connection row.
      if (!onConnectRow) this.change(event.key === 'ArrowLeft' ? -1 : 1);
      return true;
    }
    if (event.key === 'Enter') {
      if (onConnectRow) {
        this.deps.connect(this.hostLocked ? null : this.host.trim());
        return true;
      }
      if (this.pendingModel !== this.model) this.deps.applyModel(this.pendingModel);
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
   * in the very terminal being restyled, so it is its own preview. The screen
   * size cannot preview: it costs a round trip to b3270 and, while connected, a
   * reconnection, so it waits for Enter.
   *
   * @param {number} step
   * @returns {void}
   */
  change(step) {
    // The connection row, when shown, pushes every other field down by one.
    const field = this.selected - (this.showsConnect() ? 1 : 0);
    if (field === 0) {
      this.themeIndex = (this.themeIndex + step + THEMES.length) % THEMES.length;
      this.deps.applyTheme(this.theme());
      this.save();
    } else if (field === 1) {
      this.fontIndex = (this.fontIndex + step + FONTS.length) % FONTS.length;
      this.deps.applyFont(this.font());
      this.save();
    } else if (field === 2) {
      const models = this.models.length > 0 ? this.models.map((info) => info.model) : [2, 3, 4, 5];
      const current = models.indexOf(this.pendingModel);
      const next = (current + step + models.length) % models.length;
      this.pendingModel = models[next] ?? this.pendingModel;
    } else {
      // Only two states, so either arrow key just flips it.
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
    // Editable values sit on a slightly brighter block, the way an unprotected
    // field looks on a real 3270. Curated per theme (see the Theme typedef)
    // since a flat blend off the background looks right on some themes and
    // grey on others.
    const field = colors['field'] ?? mix(background, foreground, 0.12);
    const chosen = mix(field, foreground, 0.3);
    const warn = rgb(background)[0] > 128 ? '#a02c00' : '#ffcc00';

    const showsConnect = this.showsConnect();
    const labels = showsConnect
      ? ['Host', 'Theme', 'Font', 'Screen size', 'Host colors']
      : ['Theme', 'Font', 'Screen size', 'Host colors'];
    const hostValue = this.hostLocked
      ? '(set by the server)'
      : this.host + (showsConnect && this.selected === 0 ? '_' : '');
    const values = showsConnect
      ? [hostValue, this.theme().name, this.font().name, this.describeModel(this.pendingModel), this.hostColors ? 'On' : 'Off']
      : [this.theme().name, this.font().name, this.describeModel(this.pendingModel), this.hostColors ? 'On' : 'Off'];

    const left = Math.max(1, Math.floor((cols - PANEL_WIDTH) / 2) + 1);
    const top = Math.max(1, Math.floor((rows - (18 + (labels.length - 4) * 2)) / 2) + 1);

    /** @type {string[]} */
    const out = [`${ESC}[?25l`, paint(foreground, background), `${ESC}[2J`];

    out.push(at(top, left), paint(foreground, background, true), 'TN3270 SETTINGS');
    out.push(at(top + 1, left), paint(dim, background), '='.repeat(PANEL_WIDTH));

    for (let index = 0; index < labels.length; index++) {
      const row = top + 3 + index * 2;
      const active = index === this.selected;
      const isConnectRow = showsConnect && index === 0;
      out.push(at(row, left), paint(active ? foreground : dim, background, active));
      out.push(`${active ? '>' : ' '} ${(labels[index] ?? '').padEnd(14)}`);
      out.push(paint(foreground, active ? chosen : field));
      out.push(` ${(values[index] ?? '').padEnd(FIELD_WIDTH - 2)} `);
      out.push(paint(dim, background), active ? (isConnectRow ? '  Enter' : '  < >') : '');
    }

    let row = top + 3 + labels.length * 2 + 1;
    if (this.pendingModel !== this.model) {
      // Two lines: the panel is 62 columns wide and autowrap is off, so a longer
      // sentence would simply be cut in half at the right edge.
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
