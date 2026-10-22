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
import { TransferFailed, Transfers } from "./transfers.js";
import {
  createSessionRequest,
  listSessions,
  terminateSession,
  logonRequest,
} from "./session-api.js";
import { HintPrefix, computeHints } from "./hints.js";
import {
  MAX_SESSIONS,
  paneBox,
  paneShares,
  parseSessionHash,
  sessionHash,
  sessionKey,
} from "./sessions.js";

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

// The page's markup is fixed: `index.html` has a canvas for every session, and
// nothing here ever builds, moves or removes an element.
const paneCanvases = Array.from({ length: MAX_SESSIONS }, (_, index) => {
  const canvas = element(`pane-${index + 1}`);
  if (!(canvas instanceof HTMLCanvasElement))
    throw new Error(`#pane-${index + 1} is not a canvas`);
  return canvas;
});
const pasteTarget = element("paste-target");
const importInput = element("recording-import");
if (!(importInput instanceof HTMLInputElement))
  throw new Error("#recording-import is not a file input");

/**
 * One canvas per session slot, and every frame is drawn whole — see
 * `redraw()`, which is the only way one happens.
 *
 * @type {Screen[]}
 */
let screens = [];

/** Whether the on-screen keyboard is drawn over the screen. */
let keyboardShown =
  new URLSearchParams(location.search).get("keyboard") === "1";

/**
 * The panels the address had on show, waiting for the session's first status:
 * that status opens or closes panels itself, so restoring sooner is undone.
 *
 * @type {string[] | null}
 */
let addressPanels = new URLSearchParams(location.search).getAll("panel");

/**
 * The address says which panels and whether the keyboard are on show, so a
 * reload or a shared link comes back to the same place.
 *
 * @returns {void}
 */
function writeAddress() {
  const url = new URL(location.href);
  url.searchParams.delete("panel");
  url.searchParams.delete("keyboard");
  for (const id of addressPanels ?? panels.stack.map((frame) => frame.id))
    url.searchParams.append("panel", id);
  if (keyboardShown) url.searchParams.set("keyboard", "1");
  // Some browsers throttle replaceState, so only a real change is written.
  if (url.href !== location.href) history.replaceState(null, "", url.href);
}

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
 * @param {Session} slot
 * @param {number} cols
 * @returns {StatusButton[]}
 */
function statusButtons(slot, cols) {
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
  const request = slot.requests[0];
  if (slot.refusal !== null || slot.waiting) {
    // Nothing to share and nothing to ask for.
  } else if (request !== undefined) {
    wanted.push({
      label: statusLabel("AnswerNo", "No"),
      press: () => answerRequest(slot, request, false),
    });
    wanted.push({
      label: statusLabel("AnswerYes", "Yes"),
      press: () => answerRequest(slot, request, true),
    });
  } else if (slot.owner) {
    if (slot.editor !== null)
      wanted.push({
        label: statusLabel("StopEditing", "X edit"),
        press: () => sendTo(slot, { type: "stopEditing" }),
      });
    if (slot.guests > 0)
      wanted.push({
        label: statusLabel("StopSharing", "X shr"),
        press: () => sendTo(slot, { type: "stopSharing" }),
      });
  } else if (slot.role === "observer" && !slot.editRequested) {
    wanted.push({
      label: statusLabel("AskEdit", "Edit"),
      press: () => sendTo(slot, { type: "askEdit" }),
    });
  }

  /** @type {StatusButton[]} */
  const placed = [];
  const cursor = slot.screen.overlay.cursor ??
    slot.screen.host.cursor ?? { row: 0, col: 0 };
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
  else {
    recordingSlot = session;
    recorder.start();
  }
  redraw();
}

/**
 * What the status row says instead of the OIA while sharing needs a word:
 * someone asking the owner, or this viewer waiting on one.
 *
 * @param {Session} slot
 * @returns {string | null}
 */
function sharingText(slot) {
  if (slot.refusal !== null) return slot.refusal;
  if (slot.waiting) return "Waiting for the session's owner to let you in";
  const request = slot.requests[0];
  if (request !== undefined) {
    const more =
      slot.requests.length > 1 ? ` (${slot.requests.length - 1} more)` : "";
    return request.kind === "watch"
      ? `${request.name} wants to watch${more}`
      : `${request.name} wants to edit${more}`;
  }
  if (slot.editRequested) return "Asked the owner to let you edit";
  return null;
}

/**
 * @param {Session} slot
 * @param {import('../server/protocol.js').SharingRequest} request
 * @param {boolean} allow
 * @returns {void}
 */
function answerRequest(slot, request, allow) {
  console.info("sharing request answered", { ...request, allow });
  sendTo(slot, { type: "answer", viewer: request.viewer, allow });
}

/** @returns {import('./screen-keyboard.js').PlacedKey[]} */
function keyboardKeys() {
  const screen = session.screen;
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
 * Everything this page draws over a session's screen: the panels' own host
 * screen across all of it, the status row under it, and then an error and the
 * hint letters on top. The host's own grid is never touched, so taking the
 * overlay off puts the screen back without asking the server for it again.
 *
 * @param {Session} slot
 * @returns {void}
 */
function drawChrome(slot) {
  const screen = slot.screen;
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
  const focused = slot === session;
  const panel = focused && panels.isOpen();
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
  const insert = panel ? panels.host.insert : slot.insert;
  // The one cursor on the page is where the keyboard types.
  screen.cursorStyle = !focused ? "hidden" : insert ? "underline" : "block";

  const style = paint(statusInk, statusBar);
  const loud = paint(statusInk, statusBar, true);
  const cursor = overlay.cursor ?? screen.host.cursor ?? { row: 0, col: 0 };
  const position = cursorPosition(cursor);
  const positionCol = screen.cols - position.length - 1;
  const buttons = statusButtons(slot, screen.cols);
  const buttonsStart = buttons.at(-1)?.col ?? positionCol - 1;
  // Browser zoom and OS display scaling together; the page cannot tell them apart.
  const scale = Math.round((window.devicePixelRatio || 1) * 100);
  const scaleText = scale === 100 ? "" : `Zoom ${scale}%`;
  const scaleCol = buttonsStart - scaleText.length - 1;
  const width = Math.max(0, (scaleText === "" ? buttonsStart : scaleCol) - 2);
  const said = sharingText(slot);
  overlay.put(bottom, 0, wide(""), style);
  if (panes.length > 1) overlay.put(bottom, 0, String(slot.index + 1), loud);
  if (said === null)
    overlay.put(
      bottom,
      1,
      renderOia({ ...oiaState(slot), insert }, null, width),
      style,
    );
  else overlay.put(bottom, 1, said.slice(0, width), loud);
  if (scaleText !== "") overlay.put(bottom, scaleCol, scaleText, loud);
  for (const button of buttons)
    overlay.put(bottom, button.col, button.label, loud);
  overlay.put(bottom, positionCol, position, style);

  // Everything below belongs to the session the keyboard is on.
  if (!focused) return;

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
 * The one way a frame happens. Every pane on screen gets its chrome rebuilt
 * from the current state and its canvas drawn again, so there is no such thing
 * as a half-updated screen — and nothing has to work out which part of it an
 * action touched.
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
      if (slot === null) continue;
      drawChrome(slot);
      slot.screen.render();
    }
    writeAddress();
  });
}

/**
 * A session with no pane on screen — a fourth one running a macro, say — still
 * takes its paints, but a frame it cannot appear in would be the same pixels.
 *
 * @param {Session} slot
 * @returns {boolean}
 */
function displayed(slot) {
  return panes.some((index) => sessions[index] === slot);
}

/**
 * @param {Session} slot
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

/**
 * An error from a session the keyboard is not on says which one it is.
 *
 * @param {Session} slot
 * @param {string} code
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {void}
 */
function slotError(slot, code, message, cause) {
  if (slot === session) showError(code, message, cause);
  else showError(code, `Session ${slot.index + 1}: ${message}`, cause);
}

/** @returns {void} */
function clearError() {
  if (activeError === null) return;
  activeError = null;
  if (errorTimer !== undefined) clearTimeout(errorTimer);
  redraw();
}

/**
 * @param {{ width: number, height: number }} box the pane it will be shown in
 * @returns {Promise<{ id: string, rows: number, cols: number }>}
 */
function createSession(box) {
  return createSessionRequest(startingSize(box));
}

/**
 * One of the host sessions this tab holds. Every one keeps its socket open,
 * shown or not, or the server reaps it.
 *
 * @typedef {object} Session
 * @property {string} id
 * @property {number} index its slot, Ctrl+1 being 0
 * @property {Screen} screen its slot's canvas
 * @property {Transfers} transfers the ones asked for on this session
 * @property {Map<number, string>} printJobs still arriving, by number
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

/**
 * @param {string} id
 * @param {number} index its slot
 * @returns {Session}
 */
function newSlot(id, index) {
  return {
    id,
    index,
    screen: screens[index],
    transfers: new Transfers({
      saveFile: (name, text) =>
        downloadFile(name, text, "text/plain;charset=utf-8"),
    }),
    printJobs: new Map(),
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
}

/** @type {(Session | null)[]} every slot Ctrl+1-4 reaches, open or not */
const sessions = /** @type {(Session | null)[]} */ (
  Array(MAX_SESSIONS).fill(null)
);

/**
 * The session the keyboard types into. Set before anything is drawn.
 *
 * @type {Session}
 */
let session;

/** @type {number[]} the slots on screen, in pane order */
let panes = [0];

/** @type {Session | null} the recording's session, whatever is on screen since */
let recordingSlot = null;

let editOnJoinId = new URLSearchParams(location.search).has("requestEdit")
  ? parseSessionHash(location.hash)[0]
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
  localStorage.setItem("tn3270.host", host);
  send({ type: "connect", host });
}

/**
 * @param {string} filename
 * @param {string} content
 * @param {string} [type]
 * @returns {void}
 */
function downloadFile(filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
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
  prepareTransfer: (step, sources) => {
    const prepared = session.transfers.prepare(step, sources);
    // A macro's transfer has no panel to show how it went, so the screen does.
    prepared.end.then(
      (said) => console.info("macro transfer done", said),
      (err) =>
        err instanceof TransferFailed
          ? showError(err.code, err.text)
          : showError("E5053", "The transfer failed", err),
    );
    return prepared;
  },
  persist: (values) => {
    saveMacros(values).catch((cause) => {
      showError("E5009", "Macros could not be saved on the server.", cause);
    });
  },
  keymap,
});

const recorder = new Recorder({
  dispatch: (message) => sendTo(recordingSlot ?? session, message),
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
    for (const screen of screens) screen.fieldBackground = enabled;
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
    sessions.some((slot) => slot?.id === id && slot.owner) &&
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
  transfer: (step) => {
    const slot = session;
    return slot.transfers.start(step, (message) => sendQuietly(message, slot));
  },
  cancelTransfer: () => sendQuietly({ type: "transferCancel" }),
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
  for (const screen of screens) screen.theme = theme.colors;
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
 * How big a screen the keyboard's pane would hold with text `fontSize` pixels
 * tall.
 *
 * @param {number} fontSize
 * @param {Session} [slot]
 * @returns {{ cols: number, rows: number } | null}
 */
function paneFit(fontSize, slot = session) {
  return slot.screen.cols === 0 ? null : boxFit(slot.screen.page, fontSize);
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
  const cell = screens[0].measure(settings.font().family, fontSize);
  const cols = Math.floor(box.width / cell.width);
  // One row is the OIA, which this side paints and the host knows nothing about.
  const rows = Math.floor(box.height / cell.height) - 1;
  if (cols < 1 || rows < 1) return null;
  return { cols, rows };
}

/**
 * What a session should start at. Asked for in the request that creates it,
 * so the first screen is already the right size and the host is never dropped
 * to resize it.
 *
 * @param {{ width: number, height: number }} box the pane it will be shown in
 * @returns {{ model?: number, oversize?: string }}
 */
function startingSize(box) {
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
  const fit = boxFit(box, settings.values.fitFontSize);
  if (fit !== null)
    size.oversize = settings.fitSize(fit, model ?? settings.model);
  return size;
}

/**
 * Only an untouched session: refitting a live one would lose the host's
 * cursor, since changing the oversize drops and reopens the host connection.
 * A touched one shrinks its text to fit its pane instead.
 *
 * @param {Session} slot
 * @returns {void}
 */
function fitIdleSession(slot) {
  if (!settings.fitsWindow()) return;
  if (slot.connected === true && slot.touched) return;
  const fit = paneFit(settings.values.fitFontSize, slot);
  if (fit === null) return;
  const value = settings.fitSize(fit, slot.model);
  if (value === slot.oversize) return;
  sendQuietly({ type: "oversize", value }, slot);
}

/** @returns {void} */
function fitIdleSessions() {
  for (const index of panes) {
    const slot = sessions[index];
    if (slot !== null) fitIdleSession(slot);
  }
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
  settleTimer = setTimeout(fitIdleSessions, 400);
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
 * @returns {boolean} whether it went out
 */
function sendUnrecorded(message) {
  return sendTo(session, message);
}

/**
 * @param {Session} slot
 * @param {import('../server/protocol.js').ClientMessage} message
 * @returns {boolean} whether it went out
 */
function sendTo(slot, message) {
  if (sendQuietly(message, slot)) return true;
  slotError(
    slot,
    "E5002",
    "Not connected to the server; your input was not sent.",
  );
  return false;
}

/**
 * For messages nobody asked for by hand, where a closed socket is routine.
 *
 * @param {import('../server/protocol.js').ClientMessage} message
 * @param {Session} [slot]
 * @returns {boolean} whether it went out
 */
function sendQuietly(message, slot = session) {
  const socket = slot.socket;
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

/**
 * @param {Session} slot
 * @returns {void}
 */
function connectSocket(slot) {
  // Relative to the document, so a reverse proxy can mount us under a path.
  const url = new URL(`./ws/${slot.id}`, document.baseURI);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // Per tab and never in the fragment, so sharing the URL does not share it.
  const pass = sessionStorage.getItem(`tn3270.pass.${slot.id}`);
  if (pass !== null) url.searchParams.set("pass", pass);
  url.searchParams.set("tab", TAB_ID);

  const ws = new WebSocket(url.href);
  slot.socket = ws;

  ws.addEventListener("message", (event) => {
    try {
      const frame = JSON.parse(String(event.data));
      for (const message of Array.isArray(frame) ? frame : [frame])
        handleServerMessage(slot, message);
    } catch (cause) {
      slotError(
        slot,
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
    slot.socket = null;
    slot.transfers.closed();
    if (event.reason === "E3015") {
      slot.refusal = "[E3015] Session terminated by its owner";
      slotError(slot, "E3015", "The session was terminated by its owner.");
      return;
    }
    if (event.reason === "E3001") {
      slotError(slot, "E3001", "The session is gone; starting a new one.");
      startFreshSession(slot);
      return;
    }
    // Coming back on our own would only ask again after a no.
    if (slot.refusal !== null) return;
    slot.reconnecting = true;
    slot.connection = "Server disconnected";
    slot.connected = false;
    syncSettings();
    redraw();
    if (event.reason === "E6010")
      slotError(
        slot,
        "E6010",
        "This viewer fell behind the screen; reconnecting.",
      );
    else slotError(slot, "E5002", "Connection to server lost. Reconnecting...");
    scheduleReconnect(slot);
  });
}

/**
 * @param {Session} slot
 * @returns {void}
 */
function scheduleReconnect(slot) {
  const delay = backoffDelay(slot.attempt);
  slot.attempt += 1;
  slot.retryTimer = setTimeout(() => reconnect(slot), delay);
}

/**
 * @param {Session} slot
 * @returns {void}
 */
function reconnect(slot) {
  slot.retryTimer = null;
  connectSocket(slot);
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
  for (const slot of sessions) {
    if (slot === null || slot.retryTimer === null) continue;
    console.info(`[reconnect] session ${slot.id}: tab visible, retrying now`);
    clearTimeout(slot.retryTimer);
    reconnect(slot);
  }
});

/**
 * @param {Session} slot
 * @returns {Promise<void>}
 */
async function startFreshSession(slot) {
  /** @type {{ id: string, rows: number, cols: number }} */
  let created;
  try {
    created = await createSession(slot.screen.page);
  } catch (cause) {
    if (cause instanceof TypeError)
      slotError(
        slot,
        "E5002",
        "Connection to server lost. Reconnecting...",
        cause,
      );
    else
      slotError(
        slot,
        "E5014",
        `The session could not be restarted: ${String(cause)}`,
        cause,
      );
    scheduleReconnect(slot);
    return;
  }
  slot.id = created.id;
  slot.screen.resize(created.cols, created.rows);
  writeHash();
  connectSocket(slot);
}

/**
 * @param {Session} slot the session whose socket it came in on
 * @param {import('../server/protocol.js').ServerMessage} message
 * @returns {void}
 */
function handleServerMessage(slot, message) {
  const focused = slot === session;
  const screen = slot.screen;
  // A refused attach closes without a hello, so hello is the success signal.
  if (message.type === "hello") {
    slot.attempt = 0;
    slot.waiting = false;
    slot.owner = message.owner;
    sessionStorage.setItem(`tn3270.pass.${slot.id}`, message.pass);
    if (slot.reconnecting) {
      // Reload rather than resume: the server may now serve newer page code.
      slot.reconnecting = false;
      location.reload();
      return;
    }
  }

  if (message.type === "waiting" || message.type === "refused") {
    slot.waiting = message.type === "waiting";
    if (message.type === "refused") {
      console.error(`[${message.code}] ${message.message}`);
      slot.refusal = `[${message.code}] ${message.message}`;
    }
    // No hello has told us a size, but the status row needs a screen to sit under.
    if (screen.cols === 0) screen.resize(80, 24);
    applyLayout();
    return;
  }
  if (message.type === "screen") {
    slot.model = message.model;
    slot.oversize = message.oversize;
    screen.resize(message.cols, message.rows);
    syncSettings();
    applyLayout();
    return;
  }
  if (message.type === "hello") {
    slot.model = message.model;
    slot.codePage = message.codePage;
    slot.chart = message.chart;
    slot.oversize = message.oversize;
    screen.resize(message.cols, message.rows);
    slot.hostLocked = message.hostLocked;
    slot.role = message.role;
    syncSettings();
    applyLayout();
    screenEl.focus();
    if (slot.id === editOnJoinId) {
      editOnJoinId = null;
      const url = new URL(location.href);
      url.searchParams.delete("requestEdit");
      history.replaceState(null, "", url.href);
      if (message.role === "observer") sendTo(slot, { type: "askEdit" });
    }
    return;
  }
  if (message.type === "logon") {
    console.error(`[${message.code}] ${message.message}`);
    // The logon panel logs on the session the keyboard is on.
    if (focused) panels.openLogon(`[${message.code}] ${message.message}`);
    else slotError(slot, message.code, message.message);
    return;
  }
  if (message.type === "recorderStep") {
    if (slot === recordingSlot) recorder.record(message.step);
    if (focused && panels.isOpen()) redraw();
    return;
  }
  if (message.type === "recorderStopped") {
    // Another viewer's recording ends here too, and is none of this tab's.
    if (slot === recordingSlot && recorder.stopping) {
      recorder.stopped();
      recordingSlot = null;
      redraw();
    }
    return;
  }
  if (message.type === "print") {
    const sofar = slot.printJobs.get(message.job) ?? "";
    slot.printJobs.set(message.job, sofar + message.text);
    return;
  }
  if (message.type === "printEnd") {
    const text = slot.printJobs.get(message.job);
    slot.printJobs.delete(message.job);
    // A tab that joined after the job's text went out has nothing to save.
    if (text === undefined) {
      console.warn("print job ended before this tab saw it", message.job);
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    console.info("print job downloaded", {
      job: message.job,
      chars: text.length,
    });
    downloadFile(
      `print-${stamp}-${message.job}.txt`,
      text,
      "text/plain;charset=utf-8",
    );
    return;
  }
  if (message.type === "download" || message.type === "transferEnd") {
    slot.transfers.received(message);
    return;
  }
  if (message.type === "userdata") {
    console.info("another tab saved", message.key);
    reloadUserData(message.key);
    return;
  }
  if (message.type === "paint") {
    // Even hidden, even behind a panel: the grid underneath is what showing
    // it again puts back.
    screen.applyHostPaint(message);
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
    slot.owner = message.owner;
    slot.guests = message.guests;
    slot.editor = message.editor;
    slot.requests = message.requests;
    slot.editRequested = message.editRequested;
    if (displayed(slot)) redraw();
    // An idle session is fitted to its pane again, which it may not have been.
    if (changed && !message.connected && displayed(slot)) fitIdleSession(slot);
    if (!focused) return;
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
    if (addressPanels !== null) {
      // A panel already open, like the logon, has something to say first.
      if (!panels.isOpen()) panels.restore(addressPanels);
      addressPanels = null;
      redraw();
    }
    return;
  }
  // A refused change leaves the page showing a size never accepted.
  syncSettings();
  slotError(slot, message.code, message.message);
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
    for (const screen of screens)
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

/** @returns {{ width: number, height: number }} what the panes share */
function pageSize() {
  return { width: screenEl.clientWidth, height: screenEl.clientHeight };
}

/**
 * Everything that decides where a cell lands, in one pass: which sessions are
 * on screen, how the page is split between them, how big their text has to be
 * to fit, and then the frame. A resize, a layout change and a new session all
 * come through here, so none of them can leave the three disagreeing.
 *
 * @returns {void}
 */
function applyLayout() {
  const page = pageSize();
  const shares = paneShares(panes.length);
  for (const [index, screen] of screens.entries()) {
    const pane = panes.indexOf(index);
    screen.canvas.hidden = pane === -1 || sessions[index] === null;
    if (screen.canvas.hidden) continue;
    screen.layout(
      paneBox(shares[pane], page),
      settings.font().family,
      settings.values.forceMaxFontSize
        ? settings.values.fitFontSize
        : undefined,
    );
  }
  redraw();
}

/**
 * Puts the keyboard on a session that is open, and on screen if it was not:
 * in the pane the keyboard was on.
 *
 * @param {number} index
 * @returns {void}
 */
function focusSlot(index) {
  const slot = sessions[index];
  if (slot === null || slot === session) return;
  console.info(`keyboard on session ${index + 1}`);

  // The panels belong to the pane that was being looked at.
  panels.close();
  session.screen.clearSelection();

  const moved = !panes.includes(index);
  if (moved) panes[Math.max(0, panes.indexOf(session.index))] = index;
  session = slot;
  syncSettings();
  if (moved) applyLayout();
  else redraw();
  screenEl.focus();

  if (slot.connection === "not-connected") panels.open("settings");
}

/** @type {boolean} One opening at a time; two fast keystrokes are one session. */
let opening = false;

/**
 * @param {number} index
 * @param {{ width: number, height: number }} box the pane it will be shown in
 * @returns {Promise<Session>}
 */
async function ensureSlot(index, box) {
  const existing = sessions[index];
  if (existing !== null) return existing;
  const created = await createSession(box);
  const slot = newSlot(created.id, index);
  slot.screen.resize(created.cols, created.rows);
  sessions[index] = slot;
  console.info("session opened", { slot: index + 1, id: created.id });
  writeHash();
  connectSocket(slot);
  return slot;
}

/**
 * Ctrl+1-4: the keyboard goes to that session, which is opened first if the
 * slot is empty.
 *
 * @param {number} index
 * @returns {Promise<void>}
 */
async function switchTo(index) {
  if (sessions[index] !== null) {
    focusSlot(index);
    return;
  }
  if (opening) return;
  opening = true;
  try {
    await ensureSlot(index, session.screen.page);
    focusSlot(index);
  } catch (cause) {
    showError(
      "E5059",
      `Another terminal session could not be opened: ${String(cause)}`,
      cause,
    );
  } finally {
    opening = false;
  }
}

/**
 * Ctrl+Shift+1-4: the page split into that many panes, sessions 1 to `count`
 * in them. Missing sessions are opened all at once: each costs a host startup.
 *
 * @param {number} count
 * @returns {Promise<void>}
 */
async function changeLayout(count) {
  if (opening) return;
  opening = true;
  console.info(`layout of ${count} panes`);
  const shares = paneShares(count);
  const page = pageSize();
  try {
    if (count > 1)
      await Promise.all(
        shares.map((share, index) => ensureSlot(index, paneBox(share, page))),
      );
    panes = count === 1 ? [session.index] : shares.map((_, index) => index);
    if (!panes.includes(session.index)) focusSlot(panes[0]);
    applyLayout();
    fitIdleSessions();
    screenEl.focus();
  } catch (cause) {
    showError(
      "E5060",
      `The sessions for that layout could not be opened: ${String(cause)}`,
      cause,
    );
  } finally {
    opening = false;
  }
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
    const picked = sessionKey(event);
    if (picked !== null && !panels.capturing()) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (picked.action === "switch") void switchTo(picked.index);
      else void changeLayout(picked.panes);
      return;
    }
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
          answerRequest(session, request, sharingCommand === "AnswerYes");
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
        const screen = session.screen;
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
      session.screen.stepSelection(step.row, step.col);
      redraw();
      return;
    }

    // Copy, Cut and Paste are this browser's clipboard, not 3270 actions, so
    // keymap.js maps them but cannot dispatch them.
    if (mapped.command === "Copy" || mapped.command === "Cut") {
      const cut = mapped.command === "Cut";
      const screen = session.screen;
      const grid = panel ? panels.host.grid() : screen.host;
      const box = screen.selectionBox();
      if (box !== null) {
        navigator.clipboard.writeText(screen.getSelection());
        // Last run first: a Delete pulls the rest of its field left, over
        // cells that would otherwise still have to be cut.
        if (cut && grid !== null)
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
 * A click on another session's pane puts the keyboard there first, and then
 * is a click in it.
 *
 * @param {number} index the slot whose canvas was clicked
 * @param {MouseEvent} event
 * @returns {void}
 */
function canvasClicked(index, event) {
  screenEl.focus();
  focusSlot(index);
  const screen = session.screen;
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
    const button = statusButtons(session, screen.cols).find(
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
  screens = paneCanvases.map(
    (canvas) =>
      new Screen({
        canvas,
        theme: settings.theme().colors,
        fieldBackground: settings.values.fieldBackground,
        redraw,
      }),
  );
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
for (const [index, canvas] of paneCanvases.entries()) {
  canvas.addEventListener("click", (event) => canvasClicked(index, event));
  canvas.addEventListener("auxclick", (event) => canvasClicked(index, event));
  // The right button is the terminal's, and a held middle one would scroll.
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("mousedown", (event) => {
    if (event.button === 1) event.preventDefault();
  });
}
screenEl.style.background = settings.theme().colors.background;

const storedHost = localStorage.getItem("tn3270.host");
if (storedHost !== null) settings.host = storedHost;

// A session that is gone is found out by its socket, which starts a new one.
for (const [index, id] of parseSessionHash(location.hash).entries())
  if (id !== null) sessions[index] = newSlot(id, index);
const joining = sessions.filter((slot) => slot !== null);

let startupFailed = false;
if (joining.length === 0) {
  try {
    await ensureSlot(0, pageSize());
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
  const first = sessions.findIndex((slot) => slot !== null);
  session = /** @type {Session} */ (sessions[first]);
  panes = [first];
  writeHash();
  applyLayout();
  for (const slot of joining) connectSocket(slot);
}
