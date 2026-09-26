/**
 * Settings in IndexedDB, one record per fixed key. IndexedDB, not localStorage:
 * it survives the "clear site data on close" settings people use here.
 */

const DB_NAME = "tn3270";
const STORE_NAME = "settings";
const KEY = "ui";
const MACROS_KEY = "macros";
const KEYMAP_KEY = "keymap";
const RECORDINGS_KEY = "recordings";

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

/** @type {Promise<IDBDatabase> | null} */
let opening = null;

/** @returns {Promise<IDBDatabase>} */
function open() {
  if (opening !== null) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexedDB.open failed"));
  }).catch((error) => {
    opening = null;
    throw error;
  });
  return opening;
}

/** @param {string} key @returns {Promise<unknown>} */
async function read(key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("read failed"));
  });
}

/** @param {string} key @param {unknown} value @returns {Promise<void>} */
async function write(key, value) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("write failed"));
  });
}

/**
 * @returns {Promise<Partial<StoredSettings>>} empty on a first visit
 */
export async function loadSettings() {
  const value = await read(KEY);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}

/**
 * @param {Partial<StoredSettings>} settings only what differs from the defaults
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  await write(KEY, settings);
}

/**
 * @returns {Promise<import('./macros.js').Macro[]>} empty on a first visit
 */
export async function loadMacros() {
  const value = await read(MACROS_KEY);
  return Array.isArray(value) ? value : [];
}

/**
 * @param {import('./macros.js').Macro[]} macros
 * @returns {Promise<void>}
 */
export async function saveMacros(macros) {
  await write(MACROS_KEY, macros);
}

/**
 * @returns {Promise<import('./recorder.js').Recording[]>} empty on a first visit
 */
export async function loadRecordings() {
  const value = await read(RECORDINGS_KEY);
  return Array.isArray(value) ? value : [];
}

/**
 * @param {import('./recorder.js').Recording[]} recordings
 * @returns {Promise<void>}
 */
export async function saveRecordings(recordings) {
  await write(RECORDINGS_KEY, recordings);
}

/**
 * @returns {Promise<import('./keymap.js').Bindings>} empty on a first visit
 */
export async function loadKeymap() {
  const value = await read(KEYMAP_KEY);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {import('./keymap.js').Bindings} */ (value)
    : {};
}

/**
 * @param {import('./keymap.js').Bindings} bindings
 * @returns {Promise<void>}
 */
export async function saveKeymap(bindings) {
  await write(KEYMAP_KEY, bindings);
}
