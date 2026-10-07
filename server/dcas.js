// Asks z/OS's Digital Certificate Access Server for a PassTicket: a one-time
// password RACF accepts once, for one user on one application, for a short while.
// The layout is IBM's "Format 2" request and its reply, from z/OS Communications
// Server: IP Programmer's Guide, "Interfacing with the DCAS". Integers are
// big-endian, text is EBCDIC 1047.
import { connect } from "node:tls";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { codePage } from "../3270/src/charset.js";
import { AppError } from "./errors.js";

const EBCDIC = codePage("cp1047");
const REPLY_BYTES = 38;

/** What DCAS's own return code 1 means, from the same page. @type {Record<number, string>} */
const RETURN_CODES = {
  248: "AT-TLS policy is misconfigured",
  249: "TLS handshake failed or the connection is not secure",
  250: "internal DCAS error",
  251: "PassTicket generation failed: is there a PTKTDATA profile for the applid?",
  252: "certificate is invalid or maps to no user ID",
  253: "request was malformed",
  254: "client authentication failed",
  255: "client certificate maps to no valid user ID",
};

/** @param {string} text @returns {Buffer} */
function toEbcdic(text) {
  return Buffer.from(
    [...text].map((ch) => EBCDIC.toEbcdic.get(ch.codePointAt(0) ?? 0) ?? 0x6f),
  );
}

/** @param {Buffer} bytes @returns {string} without the blank or null padding */
function fromEbcdic(bytes) {
  return String.fromCodePoint(...[...bytes].map((byte) => EBCDIC.base[byte]))
    .replace(/[\0 ]+$/, "")
    .replace(/^\0+/, "");
}

/**
 * @param {string} applid
 * @param {string} user
 * @param {Buffer} correlator 4 bytes
 * @returns {Buffer}
 */
export function encodeRequest(applid, user, correlator) {
  const userBytes = toEbcdic(user);
  const request = Buffer.alloc(32 + userBytes.length);
  request[0] = 0x02; // opcode: request, as IBM's Format 2 table gives it
  request[1] = 0x02; // format 2: a PassTicket for this user ID
  correlator.copy(request, 2);
  toEbcdic(applid).subarray(0, 20).copy(request, 6); // unused bytes stay x'00'
  request.writeUInt32BE(userBytes.length, 28);
  userBytes.copy(request, 32);
  return request;
}

/**
 * @param {Buffer} reply
 * @param {Buffer} correlator
 * @returns {string} the PassTicket
 */
export function decodeReply(reply, correlator) {
  if (reply.length < REPLY_BYTES)
    throw new AppError("E9004", `${reply.length} bytes, not ${REPLY_BYTES}`);
  if (!reply.subarray(2, 6).equals(correlator))
    throw new AppError("E9004", "correlator does not match the request");
  const rc1 = reply.readUInt16BE(6);
  if (rc1 !== 0) {
    const rc = [
      rc1,
      reply.readUInt32BE(8),
      reply.readUInt32BE(12),
      reply.readUInt32BE(16),
    ].join("/");
    throw new AppError(
      "E9003",
      `return codes ${rc}: ${RETURN_CODES[rc1] ?? "unknown"}`,
    );
  }
  const ticket = fromEbcdic(reply.subarray(30, 38));
  if (ticket === "") throw new AppError("E9004", "no PassTicket in the reply");
  return ticket;
}

/**
 * @param {import('./config.js').DcasConfig} dcas
 * @param {string} user RACF user ID
 * @param {number} timeoutMs for the whole exchange
 * @returns {Promise<string>} the PassTicket
 */
export async function requestPassTicket(dcas, user, timeoutMs) {
  let files;
  try {
    files = await Promise.all(
      [dcas.certFile, dcas.keyFile, dcas.caFile].map((file) =>
        file === "" ? undefined : readFile(file),
      ),
    );
  } catch (cause) {
    throw new AppError("E9005", `${dcas.certFile} ${dcas.keyFile}`, cause);
  }
  const [cert, key, ca] = files;
  const correlator = randomBytes(4);
  const where = `${dcas.host}:${dcas.port}`;

  return new Promise((resolve, reject) => {
    let reply = Buffer.alloc(0);
    const socket = connect(
      { host: dcas.host, port: dcas.port, cert, key, ca },
      () => socket.write(encodeRequest(dcas.applid, user, correlator)),
    );
    const timer = setTimeout(() => {
      stop();
      reject(new AppError("E9002", `${where} after ${timeoutMs} ms`));
    }, timeoutMs);
    const stop = () => {
      clearTimeout(timer);
      socket.destroy();
    };

    socket.on("data", (/** @type {Buffer} */ chunk) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length < REPLY_BYTES) return;
      stop();
      try {
        resolve(decodeReply(reply, correlator));
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", (cause) => {
      stop();
      reject(new AppError("E9001", where, cause));
    });
    socket.on("end", () => {
      if (reply.length >= REPLY_BYTES) return;
      stop();
      reject(new AppError("E9004", `closed after ${reply.length} bytes`));
    });
  });
}
