// The page this one is framed in, when that is an editor holding a repo, such as
// VS Code's PL/I extension: it says which data set names on the screen are files
// in the repo, and opens them, and it may type on the session through REST. The
// messages are SPECIFICATION.md §4.2's.

// Looking up a repo the editor has only just opened can take seconds.
const RESOLVE_TIMEOUT_MS = 15000;
const OPEN_TIMEOUT_MS = 5000;

/** @type {string | null} the parent's origin, null while there is none to talk to */
let parentOrigin = null;
/** @type {Set<string>} the requests the parent answers */
let capabilities = new Set();
/** @type {Map<string, boolean>} data set name → whether it is in the repo */
const known = new Map();
/** @type {Set<string>} names asked about, not answered yet */
const asking = new Set();
/** Bumped when the repo changes, so an answer about the old one is dropped. */
let generation = 0;
/** @type {Map<number, (answer: Answer | null) => void>} */
const requests = new Map();
let nextId = 0;
/** @type {() => void} */
let changed = () => {};
/** @type {(code: string, message: string) => void} */
let error = () => {};
/** @type {() => string | null} */
let controlledSession = () => null;

/**
 * @typedef {{ result?: { found?: string[] }, error?: { code: string, message: string } }} Answer
 */

/**
 * Says hello to the parent, if it may hear what is on the screen: a VS Code
 * webview, or a page of this server's own. Any other site could frame the
 * page just to read the names off it.
 *
 * @param {{ changed: () => void, error: (code: string, message: string) => void, controlledSession: () => string | null }} hooks
 *   `changed` when names should be looked up again and the screens redrawn;
 *   `controlledSession` is the id of the session the keyboard is on, when
 *   this page may type on it
 * @returns {void}
 */
export function startEmbedder(hooks) {
  if (window.parent === window) return;
  const origin = location.ancestorOrigins?.[0];
  if (
    origin === undefined ||
    !(origin.startsWith("vscode-webview://") || origin === location.origin)
  ) {
    console.info("not talking to the page around this one, from", origin);
    return;
  }
  parentOrigin = origin;
  changed = hooks.changed;
  error = hooks.error;
  controlledSession = hooks.controlledSession;
  window.addEventListener("message", received);
  post({
    type: "hello",
    capabilities: ["resolveDatasets", "openDataset", "rest"],
  });
}

/** @param {MessageEvent} event */
function received(event) {
  if (event.source !== window.parent || event.origin !== parentOrigin) return;
  const message = event.data;
  if (message?.bridge !== "tn3270" || message.v !== 1) return;
  console.info("the editor says", message);
  if (message.type === "hello") {
    capabilities = new Set(message.capabilities ?? []);
    forget();
    return;
  }
  if (message.type === "datasetsChanged") {
    forget();
    return;
  }
  if (message.type === "rest") {
    runRest(message.id, message.actions);
    return;
  }
  if (message.type === "result") {
    const answered = requests.get(message.id);
    requests.delete(message.id);
    answered?.(message);
  }
}

/** @returns {void} */
function forget() {
  generation++;
  known.clear();
  asking.clear();
  changed();
}

/** @param {Record<string, unknown>} message */
function post(message) {
  if (parentOrigin === null) return;
  console.info("telling the editor", message);
  window.parent.postMessage(
    { bridge: "tn3270", v: 1, ...message },
    parentOrigin,
  );
}

/**
 * @param {string} type
 * @param {Record<string, unknown>} fields
 * @param {number} timeoutMs
 * @returns {Promise<Answer | null>} null when no answer came in time
 */
function request(type, fields, timeoutMs) {
  const id = ++nextId;
  post({ type, id, ...fields });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      requests.delete(id);
      resolve(null);
    }, timeoutMs);
    requests.set(id, (answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
  });
}

/**
 * Asks the editor about the names it has not been asked about yet. A name it
 * did not answer for in time is asked about again with the next paint.
 *
 * @param {Iterable<string>} names
 * @returns {void}
 */
export function resolveDatasets(names) {
  if (!capabilities.has("resolveDatasets")) return;
  const unasked = [...names].filter(
    (name) => !known.has(name) && !asking.has(name),
  );
  if (unasked.length === 0) return;
  for (const name of unasked) asking.add(name);
  const askedIn = generation;
  request("resolveDatasets", { names: unasked }, RESOLVE_TIMEOUT_MS).then(
    (answer) => {
      if (askedIn !== generation) return;
      for (const name of unasked) asking.delete(name);
      if (answer === null) {
        console.warn("the editor did not say in time which data sets it has");
        return;
      }
      if (answer.error !== undefined) {
        error(
          "E5063",
          `The editor could not look up the data sets on the screen: [${answer.error.code}] ${answer.error.message}`,
        );
        return;
      }
      const found = new Set(answer.result?.found ?? []);
      for (const name of unasked) known.set(name, found.has(name));
      changed();
    },
  );
}

/** @param {string} name @returns {boolean} */
export function inRepo(name) {
  return known.get(name) === true;
}

/**
 * @param {string} name a name the editor said is in its repo
 * @returns {void}
 */
export function openDataset(name) {
  if (!capabilities.has("openDataset")) return;
  request("openDataset", { name }, OPEN_TIMEOUT_MS).then((answer) => {
    if (answer === null)
      error(
        "E5062",
        `The editor did not answer in time when asked to open ${name}`,
      );
    else if (answer.error !== undefined)
      error(
        "E5061",
        `${name} could not be opened in the editor: [${answer.error.code}] ${answer.error.message}`,
      );
  });
}

/**
 * Runs the editor's actions as a REST post would, so the server's list of
 * what REST may run is the only one. It goes through the page because the
 * page is already signed in to the server and the editor is not.
 *
 * @param {unknown} id
 * @param {unknown} actions as a REST post's JSON body takes them
 * @returns {Promise<void>}
 */
async function runRest(id, actions) {
  /** @param {string} code @param {string} message */
  const fail = (code, message) => {
    console.warn(`[${code}] ${message}`);
    post({ type: "result", id, error: { code, message } });
  };
  const sessionId = controlledSession();
  if (sessionId === null) {
    fail("E5064", "The editor may only type on a session this page controls");
    return;
  }
  // Names only: a String's text can be a password.
  const names = Array.isArray(actions)
    ? actions.map((step) => step?.action)
    : typeof actions;
  console.info("the editor runs", names, "on", sessionId);
  let response;
  let body;
  try {
    response = await fetch(
      new URL(`./api/sessions/${sessionId}/3270/rest/post`, document.baseURI),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(actions),
      },
    );
    body = await response.json();
  } catch (cause) {
    fail("E5065", `The editor's actions did not reach the server: ${cause}`);
    return;
  }
  // s3270 answers a failing action with 400 and says which in the body.
  if (response.status === 200 || response.status === 400) {
    post({ type: "result", id, result: body });
    return;
  }
  fail(
    body?.code ?? "E5065",
    body?.message ?? `The server answered ${response.status}`,
  );
}
