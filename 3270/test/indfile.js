// IND$FILE GET as a host answers it, record by record. Each record is TN3270E 3270-data: Write
// Structured Field with an unlocking Write in front, as IND$FILE sends them.

/** @param {string} hex one structured field, without its length */
export function sf(hex) {
  const length = hex.length / 2 + 2;
  return length.toString(16).padStart(4, "0") + hex;
}

/** @param {...string} fields */
export function record(...fields) {
  const body = `f3${sf("4000f1c2")}${fields.join("")}`.replace(/../g, (byte) =>
    byte === "ff" ? "ffff" : byte,
  );
  return `0000000000${body}ffef`;
}

/** @param {string} name */
export const open = (name) =>
  record(
    sf(
      `d000120106010104030a0a000000001101010050055203f00309${Buffer.from(name.padEnd(7)).toString("hex")}`,
    ),
  );

/** @param {Buffer} data */
export const insert = (data) =>
  record(
    sf("d047110105008000"),
    sf(
      `d04704c08061${(data.length + 5).toString(16).padStart(4, "0")}${data.toString("hex")}`,
    ),
  );

export const CLOSE = record(sf("d04112"));

// TSO's READY: an Erase/Write with no fields, the whole screen to type the command into.
export const UNFORMATTED = "0000000000f5c2ffef";

/** @param {string} text what IND$FILE says when it ends, up to a $ */
export const message = (text) => [
  open("FT:MSG"),
  insert(Buffer.from(`${text}$`.padEnd(80))),
];
