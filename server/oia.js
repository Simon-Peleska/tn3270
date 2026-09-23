// The Operator Information Area: the status line below a 3270 screen. This is
// the parsing half; the drawing half is the browser's, in public/oia.js.

export class OiaModel {
  constructor() {
    /** @type {string} */
    this.connectionState = "not-connected";
    /** @type {string | null} */
    this.host = null;
    /** @type {string} */
    this.lock = "not-connected";
    /** @type {boolean} */
    this.insert = false;
    /** @type {boolean} */
    this.typeahead = false;
  }

  /**
   * @param {import('./b3270.js').OiaIndication} oia
   * @returns {void}
   */
  applyOia(oia) {
    const value = oia.value;
    switch (oia.field) {
      case "lock":
        this.lock = typeof value === "string" ? value : "";
        break;
      case "insert":
        this.insert = value === true || value === "true";
        break;
      case "typeahead":
        this.typeahead = value === true || value === "true";
        break;
      default:
        break;
    }
  }

  /**
   * @param {import('./b3270.js').ConnectionIndication} connection
   * @returns {void}
   */
  applyConnection(connection) {
    this.connectionState = connection.state;
    this.host = typeof connection.host === "string" ? connection.host : null;
  }

  /** @returns {boolean} */
  get connected() {
    return this.connectionState.startsWith("connected");
  }

  /** @returns {boolean} */
  get keyboardLocked() {
    return this.lock !== "" && this.lock !== "unlocked";
  }
}
