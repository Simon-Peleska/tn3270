// The settings page, drawn as VT bytes into the terminal itself rather than HTML.

export const ESC = '\x1b';

/**
 * @typedef {object} Theme
 * @property {string} name
 * @property {Record<string, string>} colors ghostty's chrome and ANSI slots,
 *   plus `field`, the tint of a typeable field; ghostty ignores that extra key
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
  // IBM Host On-Demand's default; its blue really is this dark, left uncorrected.
  { name: 'Host On-Demand', colors: {
    background: '#000000', foreground: '#00ff00', cursor: '#00ff00', cursorAccent: '#000000', selectionBackground: '#ffffff', selectionForeground: '#000000', field: '#1c1c1c',
    black: '#000000', red: '#ff0000', green: '#00ff00', yellow: '#ffff00', blue: '#0000b3', magenta: '#c000ff', cyan: '#00ffff', white: '#ffffff',
    brightBlack: '#808080', brightRed: '#ff8000', brightGreen: '#80ff80', brightYellow: '#ffff80', brightBlue: '#0000ff', brightMagenta: '#ff00ff', brightCyan: '#80ffff', brightWhite: '#ffffff',
  } },
  // The same emulator on white: black and white swap roles, as they do above.
  { name: 'Host On-Demand White', colors: {
    background: '#ffffff', foreground: '#000000', cursor: '#000000', cursorAccent: '#ffffff', selectionBackground: '#000000', selectionForeground: '#ffffff', field: '#e6e6e6',
    black: '#ffffff', red: '#cc0000', green: '#008000', yellow: '#8a7f00', blue: '#000099', magenta: '#7700cc', cyan: '#008080', white: '#000000',
    brightBlack: '#666666', brightRed: '#cc6600', brightGreen: '#00a300', brightYellow: '#b38f00', brightBlue: '#0000cc', brightMagenta: '#cc00cc', brightCyan: '#00a3a3', brightWhite: '#000000',
  } },
  { name: 'Ghostty Dark', colors: {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff', cursorAccent: '#1e1e1e', selectionBackground: '#d4d4d4', selectionForeground: '#1e1e1e', field: '#2d2d2d',
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
  } },
  // `field` is a lift of base02: base02 is already black here, base01 too bright.
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
  // Bright palette in the plain slots: the muted set is too dim for full screens.
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
 * The first three are vendored in `public/fonts/`; the rest are the machine's.
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
 * @param {string} from
 * @param {string} to
 * @param {number} amount 0 = from, 1 = to
 * @returns {string} `#rrggbb`
 */
export function mix(from, to, amount) {
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
export function at(row, col) {
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
    colors[key] = value.toLowerCase() === '#000000' ? '#010101' : value;
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
  return `${ESC}[0${bold ? ';1' : ''};38;2;${fr};${fg2};${fb};48;2;${br};${bg2};${bb}m`;
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

const FIELD_WIDTH = 26;
const PANEL_WIDTH = 62;

/**
 * The panel macros.js and recorder.js draw; settings.js draws its own.
 *
 * @param {object} args
 * @param {(bytes: string) => void} args.write
 * @param {() => { cols: number, rows: number }} args.geometry
 * @param {Theme} args.theme
 * @param {string} args.title
 * @param {{ label: string, value: string }[]} args.fields
 * @param {number} args.selected
 * @param {number} args.labelWidth
 * @param {number} args.fieldWidth
 * @param {number} args.heightBase rows the panel needs beyond its fields
 * @param {string[]} args.helpLines
 * @returns {void}
 */
export function drawListPanel({ write, geometry, theme, title, fields, selected, labelWidth, fieldWidth, heightBase, helpLines }) {
  const { cols, rows } = geometry();
  const colors = theme.colors;
  const background = colors['background'] ?? '#000000';
  const foreground = colors['foreground'] ?? '#00ff00';
  const dim = mix(background, foreground, 0.55);
  const field = colors['field'] ?? mix(background, foreground, 0.12);
  const chosen = mix(field, foreground, 0.3);

  const left = Math.max(1, Math.floor((cols - PANEL_WIDTH) / 2) + 1);
  const top = Math.max(1, Math.floor((rows - (heightBase + fields.length * 2)) / 2) + 1);

  /** @type {string[]} */
  const out = [`${ESC}[?25l`, paint(foreground, background), `${ESC}[2J`];

  out.push(at(top, left), paint(foreground, background, true), title);
  out.push(at(top + 1, left), paint(dim, background), '='.repeat(PANEL_WIDTH));

  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index];
    const row = top + 3 + index * 2;
    const active = index === selected;
    out.push(at(row, left), paint(active ? foreground : dim, background, active));
    out.push(`${active ? '>' : ' '} ${(entry?.label ?? '').slice(0, labelWidth).padEnd(labelWidth)}`);
    out.push(paint(foreground, active ? chosen : field));
    out.push(` ${(entry?.value ?? '').slice(0, fieldWidth - 2).padEnd(fieldWidth - 2)} `);
  }

  let helpRow = top + 3 + fields.length * 2 + 1;
  for (const line of helpLines) {
    out.push(at(helpRow, left), paint(dim, background), line);
    helpRow += 1;
  }

  write(out.join(''));
}

// The size "fit to window" measures at, not the font size on screen.
const DEFAULT_FIT_FONT_SIZE = 16;
const MIN_FIT_FONT_SIZE = 8;
const MAX_FIT_FONT_SIZE = 32;

// An oversize on top of the model is what makes b3270 negotiate IBM-DYNAMIC,
// and 62x160 is the biggest screen an IBM host will bind.
const DYNAMIC_ROWS = 62;
const DYNAMIC_COLS = 160;
export const DYNAMIC_OVERSIZE = `${DYNAMIC_COLS}x${DYNAMIC_ROWS}`;

/**
 * A fit is measured from the window it was made in, so what is worth saving is
 * the choice, not the cells that window happened to come to.
 *
 * @param {string} oversize
 * @returns {'model' | 'fit' | 'dynamic'}
 */
export function sizeMode(oversize) {
  if (oversize === DYNAMIC_OVERSIZE) return 'dynamic';
  return oversize === '' ? 'model' : 'fit';
}

/**
 * @typedef {object} SettingsDeps
 * @property {(bytes: string) => void} write
 * @property {() => { cols: number, rows: number }} geometry
 * @property {(theme: Theme) => void} applyTheme
 * @property {(font: { name: string, family: string }) => void} applyFont
 * @property {(model: number) => void} applyModel
 * @property {(value: string) => void} applyOversize `<cols>x<rows>`, or '' for the model's own size
 * @property {(fontSize: number) => { cols: number, rows: number } | null} windowFit
 * @property {(enabled: boolean) => void} applyHostColors
 * @property {(allowView: boolean, allowEdit: boolean) => void} applySharing
 * @property {(allowed: boolean) => void} applyAutomation
 * @property {(host: string | null) => void} connect
 * @property {() => void} restore
 * @property {(settings: import('./store.js').StoredSettings) => void} persist
 */

export class SettingsPage {
  /** @param {SettingsDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {string} the Alt+key KeyboardEvent.code that toggles this page */
    this.toggleKey = 'Space';
    /** @type {boolean} */
    this.open = false;
    /** @type {number} Index into rows(). */
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
    /** @type {number} */
    this.fitFontSize = DEFAULT_FIT_FONT_SIZE;
    /** @type {number | null} The model saved in this browser: every tab starts
     * its own sessions, so each one has to ask for it again. */
    this.savedModel = null;
    /** @type {'model' | 'fit' | 'dynamic' | null} The saved screen size. */
    this.savedSize = null;
    /** @type {import('../server/b3270.js').ModelInfo[]} */
    this.models = [];
    /** @type {boolean} */
    this.connected = false;
    /** @type {boolean} */
    this.hostColors = true;
    /** @type {string} */
    this.host = '';
    /** @type {boolean} Host comes from the server's config: not editable here. */
    this.hostLocked = false;
    /** @type {'controller' | 'observer'} Server-assigned, not a preference. */
    this.role = 'controller';
    /** @type {boolean} */
    this.allowSharing = true;
    /** @type {boolean} */
    this.allowSharedEditing = false;
    /** @type {boolean} Whether REST over the proxy may drive this session. */
    this.allowAutomation = false;
    /** @type {boolean} Ctrl-B field hints: local only, so no deps.applyX(). */
    this.hints = false;
  }

  /** @returns {boolean} */
  showsConnect() {
    return !this.connected;
  }

  /**
   * Whether the size in force was measured from the window, not asked for by name.
   *
   * @returns {boolean}
   */
  fitsWindow() {
    return sizeMode(this.oversize) === 'fit';
  }

  /**
   * Built fresh each time: two rows come and go, so indexes are not fixed.
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
    const dynamic = this.pendingOversize === DYNAMIC_OVERSIZE;
    rows.push({
      key: 'model',
      label: 'Screen model',
      value: dynamic ? `Dynamic - ${DYNAMIC_ROWS}x${DYNAMIC_COLS}` : this.describeModel(this.pendingModel),
    });
    // The dynamic screen is already a size asked for, so there is nothing to fit.
    if (!dynamic) {
      rows.push({
        key: 'fit',
        label: 'Fit to window',
        value: this.pendingOversize === '' ? 'Off' : this.pendingOversize,
      });
      if (this.pendingOversize !== '') {
        rows.push({ key: 'fitSize', label: 'Text size', value: `${this.fitFontSize} px` });
      }
    }
    rows.push({ key: 'hostColors', label: 'Host colors', value: this.hostColors ? 'On' : 'Off' });
    rows.push({ key: 'hints', label: 'Field hints (Ctrl-B)', value: this.hints ? 'On' : 'Off' });
    // Only the controller's call: it is their screen being shared and driven.
    if (this.role === 'controller') {
      rows.push({
        key: 'allowAutomation',
        label: 'Allow automation',
        value: this.allowAutomation ? 'On' : 'Off',
      });
      rows.push({ key: 'allowSharing', label: 'Allow sharing', value: this.allowSharing ? 'On' : 'Off' });
      if (this.allowSharing) {
        rows.push({
          key: 'allowSharedEditing',
          label: 'Shared editing',
          value: this.allowSharedEditing ? 'On' : 'Off',
        });
      }
    }
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

  /**
   * @param {'controller' | 'observer'} role
   * @returns {void}
   */
  setRole(role) {
    if (role === this.role) return;
    this.role = role;
    if (this.open) this.draw();
  }

  /**
   * @param {boolean} allowSharing
   * @param {boolean} allowSharedEditing
   * @returns {void}
   */
  setSharing(allowSharing, allowSharedEditing) {
    this.allowSharing = allowSharing;
    this.allowSharedEditing = allowSharedEditing;
    if (this.open) this.draw();
  }

  /**
   * @param {boolean} allowAutomation
   * @returns {void}
   */
  setAutomation(allowAutomation) {
    this.allowAutomation = allowAutomation;
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
   * Matched by name, so reordering the lists cannot scramble an old choice.
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
    if (typeof saved.hints === 'boolean') this.hints = saved.hints;
    if (typeof saved.model === 'number') this.savedModel = saved.model;
    if (saved.screenSize === 'model' || saved.screenSize === 'fit' || saved.screenSize === 'dynamic') {
      this.savedSize = saved.screenSize;
    }
    if (typeof saved.fitFontSize === 'number') {
      this.fitFontSize = Math.max(MIN_FIT_FONT_SIZE, Math.min(MAX_FIT_FONT_SIZE, saved.fitFontSize));
    }
  }

  /** @returns {void} */
  save() {
    this.deps.persist({
      theme: this.theme().name,
      font: this.font().name,
      model: this.savedModel,
      screenSize: this.savedSize,
      hostColors: this.hostColors,
      fitFontSize: this.fitFontSize,
      hints: this.hints,
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
   * b3270 silently refuses an oversize below the model, and buffers 16383 cells.
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

    // A pane too narrow for the model shrinks the text, which buys more rows.
    if (cols > fit.cols) {
      rows = Math.round(((fit.rows + 1) * cols) / fit.cols) - 1;
      rows = Math.max(minRows, Math.min(rows, Math.floor(16383 / cols)));
    }
    return `${cols}x${rows}`;
  }

  /** @returns {string} */
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
    if (event.altKey && event.code === this.toggleKey) {
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
      this.selected = cycle(this.selected, step, this.fieldCount());
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
      this.savedModel = this.pendingModel;
      this.savedSize = sizeMode(this.pendingOversize);
      this.save();
      this.close();
      return true;
    }
    // Swallow the rest: the host must not see keys aimed at this page.
    return true;
  }

  /**
   * Theme and font preview live; the screen size costs a reconnection, so it
   * waits for Enter.
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
      // The dynamic screen is one more choice after the models.
      const models = this.models.length > 0 ? this.models.map((info) => info.model) : [2, 3, 4, 5];
      const dynamic = this.pendingOversize === DYNAMIC_OVERSIZE;
      const current = dynamic ? models.length : models.indexOf(this.pendingModel);
      const next = cycle(current, step, models.length + 1);
      if (next === models.length) {
        this.pendingOversize = DYNAMIC_OVERSIZE;
      } else {
        this.pendingModel = models[next] ?? this.pendingModel;
        if (dynamic) this.pendingOversize = '';
      }
    } else if (key === 'fit') {
      // Measured afresh: the window may have been resized since it was shown.
      this.pendingOversize = this.pendingOversize === '' ? this.fitToWindow() : '';
    } else if (key === 'fitSize') {
      this.fitFontSize = Math.max(MIN_FIT_FONT_SIZE, Math.min(MAX_FIT_FONT_SIZE, this.fitFontSize + step));
      this.pendingOversize = this.fitToWindow();
      this.save();
    } else if (key === 'hostColors') {
      this.hostColors = !this.hostColors;
      this.deps.applyHostColors(this.hostColors);
      this.save();
    } else if (key === 'hints') {
      this.hints = !this.hints;
      this.save();
    } else if (key === 'allowSharing') {
      this.allowSharing = !this.allowSharing;
      // Nothing left to share editing with once sharing is off.
      if (!this.allowSharing) this.allowSharedEditing = false;
      this.deps.applySharing(this.allowSharing, this.allowSharedEditing);
    } else if (key === 'allowSharedEditing') {
      this.allowSharedEditing = !this.allowSharedEditing;
      this.deps.applySharing(this.allowSharing, this.allowSharedEditing);
    } else if (key === 'allowAutomation') {
      this.allowAutomation = !this.allowAutomation;
      this.deps.applyAutomation(this.allowAutomation);
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
