// The JSON indications the emulator reports, as session.js reads them. Types only.

/**
 * @typedef {object} ScreenIndication
 * @property {number[]} [rows] 1-based, the ones that changed
 *
 * @typedef {object} ScreenModeIndication
 * @property {number} model
 *
 * @typedef {object} OiaIndication
 * @property {string} field
 * @property {string | boolean | number} [value]
 *
 * @typedef {object} ConnectionIndication
 * @property {string} state
 * @property {string} [host]
 * @property {string} [cause]
 *
 * @typedef {object} PopupIndication
 * @property {string} [type]
 * @property {string} [text]
 * @property {string} [error]
 *
 * @typedef {object} UiErrorIndication
 * @property {boolean} [fatal]
 * @property {string} [text]
 * @property {string} [operation]
 */

/**
 * @typedef {object} Indication
 * @property {string} kind
 * @property {unknown} body
 */

export {};
