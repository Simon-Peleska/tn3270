import { init, Terminal } from '/vendor/dist/ghostty-web.js';
import { mapKey } from '/keymap.js';
import { SettingsPage } from '/settings.js';
import { loadSettings, saveSettings } from '/store.js';
import { MAX_SESSIONS, SessionPrefix, paneAreas, parseSessionHash, sessionHash, switcherText } from '/sessions.js';
import { installBoxSelection } from '/box-select.js';
import { installCursorGlyph } from '/cursor-glyph.js';

installBoxSelection();
installCursorGlyph();

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
  const term = activeTerminal();
  if (activeError === null || term === null) return '';
  const cols = term.cols;
  const row = term.rows;
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
 * @param {import('ghostty-web').Terminal} term the pane's own terminal: every
 *   session on screen carries its own button, so a split is not a screen you
 *   have to switch away from to configure.
 * @returns {string} VT bytes painting the button over the end of the OIA row,
 *   just past the cursor position, reverse-themed so it reads as clickable
 *   against plain status text. The server lays the status line out narrow
 *   enough to leave these columns free (see oia.js). Cursor position is saved
 *   and restored around the paint (`ESC 7`/`ESC 8`) so redrawing this on every
 *   host update never steals the real cursor from whatever field the host put
 *   it in.
 */
function settingsButtonBytes(term) {
  const colors = settings.theme().colors;
  const [br, bg, bb] = hexToRgb(colors['foreground'] ?? '#00ff00');
  const [fr, fg, fb] = hexToRgb(colors['background'] ?? '#000000');
  const row = term.rows;
  const col = term.cols - SETTINGS_BUTTON_LABEL.length + 1;
  return `\x1b7\x1b[${row};${col}H\x1b[0;1;38;2;${fr};${fg};${fb};48;2;${br};${bg};${bb}m${SETTINGS_BUTTON_LABEL}\x1b[0m\x1b8`;
}

/**
 * @returns {string} VT bytes painting the session switcher over the whole status
 *   row while Ctrl-B is armed, or an empty string. It is shown only for the one
 *   keystroke it lasts, so it costs the screen nothing the rest of the time.
 */
function prefixBarBytes() {
  const term = activeTerminal();
  if (!prefix.armed || term === null) return '';
  const colors = settings.theme().colors;
  const [br, bg, bb] = hexToRgb(colors['foreground'] ?? '#00ff00');
  const [fr, fg, fb] = hexToRgb(colors['background'] ?? '#000000');
  const ids = sessions.map((slot) => slot?.id ?? null);
  const text = switcherText(ids, active).slice(0, term.cols).padEnd(term.cols, ' ');
  return `\x1b[?25l\x1b[${term.rows};1H\x1b[0;1;38;2;${fr};${fg};${fb};48;2;${br};${bg};${bb}m${text}\x1b[0m`;
}

/**
 * Both bars live on the terminal's last row and neither exists on the server, so
 * both are reasserted after every write that lands there. The switcher goes on
 * top: it is only up while a key is being pressed for it.
 *
 * @returns {string}
 */
function overlayBytes() {
  return errorOverlayBytes() + prefixBarBytes();
}

/**
 * Paint whatever overlay is up, if any. Nothing is the usual answer, and it has
 * to stay unwritten: ghostty-web 0.4.0 asks the WASM heap for a buffer before
 * every write, an allocation of zero bytes comes back as the pointer -1, and
 * copying into it throws `RangeError: offset is out of bounds` — which lands in
 * the middle of whoever was drawing and leaves the screen half painted.
 *
 * @returns {void}
 */
function writeOverlays() {
  const slot = activeSession();
  const bytes = overlayBytes();
  if (bytes === '' || slot === null || slot.terminal === null) return;
  slot.terminal.write(bytes);
  // Which pane was painted over has to be remembered, because by the time the
  // overlay comes off the keyboard may well be aimed at a different one.
  overlaySlot = slot;
}

/**
 * @param {SessionSlot} slot
 * @param {MouseEvent} event
 * @returns {{ row: number, col: number } | null} the 0-based cell under the
 *   pointer, or null before the terminal exists.
 */
function cellAt(slot, event) {
  const renderer = slot.terminal?.renderer;
  if (renderer === undefined) return null;
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
  else writeOverlays();
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
  repaintStatus();
}

/**
 * Ask for the real status line back, the way the settings page asks for the real
 * screen back when it closes. Anything painted over that row — the error bar,
 * the session switcher — exists only in this browser, so the row can only be
 * undone by having the server send it again.
 *
 * @returns {void}
 */
function repaintStatus() {
  const painted = overlaySlot;
  overlaySlot = null;
  if (settings.open) {
    settings.draw();
    return;
  }
  if (painted?.socket?.readyState === WebSocket.OPEN) sendTo(painted, { type: 'refresh' });
}

/** @returns {Promise<{ id: string, rows: number, cols: number }>} */
async function createSession() {
  const response = await fetch('/api/sessions', { method: 'POST' });
  const body = await response.json();
  if (!response.ok) throw new Error(`[${body.code ?? 'E0000'}] ${body.message ?? 'could not create a session'}`);
  return body;
}

/**
 * One host session, of which the tab holds up to MAX_SESSIONS at once. Every
 * socket stays open whether its session is on screen or not: the bytes of a
 * session whose pane is hidden are thrown away — the server holds the screen
 * and will repaint it on demand — but its viewer has to stay attached, or the
 * server would reap the session out from under it after the idle timeout.
 *
 * A session owns its pane and the terminal drawn in it for as long as it lives.
 * Laying the screen out differently moves panes around and hides some of them;
 * it never hands one session's terminal to another.
 *
 * @typedef {object} SessionSlot
 * @property {string} id
 * @property {HTMLElement} pane
 * @property {import('ghostty-web').Terminal | null} terminal built the first
 *   time the pane is on screen with a known geometry
 * @property {WebSocket | null} socket
 * @property {number} backoffMs
 * @property {number} model the model the server has confirmed, which the
 *   settings page must agree with
 * @property {string} oversize the fitted screen it has confirmed, likewise
 * @property {number} cols
 * @property {number} rows including the OIA row this side adds
 * @property {string} connection the last connection state the server reported;
 *   empty until the first status arrives, so that first status always counts as
 *   a change and settles the settings page one way or the other
 */

/** @type {(SessionSlot | null)[]} */
const sessions = [];
for (let index = 0; index < MAX_SESSIONS; index++) sessions.push(null);

/** @type {number} The slot the keyboard is aimed at; always one of `panes`. */
let active = 0;

/** @type {number[]} The slots on screen, in pane order — one entry per pane. */
let panes = [0];

/** @type {SessionSlot | null} The pane an overlay is currently painted over. */
let overlaySlot = null;

const prefix = new SessionPrefix();

/** @returns {SessionSlot | null} */
function activeSession() {
  return sessions[active] ?? null;
}

/** @returns {import('ghostty-web').Terminal | null} */
function activeTerminal() {
  return activeSession()?.terminal ?? null;
}

/**
 * @param {string} id
 * @param {number} cols
 * @param {number} rows including the OIA row
 * @returns {SessionSlot}
 */
function newSlot(id, cols = 0, rows = 0) {
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.hidden = true;
  screenEl.append(pane);
  /** @type {SessionSlot} */
  const slot = {
    id, pane, terminal: null, socket: null, backoffMs: 250,
    model: 0, oversize: '', cols, rows, connection: '',
  };
  pane.addEventListener('click', (event) => paneClicked(slot, event));
  return slot;
}

/**
 * Every session the tab holds goes in the URL fragment, so sharing the address
 * still shares all of them at once.
 *
 * @returns {void}
 */
function writeHash() {
  location.hash = sessionHash(sessions.map((slot) => slot?.id ?? null));
}

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
    activeTerminal()?.write(bytes);
    writeOverlays();
  },
  geometry: () => ({ cols: activeTerminal()?.cols ?? 80, rows: activeTerminal()?.rows ?? 25 }),
  applyTheme,
  applyFont,
  applyModel: (model) => send({ type: 'model', model }),
  applyOversize: (value) => send({ type: 'oversize', value }),
  windowFit,
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
 * Build the session's terminal, or resize the one it has to the geometry the
 * server last reported. A session with no geometry yet has nothing to build.
 *
 * @param {SessionSlot} slot
 * @returns {import('ghostty-web').Terminal | null}
 */
function ensureTerminal(slot) {
  if (slot.cols < 1 || slot.rows < 1) return null;
  const existing = slot.terminal;
  if (existing !== null) {
    if (existing.cols !== slot.cols || existing.rows !== slot.rows) existing.resize(slot.cols, slot.rows);
    fitFontSize(slot);
    if (settings.open && slot === activeSession()) settings.draw();
    return existing;
  }
  // One extra row for the OIA status line the server paints below the screen.
  const created = new Terminal({
    cols: slot.cols,
    rows: slot.rows,
    cursorBlink: false,
    disableStdin: true,
    fontFamily: settings.font().family,
    fontSize: 15,
    scrollback: 0,
    theme: settings.theme().colors,
  });
  created.open(slot.pane);
  slot.terminal = created;
  paintFrame();
  fitFontSize(slot);
  return created;
}

/**
 * The page around the grids is part of the picture: a black frame around an
 * amber screen looks like a bug rather than a theme.
 *
 * @returns {void}
 */
function paintFrame() {
  const background = settings.theme().colors['background'] ?? '#000000';
  screenEl.style.background = background;
  for (const slot of sessions) {
    if (slot === null) continue;
    slot.pane.style.background = background;
  }
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
  paintFrame();
  for (const slot of sessions) {
    if (slot === null) continue;
    // The server paints the typeable fields, so every session has to be told
    // which colour this theme wants them; each repaints in answer. A theme is
    // the whole page's, not one pane's.
    if (slot.socket?.readyState === WebSocket.OPEN) {
      sendTo(slot, { type: 'fieldColor', color: theme.colors['field'] ?? null });
    }
    const created = slot.terminal;
    const renderer = created?.renderer;
    if (created == null || renderer === undefined) continue;

    renderer.setTheme(theme.colors);
    created.options.theme = theme.colors;
    created.reset();
    // reset() frees the WASM terminal and builds a new one, but the selection
    // manager holds its own reference and is never told. Copying then reads
    // freed memory, and once the screen grows — a host switching to the
    // alternate screen, say — the dead terminal still has the old, smaller grid,
    // so anything outside it silently copies as nothing.
    const selection = created['selectionManager'];
    const wasmTerm = created.wasmTerm;
    if (selection !== undefined && wasmTerm !== undefined) selection['wasmTerm'] = wasmTerm;
    renderer.resize(created.cols, created.rows);
    if (created.wasmTerm !== undefined) renderer.render(created.wasmTerm, true);
  }
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

  for (const slot of sessions) {
    if (slot?.terminal == null) continue;
    slot.terminal.options.fontFamily = font.family;
    fitFontSize(slot);
  }
  if (settings.open) settings.draw();
}

/**
 * The room a pane leaves its terminal. A hidden pane has none, which is how a
 * session nobody is looking at is kept out of every measurement.
 *
 * @param {HTMLElement} pane
 * @returns {{ width: number, height: number } | null}
 */
function paneBox(pane) {
  const style = getComputedStyle(pane);
  const width = pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = pane.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

/**
 * Make the grid as large as its pane allows without cutting it off. The row and
 * column counts belong to the 3270 model and cannot be traded away, so the font
 * size is the only thing free to move.
 *
 * @param {SessionSlot} slot
 * @returns {void}
 */
function fitFontSize(slot) {
  const created = slot.terminal;
  const renderer = created?.renderer;
  if (created == null || renderer === undefined) return;

  const box = paneBox(slot.pane);
  if (box === null) return;
  const { width, height } = box;

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

/**
 * How big a screen this session's pane would hold with text `fontSize` pixels
 * tall — the inverse of fitFontSize(), where the grid is fixed and the text
 * scales. The answer is what the settings page asks the host for as an oversize
 * screen, which is why it measures the pane and not the window: in a split, a
 * session gets the screen its own quarter or half of the page can show.
 *
 * @param {number} fontSize
 * @returns {{ cols: number, rows: number } | null}
 */
function windowFit(fontSize) {
  const slot = activeSession();
  return slot === null ? null : paneFit(slot, fontSize);
}

/**
 * @param {SessionSlot} slot
 * @param {number} fontSize
 * @returns {{ cols: number, rows: number } | null}
 */
function paneFit(slot, fontSize) {
  const created = slot.terminal;
  const renderer = created?.renderer;
  if (created == null || renderer === undefined) return null;

  const box = paneBox(slot.pane);
  if (box === null) return null;

  // The cell is measured at the size being asked about rather than scaled from
  // the size in force. ghostty rounds a cell up to whole pixels, so scaling a
  // rounded cell lands near the answer and somewhere slightly different for
  // every pane — which is four panes of the same size that never agree on a
  // screen, and a fit that walks a column or two every time it is asked for.
  // Assigning the size is what re-measures; the terminal is not redrawn until
  // something asks it to be.
  const drawn = created.options.fontSize;
  created.options.fontSize = fontSize;
  const cellWidth = renderer.charWidth;
  const cellHeight = renderer.charHeight;
  created.options.fontSize = drawn;

  const cols = Math.floor(box.width / cellWidth);
  // One row of the grid is the OIA, which this side paints and the host knows
  // nothing about.
  const rows = Math.floor(box.height / cellHeight) - 1;
  if (cols < 1 || rows < 1) return null;
  return { cols, rows };
}

/**
 * Give a session with no host on it a screen the size of the pane it now sits
 * in, which is what keeps a split from being four screens of unreadable text.
 * The size is negotiated when the connection is opened, so a session between
 * hosts is the only one where it is free: asking a *connected* session to
 * resize drops and reopens its connection, and losing the host's idea of where
 * the operator was just because the screen was split would be indefensible. A
 * connected pane keeps its screen and shrinks the text instead, and the
 * settings page — which measures the pane, not the window — is there to refit
 * it on purpose.
 *
 * Only a layout change calls this. A single pane is the whole page, which is
 * the size the server handed out in the first place.
 *
 * @returns {void}
 */
function fitIdleSessions() {
  // An empty oversize is the operator asking for the model's own size, and that
  // is not a preference to be second-guessed here.
  if (settings.oversize === '') return;
  for (const index of panes) {
    const slot = sessions[index];
    if (slot == null || slot.connection !== 'not-connected') continue;
    if (slot.socket?.readyState !== WebSocket.OPEN) continue;
    const fit = paneFit(slot, settings.fitFontSize);
    if (fit === null) continue;
    const value = settings.fitSize(fit, slot.model);
    if (value === slot.oversize) continue;
    sendTo(slot, { type: 'oversize', value });
  }
}

/** @returns {void} Refit every terminal the page is showing. */
function fitPanes() {
  for (const index of panes) {
    const slot = sessions[index];
    if (slot != null) fitFontSize(slot);
  }
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
    fitPanes();
  });
}).observe(screenEl);

/**
 * Everything the user types is aimed at the session the keyboard is on; the
 * other panes are being watched, not typed at.
 *
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {void}
 */
function send(message) {
  sendTo(activeSession(), message);
}

/**
 * @param {SessionSlot | null} slot
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {void}
 */
function sendTo(slot, message) {
  const socket = slot?.socket ?? null;
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    showError('E5002', 'Not connected to the server; your input was not sent.');
    return;
  }
  socket.send(JSON.stringify(message));
}

/**
 * @param {SessionSlot} slot
 * @returns {void}
 */
function connectSocket(slot) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  // Passed on the URL, not a follow-up message, so the very first repaint the
  // server sends already matches the saved preference instead of flashing
  // host colours for one frame.
  const query = new URLSearchParams();
  if (!settings.hostColors) query.set('hostColors', '0');
  const field = settings.theme().colors['field'];
  if (field !== undefined) query.set('fieldColor', field);
  const ws = new WebSocket(`${scheme}://${location.host}/ws/${slot.id}?${query}`);
  ws.binaryType = 'arraybuffer';
  slot.socket = ws;

  let opened = false;
  ws.addEventListener('open', () => {
    opened = true;
    slot.backoffMs = 250;
  });

  ws.addEventListener('message', (event) => {
    // Binary frames are screen bytes, text frames are control messages. The
    // hello that sizes the terminal always precedes the first screen bytes.
    if (event.data instanceof ArrayBuffer) {
      // Only a session with a pane on screen is painted. The settings page owns
      // the pane it is drawn in while it is open, and a hidden session has no
      // pane at all; dropping either one's bytes is safe because the server is
      // asked for a full repaint when it comes back into view.
      const term = slot.terminal;
      const covered = settings.open && slot === activeSession();
      if (term === null || slot.pane.hidden || covered) return;
      term.write(new Uint8Array(event.data));
      term.write(settingsButtonBytes(term));
      if (slot === activeSession()) writeOverlays();
      return;
    }
    handleServerMessage(slot, JSON.parse(String(event.data)));
  });

  ws.addEventListener('error', () => {
    showError('E5002', 'The connection to the server failed.');
  });

  ws.addEventListener('close', () => {
    // The session lives on the server, so reconnecting picks the screen back up
    // exactly where it was — no state to restore here.
    //
    // Unless the socket never opened at all: then the session is probably gone
    // (the server restarted), and retrying the same id would 404 forever, so the
    // slot is given a fresh session instead.
    setTimeout(() => {
      if (opened) {
        connectSocket(slot);
        return;
      }
      createSession().then(
        (created) => {
          slot.id = created.id;
          slot.cols = created.cols;
          slot.rows = created.rows + 1;
          writeHash();
          connectSocket(slot);
        },
        () => connectSocket(slot),
      );
    }, slot.backoffMs);
    slot.backoffMs = Math.min(slot.backoffMs * 2, 8000);
  });
}

/**
 * @param {SessionSlot} slot the session the message came from, which is not
 *   necessarily the one on screen: all of them keep running and keep reporting.
 * @param {import('../server/protocol.js').ServerMessage} message
 * @returns {void}
 */
function handleServerMessage(slot, message) {
  const onScreen = slot === activeSession();

  if (message.type === 'hello' || message.type === 'screen') {
    slot.model = message.model;
    slot.oversize = message.oversize;
    slot.cols = message.cols;
    slot.rows = message.rows + 1;
    if (message.type === 'hello') settings.models = message.models;
    if (!slot.pane.hidden) ensureTerminal(slot);
    if (!onScreen) return;
    settings.setModel(slot.model);
    settings.setOversize(slot.oversize);
    if (message.type === 'hello') {
      // A host that comes from the config is the operator's business, not the
      // browser's: it is neither shown nor editable here.
      settings.setHostLocked(message.hostLocked);
      screenEl.focus();
    }
    return;
  }
  if (message.type === 'fieldContent') {
    if (onScreen) navigator.clipboard.writeText(message.text);
    return;
  }
  if (message.type === 'status') {
    const connected = message.connection.startsWith('connected');
    const changed = slot.connection === '' || connected !== slot.connection.startsWith('connected');
    slot.connection = message.connection;
    // A real 3270 swaps the solid block cursor for an underline in insert
    // mode, since it is otherwise the only way to tell the two apart. Insert is
    // the session's own state, so this is not just the focused pane's business.
    slot.terminal?.renderer?.setCursorStyle(message.insert ? 'underline' : 'block');
    // A session opened to fill a new pane is only reachable once its socket has
    // said hello, which is well after the layout that made the pane was applied.
    if (changed && !connected && !slot.pane.hidden && panes.length > 1) fitIdleSessions();
    if (!onScreen) return;
    settings.connected = message.connection !== 'not-connected';
    // b3270 reports the host without its port, so filling the field from it
    // would quietly destroy what the user typed. Only use it to seed an empty
    // field, which is what a viewer joining someone else's session needs.
    if (message.host !== null && settings.host === '' && !settings.hostLocked) settings.setHost(message.host);
    // Only the moment the connection changes opens or closes the settings page
    // — once it has, it stays exactly where the user or the connection left it
    // across every unrelated status update (lock state, insert mode, ...).
    if (changed) {
      if (connected) {
        settings.close();
        clearError();
      } else {
        settings.show();
      }
    }
    return;
  }
  if (onScreen) {
    // A refused change leaves the settings page showing something the server
    // never accepted, so put it back to the size actually in force.
    settings.setModel(slot.model);
    settings.setOversize(slot.oversize);
    showError(message.code, message.message);
    return;
  }
  // A session nobody is looking at can still die, and swallowing that would
  // leave the operator switching to a screen that stopped ages ago.
  showError(message.code, `Session ${sessions.indexOf(slot) + 1}: ${message.message}`);
}

/**
 * Ask the server to paint a session's pane again. The screen lives entirely on
 * the server, so this is the only way to get back a pane this side has drawn
 * over — the settings page, the error bar, the switcher — or one that has been
 * out of sight while its bytes were being dropped.
 *
 * @param {SessionSlot} slot
 * @returns {void}
 */
function repaint(slot) {
  if (settings.open && slot === activeSession()) {
    settings.draw();
    return;
  }
  if (slot.socket?.readyState === WebSocket.OPEN) {
    sendTo(slot, { type: 'refresh' });
    return;
  }
  // A session still opening has nothing to repaint yet, and whatever is on its
  // terminal is older than the pane it now sits in.
  slot.terminal?.write('\x1b[2J');
}

/**
 * Give every pane its place in the grid, hide the sessions the layout leaves
 * out, and mark the one the keyboard is aimed at. A pane coming back into sight
 * is built if it has never been drawn in and repainted either way, since its
 * bytes were thrown away while it was hidden.
 *
 * @returns {void}
 */
function applyLayout() {
  const areas = paneAreas(panes.length);
  /** @type {SessionSlot[]} */
  const revealed = [];

  for (let index = 0; index < MAX_SESSIONS; index++) {
    const slot = sessions[index];
    if (slot == null) continue;
    const position = panes.indexOf(index);
    if (position < 0) {
      slot.pane.hidden = true;
      continue;
    }
    if (slot.pane.hidden) revealed.push(slot);
    slot.pane.hidden = false;
    slot.pane.style.gridArea = areas[position];
  }
  paintFrame();

  // The panes have to be laid out before a terminal can be fitted into one, and
  // built before there is anything to repaint.
  for (const slot of revealed) ensureTerminal(slot);
  fitPanes();
  for (const slot of revealed) repaint(slot);
}

/**
 * Aim the keyboard at a session. In a split it is already on screen and this is
 * only a change of focus; otherwise it takes over the pane the keyboard was on,
 * so the session you switch to is always the session you see.
 *
 * @param {number} index
 * @returns {void}
 */
function focusSlot(index) {
  const slot = sessions[index] ?? null;
  if (slot === null || index === active) return;

  // Closed before the switch, so the pane the page was drawn over is the one
  // that gets asked for its screen back.
  if (settings.open) settings.close();

  if (!panes.includes(index)) {
    const here = Math.max(0, panes.indexOf(active));
    panes[here] = index;
  }
  active = index;
  settings.setModel(slot.model);
  settings.setOversize(slot.oversize);
  settings.connected = slot.connection !== '' && slot.connection !== 'not-connected';
  applyLayout();
  screenEl.focus();

  if (slot.connection === 'not-connected') settings.show();
}

/** @type {boolean} One creation at a time; two fast keystrokes are one session. */
let opening = false;

/**
 * @param {number} index
 * @returns {Promise<SessionSlot>} the session in that slot, opening one first if
 *   the slot is still empty.
 */
async function ensureSlot(index) {
  const existing = sessions[index];
  if (existing != null) return existing;
  const created = await createSession();
  const slot = newSlot(created.id, created.cols, created.rows + 1);
  sessions[index] = slot;
  writeHash();
  connectSocket(slot);
  return slot;
}

/**
 * @param {number} index
 * @returns {void}
 */
function switchTo(index) {
  if (sessions[index] != null) {
    focusSlot(index);
    return;
  }
  if (opening) return;
  opening = true;
  ensureSlot(index).then(() => {
    focusSlot(index);
  }).catch((cause) => {
    showError('E5006', `Another session could not be opened: ${String(cause)}`);
  }).finally(() => {
    opening = false;
  });
}

/**
 * Split the screen between the first `count` sessions, opening the ones that do
 * not exist yet. One pane is the exception: it shows the session the keyboard is
 * already on rather than jumping back to the first.
 *
 * @param {number} count
 * @returns {void}
 */
function changeLayout(count) {
  if (opening) return;
  opening = true;
  (async () => {
    for (let index = 0; count > 1 && index < count; index++) await ensureSlot(index);
    panes = [];
    if (count === 1) panes.push(active);
    else for (let index = 0; index < count; index++) panes.push(index);
    if (!panes.includes(active)) active = panes[0];
    applyLayout();
    fitIdleSessions();
    screenEl.focus();
  })().catch((cause) => {
    showError('E5006', `Another session could not be opened: ${String(cause)}`);
  }).finally(() => {
    opening = false;
  });
}

// Alt+Space has to work wherever the focus is, so the settings page gets first
// refusal on every key in the page. It swallows everything while it is open, so
// the host cannot be typed at through a screen nobody can see.
//
// The session switcher comes before even that: a session that is not connected
// has the settings page open over it, and being unable to switch away from there
// would be a trap.
window.addEventListener('keydown', (event) => {
  const decision = prefix.handleKey(event);
  if (decision.action !== 'ignore') {
    event.preventDefault();
    event.stopPropagation();
    if (decision.action === 'arm') {
      writeOverlays();
      return;
    }
    // The bar has done its job either way, and the pane under it is the one to
    // ask for its status row back — which is not necessarily the pane the
    // keyboard is about to end up on.
    clearError();
    repaintStatus();
    if (decision.action === 'switch') switchTo(decision.index);
    else if (decision.action === 'layout') changeLayout(decision.panes);
    return;
  }
  if (!settings.handleKey(event)) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

screenEl.addEventListener('keydown', (event) => {
  if (settings.open) return;
  // A keystroke aimed at the live host is also the operator saying "I've seen
  // it", exactly how a real 3270 clears an operator-error condition.
  clearError();

  // Ctrl+C is copy, not a 3270 action: with a selection, copy that; with none,
  // copy whatever is in the field the cursor sits in (the server decides that
  // last part — it is the only side that knows where fields are).
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    event.stopPropagation();
    const term = activeTerminal();
    if (term !== null && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
    } else {
      send({ type: 'copyField' });
    }
    return;
  }

  // Shift+Insert is paste everywhere else in the world, but the browser only
  // turns Ctrl+V into a paste event — this one arrives as an ordinary key, so
  // the clipboard has to be read directly, which Chrome asks permission for
  // once. Ctrl+V is the way in that never needs it.
  if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Insert') {
    event.preventDefault();
    event.stopPropagation();
    navigator.clipboard.readText().then((text) => {
      if (text !== '') send({ type: 'paste', text });
    }).catch((cause) => {
      showError('E5005', `The clipboard could not be read; Ctrl+V pastes without asking: ${String(cause)}`);
    });
    return;
  }

  const mapped = mapKey(event);
  if (mapped === null) return;
  event.preventDefault();
  event.stopPropagation();

  if (mapped.kind === 'text') send({ type: 'text', value: mapped.value });
  else send({ type: 'action', action: mapped.action, args: mapped.args });
}, true);

// Ctrl+V and the right-click menu arrive as one event carrying the text, which
// needs no clipboard permission — unlike reading it ourselves. Capture, because
// ghostty puts its own paste handler on the hidden textarea and stops the event
// there, where it would be dropped: ghostty is a renderer here, it has no host.
screenEl.addEventListener('paste', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (settings.open) return;
  clearError();
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (text !== '') send({ type: 'paste', text });
}, true);

/**
 * A click is both "type here" and, in a split, "type at this session from now
 * on" — the pane is the only thing a mouse can aim at.
 *
 * @param {SessionSlot} slot
 * @param {MouseEvent} event
 * @returns {void}
 */
function paneClicked(slot, event) {
  screenEl.focus();
  focusSlot(sessions.indexOf(slot));
  const term = slot.terminal;
  if (settings.open || term === null) return;
  const cell = cellAt(slot, event);
  if (cell === null) return;

  if (cell.row === term.rows - 1 && cell.col >= term.cols - SETTINGS_BUTTON_LABEL.length) {
    settings.toggle();
    return;
  }

  // Clicking a cell puts the cursor there, the way every other 3270 client
  // works. The status line under the screen is ours, not the host's, and a
  // click that ends a drag was aiming at the selection, not at a field.
  if (cell.row < 0 || cell.row >= term.rows - 1) return;
  if (cell.col < 0 || cell.col >= term.cols) return;
  if (term.hasSelection()) return;
  sendTo(slot, { type: 'action', action: 'MoveCursor1', args: [String(cell.row + 1), String(cell.col + 1)] });
}

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

const wanted = parseSessionHash(location.hash);
if (wanted.some((id) => id !== null)) {
  const response = await fetch('/api/sessions');
  const body = await response.json();
  const live = new Set((body.sessions ?? []).map((/** @type {{ id: string }} */ s) => s.id));
  const gone = [];
  for (let index = 0; index < MAX_SESSIONS; index++) {
    const id = wanted[index];
    if (id == null) continue;
    if (live.has(id)) sessions[index] = newSlot(id);
    else gone.push(index + 1);
  }
  if (gone.length > 0) showError('E3001', `Session ${gone.join(', ')} is gone; starting a new one.`);
}

if (!sessions.some((slot) => slot !== null)) {
  const created = await createSession();
  sessions[0] = newSlot(created.id, created.cols, created.rows + 1);
}
writeHash();

// The page opens on one session filling the screen; a split is a keystroke away
// (Ctrl-B and a shifted digit) and is not worth restoring across a reload, when
// the sessions behind it may not have survived either.
active = Math.max(0, sessions.findIndex((slot) => slot !== null));
panes = [active];
applyLayout();
for (const slot of sessions) {
  if (slot !== null) connectSocket(slot);
}
