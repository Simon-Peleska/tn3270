import { init, Terminal } from '/vendor/dist/ghostty-web.js';
import { mapKey } from '/keymap.js';
import { ESC, SettingsPage, paint } from '/settings.js';
import { loadSettings, saveSettings } from '/store.js';
import { MAX_SESSIONS, SessionPrefix, paneAreas, parseSessionHash, sessionHash, switcherText } from '/sessions.js';
import { installBoxSelection } from '/box-select.js';
import { installCursorGlyph } from '/cursor-glyph.js';

installBoxSelection();
installCursorGlyph();

/**
 * The browser side is deliberately thin: it renders VT bytes the server sends
 * and forwards keystrokes back, holding no screen state of its own. That is
 * what lets a second browser join a running session and be correct at once.
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

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 64;

const RESET_LABEL = '[Reset]';
const SETTINGS_LABEL = '[Settings]';
/** Exactly one narrower than BUTTON_COLUMNS in server/oia.js, which holds these
 *  columns of the status line clear for them. */
const BUTTONS = `${RESET_LABEL} ${SETTINGS_LABEL}`;

/** @type {{ code: string, message: string } | null} */
let activeError = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let errorTimer;

/**
 * A full-width bar over one row, cursor hidden so it cannot be left sitting in
 * chrome the host knows nothing about.
 *
 * @param {number} row 1-based
 * @param {number} cols
 * @param {string} text
 * @param {string} fg `#rrggbb`
 * @param {string} bg `#rrggbb`
 * @returns {string}
 */
function barBytes(row, cols, text, fg, bg) {
  const line = text.slice(0, cols).padEnd(cols, ' ');
  return `${ESC}[?25l${ESC}[${row};1H${paint(fg, bg, true)}${line}${ESC}[0m`;
}

/** @returns {string} the active error over the terminal's last row, or '' */
function errorOverlayBytes() {
  const term = activeTerminal();
  if (activeError === null || term === null) return '';
  return barBytes(term.rows, term.cols, `[${activeError.code}] ${activeError.message}`, '#ffd9d9', '#3a1d20');
}

/** @returns {string} the session switcher, up only while Ctrl-B is armed */
function prefixBarBytes() {
  const term = activeTerminal();
  if (!prefix.armed || term === null) return '';
  const colors = settings.theme().colors;
  const text = switcherText(sessions.map((slot) => slot?.id ?? null), active);
  return barBytes(term.rows, term.cols, text, colors['background'] ?? '#000000', colors['foreground'] ?? '#00ff00');
}

/**
 * The only way into settings or a refit for a mouse, so they live on the 3270's
 * own status line: the terminal is the whole UI. Every pane carries its own, so
 * a split is not a screen you have to switch away from to work on. The cursor is
 * saved and restored around the paint, or redrawing it on every host update
 * would steal the real cursor from whatever field the host put it in.
 *
 * @param {import('ghostty-web').Terminal} term
 * @returns {string}
 */
function buttonBytes(term) {
  const colors = settings.theme().colors;
  const fg = colors['background'] ?? '#000000';
  const bg = colors['foreground'] ?? '#00ff00';
  const col = term.cols - BUTTONS.length + 1;
  return `${ESC}7${ESC}[${term.rows};${col}H${paint(fg, bg, true)}${BUTTONS}${ESC}[0m${ESC}8`;
}

/**
 * Both bars live on the terminal's last row and neither exists on the server,
 * so both are reasserted after every write that lands there.
 *
 * Nothing to paint is the usual answer and it has to stay unwritten:
 * ghostty-web 0.4.0 allocates a WASM buffer per write, zero bytes comes back as
 * the pointer -1, and copying into it throws mid-paint.
 *
 * @returns {void}
 */
function writeOverlays() {
  const slot = activeSession();
  const bytes = errorOverlayBytes() + prefixBarBytes();
  if (bytes === '' || slot === null || slot.terminal === null) return;
  slot.terminal.write(bytes);
  // By the time the overlay comes off, the keyboard may be on another pane.
  overlaySlot = slot;
}

/**
 * Show a coded error in place, on the terminal's own status line. Never
 * navigate: the session is right there on screen and a redirect would throw it
 * away.
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

/** @returns {void} */
function clearError() {
  if (activeError === null) return;
  activeError = null;
  if (errorTimer !== undefined) clearTimeout(errorTimer);
  repaintStatus();
}

/**
 * Ask for the real status line back. Anything painted over that row exists only
 * in this browser, so only the server sending it again can undo it.
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
  sendQuietly(painted, { type: 'refresh' });
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
 * socket stays open whether its session is on screen or not: a hidden pane's
 * bytes are thrown away — the server holds the screen and repaints on demand —
 * but its viewer has to stay attached or the idle timeout would reap it.
 *
 * A session owns its pane and terminal for as long as it lives; laying the
 * screen out differently moves panes, it never hands one session's terminal
 * to another.
 *
 * @typedef {object} SessionSlot
 * @property {string} id
 * @property {HTMLElement} pane
 * @property {import('ghostty-web').Terminal | null} terminal built the first
 *   time the pane is on screen with a known geometry
 * @property {WebSocket | null} socket
 * @property {number} backoffMs
 * @property {number} model the model the server has confirmed
 * @property {string} oversize the fitted screen it has confirmed
 * @property {number} cols
 * @property {number} rows including the OIA row this side adds
 * @property {string} connection b3270's own connection state, '' until the
 *   first status arrives
 * @property {boolean | null} connected the server's verdict on that state;
 *   null until the first status, so it always counts as a change
 * @property {boolean} touched whether anyone has typed at this session — the
 *   server's answer, since another viewer's typing counts too
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
    model: 0, oversize: '', cols, rows, connection: '', connected: null, touched: false,
  };
  pane.addEventListener('click', (event) => paneClicked(slot, event));
  return slot;
}

/** @returns {void} Every session in the URL, so sharing shares all of them. */
function writeHash() {
  location.hash = sessionHash(sessions.map((slot) => slot?.id ?? null));
}

/**
 * @param {string | null} host null when the server has a configured host and
 *   connecting means asking it to reopen the one it already knows.
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
  windowFit: (fontSize) => {
    const slot = activeSession();
    return slot === null ? null : paneFit(slot, fontSize);
  },
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
 * ghostty-web 0.4.0 resizes the canvas in CSS pixels after a font or theme
 * change, discarding the device-pixel backing store its own resize() set up.
 * Put it back, or every glyph is soft on a HiDPI screen.
 *
 * @param {import('ghostty-web').Terminal} created
 * @returns {void}
 */
function repaintCanvas(created) {
  const renderer = created.renderer;
  if (renderer === undefined) return;
  renderer.resize(created.cols, created.rows);
  if (created.wasmTerm !== undefined) renderer.render(created.wasmTerm, true);
}

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

/** @returns {void} A black frame around an amber screen looks like a bug. */
function paintFrame() {
  const background = settings.theme().colors['background'] ?? '#000000';
  screenEl.style.background = background;
  for (const slot of sessions) {
    if (slot === null) continue;
    slot.pane.style.background = background;
  }
}

/**
 * `renderer.setTheme()` recolors the canvas chrome, but host colours index into
 * the WASM terminal's ANSI palette, which ghostty-web builds once at `open()`.
 * `reset()` picking up `options.theme` is what rebuilds it. The page is redrawn
 * over the blank screen immediately after, so nothing is lost.
 *
 * @param {import('/settings.js').Theme} theme
 * @returns {void}
 */
function applyTheme(theme) {
  paintFrame();
  for (const slot of sessions) {
    if (slot === null) continue;
    // The server paints the typeable fields, so every session is told which
    // colour this theme wants them. A theme is the page's, not one pane's.
    sendQuietly(slot, { type: 'fieldColor', color: theme.colors['field'] ?? null });

    const created = slot.terminal;
    const renderer = created?.renderer;
    if (created == null || renderer === undefined) continue;

    renderer.setTheme(theme.colors);
    created.options.theme = theme.colors;
    created.reset();
    // reset() frees the WASM terminal and builds a new one, but the selection
    // manager keeps its own reference and is never told; copying would then
    // read freed memory, against a stale, smaller grid.
    const selection = created['selectionManager'];
    const wasmTerm = created.wasmTerm;
    if (selection !== undefined && wasmTerm !== undefined) selection['wasmTerm'] = wasmTerm;
    repaintCanvas(created);
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
 * The room a pane leaves its terminal. A hidden pane has none, which keeps a
 * session nobody is looking at out of every measurement.
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
 * column counts belong to the 3270 model, so the font size is the only thing
 * free to move.
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

  // A cell measures ceil(fontSize x something), so this ratio lands on the
  // answer or a pixel above it; starting one high and walking down is exact.
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

  repaintCanvas(created);
}

/**
 * How big a screen this pane would hold with text `fontSize` pixels tall — the
 * inverse of fitFontSize(), where the grid is fixed and the text scales. It
 * measures the pane and not the window so that in a split a session gets the
 * screen its own share of the page can show.
 *
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

  // Measured at the size being asked about, never scaled from the size in
  // force: ghostty rounds a cell up to whole pixels, so a scaled cell lands
  // somewhere slightly different for every pane and no two panes ever agree on
  // a screen. Assigning the size re-measures without redrawing.
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
 * Ask for this session's screen at the size of the pane it now sits in. The
 * size is negotiated when the connection opens, so on a connected session this
 * drops and reopens the host — the caller is the one that decides that is
 * acceptable.
 *
 * @param {SessionSlot} slot
 * @returns {void}
 */
function fitSession(slot) {
  const fit = paneFit(slot, settings.fitFontSize);
  if (fit === null) return;
  const value = settings.fitSize(fit, slot.model);
  if (value === slot.oversize) return;
  sendQuietly(slot, { type: 'oversize', value });
}

/**
 * Give every pane a screen its own size, which keeps a split from being four
 * screens of unreadable text. Only for the sessions where that costs nothing:
 * one with no host on it, and one nobody has typed at yet. Losing the host's
 * idea of where the operator was just because the screen was split would be
 * indefensible — but before they have touched it there is nothing to lose, and
 * a pane of the wrong size is what they would have had to fix by hand anyway.
 * A session that has been used shrinks its text instead, until [Reset].
 *
 * @returns {void}
 */
function fitIdleSessions() {
  // A model's own size, or the dynamic screen, is a size the operator asked for
  // by name, and that is not a preference to be second-guessed here.
  if (!settings.fitsWindow()) return;
  for (const index of panes) {
    const slot = sessions[index];
    if (slot == null || (slot.connected === true && slot.touched)) continue;
    fitSession(slot);
  }
}

/** @returns {void} Refit every terminal the page is showing. */
function fitPanes() {
  for (const index of panes) {
    const slot = sessions[index];
    if (slot != null) fitFontSize(slot);
  }
}

// The screen box is sized by the page, so its own resizes are the signal to
// refit. Coalesced into a frame because a drag fires this continuously.
let fitScheduled = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let settleTimer;
new ResizeObserver(() => {
  if (!fitScheduled) {
    fitScheduled = true;
    requestAnimationFrame(() => {
      fitScheduled = false;
      fitPanes();
    });
  }
  // Asking for a bigger screen costs a round trip to the host, so the sessions
  // that can be resized wait for the window to stop moving first. The ones that
  // cannot have already rescaled their text in the frame above.
  clearTimeout(settleTimer);
  settleTimer = setTimeout(fitIdleSessions, 400);
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
  if (!sendQuietly(slot, message)) {
    showError('E5002', 'Not connected to the server; your input was not sent.');
  }
}

/**
 * For messages nobody asked for by hand — a theme push, a refit, a repaint of a
 * background pane — where a closed socket is routine rather than an error.
 *
 * @param {SessionSlot | null} slot
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {boolean} whether it went out
 */
function sendQuietly(slot, message) {
  const socket = slot?.socket ?? null;
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

/**
 * @param {SessionSlot} slot
 * @returns {void}
 */
function connectSocket(slot) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  // On the URL, not a follow-up message, so the very first repaint already
  // matches the saved preference instead of flashing host colours for a frame.
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
    if (!(event.data instanceof ArrayBuffer)) {
      handleServerMessage(slot, JSON.parse(String(event.data)));
      return;
    }
    // Only a session with a pane on screen is painted; the settings page owns
    // the pane it is drawn in. Dropping the rest is safe because the server is
    // asked for a full repaint when they come back into view.
    const term = slot.terminal;
    const covered = settings.open && slot === activeSession();
    if (term === null || slot.pane.hidden || covered) return;
    term.write(new Uint8Array(event.data));
    term.write(buttonBytes(term));
    if (slot === activeSession()) writeOverlays();
  });

  ws.addEventListener('error', () => {
    showError('E5002', 'The connection to the server failed.');
  });

  ws.addEventListener('close', () => {
    // The session lives on the server, so reconnecting picks the screen back up
    // where it was. Unless the socket never opened at all: the session is then
    // probably gone (the server restarted) and retrying the same id would 404
    // forever, so the slot is given a fresh session instead.
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
 * @param {SessionSlot} slot not necessarily the one on screen: every session
 *   keeps running and keeps reporting.
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
    const changed = slot.connected !== message.connected;
    slot.connection = message.connection;
    slot.connected = message.connected;
    slot.touched = message.touched;
    // A real 3270 swaps the block cursor for an underline in insert mode, and
    // insert is the session's own state, not just the focused pane's.
    slot.terminal?.renderer?.setCursorStyle(message.insert ? 'underline' : 'block');
    // A session opened to fill a new pane is only reachable once its socket has
    // said hello, which is well after the layout that made the pane was applied.
    if (changed && !message.connected && !slot.pane.hidden && panes.length > 1) fitIdleSessions();
    if (!onScreen) return;
    settings.connected = message.connected;
    // b3270 reports the host without its port, so filling the field from it
    // would quietly destroy what the user typed. Only seed an empty one, which
    // is what a viewer joining someone else's session needs.
    if (message.host !== null && settings.host === '' && !settings.hostLocked) settings.setHost(message.host);
    // Only the moment the connection changes opens or closes the page; after
    // that it stays where the user or the connection left it.
    if (changed) {
      if (message.connected) {
        settings.close();
        clearError();
      } else {
        settings.show();
      }
    }
    return;
  }
  if (onScreen) {
    // A refused change leaves the page showing something the server never
    // accepted, so put it back to the size actually in force.
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
 * the server, so this is the only way back from a pane this side has drawn over
 * or one whose bytes were dropped while it was out of sight.
 *
 * @param {SessionSlot} slot
 * @returns {void}
 */
function repaint(slot) {
  if (settings.open && slot === activeSession()) {
    settings.draw();
    return;
  }
  // A session still opening has nothing to repaint yet, and whatever is on its
  // terminal is older than the pane it now sits in.
  if (!sendQuietly(slot, { type: 'refresh' })) slot.terminal?.write(`${ESC}[2J`);
}

/**
 * Give every pane its place in the grid and hide the sessions the layout leaves
 * out. A pane coming back into sight is built if it has never been drawn in,
 * and repainted either way, since its bytes were thrown away while hidden.
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
  // asked for its screen back.
  if (settings.open) settings.close();

  if (!panes.includes(index)) {
    const here = Math.max(0, panes.indexOf(active));
    panes[here] = index;
  }
  active = index;
  settings.setModel(slot.model);
  settings.setOversize(slot.oversize);
  settings.connected = slot.connected === true;
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
 * not exist yet — all at once, because each costs a b3270 startup on the server
 * and waiting them out one by one is the whole delay times four. One pane is
 * the exception: it shows the session the keyboard is already on rather than
 * jumping back to the first.
 *
 * @param {number} count
 * @returns {void}
 */
function changeLayout(count) {
  if (opening) return;
  opening = true;
  /** @type {Promise<unknown>[]} */
  const opens = [];
  if (count > 1) for (let index = 0; index < count; index++) opens.push(ensureSlot(index));

  Promise.all(opens).then(() => {
    panes = [];
    if (count === 1) panes.push(active);
    else for (let index = 0; index < count; index++) panes.push(index);
    if (!panes.includes(active)) active = panes[0];
    applyLayout();
    fitIdleSessions();
    screenEl.focus();
  }).catch((cause) => {
    showError('E5006', `Another session could not be opened: ${String(cause)}`);
  }).finally(() => {
    opening = false;
  });
}

// Alt+Space has to work wherever the focus is, so the settings page gets first
// refusal on every key in the page; it swallows everything while it is open.
// The switcher comes before even that: a session that is not connected has the
// settings page open over it, and being unable to switch away would be a trap.
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
    // ask for its status row back — not necessarily the pane the keyboard is
    // about to end up on.
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
  // copy the field the cursor sits in (the server decides that last part — it
  // is the only side that knows where fields are).
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    event.stopPropagation();
    const term = activeTerminal();
    if (term !== null && term.hasSelection()) navigator.clipboard.writeText(term.getSelection());
    else send({ type: 'copyField' });
    return;
  }

  // Shift+Insert is paste everywhere else in the world, but the browser only
  // turns Ctrl+V into a paste event — this arrives as an ordinary key, so the
  // clipboard has to be read directly, which Chrome asks permission for once.
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
// needs no clipboard permission. Capture, because ghostty puts its own paste
// handler on the hidden textarea and stops the event there, where it would be
// dropped: ghostty is a renderer here, it has no host.
screenEl.addEventListener('paste', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (settings.open) return;
  clearError();
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (text !== '') send({ type: 'paste', text });
}, true);

/**
 * The operator asking for this session's screen back at the size of its pane,
 * whatever it has been through — the way out of a pane that was resized under a
 * connection this side would not touch on its own. It costs the host connection,
 * which is why it is a button and not something that happens behind their back.
 *
 * @param {SessionSlot} slot
 * @returns {void}
 */
function resetSize(slot) {
  if (!settings.fitsWindow()) {
    showError('E5007', 'Turn "Fit to window" on in the settings first.');
    return;
  }
  fitSession(slot);
}

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
  const renderer = term?.renderer;
  if (settings.open || term === null || renderer === undefined) return;

  const rect = renderer.getCanvas().getBoundingClientRect();
  const row = Math.floor((event.clientY - rect.top) / renderer.charHeight);
  const col = Math.floor((event.clientX - rect.left) / renderer.charWidth);

  if (row === term.rows - 1 && col >= term.cols - SETTINGS_LABEL.length) {
    settings.toggle();
    return;
  }
  if (row === term.rows - 1 && col >= term.cols - BUTTONS.length) {
    resetSize(slot);
    return;
  }

  // Clicking a cell puts the cursor there, the way every other 3270 client
  // works. The status line under the screen is ours, not the host's, and a
  // click that ends a drag was aiming at the selection, not at a field.
  if (row < 0 || row >= term.rows - 1 || col < 0 || col >= term.cols) return;
  if (term.hasSelection()) return;
  sendTo(slot, { type: 'action', action: 'MoveCursor1', args: [String(row + 1), String(col + 1)] });
}

// The renderer's WASM module and the saved settings have nothing to do with
// each other, so they load together; the font can only be named once the
// settings are in hand, and has to be loaded before the first terminal is
// built or the first screen is painted in the wrong face and then restyled.
const [renderer, saved] = await Promise.allSettled([init(), loadSettings()]);
if (renderer.status === 'rejected') {
  showError('E5001', `The terminal renderer failed to load: ${String(renderer.reason)}`);
  throw renderer.reason;
}
if (saved.status === 'fulfilled') settings.restoreSaved(saved.value);
else showError('E5003', `Saved settings could not be read; using the defaults: ${String(saved.reason)}`);

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
// and is not worth restoring across a reload, when the sessions behind it may
// not have survived either.
active = Math.max(0, sessions.findIndex((slot) => slot !== null));
panes = [active];
applyLayout();
for (const slot of sessions) {
  if (slot !== null) connectSocket(slot);
}
