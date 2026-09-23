import { Pane, Screen } from "./canvas.js";
import { renderOia, keyboardLocked } from "./oia.js";
import { PANEL_COMMANDS, commandForEvent, mapKey } from "./keymap.js";
import { paint } from "./panel.js";
import { HelpPage, MenuPage } from "./menu.js";
import { SettingsPage, modeOversize } from "./settings.js";
import { MacrosPage } from "./macros.js";
import { RecorderPage } from "./recorder.js";
import { KeymapPage } from "./keymap-page.js";
import {
  loadSettings,
  saveSettings,
  loadMacros,
  saveMacros,
  loadKeymap,
  saveKeymap,
} from "./store.js";
import {
  MAX_SESSIONS,
  SessionPrefix,
  paneShares,
  parseSessionHash,
  sessionHash,
  switcherText,
} from "./sessions.js";
import { backoffDelay, reconnectStep } from "./reconnect.js";

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

// The page's markup is fixed: `index.html` has the canvas, and nothing here
// ever builds, moves or removes an element.
const canvasEl = element("canvas");
if (!(canvasEl instanceof HTMLCanvasElement))
  throw new Error("#canvas is not a canvas");

/**
 * One canvas for the whole page. Every session is a rectangle on it, and every
 * frame is drawn whole — see `redraw()`, which is the only way one happens.
 *
 * @type {Screen}
 */
let screen;

const RESET_LABEL = "[Reset]";
const MENU_LABEL = "[Menu]";
// The menu is the way to every panel, so one button reaches all of them. They
// sit at the right end of the status row, which this page lays out whole.
const BUTTONS = `${RESET_LABEL} ${MENU_LABEL}`;

/**
 * Where the two buttons start. `drawChrome` puts them here and `canvasClicked`
 * hit-tests them here, so the row that is drawn and the row that is clickable
 * cannot drift apart.
 *
 * @param {number} cols
 * @returns {{ reset: number, menu: number }}
 */
function buttonColumns(cols) {
  return { reset: cols - BUTTONS.length, menu: cols - MENU_LABEL.length };
}

/** @type {{ code: string, message: string } | null} */
let activeError = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let errorTimer;

/**
 * Everything this page draws over the screen: a panel across all of it, or the
 * status row under it, and then the switcher bar, an error and the hint letters
 * on top of either. The host's own grid is never touched, so taking the overlay
 * off puts the screen back without asking the server for it again.
 *
 * @param {SessionSlot} slot
 * @returns {void}
 */
function drawChrome(slot) {
  const canvas = slot.pane;
  if (canvas === null) return;
  const overlay = canvas.overlay;
  const bottom = canvas.statusRow;
  const buttons = buttonColumns(canvas.cols);
  const colors = settings.theme().colors;
  const background = colors["background"] ?? "#000000";
  const foreground = colors["foreground"] ?? "#00ff00";
  /** @param {string} text */
  const wide = (text) => text.slice(0, canvas.cols).padEnd(canvas.cols, " ");

  overlay.clear();
  const onScreen = slot === activeSession();
  const panel = onScreen ? openPanel() : null;

  if (panel !== null) panel.drawInto(overlay);
  else {
    // Reverse video, as the operator information area is on the hardware.
    const style = paint(background, foreground);
    const cursor = canvas.host.cursor ?? { row: 0, col: 0 };
    overlay.put(bottom, 0, wide(""), style);
    overlay.put(
      bottom,
      0,
      renderOia(oiaState(slot), cursor, buttons.reset - 1),
      style,
    );
    overlay.put(
      bottom,
      buttons.reset,
      BUTTONS,
      paint(background, foreground, true),
    );
  }

  // Everything below belongs to the session being looked at, not to every pane.
  if (!onScreen) return;

  if (activeError !== null)
    overlay.put(
      bottom,
      0,
      wide(`[${activeError.code}] ${activeError.message}`),
      paint("#ffd9d9", "#3a1d20", true),
    );
  else if (prefix.armed)
    overlay.put(
      bottom,
      0,
      wide(
        switcherText(
          sessions.map((each) => each?.id ?? null),
          active,
        ),
      ),
      paint(background, foreground, true),
    );

  if (prefix.armed && settings.hints)
    for (const hint of hints)
      overlay.put(
        hint.row,
        hint.col,
        hint.letter,
        paint(background, foreground, true),
      );
}

/** @type {number | null} */
let chromeFrame = null;

/**
 * The one way a frame happens. Every pane on screen gets its chrome rebuilt
 * from the current state and then the whole canvas is drawn again, so there is
 * no such thing as a half-updated screen — and nothing has to work out which
 * part of it an action touched.
 *
 * It happens once per frame rather than once per caller: one keystroke can
 * bring a paint and two status messages, and each rebuild clears an overlay the
 * size of the screen. Whatever the state is when the frame comes is what gets
 * drawn, which is the answer the last caller would have got anyway.
 *
 * @returns {void}
 */
function redraw() {
  if (chromeFrame !== null) return;
  chromeFrame = requestAnimationFrame(() => {
    chromeFrame = null;
    for (const index of panes) {
      const slot = sessions[index];
      if (slot != null) drawChrome(slot);
    }
    screen.render();
  });
}

/**
 * A session with no pane on screen — a fourth one running a macro, say — still
 * takes its paints, but a frame it cannot appear in would be the same pixels.
 *
 * @param {SessionSlot} slot
 * @returns {boolean}
 */
function displayed(slot) {
  return panes.some((index) => sessions[index] === slot);
}

/**
 * @param {SessionSlot} slot
 * @returns {import('./oia.js').OiaState}
 */
function oiaState(slot) {
  return {
    connection: slot.connection,
    connected: slot.connected === true,
    host: slot.hostName,
    lock: slot.lock,
    insert: slot.insert,
    typeahead: slot.typeahead,
  };
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
  redraw();
}

/** @returns {void} */
function clearError() {
  if (activeError === null) return;
  activeError = null;
  if (errorTimer !== undefined) clearTimeout(errorTimer);
  redraw();
}

/** @type {number} */
const DEFAULT_IDLE_TIMEOUT_MS = 300000;

/** @returns {Promise<{ id: string, rows: number, cols: number }>} */
async function createSession() {
  const response = await fetch("./api/sessions", { method: "POST" });
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
    const response = await fetch("./api/sessions");
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
 * A hidden pane keeps taking paints — applying cells to a grid nobody is looking
 * at is free, and it means coming back into view costs no round trip. Its socket
 * stays open too, or the server reaps the session.
 *
 * @typedef {object} SessionSlot
 * @property {string} id
 * @property {import('./canvas.js').Pane | null} pane its rectangle on the page's
 *   canvas, once the server has said how big the screen is
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
 * @property {number} rows the host's screen; the status row is not the host's
 * @property {string} connection
 * @property {boolean | null} connected null until the first status
 * @property {string | null} hostName what b3270 calls the host it is on
 * @property {boolean} touched
 * @property {string} lock b3270's own word for why the keyboard is locked
 * @property {boolean} insert
 * @property {boolean} typeahead
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

const prefix = new SessionPrefix();

/** @type {{ row: number, col: number, letter: string }[]} */
let hints = [];

/** @returns {SessionSlot | null} */
function activeSession() {
  return sessions[active] ?? null;
}

/** @returns {import('./canvas.js').Pane | null} */
function activePane() {
  return activeSession()?.pane ?? null;
}

/**
 * @param {string} id
 * @param {boolean} started
 * @param {number} cols
 * @param {number} rows the host's screen, without the status row
 * @returns {SessionSlot}
 */
function newSlot(id, started = false, cols = 0, rows = 0) {
  /** @type {SessionSlot} */
  const slot = {
    id,
    pane: null,
    socket: null,
    started,
    attempt: 0,
    reconnectUntil: null,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    model: 0,
    oversize: "",
    cols,
    rows,
    connection: "not-connected",
    connected: null,
    hostName: null,
    touched: false,
    lock: "",
    insert: false,
    typeahead: false,
    role: "controller",
    allowSharing: true,
    allowSharedEditing: false,
    allowAutomation: false,
  };
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
  if (slot === null || !keyboardLocked(slot.lock)) return Promise.resolve();
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
 * @type {import('./panel.js').PanelDeps}
 */
const panelIo = {
  redraw,
  theme: () => settings.theme(),
  end: () => endPanel(),
  go: (id) => goPanel(id),
  keyCommand: (event) => commandForEvent(event, keymap.lookup()),
  keyName: (commandId) => keymap.labelFor(commandId),
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
  applyHostColors: (enabled) => {
    screen.hostColors = enabled;
    redraw();
  },
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
  // The screen was never painted over, only covered, so the overlay coming off
  // is the whole of giving it back.
  if (previous === null) redraw();
  else previous.show();
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
  redraw();
}

/**
 * Build the session's pane, or resize the one it has to the geometry the server
 * last reported. A session with no geometry yet has nothing to build.
 *
 * @param {SessionSlot} slot
 * @returns {void}
 */
function ensurePane(slot) {
  if (slot.cols < 1 || slot.rows < 1) return;
  if (slot.pane !== null) {
    slot.pane.resize(slot.cols, slot.rows);
    return;
  }
  slot.pane = new Pane(slot.cols, slot.rows);
  // It was built empty, and every paint before it was built went nowhere.
  sendQuietly(slot, { type: "refresh" });
}

/**
 * The colours are the browser's own now, so a theme change is a repaint and
 * nothing more: no pane has to ask the server for its screen back.
 *
 * @param {import('./settings.js').Theme} theme
 * @returns {void}
 */
function applyTheme(theme) {
  screenEl.style.background = theme.colors.background;
  screen.theme = theme.colors;
  redraw();
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
  applyLayout();
  if (settings.open) settings.draw();
}

/**
 * How big a screen this pane would hold with text `fontSize` pixels tall.
 *
 * @param {SessionSlot} slot
 * @param {number} fontSize
 * @returns {{ cols: number, rows: number } | null}
 */
function paneFit(slot, fontSize) {
  const pane = slot.pane;
  if (pane === null) return null;

  const box = pane.box;
  if (box.width < 1 || box.height < 1) return null;

  // Never scale from the drawn size: a cell rounds up to whole pixels, so
  // scaled panes never agree on a screen.
  const cell = screen.measure(settings.font().family, fontSize);
  const cols = Math.floor(box.width / cell.width);
  // One row is the OIA, which this side paints and the host knows nothing about.
  const rows = Math.floor(box.height / cell.height) - 1;
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

// Coalesced into a frame: a drag fires this continuously.
let fitScheduled = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let settleTimer;
new ResizeObserver(() => {
  if (!fitScheduled) {
    fitScheduled = true;
    requestAnimationFrame(() => {
      fitScheduled = false;
      applyLayout();
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
  // Relative to the document, so a reverse proxy can mount us under a path.
  const url = new URL(`./ws/${slot.id}`, document.baseURI);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";

  const ws = new WebSocket(url.href);
  slot.socket = ws;

  ws.addEventListener("message", (event) => {
    handleServerMessage(slot, JSON.parse(String(event.data)));
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
  slot.rows = created.rows;
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

  if (message.type === "screen") {
    slot.model = message.model;
    slot.oversize = message.oversize;
    slot.cols = message.cols;
    slot.rows = message.rows;
    if (!onScreen) return;
    applyLayout();
    settings.setModel(slot.model);
    settings.setOversize(slot.oversize);
    return;
  }
  if (message.type === "hello") {
    slot.model = message.model;
    slot.oversize = message.oversize;
    slot.cols = message.cols;
    slot.rows = message.rows;
    settings.models = message.models;
    if (onScreen) applyLayout();
    applySavedSize(slot);
    if (!onScreen) return;
    settings.setModel(slot.model);
    settings.setOversize(slot.oversize);
    slot.role = message.role;
    slot.allowSharing = message.allowSharing;
    slot.allowSharedEditing = message.allowSharedEditing;
    slot.allowAutomation = message.allowAutomation;
    settings.setRole(slot.role);
    settings.setSharing(slot.allowSharing, slot.allowSharedEditing);
    settings.setAutomation(slot.allowAutomation);
    settings.setHostLocked(message.hostLocked);
    screenEl.focus();
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
      redraw();
    }
    return;
  }
  if (message.type === "paint") {
    // Even hidden, even behind a panel: a grid nobody is looking at costs
    // nothing to keep, and keeping it is what makes coming back free.
    slot.pane?.host.applyPaint(message);
    if (displayed(slot)) redraw();
    return;
  }
  if (message.type === "status") {
    const changed = slot.connected !== message.connected;
    slot.connection = message.connection;
    slot.connected = message.connected;
    slot.hostName = message.host;
    slot.touched = message.touched;
    slot.lock = message.lock;
    slot.insert = message.insert;
    slot.typeahead = message.typeahead;
    slot.role = message.role;
    slot.allowSharing = message.allowSharing;
    slot.allowSharedEditing = message.allowSharedEditing;
    slot.allowAutomation = message.allowAutomation;
    if (!keyboardLocked(slot.lock)) {
      const waiters = unlockWaiters.get(slot);
      if (waiters !== undefined) {
        unlockWaiters.delete(slot);
        for (const resolve of waiters) resolve();
      }
    }
    if (slot.pane !== null)
      slot.pane.cursorStyle = message.insert ? "underline" : "block";
    if (displayed(slot)) redraw();
    // A new pane's session is only reachable once its socket has said hello,
    // which is after the layout that made the pane.
    if (changed && !message.connected && onScreen && panes.length > 1)
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
 * Everything that decides where a cell lands on the canvas, in one pass: which
 * sessions are on screen, how the page is split between them, how big their
 * text has to be to fit, and then the frame. A resize, a layout change and a
 * new session all come through here, so none of them can leave the three
 * disagreeing.
 *
 * @returns {void}
 */
function applyLayout() {
  /** @type {import('./canvas.js').Pane[]} */
  const onCanvas = [];
  for (const index of panes) {
    const slot = sessions[index];
    if (slot == null) continue;
    ensurePane(slot);
    if (slot.pane !== null) onCanvas.push(slot.pane);
  }

  screen.layout(
    onCanvas,
    paneShares(onCanvas.length),
    { width: screenEl.clientWidth, height: screenEl.clientHeight },
    settings.font().family,
  );
  redraw();
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
  const slot = newSlot(created.id, true, created.cols, created.rows);
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
        redraw();
        return;
      }
      // The bar comes off first: a hint or a cancel draws nothing after it.
      clearError();
      redraw();
      if (decision.action === "switch") switchTo(decision.index);
      else if (decision.action === "layout") changeLayout(decision.panes);
      else if (decision.action === "hint") jumpToHint(decision.letter);
      return;
    }
    // A panel command opens its panel from anywhere, including from another
    // panel, so it is claimed before the open panel gets to read the key.
    const command = commandForEvent(event, keymap.lookup());
    const wanted = command === null ? undefined : PANEL_COMMANDS[command];
    if (wanted !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      startPanel(wanted);
      return;
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
      const canvas = activePane();
      if (canvas !== null && canvas.hasSelection())
        navigator.clipboard.writeText(canvas.getSelection());
      else if (panel !== null) navigator.clipboard.writeText(panel.copy());
      else send({ type: "copyField" });
      return;
    }
    // The panel commands are the other client commands, and the window handler
    // claims those before this one ever runs.
    if (mapped.command !== "Paste") return;
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

// Capture: the keydown handler above would otherwise see Ctrl+V twice.
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
  applyLayout();
}

/**
 * One canvas means one click listener: which session was clicked is a question
 * about where on the page it landed, and the renderer is what knows.
 *
 * @param {MouseEvent} event
 * @returns {void}
 */
function canvasClicked(event) {
  screenEl.focus();
  const hit = screen.paneAt(event.clientX, event.clientY);
  if (hit === null) return;
  const slot = sessions.find((each) => each?.pane === hit.pane) ?? null;
  if (slot == null) return;
  focusSlot(sessions.indexOf(slot));

  const canvas = hit.pane;
  const { row, col } = hit;

  const panel = openPanel();
  if (panel !== null) {
    if (slot === activeSession()) panel.clicked(row + 1);
    return;
  }

  if (row === canvas.statusRow) {
    const buttons = buttonColumns(canvas.cols);
    if (col >= buttons.menu) {
      startPanel("menu");
      return;
    }
    if (col >= buttons.reset) {
      resetScreen(slot);
      return;
    }
  }

  // The last row is ours, and a click ending a drag was aiming at the selection.
  if (row < 0 || row >= canvas.rows || col < 0 || col >= canvas.cols) return;
  if (canvas.hasSelection()) return;
  sendTo(slot, {
    type: "action",
    action: "MoveCursor1",
    args: [String(row + 1), String(col + 1)],
  });
}

// The font has to be loaded before the first canvas, or the first screen is
// measured in the wrong face and fitted to the wrong size.
const [saved, savedMacros, savedKeymap] = await Promise.allSettled([
  loadSettings(),
  loadMacros(),
  loadKeymap(),
]);
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

try {
  screen = new Screen({
    canvas: canvasEl,
    theme: settings.theme().colors,
    hostColors: settings.hostColors,
  });
} catch (cause) {
  showError("E5001", `The renderer failed to start: ${String(cause)}`);
  throw cause;
}
canvasEl.addEventListener("click", canvasClicked);
screenEl.style.background = settings.theme().colors.background;

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
  sessions[0] = newSlot(created.id, true, created.cols, created.rows);
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
