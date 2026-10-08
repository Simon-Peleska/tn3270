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

/**
 * Sent with every save, so the server tells this user's other tabs about it
 * but not this one. Not crypto.randomUUID(): that needs HTTPS.
 */
export const TAB_ID = Math.random().toString(36).slice(2);

/** @param {Response} response @returns {Promise<Error>} */
export async function responseError(response) {
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
 * What this tab last read or wrote per key, as JSON, so a reload that finds
 * the same is no news. Not recordings: they can be megabytes, and are only
 * reloaded when another tab saved them.
 * @type {Map<Key, string>}
 */
const seen = new Map();

/** @param {Key} key @param {unknown} value @returns {void} */
function remember(key, value) {
  if (key !== "recordings") seen.set(key, JSON.stringify(value));
}

/**
 * Bumped by every write and reload, so a reload overtaken by either is
 * dropped: it would put back what was just replaced.
 * @type {Map<Key, number>}
 */
const generations = new Map();

/** @param {Key} key @returns {number} */
function bump(key) {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

/**
 * Chained per key: two saves in flight at once could otherwise land in the
 * opposite order.
 *
 * @param {Key} key @param {unknown} value @returns {Promise<void>}
 */
function write(key, value) {
  bump(key);
  remember(key, value);
  const put = async () => {
    const response = await fetch(`./api/userdata/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-tab": TAB_ID },
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
  remember(key, value);
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
 * What is saved for `key` now, when that is news to this tab: another tab
 * saved it since.
 *
 * @param {Key} key
 * @returns {Promise<unknown>} undefined when nothing changed, or a later write
 *   or reload overtook this one
 */
export async function reload(key) {
  const generation = bump(key);
  // A save of this tab's still on its way would be read back as it was before.
  await writing.get(key)?.catch(() => {});
  const response = await fetch(`./api/userdata/${key}`);
  if (!response.ok) throw await responseError(response);
  const text = await response.text();
  if (generations.get(key) !== generation || seen.get(key) === text)
    return undefined;
  const value = JSON.parse(text);
  remember(key, value);
  return SHAPES[key](value);
}

/** @param {unknown} value @returns {Record<string, unknown>} empty when it is none */
function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value @returns {unknown[]} empty when it is none */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** What a first visit, or a value of the wrong shape, reads as. */
const SHAPES = {
  settings: asObject,
  macros: asArray,
  keymap: asObject,
  recordings: asArray,
};

/**
 * @returns {Promise<Partial<StoredSettings>>} empty on a first visit
 */
export async function loadSettings() {
  return asObject(await read("settings"));
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
  return /** @type {import('./macros.js').Macro[]} */ (
    asArray(await read("macros"))
  );
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
  return /** @type {import('./recorder.js').Recording[]} */ (
    asArray(await read("recordings"))
  );
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
  return /** @type {import('./keymap.js').Bindings} */ (
    asObject(await read("keymap"))
  );
}

/**
 * @param {import('./keymap.js').Bindings} bindings
 * @returns {Promise<void>}
 */
export async function saveKeymap(bindings) {
  await write("keymap", bindings);
}
