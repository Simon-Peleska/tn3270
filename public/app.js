import { init, Terminal } from '/vendor/dist/ghostty-web.js';
import { mapKey } from '/keymap.js';
import { SettingsPage } from '/settings.js';
import { loadSettings, saveSettings } from '/store.js';
import { installBoxSelection } from '/box-select.js';

installBoxSelection();

/**
 * The browser side is deliberately thin: it renders VT bytes the server sends
 * and forwards keystrokes back. It holds no screen state of its own, which is
 * exactly why a second browser can join a running session and be correct
 * immediately.
 */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function element(id) {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found;
}

const screenEl = element('screen');

/** @type {{ code: string, message: string } | null} */
let activeError = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let errorTimer;

/**
 * @returns {string} VT bytes painting the active error over the terminal's
 *   last row — the same row a real 3270 uses for its status line — or an
 *   empty string when there is nothing to show.
 */
function errorOverlayBytes() {
  if (activeError === null || terminal === null) return '';
  const cols = terminal.cols;
  const row = terminal.rows;
  const text = `[${activeError.code}] ${activeError.message}`.slice(0, cols).padEnd(cols, ' ');
  return `\x1b[?25l\x1b[${row};1H\x1b[0;1;38;2;255;217;217;48;2;58;29;32m${text}\x1b[0m`;
}

/**
 * @param {string} hex `#rrggbb`
 * @returns {[number, number, number]}
 */
function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** The only way into settings for a mouse or a touch, so it lives right on
 *  the 3270's own status line rather than in page chrome around the
 *  terminal — the terminal is the whole UI (see settings.js). */
const SETTINGS_BUTTON_LABEL = '[Settings]';

/**
 * @returns {string} VT bytes painting the button over the start of the OIA
 *   row, reverse-themed so it reads as clickable against plain status text.
 *   Cursor position is saved and restored around the paint (`ESC 7`/`ESC 8`)
 *   so redrawing this on every host update never steals the real cursor from
 *   whatever field the host put it in.
 */
function settingsButtonBytes() {
  if (terminal === null) return '';
  const colors = settings.theme().colors;
  const [br, bg, bb] = hexToRgb(colors['foreground'] ?? '#00ff00');
  const [fr, fg, fb] = hexToRgb(colors['background'] ?? '#000000');
  const row = terminal.rows;
  return `\x1b7\x1b[${row};1H\x1b[0;1;38;2;${fr};${fg};${fb};48;2;${br};${bg};${bb}m${SETTINGS_BUTTON_LABEL}\x1b[0m\x1b8`;
}

/**
 * @param {MouseEvent} event
 * @returns {{ row: number, col: number } | null} the 0-based cell under the
 *   pointer, or null before the terminal exists.
 */
function cellAt(event) {
  const renderer = terminal?.renderer;
  if (terminal === null || renderer === undefined) return null;
  const rect = renderer.getCanvas().getBoundingClientRect();
  return {
    row: Math.floor((event.clientY - rect.top) / renderer.charHeight),
    col: Math.floor((event.clientX - rect.left) / renderer.charWidth),
  };
}

/**
 * Show a coded error in place, on the terminal's own status line. Never
 * navigate: the session is right there on screen and a redirect would throw
 * it away. The overlay is reasserted after every later write to that row (see
 * the WebSocket message handler and the settings page's `write` dependency),
 * so it stays on top until it is cleared.
 *
 * @param {string} code
 * @param {string} message
 * @returns {void}
 */
function showError(code, message) {
  console.error(`[${code}] ${message}`);
  activeError = { code, message };
  if (errorTimer !== undefined) clearTimeout(errorTimer);
  errorTimer = setTimeout(clearError, 6000);
  if (settings.open) settings.draw();
  else if (terminal !== null) terminal.write(errorOverlayBytes());
}

/**
 * Drop the active error and ask for the real status line back, exactly the
 * way the settings page asks for the real screen back when it closes.
 *
 * @returns {void}
 */
function clearError() {
  if (activeError === null) return;
  activeError = null;
  if (errorTimer !== undefined) clearTimeout(errorTimer);
  if (settings.open) settings.draw();
  else if (socket !== null && socket.readyState === WebSocket.OPEN) send({ type: 'refresh' });
}

/** @returns {Promise<{ id: string, rows: number, cols: number }>} */
async function createSession() {
  const response = await fetch('/api/sessions', { method: 'POST' });
  const body = await response.json();
  if (!response.ok) throw new Error(`[${body.code ?? 'E0000'}] ${body.message ?? 'could not create a session'}`);
  return body;
}

/**
 * The session id lives in the URL fragment, so sharing the address is all it
 * takes for a second person to watch the same screen.
 *
 * @returns {Promise<{ id: string, rows: number, cols: number }>}
 */
async function resolveSession() {
  const existing = location.hash.slice(1);
  if (existing !== '') {
    const response = await fetch('/api/sessions');
    const body = await response.json();
    const found = (body.sessions ?? []).find((/** @type {{ id: string }} */ s) => s.id === existing);
    if (found) return { id: existing, rows: 0, cols: 0 };
    showError('E3001', `Session ${existing} is gone; starting a new one.`);
  }
  const created = await createSession();
  location.hash = created.id;
  return created;
}

/** @type {import('ghostty-web').Terminal | null} */
let terminal = null;

/** @type {number} The model the server has confirmed, which the picker must agree with. */
let currentModel = 0;

/** @type {boolean | null} Whether the last status the server sent was a connected
 * one; null until the first status arrives, so that first status is always
 * treated as a change and settles the settings page one way or the other. */
let wasConnected = null;

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 64;

/**
 * @param {string | null} host `null` when the server has a configured host and
 *   the field only ever shows it, never edits it — connecting then just means
 *   asking the server to reopen the one it already knows.
 * @returns {void}
 */
function connectHost(host) {
  if (host === null) {
    send({ type: 'connect', host: null });
    return;
  }
  if (host === '') {
    showError('E5002', 'Enter a host as name:port first.');
    return;
  }
  localStorage.setItem('tn3270.host', host);
  send({ type: 'connect', host });
}

/**
 * The settings page is drawn into this very terminal, so it needs nothing but a
 * way to write bytes and a handful of things to apply. While it is open the
 * host's own bytes are dropped and the screen is asked for again on close.
 */
const settings = new SettingsPage({
  write: (bytes) => {
    terminal?.write(bytes);
    if (activeError !== null) terminal?.write(errorOverlayBytes());
  },
  geometry: () => ({ cols: terminal?.cols ?? 80, rows: terminal?.rows ?? 25 }),
  applyTheme,
  applyFont,
  applyModel: (model) => send({ type: 'model', model }),
  applyHostColors: (enabled) => send({ type: 'hostColors', enabled }),
  connect: connectHost,
  restore: () => send({ type: 'refresh' }),
  persist: (values) => {
    saveSettings(values).catch((cause) => {
      showError('E5004', `Settings could not be saved in this browser: ${String(cause)}`);
    });
  },
});

/**
 * @param {number} cols
 * @param {number} rows
 * @returns {import('ghostty-web').Terminal}
 */
function ensureTerminal(cols, rows) {
  const existing = terminal;
  if (existing !== null) {
    if (existing.cols !== cols || existing.rows !== rows) existing.resize(cols, rows);
    fitFontSize();
    if (settings.open) settings.draw();
    return existing;
  }
  // One extra row for the OIA status line the server paints below the screen.
  const created = new Terminal({
    cols,
    rows,
    cursorBlink: false,
    disableStdin: true,
    fontFamily: settings.font().family,
    fontSize: 15,
    scrollback: 0,
    theme: settings.theme().colors,
  });
  created.open(screenEl);
  terminal = created;
  screenEl.style.background = settings.theme().colors['background'] ?? '#000000';
  fitFontSize();
  return created;
}

/**
 * `renderer.setTheme()` recolors the canvas chrome (background, cursor, ...)
 * but host colours are indexed into the WASM terminal's own ANSI palette,
 * which ghostty-web only builds once, at `open()`. Setting `options.theme`
 * afterwards is silently kept (it just skips ghostty-web's own, still
 * unfinished, live-theme handling), so `reset()` picking it back up is what
 * actually rebuilds that palette from the newly chosen theme. The settings
 * page redraws over the now-blank screen immediately after this returns, and
 * closing it asks the server for a full repaint, so nothing is lost.
 *
 * @param {import('/settings.js').Theme} theme
 * @returns {void}
 */
function applyTheme(theme) {
  const created = terminal;
  const renderer = created?.renderer;
  if (created === null || renderer === undefined) return;

  renderer.setTheme(theme.colors);
  // The page around the grid is part of the picture: a black frame around an
  // amber screen looks like a bug rather than a theme.
  screenEl.style.background = theme.colors['background'] ?? '#000000';
  created.options.theme = theme.colors;
  created.reset();
  renderer.resize(created.cols, created.rows);
  if (created.wasmTerm !== undefined) renderer.render(created.wasmTerm, true);
}

/**
 * @param {{ name: string, family: string }} font
 * @returns {Promise<void>}
 */
async function applyFont(font) {
  // Measuring a face the browser has not loaded yet gives the fallback's
  // metrics, and the grid would be fitted to the wrong size.
  try {
    await document.fonts.load(`16px ${font.family}`);
  } catch (cause) {
    console.warn(`could not preload ${font.name}`, cause);
  }

  const created = terminal;
  if (created === null) return;
  created.options.fontFamily = font.family;
  fitFontSize();
  if (settings.open) settings.draw();
}

/**
 * Make the grid as large as the page allows without cutting it off. The row and
 * column counts belong to the 3270 model and cannot be traded away, so the font
 * size is the only thing free to move.
 *
 * @returns {void}
 */
function fitFontSize() {
  const created = terminal;
  const renderer = created?.renderer;
  if (created === null || renderer === undefined) return;

  const style = getComputedStyle(screenEl);
  const width = screenEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = screenEl.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  if (width < 1 || height < 1) return;

  // A cell measures ceil(fontSize x something), so the ratio below lands on the
  // answer or a pixel above it; starting one size high and walking down costs a
  // step or two and is exact.
  const scale = Math.min(
    width / (renderer.charWidth * created.cols),
    height / (renderer.charHeight * created.rows),
  );
  let size = Math.floor(created.options.fontSize * scale) + 1;
  size = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
  created.options.fontSize = size;

  while (
    size > MIN_FONT_SIZE &&
    (renderer.charWidth * created.cols > width || renderer.charHeight * created.rows > height)
  ) {
    size -= 1;
    created.options.fontSize = size;
  }

  // ghostty-web 0.4.0 re-sizes the canvas in CSS pixels after a font change,
  // discarding the device-pixel backing store its own resize() set up. Put it
  // back, or every glyph is soft on a HiDPI screen.
  renderer.resize(created.cols, created.rows);
  if (created.wasmTerm !== undefined) renderer.render(created.wasmTerm, true);
}

// The screen box is sized by the page, so its own resizes — the window, the
// error bar appearing — are the signal to refit. Coalesced into a frame because
// a drag fires this continuously.
let fitScheduled = false;
new ResizeObserver(() => {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    fitFontSize();
  });
}).observe(screenEl);

/** @type {WebSocket | null} */
let socket = null;
/** @type {number} */
let backoffMs = 250;

/**
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {void}
 */
function send(message) {
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    showError('E5002', 'Not connected to the server; your input was not sent.');
    return;
  }
  socket.send(JSON.stringify(message));
}

/**
 * @param {string} sessionId
 * @returns {void}
 */
function connectSocket(sessionId) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  // Passed on the URL, not a follow-up message, so the very first repaint the
  // server sends already matches the saved preference instead of flashing
  // host colours for one frame.
  const hostColors = settings.hostColors ? '' : '?hostColors=0';
  const ws = new WebSocket(`${scheme}://${location.host}/ws/${sessionId}${hostColors}`);
  ws.binaryType = 'arraybuffer';
  socket = ws;

  let opened = false;
  ws.addEventListener('open', () => {
    opened = true;
    backoffMs = 250;
  });

  ws.addEventListener('message', (event) => {
    // Binary frames are screen bytes, text frames are control messages. The
    // hello that sizes the terminal always precedes the first screen bytes.
    if (event.data instanceof ArrayBuffer) {
      // The settings page owns the screen while it is open. Dropping the host's
      // bytes is safe because the server is asked for a full repaint on close.
      if (terminal !== null && !settings.open) {
        terminal.write(new Uint8Array(event.data));
        terminal.write(settingsButtonBytes());
        if (activeError !== null) terminal.write(errorOverlayBytes());
      }
      return;
    }
    handleServerMessage(JSON.parse(String(event.data)));
  });

  ws.addEventListener('error', () => {
    showError('E5002', 'The connection to the server failed.');
  });

  ws.addEventListener('close', () => {
    // The session lives on the server, so reconnecting picks the screen back up
    // exactly where it was — no state to restore here.
    //
    // Unless the socket never opened at all: then the session is probably gone
    // (the server restarted), and retrying the same id would 404 forever.
    setTimeout(() => {
      if (opened) {
        connectSocket(sessionId);
        return;
      }
      resolveSession().then(
        (session) => connectSocket(session.id),
        () => connectSocket(sessionId),
      );
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 8000);
  });
}

/**
 * @param {import('../server/protocol.js').ServerMessage} message
 * @returns {void}
 */
function handleServerMessage(message) {
  if (message.type === 'hello') {
    currentModel = message.model;
    settings.models = message.models;
    settings.setModel(message.model);
    ensureTerminal(message.cols, message.rows + 1);
    // A host that comes from the config is the operator's business, not the
    // browser's: it is neither shown nor editable here.
    settings.setHostLocked(message.hostLocked);
    screenEl.focus();
    return;
  }
  if (message.type === 'screen') {
    currentModel = message.model;
    settings.setModel(message.model);
    ensureTerminal(message.cols, message.rows + 1);
    return;
  }
  if (message.type === 'status') {
    settings.connected = message.connection !== 'not-connected';
    // A real 3270 swaps the solid block cursor for an underline in insert
    // mode, since it is otherwise the only way to tell the two apart.
    terminal?.renderer?.setCursorStyle(message.insert ? 'underline' : 'block');
    // b3270 reports the host without its port, so filling the field from it
    // would quietly destroy what the user typed. Only use it to seed an empty
    // field, which is what a viewer joining someone else's session needs.
    if (message.host !== null && settings.host === '' && !settings.hostLocked) settings.setHost(message.host);
    const connected = message.connection.startsWith('connected');
    // Only the moment the connection changes opens or closes the settings page
    // — once it has, it stays exactly where the user or the connection left it
    // across every unrelated status update (lock state, insert mode, ...).
    if (connected !== wasConnected) {
      if (connected) {
        settings.close();
        clearError();
      } else {
        settings.show();
      }
    }
    wasConnected = connected;
    return;
  }
  // A refused model change leaves the settings page showing something the
  // server never accepted, so put it back to the model actually in force.
  settings.setModel(currentModel);
  showError(message.code, message.message);
}

// Alt+Space has to work wherever the focus is, so the settings page gets first
// refusal on every key in the page. It swallows everything while it is open, so
// the host cannot be typed at through a screen nobody can see.
window.addEventListener('keydown', (event) => {
  if (!settings.handleKey(event)) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

screenEl.addEventListener('keydown', (event) => {
  if (settings.open) return;
  // A keystroke aimed at the live host is also the operator saying "I've seen
  // it", exactly how a real 3270 clears an operator-error condition.
  clearError();
  const mapped = mapKey(event);
  if (mapped === null) return;
  event.preventDefault();
  event.stopPropagation();

  if (mapped.kind === 'text') send({ type: 'text', value: mapped.value });
  else send({ type: 'action', action: mapped.action, args: mapped.args });
}, true);

screenEl.addEventListener('click', (event) => {
  screenEl.focus();
  if (settings.open || terminal === null) return;
  const cell = cellAt(event);
  if (cell !== null && cell.row === terminal.rows - 1 && cell.col < SETTINGS_BUTTON_LABEL.length) {
    settings.toggle();
  }
});

try {
  await init();
} catch (cause) {
  showError('E5001', `The terminal renderer failed to load: ${String(cause)}`);
  throw cause;
}

// Saved settings have to be in hand before the terminal is built, or the first
// screen is painted in the default theme and then visibly restyled.
try {
  settings.restoreSaved(await loadSettings());
} catch (cause) {
  showError('E5003', `Saved settings could not be read; using the defaults: ${String(cause)}`);
}
try {
  await document.fonts.load(`16px ${settings.font().family}`);
} catch (cause) {
  console.warn('could not preload the saved font', cause);
}

const storedHost = localStorage.getItem('tn3270.host');
if (storedHost !== null) settings.setHost(storedHost);

const session = await resolveSession();
if (session.cols > 0) ensureTerminal(session.cols, session.rows + 1);
connectSocket(session.id);
