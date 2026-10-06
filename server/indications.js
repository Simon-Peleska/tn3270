// The JSON indications the emulator reports, as session.js reads them. Types only.

/**
 * @typedef {object} ScreenCursor
 * @property {boolean} [enabled]
 * @property {number} [row] 1-based
 * @property {number} [column] 1-based
 *
 * @typedef {object} ScreenIndication
 * @property {ScreenCursor} [cursor]
 * @property {number[]} [rows] 1-based, the ones that changed
 *
 * @typedef {object} EraseIndication
 * @property {number} [logical-rows]
 * @property {number} [logical-columns]
 * @property {string} [fg]
 * @property {string} [bg]
 *
 * @typedef {object} ScreenModeIndication
 * @property {number} model
 * @property {number} rows
 * @property {number} columns
 * @property {boolean} color
 * @property {boolean} [oversize]
 * @property {boolean} [extended]
 *
 * @typedef {object} ModelInfo
 * @property {number} model
 * @property {number} rows
 * @property {number} columns
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
 * @typedef {object} RunResultIndication
 * @property {string} [r-tag]
 * @property {boolean} success
 * @property {string[]} [text]
 * @property {boolean[]} [text-err]
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
