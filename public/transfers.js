/**
 * The IND$FILE transfers this tab asked for. An upload's text is read from a
 * file or the clipboard, and a download's clipboard write begun, while the key
 * press still lets the page do that; a download's text goes to a file or the
 * clipboard when its transferEnd arrives. The server echoes each one's id.
 */

/**
 * @typedef {'download' | 'upload'} Direction
 * @typedef {'file' | 'clipboard'} Place
 * @typedef {{ direction: Direction, place: Place, hostFile: string, hostCommand: string }} TransferStep
 * @typedef {import('../server/protocol.js').TransferMessage} TransferMessage
 */

/** The ways a transfer goes, numbered as the panels offer them. */
export const TRANSFER_WAYS = /** @type {const} */ ([
  { option: "1", direction: "download", place: "file" },
  { option: "2", direction: "download", place: "clipboard" },
  { option: "3", direction: "upload", place: "file" },
  { option: "4", direction: "upload", place: "clipboard" },
]);

/** @param {{ direction: Direction, place: Place }} way @returns {string} */
export function wayLabel({ direction, place }) {
  const where = place === "file" ? "a file" : "the clipboard";
  return direction === "download"
    ? `Download to ${where}`
    : `Upload from ${where}`;
}

/**
 * A macro's Download or Upload step: the data set, the command and where the
 * text comes from or goes, a file when it does not say.
 *
 * @param {import('./macros.js').MacroStep} step
 * @returns {TransferStep}
 */
export function macroTransfer(step) {
  return {
    direction: step.action === "Upload" ? "upload" : "download",
    place: step.args[2] === "clipboard" ? "clipboard" : "file",
    hostFile: step.args[0] ?? "",
    hostCommand: step.args[1] ?? "",
  };
}

// The server's MAX_UPLOAD_CHARS.
const MAX_UPLOAD_CHARS = 2 * 1024 * 1024;

export class TransferFailed extends Error {
  /** @param {string} code @param {string} text */
  constructor(code, text) {
    super(`[${code}] ${text}`);
    this.code = code;
    this.text = text;
  }
}

/**
 * @typedef {object} Prepared
 * @property {TransferMessage | Promise<TransferMessage>} message what to send,
 *   once an upload's text is in
 * @property {Promise<string>} end the host's word on it, once a download's
 *   text went where it should
 * @property {(err: Error) => void} drop when the message is never sent
 */

export class Transfers {
  /** @param {{ saveFile: (name: string, text: string) => void }} deps */
  constructor(deps) {
    this.deps = deps;
    this.lastId = 0;
    /** @type {Map<number, { chunks: string[], resolve: (end: { text: string, said: string }) => void, reject: (err: Error) => void }>} */
    this.running = new Map();
  }

  /**
   * Call it from the key press: the clipboard and the file picker need one.
   *
   * @param {TransferStep} step
   * @param {Map<Place, Promise<string>>} [sources] a macro's uploads share
   *   them, so one key press reads the clipboard or asks for a file once
   * @returns {Prepared}
   */
  prepare(step, sources = new Map()) {
    const id = ++this.lastId;
    /** @type {Promise<{ text: string, said: string }>} */
    const ended = new Promise((resolve, reject) =>
      this.running.set(id, { chunks: [], resolve, reject }),
    );
    const drop = (/** @type {Error} */ err) => this.fail(id, err);
    /** @type {TransferMessage} */
    const message = {
      type: "transfer",
      id,
      hostFile: step.hostFile,
      hostCommand: step.hostCommand,
    };
    console.info("transfer prepared", { id, ...step });

    if (step.direction === "upload") {
      let source = sources.get(step.place);
      if (source === undefined) {
        source = step.place === "clipboard" ? readClipboard() : pickFile();
        sources.set(step.place, source);
      }
      const upload = source.then((text) => {
        if (text.length > MAX_UPLOAD_CHARS)
          throw new TransferFailed(
            "E5057",
            `The text is too long to upload: at most ${MAX_UPLOAD_CHARS} characters`,
          );
        return { ...message, upload: text };
      });
      upload.catch(drop);
      return { message: upload, end: ended.then((end) => end.said), drop };
    }

    const clipboard = step.place === "clipboard" ? clipboardWriter() : null;
    const end = ended.then(
      async ({ text, said }) => {
        if (clipboard !== null) await clipboard.fill(text);
        else
          this.deps.saveFile(
            `${step.hostFile.replace(/'/g, "").replace(/[^\w.()-]/g, "_")}.txt`,
            text,
          );
        console.info("data set downloaded", { id, chars: text.length });
        return said;
      },
      (err) => {
        clipboard?.cancel(err);
        throw err;
      },
    );
    return { message, end, drop };
  }

  /**
   * The panel's transfer: prepared, sent, and the host's word on it.
   *
   * @param {TransferStep} step
   * @param {(message: TransferMessage) => boolean} send false when it could not
   * @returns {Promise<string>}
   */
  start(step, send) {
    const { message, end, drop } = this.prepare(step);
    void Promise.resolve(message).then((ready) => {
      if (!send(ready))
        drop(
          new TransferFailed(
            "E5053",
            "The transfer could not be sent to the server",
          ),
        );
    }, drop);
    return end;
  }

  /**
   * @param {import('../server/protocol.js').DownloadMessage | import('../server/protocol.js').TransferEndMessage} message
   */
  received(message) {
    const transfer = this.running.get(message.id ?? 0);
    if (transfer === undefined) {
      console.warn("a transfer this tab does not know", message.type);
      return;
    }
    if (message.type === "download") {
      transfer.chunks.push(message.text);
      return;
    }
    this.running.delete(message.id ?? 0);
    if (message.ok)
      transfer.resolve({
        text: transfer.chunks.join(""),
        said: message.message,
      });
    else
      transfer.reject(
        new TransferFailed(message.code ?? "E3030", message.message),
      );
  }

  /** The server cancels the transfers of a viewer that left, and tells nobody. */
  closed() {
    for (const id of [...this.running.keys()])
      this.fail(
        id,
        new TransferFailed(
          "E5052",
          "The connection to the server closed during the transfer",
        ),
      );
  }

  /** @param {number} id @param {Error} err */
  fail(id, err) {
    const transfer = this.running.get(id);
    if (transfer === undefined) return;
    this.running.delete(id);
    transfer.reject(err);
  }
}

/** @returns {Promise<string>} */
function readClipboard() {
  return navigator.clipboard.readText().catch((cause) => {
    console.error("[E5054] the clipboard could not be read", cause);
    throw new TransferFailed(
      "E5054",
      `The browser did not let the clipboard be read: ${String(cause)}`,
    );
  });
}

/** @returns {Promise<string>} the chosen file's text, as UTF-8 */
function pickFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  document.body.append(input);
  return new Promise((resolve, reject) => {
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (file === undefined)
        reject(new TransferFailed("E5056", "No file was chosen"));
      else {
        console.info("file chosen", { name: file.name, bytes: file.size });
        resolve(file.text());
      }
    });
    input.addEventListener("cancel", () => {
      input.remove();
      reject(new TransferFailed("E5056", "No file was chosen"));
    });
    input.click();
  });
}

/**
 * A clipboard write begun now, while the key press allows it, with the text
 * to follow when the download is in. Where the browser has no ClipboardItem,
 * or refuses the write, writeText gets a second go.
 */
function clipboardWriter() {
  /** @type {(text: string) => void} */
  let fill = () => {};
  /** @type {(err: Error) => void} */
  let cancel = () => {};
  const text = new Promise((resolve, reject) => {
    fill = resolve;
    cancel = reject;
  });
  /** @type {Promise<void> | null} */
  let written = null;
  if (typeof ClipboardItem !== "undefined") {
    written = navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })),
      }),
    ]);
    // A failed download is reported where it fails, not as a clipboard error.
    written.catch(() => {});
  }
  return {
    /** @param {string} downloaded */
    fill: async (downloaded) => {
      fill(downloaded);
      try {
        if (written === null) throw new Error("no ClipboardItem");
        await written;
      } catch (first) {
        try {
          await navigator.clipboard.writeText(downloaded);
        } catch (cause) {
          console.error("[E5055] the clipboard write failed", first, cause);
          throw new TransferFailed(
            "E5055",
            "The browser did not let the text onto the clipboard",
          );
        }
      }
    },
    cancel,
  };
}
