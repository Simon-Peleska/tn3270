// s3270's REST interface (httpd-nodes.c), one per session: /3270/rest/text, stext and json run the
// actions in the rest of the path, /3270/rest/post runs the request body. A call answers the way
// s3270 does, so scripts written against s3270's -httpd work unchanged.
import {
  ACTION_NAMES,
  parseCommand,
  parseJsonCommand,
  statusString,
} from "../3270/src/index.js";
import { AppError } from "./errors.js";
import { logger } from "./log.js";

const log = logger("rest");

// Reading the screen and typing, nothing more: Connect would aim the session at any host, and
// Set or Toggle would change it for its viewers. The WebSocket may not run them either.
const REST_ACTIONS = new Set([
  ..."Query Ascii Ascii1 AsciiField Ebcdic Ebcdic1 EbcdicField ReadBuffer".split(
    " ",
  ),
  ..."Enter PF PA Clear SysReq Attn Interrupt Reset Key".split(" "),
  ..."String PasteString HexString".split(" "),
  ..."Tab BackTab Home End Left Right Left2 Right2 Up Down Newline FieldEnd".split(
    " ",
  ),
  ..."NextWord PreviousWord MoveCursor MoveCursor1 CursorSelect".split(" "),
  ..."Delete BackSpace Erase EraseEOF EraseInput DeleteWord DeleteField".split(
    " ",
  ),
  ..."Dup FieldMark Insert ToggleInsert".split(" "),
]);

/**
 * @param {import('node:http').ServerResponse} res
 * @param {import('./session.js').Session} session
 * @param {string} path what follows /3270/rest/, still percent-encoded
 * @param {{ method: string, user: string, contentType: string, body: string }} request
 * @returns {Promise<void>}
 */
export async function answerRest(res, session, path, request) {
  // Reading counts too: a REST GET can type as well as a post can.
  if (session.remoteUser !== "" && request.user !== session.remoteUser)
    throw new AppError(
      "E7013",
      `${request.user || "no user"} on ${session.remoteUser}'s session`,
    );
  const slash = path.indexOf("/");
  const node = slash === -1 ? path : path.slice(0, slash);

  /** @type {"text" | "stext" | "json"} */
  let format;
  let parsed;
  if (node === "text" || node === "stext" || node === "json") {
    format = node;
    let command;
    try {
      command = slash === -1 ? "" : decodeURIComponent(path.slice(slash + 1));
    } catch (cause) {
      throw new AppError("E7009", path, cause);
    }
    parsed =
      command === ""
        ? { actions: [], error: "Missing 3270 action." }
        : parseCommand(command);
  } else if (path === "post") {
    if (request.method !== "POST") throw new AppError("E7006", request.method);
    if (request.contentType === "text/plain") {
      format = "stext";
      parsed = parseCommand(request.body);
    } else if (request.contentType === "application/json") {
      format = "json";
      parsed =
        request.body === ""
          ? { actions: [], error: null }
          : parseJsonCommand(request.body);
    } else throw new AppError("E7007", request.contentType || "none");
  } else throw new AppError("E7005", path);

  // A name the emulator does not know is left to it, to answer as s3270 does.
  const refused = parsed.actions.find(({ action }) => {
    const name = ACTION_NAMES.get(action.toLowerCase());
    return name !== undefined && !REST_ACTIONS.has(name);
  });
  if (refused) throw new AppError("E7012", refused.action);

  log.info("REST call", {
    session: session.id,
    format,
    // Only the names: a String() can carry a password.
    actions: parsed.actions.map(({ action }) => action).join(" "),
  });
  /** @type {{ success: boolean, text: string[], err: boolean[], time: number }} */
  let result = { success: true, text: [], err: [], time: 0 };
  if (parsed.actions.length > 0) {
    try {
      result = await session.runInTurn(parsed.actions, "REST");
    } catch (cause) {
      throw new AppError("E7010", session.id, cause);
    }
  }
  const text = [...result.text];
  const err = [...result.err];
  let success = result.success;
  if (success && parsed.error !== null) {
    text.push(parsed.error);
    err.push(true);
    success = false;
  }
  if (!success)
    log.warn("E7008 REST call failed", {
      session: session.id,
      error: text.filter((_, i) => err[i]).join(" "),
    });

  const status = `${statusString(session.emulator.s)} 0x0 ${result.time.toFixed(3)}`;
  const crlf = (/** @type {string[]} */ lines) =>
    lines.map((line) => `${line}\r\n`).join("");
  res.writeHead(success ? 200 : 400, {
    "content-type":
      format === "json"
        ? "application/json; charset=utf-8"
        : "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  if (format === "json")
    res.end(
      `${JSON.stringify({ result: text, "result-err": err, status })}\r\n`,
    );
  else res.end(crlf(format === "stext" ? [status, ...text] : text));
}
