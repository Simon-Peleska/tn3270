import { init, Terminal } from "/vendor/dist/ghostty-web.js";
import { mapKey } from "/keymap.js";
import { ESC, paint, terminalColors } from "/panel.js";
import { HelpPage, MenuPage } from "/menu.js";
import { SettingsPage, modeOversize } from "/settings.js";
import { MacrosPage } from "/macros.js";
import { RecorderPage } from "/recorder.js";
import { KeymapPage } from "/keymap-page.js";
import {
  loadSettings,
  saveSettings,
  loadMacros,
  saveMacros,
  loadKeymap,
  saveKeymap,
} from "/store.js";
import {
  MAX_SESSIONS,
  SessionPrefix,
  paneAreas,
  parseSessionHash,
  sessionHash,
  switcherText,
} from "/sessions.js";
import { backoffDelay, reconnectStep } from "/reconnect.js";
import { chooseFontSize } from "/fitfont.js";
import { installBoxSelection } from "/box-select.js";
import { installCursorGlyph } from "/cursor-glyph.js";

installBoxSelection();
installCursorGlyph();

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function element(id) {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found;
}

const screenEl = element("screen");

const RESET_LABEL = "[Reset]";
const MENU_LABEL = "[Menu]";
// The menu is the way to every panel, so one button reaches all of them.
// Narrower than BUTTON_COLUMNS in server/oia.js, which keeps these cells clear.
const BUTTONS = `${RESET_LABEL} ${MENU_LABEL}`;

/** @type {{ code: string, message: string } | null} */
let activeError = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let errorTimer;

/**
 * @param {number} row 1-based
 * @param {number} cols
 * @param {string} text
 * @param {string} fg `#rrggbb`
 * @param {string} bg `#rrggbb`
 * @returns {string}
 */
function barBytes(row, cols, text, fg, bg) {
  const line = text.slice(0, cols).padEnd(cols, " ");
  // Save and restore: a panel puts its cursor on a field, and this must not move it.
  return `${ESC}7${ESC}[${row};1H${paint(fg, bg, true)}${line}${ESC}[0m${ESC}8`;
}

/** @returns {string} */
function errorOverlayBytes() {
  const term = activeTerminal();
  if (activeError === null || term === null) return "";
  return barBytes(
    term.rows,
    term.cols,
    `[${activeError.code}] ${activeError.message}`,
    "#ffd9d9",
    "#3a1d20",
  );
}

/** @returns {string} */
function prefixBarBytes() {
  const term = activeTerminal();
  if (!prefix.armed || term === null) return "";
  const colors = settings.theme().colors;
  const text = switcherText(
    sessions.map((slot) => slot?.id ?? null),
    active,
  );
  return barBytes(
    term.rows,
    term.cols,
    text,
    colors["background"] ?? "#000000",
    colors["foreground"] ?? "#00ff00",
  );
}

/**
 * Save and restore the cursor, or a repaint steals it from the host's field.
 *
 * @param {import('ghostty-web').Terminal} term
 * @returns {string}
 */
function buttonBytes(term) {
  const colors = settings.theme().colors;
  const fg = colors["background"] ?? "#000000";
  const bg = colors["foreground"] ?? "#00ff00";
  const col = term.cols - BUTTONS.length + 1;
  return `${ESC}7${ESC}[${term.rows};${col}H${paint(fg, bg, true)}${BUTTONS}${ESC}[0m${ESC}8`;
}

/**
 * @returns {string}
 */
function hintOverlayBytes() {
  const term = activeTerminal();
  if (!prefix.armed || !settings.hints || term === null || hints.length === 0)
    return "";
  const colors = settings.theme().colors;
  const fg = colors["background"] ?? "#000000";
  const bg = colors["foreground"] ?? "#00ff00";
  let bytes = `${ESC}7`;
  for (const hint of hints) {
    bytes += `${ESC}[${hint.row + 1};${hint.col + 1}H${paint(fg, bg, true)}${hint.letter}${ESC}[0m`;
  }
  return `${bytes}${ESC}8`;
}

/**
 * Never write '': ghostty-web 0.4.0 throws on a zero-byte write.
 *
 * @returns {void}
 */
function writeOverlays() {
  const slot = activeSession();
  const bytes = errorOverlayBytes() + prefixBarBytes() + hintOverlayBytes();
  if (bytes === "" || slot === null || slot.terminal === null) return;
  slot.terminal.write(bytes);
  // By the time the overlay comes off, the keyboard may be on another pane.
  overlaySlot = slot;
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {void}
 */
function showError(code, message) {
  console.error(`[${code}] ${message}`);
  activeError = { code, message };
  if (errorTimer !== undefined) clearTimeout(errorTimer);
  errorTimer = setTimeout(clearError, 6000);
  const page = openPanel();
  if (page) page.draw();
  else writeOverlays();
}

/** @returns {void} */
function clearError() {
  if (activeError === null) return;
  activeError = null;
  if (errorTimer !== undefined) clearTimeout(errorTimer);
  repaintStatus();
}

/** @returns {void} Only the server can undo a row this browser painted over. */
function repaintStatus() {
  const painted = overlaySlot;
  overlaySlot = null;
  const page = openPanel();
  if (page) {
    page.draw();
    return;
  }
  sendQuietly(painted, { type: "refresh" });
}

/** @type {number} */
const DEFAULT_IDLE_TIMEOUT_MS = 300000;

/** @returns {Promise<{ id: string, rows: number, cols: number }>} */
async function createSession() {
  const response = await fetch("/api/sessions", { method: "POST" });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      `[${body.code ?? "E0000"}] ${body.message ?? "could not create a session"}`,
    );
  return body;
}

/** @returns {Promise<Set<string> | null>} null when the server did not answer */
async function liveSessionIds() {
  try {
    const response = await fetch("/api/sessions");
    if (!response.ok) return null;
    const body = await response.json();
    return new Set(
      (body.sessions ?? []).map((/** @type {{ id: string }} */ s) => s.id),
    );
  } catch {
    return null;
  }
}

/**
 * A hidden pane's bytes are dropped, but its socket stays open or the server
 * reaps the session.
 *
 * @typedef {object} SessionSlot
 * @property {string} id
 * @property {HTMLElement} pane
 * @property {import('ghostty-web').Terminal | null} terminal
 * @property {WebSocket | null} socket
 * @property {number} attempt
 * @property {number | null} reconnectUntil null while connected, Infinity when
 *   the server never reaps
 * @property {number} idleTimeoutMs
 * @property {boolean} started this tab opened the session, so the size saved
 *   here is its to ask for; one attached to by id belongs to whoever is in it
 * @property {number} model
 * @property {string} oversize
 * @property {number} cols
 * @property {number} rows including the OIA row
 * @property {string} connection
 * @property {boolean | null} connected null until the first status
 * @property {boolean} touched
 * @property {boolean} locked
 * @property {'controller' | 'observer'} role
 * @property {boolean} allowSharing
 * @property {boolean} allowSharedEditing
 * @property {boolean} allowAutomation
 */

/** @type {(SessionSlot | null)[]} */
const sessions = [];
for (let index = 0; index < MAX_SESSIONS; index++) sessions.push(null);

/** @type {number} The slot the keyboard is aimed at; always one of `panes`. */
let active = 0;

/** @type {number[]} The slots on screen, in pane order. */
let panes = [0];

/** @type {SessionSlot | null} The pane an overlay is painted over. */
let overlaySlot = null;

const prefix = new SessionPrefix();

/** @type {{ row: number, col: number, letter: string }[]} */
let hints = [];

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
 * @param {boolean} started
 * @param {number} cols
 * @param {number} rows including the OIA row
 * @returns {SessionSlot}
 */
function newSlot(id, started = false, cols = 0, rows = 0) {
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.hidden = true;
  screenEl.append(pane);
  /** @type {SessionSlot} */
  const slot = {
    id,
    pane,
    terminal: null,
    socket: null,
    started,
    attempt: 0,
    reconnectUntil: null,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    model: 0,
    oversize: "",
    cols,
    rows,
    connection: "",
    connected: null,
    touched: false,
    locked: false,
    role: "controller",
    allowSharing: true,
    allowSharedEditing: false,
    allowAutomation: false,
  };
  pane.addEventListener("click", (event) => paneClicked(slot, event));
  return slot;
}

/** @returns {void} */
function writeHash() {
  location.hash = sessionHash(sessions.map((slot) => slot?.id ?? null));
}

/**
 * @param {string | null} host null asks the server to reopen its configured host
 * @returns {void}
 */
function connectHost(host) {
  if (host === null) {
    send({ type: "connect", host: null });
    return;
  }
  if (host === "") {
    showError("E5002", "Enter a host as name:port first.");
    return;
  }
  localStorage.setItem("tn3270.host", host);
  send({ type: "connect", host });
}

/**
 * Macro playback paces itself by the host's keyboard lock, not a timer.
 * @type {Map<SessionSlot, (() => void)[]>}
 */
const unlockWaiters = new Map();

/**
 * @param {SessionSlot | null} slot
 * @returns {Promise<void>}
 */
function waitForUnlock(slot) {
  if (slot === null || !slot.locked) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = unlockWaiters.get(slot) ?? [];
    waiters.push(resolve);
    unlockWaiters.set(slot, waiters);
  });
}

/**
 * @param {string} filename
 * @param {string} content
 * @returns {void}
 */
function downloadFile(filename, content) {
  const type = filename.endsWith(".json")
    ? "application/json"
    : filename.endsWith(".kmp")
      ? "text/plain"
      : "application/xml";
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * @param {string} accept
 * @returns {Promise<string[]>} the text of every file picked, or [] if cancelled
 */
function pickFiles(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.style.display = "none";
    const done = (/** @type {string[]} */ result) => {
      input.remove();
      resolve(result);
    };
    input.addEventListener("cancel", () => done([]), { once: true });
    input.addEventListener(
      "change",
      () => {
        const files = Array.from(input.files ?? []);
        Promise.all(files.map((file) => file.text())).then(done, () =>
          done([]),
        );
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

/** @returns {Promise<string[]>} */
function pickXmlFiles() {
  return pickFiles(".xml,text/xml,application/xml");
}

/** @returns {Promise<string[]>} */
function pickKeymapFiles() {
  return pickFiles(".kmp,.txt,text/plain");
}

/**
 * What every panel needs to draw itself and to hand the screen on: the rest of
 * each page's deps are its own.
 *
 * @type {import('/panel.js').PanelDeps}
 */
const panelIo = {
  write: (bytes) => {
    activeTerminal()?.write(bytes);
    writeOverlays();
  },
  geometry: () => ({
    cols: activeTerminal()?.cols ?? 80,
    rows: activeTerminal()?.rows ?? 25,
  }),
  theme: () => settings.theme(),
  end: () => endPanel(),
  go: (id) => goPanel(id),
};

const settings = new SettingsPage({
  ...panelIo,
  applyTheme,
  applyFont,
  applyModel: (model) => send({ type: "model", model }),
  applyOversize: (value) => send({ type: "oversize", value }),
  windowFit: (fontSize) => {
    const slot = activeSession();
    return slot === null ? null : paneFit(slot, fontSize);
  },
  applyHostColors: (enabled) => send({ type: "hostColors", enabled }),
  applySharing: (allowView, allowEdit) =>
    send({ type: "sharing", allowView, allowEdit }),
  applyAutomation: (allowed) => send({ type: "automation", allowed }),
  connect: connectHost,
  persist: (values) => {
    saveSettings(values).catch((cause) => {
      showError(
        "E5004",
        `Settings could not be saved in this browser: ${String(cause)}`,
      );
    });
  },
});

const macros = new MacrosPage({
  ...panelIo,
  dispatch: (message) => sendTo(activeSession(), message),
  waitForUnlock: () => waitForUnlock(activeSession()),
  persist: (values) => {
    saveMacros(values).catch((cause) => {
      showError(
        "E5009",
        `Macros could not be saved in this browser: ${String(cause)}`,
      );
    });
  },
  exportFile: downloadFile,
  importFiles: pickXmlFiles,
  error: showError,
});

const recorder = new RecorderPage({
  ...panelIo,
  dispatch: (message) => sendTo(activeSession(), message),
  exportFile: downloadFile,
});

const keymap = new KeymapPage({
  ...panelIo,
  persist: (bindings) => {
    saveKeymap(bindings).catch((cause) => {
      showError(
        "E5011",
        `The keymap could not be saved in this browser: ${String(cause)}`,
      );
    });
  },
  exportFile: downloadFile,
  importFiles: pickKeymapFiles,
  error: showError,
});

const menu = new MenuPage(panelIo);
const help = new HelpPage(panelIo);

const panels = [menu, settings, macros, recorder, keymap, help];

/** @type {string[]} the panels walked through to get here, oldest first */
const trail = [];

/**
 * @param {string} id
 * @returns {typeof panels[number] | null}
 */
function panelById(id) {
  return panels.find((page) => page.id === id) ?? null;
}

/** @returns {typeof panels[number] | null} */
function openPanel() {
  return panels.find((page) => page.open) ?? null;
}

/** @returns {boolean} */
function anyPanelOpen() {
  return panels.some((page) => page.open);
}

/**
 * Navigation inside the panels: an option number, F4, or a name on the action
 * bar. Going back to a panel already behind us unwinds to it instead of piling
 * the same two panels up.
 *
 * @param {string} id
 * @returns {void}
 */
function goPanel(id) {
  const next = panelById(id);
  const current = openPanel();
  if (next === null || next === current) return;
  const seen = trail.indexOf(id);
  if (seen !== -1) trail.length = seen;
  else if (current !== null) trail.push(current.id);
  current?.hide();
  next.show();
}

/** @returns {void} F3: back one level, and out to the session at the bottom. */
function endPanel() {
  const previous = panelById(trail.pop() ?? "");
  if (previous === null) {
    send({ type: "refresh" });
    return;
  }
  previous.show();
}

/**
 * @param {string} id
 * @returns {void} An Alt shortcut starts a fresh trail: it came from the session.
 */
function startPanel(id) {
  const wanted = panelById(id);
  if (wanted === null) return;
  const current = openPanel();
  trail.length = 0;
  if (current === wanted) {
    wanted.close();
    return;
  }
  current?.hide();
  wanted.show();
}

/** @returns {void} Give the screen back without walking the trail out. */
function closePanels() {
  const current = openPanel();
  trail.length = 0;
  if (current === null) return;
  current.hide();
  send({ type: "refresh" });
}

/**
 * ghostty-web 0.4.0 drops the device-pixel backing store on a font or theme
 * change, so put it back or HiDPI glyphs go soft.
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
 * @param {SessionSlot} slot
 * @returns {import('ghostty-web').Terminal | null}
 */
function ensureTerminal(slot) {
  if (slot.cols < 1 || slot.rows < 1) return null;
  const existing = slot.terminal;
  if (existing !== null) {
    if (existing.cols !== slot.cols || existing.rows !== slot.rows)
      existing.resize(slot.cols, slot.rows);
    fitFontSize(slot);
    if (slot === activeSession()) openPanel()?.draw();
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
    theme: terminalColors(settings.theme()),
  });
  created.open(slot.pane);
  slot.terminal = created;
  paintFrame();
  fitFontSize(slot);
  return created;
}

/** @returns {void} */
function paintFrame() {
  const background = settings.theme().colors["background"] ?? "#000000";
  screenEl.style.background = background;
  for (const slot of sessions) {
    if (slot === null) continue;
    slot.pane.style.background = background;
  }
}

/**
 * setTheme() only recolors chrome; reset() is what rebuilds the WASM ANSI
 * palette host colours index into.
 *
 * @param {import('/settings.js').Theme} theme
 * @returns {void}
 */
function applyTheme(theme) {
  paintFrame();
  for (const slot of sessions) {
    if (slot === null) continue;
    sendQuietly(slot, {
      type: "fieldColor",
      color: theme.colors["field"] ?? null,
    });

    const created = slot.terminal;
    const renderer = created?.renderer;
    if (created == null || renderer === undefined) continue;

    const colors = terminalColors(theme);
    renderer.setTheme(colors);
    created.options.theme = colors;
    created.reset();
    // reset() rebuilds the WASM terminal; the selection manager keeps a stale
    // pointer into the freed one.
    const selection = created["selectionManager"];
    const wasmTerm = created.wasmTerm;
    if (selection !== undefined && wasmTerm !== undefined)
      selection["wasmTerm"] = wasmTerm;
    repaintCanvas(created);
  }
}

/**
 * @param {{ name: string, family: string }} font
 * @returns {Promise<void>}
 */
async function applyFont(font) {
  // An unloaded face measures as the fallback, fitting the grid to the wrong size.
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
 * @param {HTMLElement} pane
 * @returns {{ width: number, height: number } | null}
 */
function paneBox(pane) {
  const style = getComputedStyle(pane);
  const width =
    pane.clientWidth -
    parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight);
  const height =
    pane.clientHeight -
    parseFloat(style.paddingTop) -
    parseFloat(style.paddingBottom);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

/**
 * @param {SessionSlot} slot
 * @returns {void}
 */
function fitFontSize(slot) {
  const created = slot.terminal;
  const renderer = created?.renderer;
  if (created == null || renderer === undefined) return;

  const box = paneBox(slot.pane);
  if (box === null) return;

  // Measuring means setting the size, so the search leaves its last probe on.
  created.options.fontSize = chooseFontSize({
    measure: (size) => {
      created.options.fontSize = size;
      return { width: renderer.charWidth, height: renderer.charHeight };
    },
    cols: created.cols,
    rows: created.rows,
    box,
    start: created.options.fontSize,
  });

  repaintCanvas(created);
}

/**
 * How big a screen this pane would hold with text `fontSize` pixels tall.
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

  // Never scale from the drawn size: ghostty rounds cells up to whole pixels,
  // so scaled panes never agree on a screen.
  const drawn = created.options.fontSize;
  created.options.fontSize = fontSize;
  const cellWidth = renderer.charWidth;
  const cellHeight = renderer.charHeight;
  created.options.fontSize = drawn;

  const cols = Math.floor(box.width / cellWidth);
  // One row is the OIA, which this side paints and the host knows nothing about.
  const rows = Math.floor(box.height / cellHeight) - 1;
  if (cols < 1 || rows < 1) return null;
  return { cols, rows };
}

/**
 * Changing the oversize drops and reopens the host connection.
 *
 * @param {SessionSlot} slot
 * @param {number} model the floor the fit may not go below, which is the one
 *   being asked for rather than the one in force when both move together
 * @returns {void}
 */
function fitSession(slot, model = slot.model) {
  const fit = paneFit(slot, settings.fitFontSize);
  if (fit === null) return;
  const value = settings.fitSize(fit, model);
  if (value === slot.oversize) return;
  sendQuietly(slot, { type: "oversize", value });
}

/**
 * A new tab starts its own sessions at the server's default size, so the size
 * this browser saved has to be asked for again each time one says hello.
 *
 * @param {SessionSlot} slot
 * @returns {void}
 */
function applySavedSize(slot) {
  if (!slot.started) return;

  const model = settings.savedModel ?? slot.model;
  if (model !== slot.model) sendQuietly(slot, { type: "model", model });

  // Nothing saved leaves the stretch to the server's own configuration.
  if (settings.savedSize === null) return;
  const value = modeOversize(settings.savedSize);
  if (value === null) fitSession(slot, model);
  else if (value !== slot.oversize)
    sendQuietly(slot, { type: "oversize", value });
}

/**
 * Only untouched sessions: refitting a live one would lose the host's cursor.
 *
 * @returns {void}
 */
function fitIdleSessions() {
  if (!settings.fitsWindow()) return;
  for (const index of panes) {
    const slot = sessions[index];
    if (slot == null || (slot.connected === true && slot.touched)) continue;
    fitSession(slot);
  }
}

/** @returns {void} */
function fitPanes() {
  for (const index of panes) {
    const slot = sessions[index];
    if (slot != null) fitFontSize(slot);
  }
}

// Coalesced into a frame: a drag fires this continuously.
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
  // A refit costs a host round trip, so wait for the drag to settle.
  clearTimeout(settleTimer);
  settleTimer = setTimeout(fitIdleSessions, 400);
}).observe(screenEl);

/**
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {void}
 */
function send(message) {
  if (macros.isRecording()) macros.record(message);
  sendTo(activeSession(), message);
}

/**
 * @param {SessionSlot | null} slot
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {void}
 */
function sendTo(slot, message) {
  if (!sendQuietly(slot, message)) {
    showError("E5002", "Not connected to the server; your input was not sent.");
  }
}

/**
 * For messages nobody asked for by hand, where a closed socket is routine.
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
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  // On the URL so the first repaint already has the saved colours.
  const query = new URLSearchParams();
  if (!settings.hostColors) query.set("hostColors", "0");
  const field = settings.theme().colors["field"];
  if (field !== undefined) query.set("fieldColor", field);
  const ws = new WebSocket(
    `${scheme}://${location.host}/ws/${slot.id}?${query}`,
  );
  ws.binaryType = "arraybuffer";
  slot.socket = ws;

  ws.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) {
      handleServerMessage(slot, JSON.parse(String(event.data)));
      return;
    }
    // Dropping bytes is safe: a pane coming back into view asks for a repaint.
    const term = slot.terminal;
    const covered = anyPanelOpen() && slot === activeSession();
    if (term === null || slot.pane.hidden || covered) return;
    term.write(new Uint8Array(event.data));
    term.write(buttonBytes(term));
    if (slot === activeSession()) writeOverlays();
  });

  // A failed connect fires error then close; close decides the retry.
  ws.addEventListener("error", () => {
    showError("E5002", "The connection to the server failed.");
  });

  ws.addEventListener("close", () => {
    slot.socket = null;
    // Measured from the first drop: the server started reaping then.
    if (slot.reconnectUntil === null) {
      slot.reconnectUntil =
        slot.idleTimeoutMs === 0 ? Infinity : Date.now() + slot.idleTimeoutMs;
    }
    scheduleReconnect(slot);
  });
}

/**
 * @param {SessionSlot} slot
 * @returns {void}
 */
function scheduleReconnect(slot) {
  const delay = backoffDelay(slot.attempt);
  slot.attempt += 1;
  setTimeout(async () => {
    const live = await liveSessionIds();
    const step = reconnectStep({
      answered: live !== null,
      sessionLive: live !== null && live.has(slot.id),
      msLeft: (slot.reconnectUntil ?? 0) - Date.now(),
    });
    if (step === "retry") {
      scheduleReconnect(slot);
      return;
    }
    if (step === "fresh") {
      startFreshSession(slot);
      return;
    }
    connectSocket(slot);
  }, delay);
}

/**
 * @param {SessionSlot} slot
 * @returns {Promise<void>}
 */
async function startFreshSession(slot) {
  /** @type {{ id: string, rows: number, cols: number }} */
  let created;
  try {
    created = await createSession();
  } catch (cause) {
    showError("E5014", `The session could not be restarted: ${String(cause)}`);
    scheduleReconnect(slot);
    return;
  }
  slot.id = created.id;
  slot.started = true;
  slot.cols = created.cols;
  slot.rows = created.rows + 1;
  writeHash();
  connectSocket(slot);
}

/**
 * @param {SessionSlot} slot not necessarily the one on screen
 * @param {import('../server/protocol.js').ServerMessage} message
 * @returns {void}
 */
function handleServerMessage(slot, message) {
  const onScreen = slot === activeSession();

  // A refused attach closes without a hello, so hello is the success signal.
  if (message.type === "hello") {
    slot.idleTimeoutMs = message.idleTimeoutMs;
    slot.attempt = 0;
    if (slot.reconnectUntil !== null) {
      // Reload rather than resume: the server may now serve newer page code.
      slot.reconnectUntil = null;
      location.reload();
      return;
    }
  }

  if (message.type === "hello" || message.type === "screen") {
    slot.model = message.model;
    slot.oversize = message.oversize;
    slot.cols = message.cols;
    slot.rows = message.rows + 1;
    if (message.type === "hello") settings.models = message.models;
    if (!slot.pane.hidden) ensureTerminal(slot);
    if (message.type === "hello") applySavedSize(slot);
    if (!onScreen) return;
    settings.setModel(slot.model);
    settings.setOversize(slot.oversize);
    if (message.type === "hello") {
      slot.role = message.role;
      slot.allowSharing = message.allowSharing;
      slot.allowSharedEditing = message.allowSharedEditing;
      slot.allowAutomation = message.allowAutomation;
      settings.setRole(slot.role);
      settings.setSharing(slot.allowSharing, slot.allowSharedEditing);
      settings.setAutomation(slot.allowAutomation);
      settings.setHostLocked(message.hostLocked);
      screenEl.focus();
    }
    return;
  }
  if (message.type === "fieldContent") {
    if (onScreen) navigator.clipboard.writeText(message.text);
    return;
  }
  if (message.type === "recorderStep") {
    recorder.record(message.step);
    return;
  }
  if (message.type === "hints") {
    // A late answer would paint stale letters over the wrong pane.
    if (onScreen && prefix.armed) {
      hints = message.hints;
      writeOverlays();
    }
    return;
  }
  if (message.type === "status") {
    const changed = slot.connected !== message.connected;
    slot.connection = message.connection;
    slot.connected = message.connected;
    slot.touched = message.touched;
    slot.locked = message.locked;
    slot.role = message.role;
    slot.allowSharing = message.allowSharing;
    slot.allowSharedEditing = message.allowSharedEditing;
    slot.allowAutomation = message.allowAutomation;
    if (!slot.locked) {
      const waiters = unlockWaiters.get(slot);
      if (waiters !== undefined) {
        unlockWaiters.delete(slot);
        for (const resolve of waiters) resolve();
      }
    }
    slot.terminal?.renderer?.setCursorStyle(
      message.insert ? "underline" : "block",
    );
    // A new pane's session is only reachable once its socket has said hello,
    // which is after the layout that made the pane.
    if (changed && !message.connected && !slot.pane.hidden && panes.length > 1)
      fitIdleSessions();
    if (!onScreen) return;
    settings.connected = message.connected;
    settings.setRole(slot.role);
    settings.setSharing(slot.allowSharing, slot.allowSharedEditing);
    settings.setAutomation(slot.allowAutomation);
    // b3270 reports the host without its port, so never overwrite a typed one.
    if (message.host !== null && settings.host === "" && !settings.hostLocked)
      settings.setHost(message.host);
    if (changed) {
      if (message.connected) {
        closePanels();
        clearError();
      } else {
        startPanel("settings");
      }
    }
    return;
  }
  if (onScreen) {
    // A refused change leaves the page showing a size never accepted.
    settings.setModel(slot.model);
    settings.setOversize(slot.oversize);
    showError(message.code, message.message);
    return;
  }
  showError(
    message.code,
    `Session ${sessions.indexOf(slot) + 1}: ${message.message}`,
  );
}

/**
 * @param {SessionSlot} slot
 * @returns {void}
 */
function repaint(slot) {
  const page = slot === activeSession() ? openPanel() : null;
  if (page) {
    page.draw();
    return;
  }
  // A session still opening has nothing to repaint; its screen is already stale.
  if (!sendQuietly(slot, { type: "refresh" }))
    slot.terminal?.write(`${ESC}[2J`);
}

/** @returns {void} */
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

  // Order matters: lay out, then build, then repaint.
  for (const slot of revealed) ensureTerminal(slot);
  fitPanes();
  for (const slot of revealed) repaint(slot);
}

/**
 * @param {number} index
 * @returns {void}
 */
function focusSlot(index) {
  const slot = sessions[index] ?? null;
  if (slot === null || index === active) return;

  // Close before the switch, or the wrong pane is asked for its screen back.
  closePanels();

  if (!panes.includes(index)) {
    const here = Math.max(0, panes.indexOf(active));
    panes[here] = index;
  }
  active = index;
  settings.setModel(slot.model);
  settings.setOversize(slot.oversize);
  settings.connected = slot.connected === true;
  settings.setRole(slot.role);
  settings.setSharing(slot.allowSharing, slot.allowSharedEditing);
  settings.setAutomation(slot.allowAutomation);
  applyLayout();
  screenEl.focus();

  if (slot.connection === "not-connected") startPanel("settings");
}

/** @type {boolean} One creation at a time; two fast keystrokes are one session. */
let opening = false;

/**
 * @param {number} index
 * @returns {Promise<SessionSlot>}
 */
async function ensureSlot(index) {
  const existing = sessions[index];
  if (existing != null) return existing;
  const created = await createSession();
  const slot = newSlot(created.id, true, created.cols, created.rows + 1);
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
  ensureSlot(index)
    .then(() => {
      focusSlot(index);
    })
    .catch((cause) => {
      showError(
        "E5006",
        `Another session could not be opened: ${String(cause)}`,
      );
    })
    .finally(() => {
      opening = false;
    });
}

/**
 * Missing sessions are opened all at once: each costs a b3270 startup.
 *
 * @param {number} count
 * @returns {void}
 */
function changeLayout(count) {
  if (opening) return;
  opening = true;
  /** @type {Promise<unknown>[]} */
  const opens = [];
  if (count > 1)
    for (let index = 0; index < count; index++) opens.push(ensureSlot(index));

  Promise.all(opens)
    .then(() => {
      panes = [];
      if (count === 1) panes.push(active);
      else for (let index = 0; index < count; index++) panes.push(index);
      if (!panes.includes(active)) active = panes[0];
      applyLayout();
      fitIdleSessions();
      screenEl.focus();
    })
    .catch((cause) => {
      showError(
        "E5006",
        `Another session could not be opened: ${String(cause)}`,
      );
    })
    .finally(() => {
      opening = false;
    });
}

/**
 * @param {string} letter
 * @returns {void}
 */
function jumpToHint(letter) {
  const hint = hints.find((entry) => entry.letter === letter);
  if (hint === undefined) return;
  send({
    type: "action",
    action: "MoveCursor1",
    args: [String(hint.row + 1), String(hint.col + 1)],
  });
}

// The prefix goes first: a disconnected session has settings open over it, and
// being unable to switch away would be a trap.
window.addEventListener(
  "keydown",
  (event) => {
    const decision = prefix.handleKey(
      event,
      settings.hints ? hints.map((hint) => hint.letter) : [],
    );
    if (decision.action !== "ignore") {
      event.preventDefault();
      event.stopPropagation();
      if (decision.action === "arm") {
        hints = [];
        if (settings.hints) send({ type: "hints" });
        writeOverlays();
        return;
      }
      // Before the switch: the pane under the bar is the one to repaint.
      clearError();
      repaintStatus();
      if (decision.action === "switch") switchTo(decision.index);
      else if (decision.action === "layout") changeLayout(decision.panes);
      else if (decision.action === "hint") jumpToHint(decision.letter);
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const wanted = panels.find(
        (page) => page.toggleKey !== "" && event.code === page.toggleKey,
      );
      if (wanted !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        startPanel(wanted.id);
        return;
      }
    }

    // Ctrl and Meta fall through on purpose: copy, paste and reload work in a panel.
    if (openPanel()?.handleKey(event) === true) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true,
);

screenEl.addEventListener(
  "keydown",
  (event) => {
    clearError();

    const mapped = mapKey(event, keymap.lookup());
    if (mapped === null) return;
    event.preventDefault();
    event.stopPropagation();

    // A panel is over the screen, so only the clipboard commands still mean something.
    const panel = openPanel();
    if (panel !== null && mapped.kind !== "client") return;

    if (mapped.kind === "text") {
      send({ type: "text", value: mapped.value });
      return;
    }
    if (mapped.kind === "action") {
      send({ type: "action", action: mapped.action, args: mapped.args });
      return;
    }

    // Copy and Paste are this browser's clipboard, not 3270 actions, so keymap.js
    // maps them but cannot dispatch them.
    if (mapped.command === "Copy") {
      const term = activeTerminal();
      if (term !== null && term.hasSelection())
        navigator.clipboard.writeText(term.getSelection());
      else if (panel !== null) navigator.clipboard.writeText(panel.copy());
      else send({ type: "copyField" });
      return;
    }
    // Ctrl+V arrives as a paste event instead; every other binding must read the
    // clipboard, which Chrome asks permission for once.
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text === "") return;
        if (panel !== null) panel.paste(text);
        else send({ type: "paste", text });
      })
      .catch((cause) => {
        showError(
          "E5005",
          `The clipboard could not be read; Ctrl+V pastes without asking: ${String(cause)}`,
        );
      });
  },
  true,
);

// Capture: ghostty's own paste handler on the hidden textarea would eat this.
screenEl.addEventListener(
  "paste",
  (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearError();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text === "") return;
    const panel = openPanel();
    if (panel !== null) panel.paste(text);
    else send({ type: "paste", text });
  },
  true,
);

/**
 * Refits a window-measured screen, which costs the host connection — hence a
 * button and not something that happens on its own.
 *
 * @param {SessionSlot} slot
 * @returns {void}
 */
function resetScreen(slot) {
  if (settings.fitsWindow()) fitSession(slot);
  fitFontSize(slot);
  repaint(slot);
}

/**
 * @param {SessionSlot} slot
 * @param {MouseEvent} event
 * @returns {void}
 */
function paneClicked(slot, event) {
  screenEl.focus();
  focusSlot(sessions.indexOf(slot));
  const term = slot.terminal;
  const renderer = term?.renderer;
  if (term === null || renderer === undefined) return;

  const rect = renderer.getCanvas().getBoundingClientRect();
  const row = Math.floor((event.clientY - rect.top) / renderer.charHeight);
  const col = Math.floor((event.clientX - rect.left) / renderer.charWidth);

  const panel = openPanel();
  if (panel !== null) {
    if (slot === activeSession()) panel.clicked(row + 1, col + 1);
    return;
  }

  const menuStart = term.cols - MENU_LABEL.length;
  const resetStart = term.cols - BUTTONS.length;

  if (row === term.rows - 1) {
    // Widest first: each start is left of the last, so the first match wins.
    const buttons = [
      { start: menuStart, action: () => startPanel("menu") },
      { start: resetStart, action: () => resetScreen(slot) },
    ];
    for (const button of buttons) {
      if (col >= button.start) {
        button.action();
        return;
      }
    }
  }

  // The last row is ours, and a click ending a drag was aiming at the selection.
  if (row < 0 || row >= term.rows - 1 || col < 0 || col >= term.cols) return;
  if (term.hasSelection()) return;
  sendTo(slot, {
    type: "action",
    action: "MoveCursor1",
    args: [String(row + 1), String(col + 1)],
  });
}

// The font has to be loaded before the first terminal, or the first screen is
// painted in the wrong face and then restyled.
const [renderer, saved, savedMacros, savedKeymap] = await Promise.allSettled([
  init(),
  loadSettings(),
  loadMacros(),
  loadKeymap(),
]);
if (renderer.status === "rejected") {
  showError(
    "E5001",
    `The terminal renderer failed to load: ${String(renderer.reason)}`,
  );
  throw renderer.reason;
}
if (saved.status === "fulfilled") settings.restoreSaved(saved.value);
else
  showError(
    "E5003",
    `Saved settings could not be read; using the defaults: ${String(saved.reason)}`,
  );
if (savedMacros.status === "fulfilled") macros.setMacros(savedMacros.value);
else
  showError(
    "E5008",
    `Saved macros could not be read: ${String(savedMacros.reason)}`,
  );
if (savedKeymap.status === "fulfilled") keymap.setBindings(savedKeymap.value);
else
  showError(
    "E5013",
    `Saved keymap could not be read; using the defaults: ${String(savedKeymap.reason)}`,
  );

try {
  await document.fonts.load(`16px ${settings.font().family}`);
} catch (cause) {
  console.warn("could not preload the saved font", cause);
}

const storedHost = localStorage.getItem("tn3270.host");
if (storedHost !== null) settings.setHost(storedHost);

const wanted = parseSessionHash(location.hash);
if (wanted.some((id) => id !== null)) {
  // No answer is not the same as forgotten: keep the slots and let the sockets wait.
  const live = await liveSessionIds();
  const gone = [];
  for (let index = 0; index < MAX_SESSIONS; index++) {
    const id = wanted[index];
    if (id == null) continue;
    if (live === null || live.has(id)) sessions[index] = newSlot(id);
    else gone.push(index + 1);
  }
  if (gone.length > 0)
    showError(
      "E3001",
      `Session ${gone.join(", ")} is gone; starting a new one.`,
    );
}

if (!sessions.some((slot) => slot !== null)) {
  const created = await createSession();
  sessions[0] = newSlot(created.id, true, created.cols, created.rows + 1);
}
writeHash();

active = Math.max(
  0,
  sessions.findIndex((slot) => slot !== null),
);
panes = [active];
applyLayout();
for (const slot of sessions) {
  if (slot !== null) connectSocket(slot);
}
