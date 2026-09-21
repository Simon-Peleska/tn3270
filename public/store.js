/**
 * Settings in IndexedDB, one record per fixed key. IndexedDB, not localStorage:
 * it survives the "clear site data on close" settings people use here.
 */

const DB_NAME = 'tn3270';
const STORE_NAME = 'settings';
const KEY = 'ui';
const MACROS_KEY = 'macros';
const KEYMAP_KEY = 'keymap';

/**
 * @typedef {object} StoredSettings
 * @property {string} theme
 * @property {string} font
 * @property {number | null} model the screen model every new session is asked
 *   for, null until one has been chosen here
 * @property {'model' | 'fit' | 'dynamic' | null} screenSize what the model is
 *   stretched to, likewise null until chosen
 * @property {boolean} hostColors
 * @property {number} fitFontSize the size "fit to window" measures from, not
 *   the size on screen
 * @property {boolean} hints
 */

/** @type {Promise<IDBDatabase> | null} */
let opening = null;

/** @returns {Promise<IDBDatabase>} */
function open() {
  if (opening !== null) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
  });
  return opening;
}

/**
 * @returns {Promise<Partial<StoredSettings>>} empty on a first visit
 */
export async function loadSettings() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(KEY);
    request.onsuccess = () => {
      const value = request.result;
      resolve(typeof value === 'object' && value !== null ? value : {});
    };
    request.onerror = () => reject(request.error ?? new Error('read failed'));
  });
}

/**
 * @param {StoredSettings} settings
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(settings, KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('write failed'));
  });
}

/**
 * @returns {Promise<import('./macro-xml.js').Macro[]>} empty on a first visit
 */
export async function loadMacros() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(MACROS_KEY);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error ?? new Error('read failed'));
  });
}

/**
 * @param {import('./macro-xml.js').Macro[]} macros
 * @returns {Promise<void>}
 */
export async function saveMacros(macros) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(macros, MACROS_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('write failed'));
  });
}

/**
 * @returns {Promise<import('./keymap.js').Bindings>} empty on a first visit
 */
export async function loadKeymap() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(KEYMAP_KEY);
    request.onsuccess = () => {
      const value = request.result;
      resolve(typeof value === 'object' && value !== null ? value : {});
    };
    request.onerror = () => reject(request.error ?? new Error('read failed'));
  });
}

/**
 * @param {import('./keymap.js').Bindings} bindings
 * @returns {Promise<void>}
 */
export async function saveKeymap(bindings) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(bindings, KEYMAP_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('write failed'));
  });
}
