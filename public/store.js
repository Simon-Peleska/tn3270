/**
 * Settings live in IndexedDB, one record under a fixed key.
 *
 * localStorage would have been shorter, but settings belong to the browser
 * rather than to a session, and IndexedDB is the store that survives the
 * "clear site data on close" settings people actually use for a terminal they
 * log into. The API is callback-based, so it is wrapped once here and never
 * thought about again.
 */

const DB_NAME = 'tn3270';
const STORE_NAME = 'settings';
const KEY = 'ui';

/**
 * @typedef {object} StoredSettings
 * @property {string} theme
 * @property {string} font
 * @property {number} model
 * @property {boolean} hostColors
 * @property {number} fitFontSize how tall the text is in the screen that "fit
 *   to window" measures; not the font size on screen, which floats
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
 * @returns {Promise<Partial<StoredSettings>>} an empty object when nothing has
 *   been saved yet, which is the normal first-visit case rather than an error.
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
