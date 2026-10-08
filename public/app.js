import { Screen } from "./canvas.js";
import { renderOia, cursorPosition } from "./oia.js";
import {
  ComboCapture,
  Keymap,
  LoneModifier,
  PANEL_COMMANDS,
  asReleased,
  commandForEvent,
  isMacroCommand,
  macroInputForEvent,
  mapKey,
} from "./keymap.js";
import { keyAt, keyFace, keyboardTop, placeKeys } from "./screen-keyboard.js";
import { Settings, modeOversize } from "./settings.js";
import { Macros } from "./macros.js";
import { Recorder } from "./recorder.js";
import { Panels } from "./panels.js";
import {
  loadSettings,
  saveSettings,
  loadMacros,
  saveMacros,
  loadRecordings,
  saveRecordings,
  loadKeymap,
  saveKeymap,
  reload,
  TAB_ID,
} from "./store.js";
import { backoffDelay } from "./reconnect.js";
import {
  createSessionRequest,
  listSessions,
  terminateSession,
  logonRequest,
} from "./session-api.js";
import { HintPrefix, computeHints } from "./hints.js";

/**
 * @param {string} fg
 * @param {string} bg
 * @param {boolean} [bold]
 * @returns {import('./grid.js').Style}
 */
function paint(fg, bg, bold = false) {
  return { fg, bg, gr: bold ? "highlight" : null };
}

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
const pasteTarget = element("paste-target");
const importInput = element("recording-import");
if (!(importInput instanceof HTMLInputElement))
  throw new Error("#recording-import is not a file input");

/**
 * One canvas for the whole page, and every frame is drawn whole — see
 * `redraw()`, which is the only way one happens.
 *
 * @type {Screen}
 */
let screen;

/** Whether the on-screen keyboard is drawn over the screen. */
let keyboardShown = false;

/**
 * @typedef {object} StatusButton
 * @property {string} label
 * @property {number} col where it starts
 * @property {() => void} press
 */

/** @param {string} command */
function shortKey(command) {
  return keymap
    .labelFor(command)
    .toLowerCase()
    .replaceAll("+", "-")
    .replace("ctrl", "c")
    .replace("shift", "s")
    .replace("alt", "a");
}

/** @param {string} command @param {string} label */
function statusLabel(command, label) {
  const key = shortKey(command);
  return key === "" ? label : `${key}=${label}`;
}

/**
 * The buttons at the right end of the status row, which this page lays out
 * whole. The menu is the way to every panel, so one button reaches all of
 * them; then the keyboard and the recorder, and left of those whatever
 * sharing asks of this viewer. `drawChrome`
 * puts them where this says and `canvasClicked` hit-tests the same list, so
 * the row that is drawn and the row that is clickable cannot drift apart.
 *
 * @param {number} cols
 * @returns {StatusButton[]}
 */
function statusButtons(cols) {
  /** @type {{ label: string, press: () => void }[]} */
  const wanted = [
    {
      label: statusLabel("Menu", "Menu"),
      press: () => panels.toggle("menu"),
    },
    {
      label: statusLabel("ToggleKeyboard", "Kbd"),
      press: toggleKeyboard,
    },
    {
      label: recorder.stopping
        ? "Saving"
        : recorder.active
          ? statusLabel("ToggleRecording", "Stop")
          : statusLabel("ToggleRecording", "Rec"),
      press: toggleRecording,
    },
  ];
  const request = session.requests[0];
  if (session.refusal !== null || session.waiting) {
    // Nothing to share and nothing to ask for.
  } else if (request !== undefined) {
    wanted.push({
      label: statusLabel("AnswerNo", "No"),
      press: () => answerRequest(request, false),
    });
    wanted.push({
      label: statusLabel("AnswerYes", "Yes"),
      press: () => answerRequest(request, true),
    });
  } else if (session.owner) {
    if (session.editor !== null)
      wanted.push({
        label: statusLabel("StopEditing", "X edit"),
        press: () => sendUnrecorded({ type: "stopEditing" }),
      });
    if (session.guests > 0)
      wanted.push({
        label: statusLabel("StopSharing", "X shr"),
        press: () => sendUnrecorded({ type: "stopSharing" }),
      });
  } else if (session.role === "observer" && !session.editRequested) {
    wanted.push({
      label: statusLabel("AskEdit", "Edit"),
      press: () => sendUnrecorded({ type: "askEdit" }),
    });
  }

  /** @type {StatusButton[]} */
  const placed = [];
  const cursor = screen.overlay.cursor ??
    screen.host.cursor ?? { row: 0, col: 0 };
  let col = cols - cursorPosition(cursor).length - 2;
  for (const button of wanted) {
    col -= button.label.length;
    placed.push({ ...button, col });
    col -= 1;
  }
  return placed;
}

function toggleKeyboard() {
  keyboardShown = !keyboardShown;
  redraw();
}

function toggleRecording() {
  if (recorder.stopping) return;
  if (recorder.active) recorder.stop();
  else recorder.start();
  redraw();
}

/**
 * What the status row says instead of the OIA while sharing needs a word:
 * someone asking the owner, or this viewer waiting on one.
 *
 * @returns {string | null}
 */
function sharingText() {
  if (session.refusal !== null) return session.refusal;
  if (session.waiting) return "Waiting for the session's owner to let you in";
  const request = session.requests[0];
  if (request !== undefined) {
    const more =
      session.requests.length > 1
        ? ` (${session.requests.length - 1} more)`
        : "";
    return request.kind === "watch"
      ? `${request.name} wants to watch${more}`
      : `${request.name} wants to edit${more}`;
  }
  if (session.editRequested) return "Asked the owner to let you edit";
  return null;
}

/**
 * @param {import('../server/protocol.js').SharingRequest} request
 * @param {boolean} allow
 * @returns {void}
 */
function answerRequest(request, allow) {
  console.info("sharing request answered", { ...request, allow });
  sendUnrecorded({ type: "answer", viewer: request.viewer, allow });
}

/** @returns {import('./screen-keyboard.js').PlacedKey[]} */
function keyboardKeys() {
  const cursorRow = panels.isOpen()
    ? (screen.overlay.cursor?.row ?? 0)
    : (screen.host.cursor?.row ?? 0);
  return placeKeys(screen.cols, keyboardTop(screen.rows, cursorRow));
}

/** @type {{ code: string, message: string } | null} */
let activeError = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let errorTimer;

/**
 * Everything this page draws over the screen: the panels' own host screen
 * across all of it, the status row under it, and then an error and the hint
 * letters on top. The host's own grid is never touched, so taking the overlay
 * off puts the screen back without asking the server for it again.
 *
 * @returns {void}
 */
function drawChrome() {
  if (screen.cols === 0) return;
  const overlay = screen.overlay;
  const bottom = screen.statusRow;
  const colors = settings.theme().colors;
  const background = colors["background"] ?? "#000000";
  const foreground = colors["foreground"] ?? "#00ff00";
  const statusInk = colors.statusForeground;
  const statusBar = colors.statusBackground;
  /** @param {string} text */
  const wide = (text) => text.slice(0, screen.cols).padEnd(screen.cols, " ");
  const statusWidth = Math.max(0, screen.cols - 2);
  /** @param {string} text */
  const statusText = (text) =>
    text.slice(0, statusWidth).padEnd(statusWidth, " ");

  overlay.clear();
  const panel = panels.isOpen();
  if (panel) {
    const painted = panels.paint(screen.rows, screen.cols);
    overlay.applyPaint(
      panels.pickingMacroCursor()
        ? {
            ...painted,
            full: false,
            rows: painted.rows.filter(
              (row) =>
                row.row < 3 ||
                (panels.message !== "" && row.row === screen.rows - 3),
            ),
          }
        : painted,
    );
  }
  const insert = panel ? panels.host.insert : session.insert;
  screen.cursorStyle = insert ? "underline" : "block";

  const style = paint(statusInk, statusBar);
  const loud = paint(statusInk, statusBar, true);
  const cursor = overlay.cursor ?? screen.host.cursor ?? { row: 0, col: 0 };
  const position = cursorPosition(cursor);
  const positionCol = screen.cols - position.length - 1;
  const buttons = statusButtons(screen.cols);
  const buttonsStart = buttons.at(-1)?.col ?? positionCol - 1;
  // Browser zoom and OS display scaling together; the page cannot tell them apart.
  const scale = Math.round((window.devicePixelRatio || 1) * 100);
  const scaleText = scale === 100 ? "" : `Zoom ${scale}%`;
  const scaleCol = buttonsStart - scaleText.length - 1;
  const width = Math.max(0, (scaleText === "" ? buttonsStart : scaleCol) - 2);
  const said = sharingText();
  overlay.put(bottom, 0, wide(""), style);
  if (said === null)
    overlay.put(
      bottom,
      1,
      renderOia({ ...oiaState(), insert }, null, width),
      style,
    );
  else overlay.put(bottom, 1, said.slice(0, width), loud);
  if (scaleText !== "") overlay.put(bottom, scaleCol, scaleText, loud);
  for (const button of buttons)
    overlay.put(bottom, button.col, button.label, loud);
  overlay.put(bottom, positionCol, position, style);

  if (keyboardShown) {
    const keys = keyboardKeys();
    const rows = new Set(keys.map((key) => key.row));
    for (const row of rows)
      overlay.put(row, 0, wide(""), paint(foreground, background));
    for (const key of keys)
      overlay.put(
        key.row,
        key.col,
        keyFace(key, key.action === "OpenChars" ? shortKey("OpenChars") : ""),
        paint(foreground, background, true),
      );
  }

  if (activeError !== null) {
    const errorStyle = paint("#ffd9d9", "#3a1d20", true);
    overlay.put(bottom, 0, wide(""), errorStyle);
    overlay.put(
      bottom,
      1,
      statusText(`[${activeError.code}] ${activeError.message}`),
      errorStyle,
    );
  }

  if (prefix.armed)
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
 * The one way a frame happens. The chrome is rebuilt from the current state
 * and then the whole canvas is drawn again, so there is
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
    drawChrome();
    screen.render();
  });
}

/** @returns {import('./oia.js').OiaState} */
function oiaState() {
  return {
    connection: session.connection,
    connected: session.connected === true,
    host: session.hostName,
    lock: session.lock,
    insert: session.insert,
    typeahead: session.typeahead,
  };
}

/**
 * @param {string} code
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {void}
 */
function showError(code, message, cause) {
  if (cause === undefined) console.error(`[${code}] ${message}`);
  else console.error(`[${code}] ${message}`, cause);
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

/** @returns {Promise<{ id: string, rows: number, cols: number }>} */
function createSession() {
  return createSessionRequest(startingSize());
}

/**
 * The one host session this tab shows. Its socket stays open while the tab is
 * hidden, or the server reaps the session.
 *
 * @typedef {object} Session
 * @property {string} id empty until the server has made or confirmed one
 * @property {WebSocket | null} socket
 * @property {number} attempt
 * @property {ReturnType<typeof setTimeout> | null} retryTimer the backoff wait before the next reconnect
 * @property {boolean} reconnecting whether a dropped socket has reattached
 * @property {number} model
 * @property {boolean} hostLocked
 * @property {string} codePage
 * @property {string} chart what each EBCDIC byte from 0x40 to 0xFF shows, empty until the hello
 * @property {string} oversize
 * @property {string} connection
 * @property {boolean | null} connected null until the first status
 * @property {string | null} hostName what b3270 calls the host it is on
 * @property {boolean} touched
 * @property {string} lock b3270's own word for why the keyboard is locked
 * @property {boolean} insert
 * @property {boolean} typeahead
 * @property {'controller' | 'observer'} role
 * @property {boolean} owner
 * @property {number} guests
 * @property {string | null} editor
 * @property {import('../server/protocol.js').SharingRequest[]} requests
 * @property {boolean} editRequested
 * @property {boolean} waiting for an owner's yes; nothing is on screen yet
 * @property {string | null} refusal why the owner sent us away; set, the socket stays closed
 */

/** @type {Session} */
const session = {
  id: "",
  socket: null,
  attempt: 0,
  retryTimer: null,
  reconnecting: false,
  model: 0,
  hostLocked: false,
  codePage: "bracket",
  chart: "",
  oversize: "",
  connection: "not-connected",
  connected: null,
  hostName: null,
  touched: false,
  lock: "",
  insert: false,
  typeahead: false,
  role: "controller",
  owner: false,
  guests: 0,
  editor: null,
  requests: [],
  editRequested: false,
  waiting: false,
  refusal: null,
};

let editOnJoinId = new URLSearchParams(location.search).has("requestEdit")
  ? location.hash.replace(/^#/, "")
  : null;

const prefix = new HintPrefix();

/** @type {{ row: number, col: number, letter: string }[]} */
let hints = [];

/** @returns {void} */
function syncSettings() {
  settings.model = session.model;
  settings.oversize = session.oversize;
  settings.connected = session.connected === true;
  settings.hostLocked = session.hostLocked;
}

/** @returns {void} */
function writeHash() {
  location.hash = session.id;
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
  localStorage.setItem("tn3270.host", host);
  send({ type: "connect", host });
}

/**
 * @param {string} filename
 * @param {string} content
 * @returns {void}
 */
function downloadFile(filename, content) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const settings = new Settings((values) => {
  saveSettings(values).catch((cause) => {
    showError("E5004", "Settings could not be saved on the server.", cause);
  });
});

const keymap = new Keymap((bindings) => {
  saveKeymap(bindings).catch((cause) => {
    showError("E5011", "The keymap could not be saved on the server.", cause);
  });
});

const macros = new Macros({
  dispatch: (message) => sendUnrecorded(message),
  persist: (values) => {
    saveMacros(values).catch((cause) => {
      showError("E5009", "Macros could not be saved on the server.", cause);
    });
  },
  keymap,
});

const recorder = new Recorder({
  dispatch: (message) => sendUnrecorded(message),
  exportFile: downloadFile,
  persist: (values) => {
    saveRecordings(values).catch((cause) => {
      showError("E5028", "Recordings could not be saved on the server.", cause);
    });
  },
});

const capture = new ComboCapture();
const lone = new LoneModifier();

// The settings title reads it when opened, so the page needn't wait for it.
let revision = "unknown";
fetch("./api/version")
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((body) => {
    if (typeof body.revision === "string") revision = body.revision;
  })
  .catch(() => {});

const panels = new Panels({
  settings,
  revision: () => revision,
  codePage: () => session.codePage,
  chart: () => session.chart,
  keymap,
  macros,
  recorder,
  redraw,
  applyTheme,
  applyFont,
  applyFieldBackground: (enabled) => {
    screen.fieldBackground = enabled;
    redraw();
  },
  applyModel: (model) => send({ type: "model", model }),
  applyOversize: (value) => send({ type: "oversize", value }),
  windowFit: (fontSize) => paneFit(fontSize),
  connect: connectHost,
  importRecording: () => importInput.click(),
  listSessions,
  joinSession: (id, requestEdit = false) => {
    window.open(
      `./${requestEdit ? "?requestEdit=1" : ""}#${id}`,
      "_blank",
      "noopener",
    );
  },
  ownsSession: (id) =>
    session.id === id &&
    session.owner &&
    sessionStorage.getItem(`tn3270.pass.${id}`) !== null,
  terminateSession: (id) =>
    terminateSession(id, sessionStorage.getItem(`tn3270.pass.${id}`) ?? ""),
  logon: (user, password) =>
    logonRequest(
      session.id,
      sessionStorage.getItem(`tn3270.pass.${session.id}`) ?? "",
      user,
      password,
    ),
  insertCharacter: (character) => {
    deliver({ type: "text", value: character });
  },
});

importInput.addEventListener("change", async () => {
  const file = importInput.files?.[0];
  importInput.value = "";
  if (file === undefined) return;
  let content;
  try {
    content = await file.text();
  } catch (cause) {
    showError("E5031", "The recording file could not be read.", cause);
    screenEl.focus();
    return;
  }
  try {
    const recording = recorder.importRecording(content);
    panels.message = `Imported ${recording.name}`;
    redraw();
    screenEl.focus();
  } catch (cause) {
    showError(
      "E5030",
      `The recording could not be imported: ${String(cause)}`,
      cause,
    );
    screenEl.focus();
  }
});

/**
 * The colours are the browser's own now, so a theme change is a repaint and
 * nothing more: the server is not asked for the screen again.
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
}

/**
 * How big a screen the page would hold with text `fontSize` pixels tall.
 *
 * @param {number} fontSize
 * @returns {{ cols: number, rows: number } | null}
 */
function paneFit(fontSize) {
  return screen.cols === 0 ? null : boxFit(screen.page, fontSize);
}

/**
 * @param {{ width: number, height: number }} box
 * @param {number} fontSize
 * @returns {{ cols: number, rows: number } | null}
 */
function boxFit(box, fontSize) {
  if (box.width < 1 || box.height < 1) return null;

  // Never scale from the drawn size: a cell rounds up to whole pixels, so a
  // scaled fit would not agree with the next one.
  const cell = screen.measure(settings.font().family, fontSize);
  const cols = Math.floor(box.width / cell.width);
  // One row is the OIA, which this side paints and the host knows nothing about.
  const rows = Math.floor(box.height / cell.height) - 1;
  if (cols < 1 || rows < 1) return null;
  return { cols, rows };
}

/**
 * What the session should start at. Asked for in the request that creates it,
 * so the first screen is already the right size and the host is never dropped
 * to resize it.
 *
 * @returns {{ model?: number, oversize?: string }}
 */
function startingSize() {
  /** @type {{ model?: number, oversize?: string }} */
  const size = {};
  const model = settings.values.model;
  if (model !== null) size.model = model;
  if (settings.values.screenSize === null) return size;

  const oversize = modeOversize(settings.values.screenSize);
  if (oversize !== null) {
    size.oversize = oversize;
    return size;
  }
  const page = { width: screenEl.clientWidth, height: screenEl.clientHeight };
  const fit = boxFit(page, settings.values.fitFontSize);
  if (fit !== null)
    size.oversize = settings.fitSize(fit, model ?? settings.model);
  return size;
}

/**
 * Only an untouched session: refitting a live one would lose the host's
 * cursor, since changing the oversize drops and reopens the host connection.
 *
 * @returns {void}
 */
function fitIdleSession() {
  if (!settings.fitsWindow()) return;
  if (session.connected === true && session.touched) return;
  const fit = paneFit(settings.values.fitFontSize);
  if (fit === null) return;
  const value = settings.fitSize(fit, session.model);
  if (value === session.oversize) return;
  sendQuietly({ type: "oversize", value });
}

// Coalesced into a frame: a drag fires this continuously.
let fitScheduled = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let settleTimer;
const resizeObserver = new ResizeObserver(() => {
  if (!fitScheduled) {
    fitScheduled = true;
    requestAnimationFrame(() => {
      fitScheduled = false;
      applyLayout();
    });
  }
  // A refit costs a host round trip, so wait for the drag to settle.
  clearTimeout(settleTimer);
  settleTimer = setTimeout(fitIdleSession, 400);
});

/**
 * Typing goes to an open panel's host, the same messages the server gets.
 *
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {void}
 */
function deliver(message) {
  if (panels.isOpen()) panels.receive(message);
  else send(message);
}

/**
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {void}
 */
function send(message) {
  macros.record(message);
  sendUnrecorded(message);
}

/**
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {void}
 */
function sendUnrecorded(message) {
  if (!sendQuietly(message)) {
    showError("E5002", "Not connected to the server; your input was not sent.");
  }
}

/**
 * For messages nobody asked for by hand, where a closed socket is routine.
 *
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {boolean} whether it went out
 */
function sendQuietly(message) {
  const socket = session.socket;
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

/** @returns {void} */
function connectSocket() {
  // Relative to the document, so a reverse proxy can mount us under a path.
  const url = new URL(`./ws/${session.id}`, document.baseURI);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // Per tab and never in the fragment, so sharing the URL does not share it.
  const pass = sessionStorage.getItem(`tn3270.pass.${session.id}`);
  if (pass !== null) url.searchParams.set("pass", pass);
  url.searchParams.set("tab", TAB_ID);

  const ws = new WebSocket(url.href);
  session.socket = ws;

  ws.addEventListener("message", (event) => {
    try {
      const frame = JSON.parse(String(event.data));
      for (const message of Array.isArray(frame) ? frame : [frame])
        handleServerMessage(message);
    } catch (cause) {
      showError(
        "E5037",
        "The server sent a message this page could not read.",
        cause,
      );
    }
  });

  // A failed connect fires error then close; close decides the retry.
  ws.addEventListener("error", () => {
    console.warn("[E5002] WebSocket connection to server failed");
  });

  ws.addEventListener("close", (event) => {
    session.socket = null;
    if (event.reason === "E3015") {
      session.refusal = "[E3015] Session terminated by its owner";
      showError("E3015", "The session was terminated by its owner.");
      return;
    }
    if (event.reason === "E3001") {
      showError("E3001", "The session is gone; starting a new one.");
      startFreshSession();
      return;
    }
    // Coming back on our own would only ask again after a no.
    if (session.refusal !== null) return;
    session.reconnecting = true;
    session.connection = "Server disconnected";
    session.connected = false;
    syncSettings();
    redraw();
    if (event.reason === "E6010")
      showError("E6010", "This viewer fell behind the screen; reconnecting.");
    else showError("E5002", "Connection to server lost. Reconnecting...");
    scheduleReconnect();
  });
}

/** @returns {void} */
function scheduleReconnect() {
  const delay = backoffDelay(session.attempt);
  session.attempt += 1;
  session.retryTimer = setTimeout(reconnect, delay);
}

/** @returns {void} */
function reconnect() {
  session.retryTimer = null;
  connectSocket();
}

// A tab that was offline missed what other tabs saved meanwhile. Recordings
// are left out: they can be megabytes, and only change when told.
window.addEventListener("focus", () => {
  reloadUserData("settings");
  reloadUserData("keymap");
  reloadUserData("macros");
});

// A hidden tab's timers are throttled to once a minute, so the backoff wait
// can outlast the outage by far; coming back should not sit through it.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (session.retryTimer === null) return;
  console.info(`[reconnect] session ${session.id}: tab visible, retrying now`);
  clearTimeout(session.retryTimer);
  reconnect();
});

/** @returns {Promise<void>} */
async function startFreshSession() {
  /** @type {{ id: string, rows: number, cols: number }} */
  let created;
  try {
    created = await createSession();
  } catch (cause) {
    if (cause instanceof TypeError)
      showError("E5002", "Connection to server lost. Reconnecting...", cause);
    else
      showError(
        "E5014",
        `The session could not be restarted: ${String(cause)}`,
        cause,
      );
    scheduleReconnect();
    return;
  }
  session.id = created.id;
  screen.resize(created.cols, created.rows);
  writeHash();
  connectSocket();
}

/**
 * @param {import('../server/protocol.js').ServerMessage} message
 * @returns {void}
 */
function handleServerMessage(message) {
  // A refused attach closes without a hello, so hello is the success signal.
  if (message.type === "hello") {
    session.attempt = 0;
    session.waiting = false;
    session.owner = message.owner;
    sessionStorage.setItem(`tn3270.pass.${session.id}`, message.pass);
    if (session.reconnecting) {
      // Reload rather than resume: the server may now serve newer page code.
      session.reconnecting = false;
      location.reload();
      return;
    }
  }

  if (message.type === "waiting" || message.type === "refused") {
    session.waiting = message.type === "waiting";
    if (message.type === "refused") {
      console.error(`[${message.code}] ${message.message}`);
      session.refusal = `[${message.code}] ${message.message}`;
    }
    // No hello has told us a size, but the status row needs a screen to sit under.
    if (screen.cols === 0) screen.resize(80, 24);
    applyLayout();
    return;
  }
  if (message.type === "screen") {
    session.model = message.model;
    session.oversize = message.oversize;
    screen.resize(message.cols, message.rows);
    syncSettings();
    applyLayout();
    return;
  }
  if (message.type === "hello") {
    session.model = message.model;
    session.codePage = message.codePage;
    session.chart = message.chart;
    session.oversize = message.oversize;
    screen.resize(message.cols, message.rows);
    session.hostLocked = message.hostLocked;
    session.role = message.role;
    syncSettings();
    applyLayout();
    screenEl.focus();
    if (session.id === editOnJoinId) {
      editOnJoinId = null;
      const url = new URL(location.href);
      url.searchParams.delete("requestEdit");
      history.replaceState(null, "", url.href);
      if (message.role === "observer") sendUnrecorded({ type: "askEdit" });
    }
    return;
  }
  if (message.type === "logon") {
    console.error(`[${message.code}] ${message.message}`);
    panels.openLogon(`[${message.code}] ${message.message}`);
    return;
  }
  if (message.type === "recorderStep") {
    recorder.record(message.step);
    if (panels.isOpen()) redraw();
    return;
  }
  if (message.type === "recorderStopped") {
    // Another viewer's recording ends here too, and is none of this tab's.
    if (recorder.stopping) {
      recorder.stopped();
      redraw();
    }
    return;
  }
  if (message.type === "userdata") {
    console.info("another tab saved", message.key);
    reloadUserData(message.key);
    return;
  }
  if (message.type === "paint") {
    // Even behind a panel: the grid underneath is what closing it puts back.
    screen.applyHostPaint(message);
    redraw();
    return;
  }
  if (message.type === "status") {
    const changed = session.connected !== message.connected;
    session.connection = message.connection;
    session.connected = message.connected;
    session.hostName = message.host;
    session.touched = message.touched;
    session.lock = message.lock;
    session.insert = message.insert;
    session.typeahead = message.typeahead;
    session.role = message.role;
    session.owner = message.owner;
    session.guests = message.guests;
    session.editor = message.editor;
    session.requests = message.requests;
    session.editRequested = message.editRequested;
    redraw();
    syncSettings();
    // The emulator reports the host without its port, so never overwrite a typed one.
    if (message.host !== null && settings.host === "" && !settings.hostLocked)
      settings.host = message.host;
    if (changed && panels.stack.at(-1)?.id !== "size") {
      if (message.connected) {
        panels.close();
        clearError();
      } else {
        panels.open("settings");
      }
    }
    return;
  }
  // A refused change leaves the page showing a size never accepted.
  syncSettings();
  showError(message.code, message.message);
}

/**
 * Shows what is saved for `key` now, which another tab may have changed. A
 * session already running keeps its size; the model and screen size are for
 * the next one.
 *
 * @param {import('../server/userdata.js').UserDataKey} key
 * @returns {Promise<void>}
 */
async function reloadUserData(key) {
  /** @type {unknown} */
  let value;
  try {
    value = await reload(key);
  } catch (cause) {
    showError(
      "E5046",
      `What another tab saved could not be read: ${String(cause)}`,
      cause,
    );
    return;
  }
  if (value === undefined) return;
  console.info("user data changed elsewhere", key);
  if (key === "settings") {
    settings.restoreSaved(
      /** @type {Partial<import('./store.js').StoredSettings>} */ (value),
    );
    applyTheme(settings.theme());
    screen.fieldBackground = settings.values.fieldBackground;
    await applyFont(settings.font());
  } else if (key === "keymap")
    keymap.setBindings(/** @type {import('./keymap.js').Bindings} */ (value));
  else if (key === "macros")
    macros.load(/** @type {import('./macros.js').Macro[]} */ (value));
  else
    recorder.recordings = /** @type {import('./recorder.js').Recording[]} */ (
      value
    );
  redraw();
}

/**
 * Everything that decides where a cell lands on the canvas, in one pass: how
 * big the screen is, how big its text has to be to fill the page, and then the
 * frame. A resize and a new screen size both come through here, so neither can
 * leave the two disagreeing.
 *
 * @returns {void}
 */
function applyLayout() {
  screen.layout(
    { width: screenEl.clientWidth, height: screenEl.clientHeight },
    settings.font().family,
    settings.values.forceMaxFontSize ? settings.values.fitFontSize : undefined,
  );
  redraw();
}

/**
 * @param {string} letter
 * @returns {void}
 */
function jumpToHint(letter) {
  const hint = hints.find((entry) => entry.letter === letter);
  if (hint === undefined) return;
  /** @type {import('../server/protocol.js').ActionMessage} */
  const move = {
    type: "action",
    action: "MoveCursor1",
    args: [String(hint.row + 1), String(hint.col + 1)],
  };
  deliver(move);
}

const SHARING_COMMANDS = new Set([
  "AnswerYes",
  "AnswerNo",
  "AskEdit",
  "StopSharing",
  "StopEditing",
]);

window.addEventListener(
  "keydown",
  (event) => {
    lone.keydown(event);
    const sharingCommand = commandForEvent(event, keymap.lookup());
    if (sharingCommand !== null && SHARING_COMMANDS.has(sharingCommand)) {
      const request = session.requests[0];
      const available =
        ((sharingCommand === "AnswerYes" || sharingCommand === "AnswerNo") &&
          request !== undefined) ||
        (sharingCommand === "AskEdit" &&
          session.role === "observer" &&
          !session.editRequested &&
          !session.waiting) ||
        (sharingCommand === "StopSharing" &&
          session.owner &&
          session.guests > 0) ||
        (sharingCommand === "StopEditing" &&
          session.owner &&
          session.editor !== null);
      if (session.refusal === null && available) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (
          request !== undefined &&
          (sharingCommand === "AnswerYes" || sharingCommand === "AnswerNo")
        )
          answerRequest(request, sharingCommand === "AnswerYes");
        else if (sharingCommand === "AskEdit")
          sendUnrecorded({ type: "askEdit" });
        else if (sharingCommand === "StopSharing")
          sendUnrecorded({ type: "stopSharing" });
        else if (sharingCommand === "StopEditing")
          sendUnrecorded({ type: "stopEditing" });
        return;
      }
    }
    if (panels.isRecordingPlayback()) {
      event.preventDefault();
      event.stopPropagation();
      const mapped = mapKey(event, keymap.lookup());
      panels.playbackKey(
        mapped?.kind === "action" && mapped.action === "Enter"
          ? "HostEnter"
          : event.key,
      );
      return;
    }
    if (
      panels.isMacroEditor() &&
      event.code === "F5" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (panels.macroCapture) panels.exitMacroCapture();
      else panels.back();
      return;
    }
    if (panels.capturingMacro()) {
      const picked = macroInputForEvent(event, keymap.lookup());
      event.preventDefault();
      event.stopPropagation();
      if (picked?.kind === "text" || picked?.kind === "action")
        panels.captureMacro(picked);
      return;
    }
    const decision = prefix.handleKey(
      event,
      hints.map((hint) => hint.letter),
    );
    if (decision.action !== "ignore") {
      event.preventDefault();
      event.stopPropagation();
      if (decision.action === "arm") {
        if (screen.cols === 0) hints = [];
        else if (panels.isOpen())
          hints = panels.hints(screen.rows, screen.cols);
        else hints = computeHints(screen.host.cells, screen.host.cols);
        redraw();
        return;
      }
      // The bar comes off first: a hint or a cancel draws nothing after it.
      clearError();
      redraw();
      if (decision.action === "hint") jumpToHint(decision.letter);
      return;
    }
    // In a key field the key is what is being picked, even a panel shortcut.
    if (panels.isOpen() && panels.capturing()) {
      const picked = capture.keydown(event, keymap.lookup());
      if (picked !== null) {
        event.preventDefault();
        event.stopPropagation();
        if (picked !== "held") panels.capture(picked);
        return;
      }
    }
    // A panel command opens its panel from anywhere, including from another panel.
    const command = sharingCommand;
    if (command === "ToggleKeyboard" || command === "ToggleRecording") {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (command === "ToggleKeyboard") toggleKeyboard();
      else toggleRecording();
      return;
    }
    if (command === "OpenChars") {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) panels.openChars();
      return;
    }
    const wanted = command === null ? undefined : PANEL_COMMANDS[command];
    if (wanted !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      panels.toggle(wanted);
    }
  },
  true,
);

// Only a modifier's keyup says it was pressed alone: to bind it in a key field,
// or to run what it is bound to, as the keydown it was.
window.addEventListener(
  "keyup",
  (event) => {
    const picked =
      panels.isOpen() && panels.capturing() ? capture.keyup(event) : null;
    if (picked !== null) {
      event.preventDefault();
      panels.capture(picked);
      return;
    }
    const down = lone.keyup(event);
    if (down === null || event.target === null) return;
    const replay = new KeyboardEvent("keydown", {
      key: down.key,
      code: down.code,
      ctrlKey: down.ctrlKey,
      shiftKey: down.shiftKey,
      altKey: down.altKey,
      bubbles: true,
      cancelable: true,
    });
    event.target.dispatchEvent(asReleased(replay));
  },
  true,
);

/** @type {Readonly<Record<string, { row: number, col: number }>>} */
const SELECT_STEPS = Object.freeze({
  SelectUp: { row: -1, col: 0 },
  SelectDown: { row: 1, col: 0 },
  SelectLeft: { row: 0, col: -1 },
  SelectRight: { row: 0, col: 1 },
});

screenEl.addEventListener(
  "keydown",
  (event) => {
    clearError();

    const mapped = mapKey(event, keymap.lookup());
    if (mapped === null) return;
    if (mapped.kind === "client" && SHARING_COMMANDS.has(mapped.command))
      return;
    // Left alone, Ctrl+V and Shift+Insert become a paste event, which reads the
    // clipboard without the prompt navigator.clipboard.readText() needs: once
    // in Chrome, on every paste in Firefox. Firefox pastes only into a text
    // field, so one takes the focus until the paste arrives.
    const browserPastes =
      (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "v") ||
      (event.shiftKey && !event.ctrlKey && event.code === "Insert");
    if (
      mapped.kind === "client" &&
      mapped.command === "Paste" &&
      !event.altKey &&
      browserPastes
    ) {
      pasteTarget.focus();
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const panel = panels.isOpen();

    if (mapped.kind === "text") {
      deliver({ type: "text", value: mapped.value });
      return;
    }
    if (mapped.kind === "action") {
      deliver({
        type: "action",
        action: mapped.action,
        args: mapped.args,
        repeat: mapped.repeat,
      });
      return;
    }

    if (mapped.command === "RepeatRecording") {
      if (panel) return;
      const recording = recorder.recordings.at(-1);
      if (
        recording === undefined ||
        !macros.playRecording(recording, event.repeat)
      )
        showError("E5040", "There is no saved recording to repeat.");
      return;
    }

    if (isMacroCommand(mapped.command)) {
      const macro = macros.macroFor(mapped.command);
      if (panel || event.repeat) return;
      if (macro !== null) macros.play(macro);
      return;
    }

    const step = SELECT_STEPS[mapped.command];
    if (step !== undefined) {
      screen.stepSelection(step.row, step.col);
      redraw();
      return;
    }

    // Copy, Cut and Paste are this browser's clipboard, not 3270 actions, so
    // keymap.js maps them but cannot dispatch them.
    if (mapped.command === "Copy" || mapped.command === "Cut") {
      const cut = mapped.command === "Cut";
      const grid = panel ? panels.host.grid() : screen.host;
      const box = screen.selectionBox();
      if (box !== null) {
        navigator.clipboard.writeText(screen.getSelection());
        if (!cut || grid === null) return;
        // Last run first: a Delete pulls the rest of its field left, over
        // cells that would otherwise still have to be cut.
        for (let row = box.bottom; row >= box.top; row--) {
          let end = box.right;
          while (end >= box.left) {
            if (!grid.cellAt(row, end)?.editable) {
              end--;
              continue;
            }
            let start = end;
            while (start > box.left && grid.cellAt(row, start - 1)?.editable)
              start--;
            deliver({
              type: "action",
              action: "MoveCursor1",
              args: [String(row + 1), String(start + 1)],
            });
            for (let col = start; col <= end; col++)
              deliver({ type: "action", action: "Delete", args: [] });
            end = start - 1;
          }
        }
        screen.clearSelection();
        redraw();
        return;
      }
      const cursor = grid?.cursor ?? null;
      const text =
        grid === null || cursor === null
          ? null
          : grid.fieldText(cursor.row, cursor.col);
      if (text === null) return;
      navigator.clipboard.writeText(text);
      if (cut) deliver({ type: "action", action: "DeleteField", args: [] });
      return;
    }
    // The panel commands are the other client commands, and the window handler
    // claims those before this one ever runs.
    if (mapped.command !== "Paste") return;
    // Ctrl+V and Shift+Insert arrive as a paste event instead; every other
    // binding must read the clipboard itself.
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text === "") return;
        deliver({ type: "paste", text });
      })
      .catch((cause) => {
        showError(
          "E5005",
          `The clipboard could not be read; Ctrl+V and Shift+Insert paste without asking: ${String(cause)}`,
          cause,
        );
      });
  },
  true,
);

/**
 * The wheel and the mouse buttons are bound like keys: each turn or click is a
 * keydown of its own name, so a key field in the Keys panel picks it up too.
 *
 * @param {string} name a combo's key, e.g. "WheelUp" or "MiddleClick"
 * @param {MouseEvent} event
 * @returns {boolean} whether something took it
 */
function pressMouseKey(name, event) {
  const keyEvent = new KeyboardEvent("keydown", {
    key: name,
    code: name,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    bubbles: true,
    cancelable: true,
  });
  return !screenEl.dispatchEvent(keyEvent);
}

screenEl.addEventListener(
  "wheel",
  (event) => {
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const delta = sideways ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    const name = sideways
      ? delta < 0
        ? "WheelLeft"
        : "WheelRight"
      : delta < 0
        ? "WheelUp"
        : "WheelDown";
    if (pressMouseKey(name, event)) event.preventDefault();
  },
  { passive: false },
);

// The paste comes before the keyup, unless there was nothing to paste.
pasteTarget.addEventListener("keyup", () => screenEl.focus());

/** Text pastes the browser made itself, so a middle click can tell it pasted. */
let textPastes = 0;

// Capture: the keydown handler above would otherwise see Ctrl+V twice.
screenEl.addEventListener(
  "paste",
  (event) => {
    event.preventDefault();
    event.stopPropagation();
    screenEl.focus();
    clearError();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text === "") return;
    textPastes++;
    if (panels.capturingMacro()) return;
    if (panels.isOpen()) panels.receive({ type: "paste", text });
    else send({ type: "paste", text });
  },
  true,
);

/**
 * @param {MouseEvent} event
 * @returns {void}
 */
function canvasClicked(event) {
  screenEl.focus();
  const name = MOUSE_BUTTONS[event.button];
  const hit = screen.cellAt(event.clientX, event.clientY);
  if (name === undefined || hit === null) return;
  const { row, col } = hit;
  /** @type {import('../server/protocol.js').ActionMessage} */
  const moveCursor = {
    type: "action",
    action: "MoveCursor1",
    args: [String(row + 1), String(col + 1)],
  };

  // Middle and right only move the cursor and run their binding; the buttons,
  // links and panel lists drawn on the canvas answer the left one alone.
  if (name !== "LeftClick") {
    if (row < 0 || row >= screen.rows || col < 0 || col >= screen.cols) return;
    if (!panels.isOpen()) sendUnrecorded(moveCursor);
    else if (panels.isRecordingPlayback()) return;
    // In a key field the click is the key being picked, not a move away.
    else if (!panels.capturing()) panels.receive(moveCursor);
    if (name !== "MiddleClick") {
      pressMouseKey(name, event);
      return;
    }
    // Firefox on Linux pastes the selection on a middle click, just after
    // this; then the click has pasted, and reading the clipboard as well
    // would paste twice and show Firefox's paste prompt.
    const pastesBefore = textPastes;
    setTimeout(() => {
      if (textPastes === pastesBefore) pressMouseKey(name, event);
      else console.info("the browser pasted the middle click itself");
    }, 0);
    return;
  }

  if (row === screen.statusRow) {
    const button = statusButtons(screen.cols).find(
      (each) => col >= each.col && col < each.col + each.label.length,
    );
    if (button !== undefined) {
      button.press();
      return;
    }
  }

  if (row < 0 || row >= screen.rows || col < 0 || col >= screen.cols) return;
  if (keyboardShown) {
    const keys = keyboardKeys();
    if (keys.some((key) => key.row === row)) {
      const key = keyAt(keys, row, col);
      if (key !== null) {
        if (key.action === "OpenChars") panels.openChars();
        else if (panels.isRecordingPlayback()) {
          const name =
            key.action === "PF"
              ? `F${key.args[0]}`
              : key.action === "Enter"
                ? "HostEnter"
                : key.action;
          panels.playbackKey(name);
        } else deliver({ type: "action", action: key.action, args: key.args });
      }
      return;
    }
  }
  if (panels.isOpen()) {
    if (panels.isCharacterPicker() && panels.chooseCharacterAt(row, col))
      return;
    if (panels.isRecordingPlayback()) {
      panels.playbackClick(row, col);
      return;
    }
    if (panels.pickingMacroCursor() && row >= 3 && row < screen.statusRow) {
      panels.addMacroCursorMove(row, col);
      return;
    }
    // Not LeftClick's binding: a click into a key field would be picked as the key.
    panels.receive(moveCursor);
    return;
  }

  // A click ending a drag was aiming at the selection.
  if (screen.hasSelection()) return;
  const url = screen.linkAt(row, col);
  if (url !== null) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  sendUnrecorded(moveCursor);
  pressMouseKey(name, event);
}

/** @type {Readonly<Record<number, string>>} `MouseEvent.button` to a combo's key */
const MOUSE_BUTTONS = Object.freeze({
  0: "LeftClick",
  1: "MiddleClick",
  2: "RightClick",
});

// The font has to be loaded before the first canvas, or the first screen is
// measured in the wrong face and fitted to the wrong size. Recordings are not
// needed for it, and can be megabytes, so they arrive while it is drawn.
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
    saved.reason,
  );
if (savedMacros.status === "fulfilled") macros.load(savedMacros.value);
else
  showError(
    "E5008",
    `Saved macros could not be read: ${String(savedMacros.reason)}`,
    savedMacros.reason,
  );
if (savedKeymap.status === "fulfilled") keymap.setBindings(savedKeymap.value);
else
  showError(
    "E5013",
    `Saved keymap could not be read; using the defaults: ${String(savedKeymap.reason)}`,
    savedKeymap.reason,
  );
loadRecordings().then(
  (value) => recorder.load(value),
  (reason) =>
    showError(
      "E5029",
      `Saved recordings could not be read: ${String(reason)}`,
      reason,
    ),
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
    fieldBackground: settings.values.fieldBackground,
    redraw,
  });
} catch (cause) {
  console.error("[E5001] The renderer failed to start", cause);
  screenEl.style.color = "#ffd9d9";
  screenEl.style.padding = "1rem";
  screenEl.textContent = `[E5001] The renderer failed to start: ${String(cause)}`;
  throw cause;
}
resizeObserver.observe(screenEl);
function watchScale() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    "change",
    () => {
      applyLayout();
      watchScale();
    },
    { once: true },
  );
}
watchScale();
canvasEl.addEventListener("click", canvasClicked);
canvasEl.addEventListener("auxclick", canvasClicked);
// The right button is the terminal's, and a held middle one would scroll.
canvasEl.addEventListener("contextmenu", (event) => event.preventDefault());
canvasEl.addEventListener("mousedown", (event) => {
  if (event.button === 1) event.preventDefault();
});
screenEl.style.background = settings.theme().colors.background;

const storedHost = localStorage.getItem("tn3270.host");
if (storedHost !== null) settings.host = storedHost;

// A session that is gone is found out by the socket, which starts a new one.
session.id = location.hash.replace(/^#/, "").trim();

let startupFailed = false;
if (session.id === "") {
  try {
    const created = await createSession();
    session.id = created.id;
    screen.resize(created.cols, created.rows);
  } catch (cause) {
    startupFailed = true;
    console.error(
      "[E5038] The first terminal session could not be opened",
      cause,
    );
  }
}
if (startupFailed) {
  screenEl.style.color = "#ffd9d9";
  screenEl.style.padding = "1rem";
  screenEl.textContent =
    "[E5038] The first terminal session could not be opened. Reload to try again.";
} else {
  writeHash();
  applyLayout();
  connectSocket();
}
