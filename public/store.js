/**
 * Settings on the server, one value per fixed key, kept per user name or else
 * per address. What an older version left in this browser's IndexedDB is
 * moved up the first time the server has nothing for a key, and left in place
 * so rolling back to that version still finds it.
 */

const LEGACY_DB_NAME = "tn3270";
const LEGACY_STORE_NAME = "settings";
const LEGACY_KEYS = /** @type {const} */ ({
  settings: "ui",
  macros: "macros",
  keymap: "keymap",
  recordings: "recordings",
});

/** @typedef {keyof typeof LEGACY_KEYS} Key */

/**
 * @typedef {object} StoredSettings
 * @property {string} theme
 * @property {string} font
 * @property {number | null} model the screen model every new session is asked
 *   for, null until one has been chosen here
 * @property {'model' | 'fit' | 'dynamic' | null} screenSize what the model is
 *   stretched to, likewise null until chosen
 * @property {number} fitFontSize the size "fit to window" measures from; also
 *   the display cap when forceMaxFontSize is enabled
 * @property {boolean} forceMaxFontSize cap display text at fitFontSize, shrinking further when needed
 * @property {boolean} fieldBackground whether a typeable field is tinted
 */

/** @param {Response} response @returns {Promise<Error>} */
async function responseError(response) {
  const body = await response.json().catch(() => null);
  return typeof body?.code === "string"
    ? new Error(`[${body.code}] ${body.message}`)
    : new Error(`HTTP ${response.status}`);
}

/** @type {{ data?: Record<string, unknown>, error?: { code: string, message: string } } | null} */
let inlined = null;

/**
 * The server writes settings, macros and keymap into the page, so the first
 * screen never waits on a request for them.
 *
 * @param {Key} key
 * @returns {unknown} null where never saved
 */
function inlinedValue(key) {
  if (inlined === null) {
    const text = document.getElementById("userdata")?.textContent;
    if (text == null) throw new Error("[E5043] the page carries no user data");
    inlined = JSON.parse(text);
  }
  const error = inlined?.error;
  if (error !== undefined) throw new Error(`[${error.code}] ${error.message}`);
  return inlined?.data?.[key] ?? null;
}

/** @param {Key} key @returns {Promise<unknown>} null where never saved */
async function fetchValue(key) {
  const response = await fetch(`./api/userdata/${key}`);
  if (!response.ok) throw await responseError(response);
  return response.json();
}

/** @type {Map<Key, Promise<void>>} */
const writing = new Map();

/**
 * Chained per key: two saves in flight at once could otherwise land in the
 * opposite order.
 *
 * @param {Key} key @param {unknown} value @returns {Promise<void>}
 */
function write(key, value) {
  const put = async () => {
    const response = await fetch(`./api/userdata/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!response.ok) throw await responseError(response);
  };
  const next = (writing.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(put);
  writing.set(key, next);
  return next;
}

/** @param {Key} key @returns {Promise<unknown>} undefined when there is none */
function readLegacy(key) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(LEGACY_STORE_NAME);
    request.onerror = () =>
      reject(request.error ?? new Error("indexedDB.open failed"));
    request.onsuccess = () => {
      const get = request.result
        .transaction(LEGACY_STORE_NAME, "readonly")
        .objectStore(LEGACY_STORE_NAME)
        .get(LEGACY_KEYS[key]);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error ?? new Error("read failed"));
    };
  });
}

/** @param {Key} key @returns {Promise<unknown>} */
async function read(key) {
  const value =
    key === "recordings" ? await fetchValue(key) : inlinedValue(key);
  if (value !== null && value !== undefined) return value;

  /** @type {unknown} */
  let legacy;
  try {
    legacy = await readLegacy(key);
  } catch (cause) {
    console.warn("browser database could not be read for", key, cause);
    return undefined;
  }
  if (legacy === undefined) return undefined;
  console.info("moving from this browser to the server:", key);
  await write(key, legacy);
  return legacy;
}

/**
 * @returns {Promise<Partial<StoredSettings>>} empty on a first visit
 */
export async function loadSettings() {
  const value = await read("settings");
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}

/**
 * @param {Partial<StoredSettings>} settings only what differs from the defaults
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  await write("settings", settings);
}

/**
 * @returns {Promise<import('./macros.js').Macro[]>} empty on a first visit
 */
export async function loadMacros() {
  const value = await read("macros");
  return Array.isArray(value) ? value : [];
}

/**
 * @param {import('./macros.js').Macro[]} macros
 * @returns {Promise<void>}
 */
export async function saveMacros(macros) {
  await write("macros", macros);
}

/**
 * @returns {Promise<import('./recorder.js').Recording[]>} empty on a first visit
 */
export async function loadRecordings() {
  const value = await read("recordings");
  return Array.isArray(value) ? value : [];
}

/**
 * @param {import('./recorder.js').Recording[]} recordings
 * @returns {Promise<void>}
 */
export async function saveRecordings(recordings) {
  await write("recordings", recordings);
}

/**
 * @returns {Promise<import('./keymap.js').Bindings>} empty on a first visit
 */
export async function loadKeymap() {
  const value = await read("keymap");
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {import('./keymap.js').Bindings} */ (value)
    : {};
}

/**
 * @param {import('./keymap.js').Bindings} bindings
 * @returns {Promise<void>}
 */
export async function saveKeymap(bindings) {
  await write("keymap", bindings);
}
