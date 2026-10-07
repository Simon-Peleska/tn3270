import {
  AID_QREPLY,
  AID_SF,
  PDS_BAD_CMD,
  PDS_OKAY_NO_OUTPUT,
  PDS_OKAY_OUTPUT,
  SF_SRM_CHAR,
  SF_SRM_FIELD,
  SF_SRM_XFIELD,
  SNA_CMD_EAU,
  SNA_CMD_EW,
  SNA_CMD_EWA,
  SNA_CMD_RB,
  SNA_CMD_RM,
  SNA_CMD_RMA,
  SNA_CMD_W,
  cursorMove,
  erase,
  eraseAllUnprotected,
  readBuffer,
  readModified,
  write,
} from "./ctlr.js";
import { kybdInhibit } from "./kybd.js";
import { netOutput } from "./telnet.js";

// Port of x3270's Common/sf.c: Write Structured Field and the query replies.

const SF_READ_PART = 0x01,
  SF_ERASE_RESET = 0x03,
  SF_SET_REPLY_MODE = 0x09,
  SF_CREATE_PART = 0x0c;
const SF_OUTBOUND_DS = 0x40;
const SF_RP_QUERY = 0x02,
  SF_RP_QLIST = 0x03,
  SF_RPQ_LIST = 0x00,
  SF_RPQ_EQUIV = 0x40,
  SF_RPQ_ALL = 0x80;
const SF_ER_DEFAULT = 0x00,
  SF_ER_ALT = 0x80;
const QR_NULL = 0xff;

/** Query reply codes in x3270's order, without DBCS-Asia (0x91) since we are SBCS only. */
const REPLIES = [0x80, 0x81, 0x84, 0x85, 0x86, 0x87, 0x88, 0x95, 0xa1, 0xa6];

/** Canned from a 3279-2, as x3270 does. */
const XR_3279_2 = 0x000a02e5,
  YR_3279_2 = 0x0002006f,
  SW_3279_2 = 0x09,
  SH_3279_2 = 0x0c;

/** @typedef {import("./session.js").State} State */

/** write_structured_field() @param {State} s @param {Uint8Array} buf */
export function writeStructuredField(s, buf) {
  let rv = PDS_OKAY_NO_OUTPUT;
  let badCmd = false;
  let cp = 1;
  let buflen = buf.length - 1;
  while (buflen > 0) {
    if (buflen < 2) {
      s.log.warn("N2101 structured field too short for its length");
      return rv ? rv : PDS_BAD_CMD;
    }
    let fieldlen = (buf[cp] << 8) + buf[cp + 1];
    if (fieldlen === 0) fieldlen = buflen;
    if (fieldlen < 3) {
      s.log.warn(`N2102 structured field length ${fieldlen} too small`);
      return rv ? rv : PDS_BAD_CMD;
    }
    if (fieldlen > buflen) {
      s.log.warn(
        `N2103 structured field length ${fieldlen} exceeds remaining message length ${buflen}`,
      );
      return rv ? rv : PDS_BAD_CMD;
    }
    const field = buf.subarray(cp, cp + fieldlen);
    let rvThis;
    switch (field[2]) {
      case SF_READ_PART:
        rvThis = readPartition(s, field);
        break;
      case SF_ERASE_RESET:
        rvThis = eraseReset(s, field);
        break;
      case SF_SET_REPLY_MODE:
        rvThis = setReplyMode(s, field);
        break;
      case SF_CREATE_PART:
        rvThis = createPartition(s, field);
        break;
      case SF_OUTBOUND_DS:
        rvThis = outboundDs(s, field);
        break;
      default:
        s.log.warn(
          `N2104 unsupported structured field 0x${field[2].toString(16)}`,
        );
        rvThis = PDS_BAD_CMD;
    }
    if (rvThis < 0) badCmd = true;
    else rv |= rvThis;
    cp += fieldlen;
    buflen -= fieldlen;
  }
  return badCmd && !rv ? PDS_BAD_CMD : rv;
}

/** sf_read_part() @param {State} s @param {Uint8Array} buf */
function readPartition(s, buf) {
  if (buf.length < 5) return PDS_BAD_CMD;
  const partition = buf[3];
  switch (buf[4]) {
    case SF_RP_QUERY:
      if (partition !== 0xff) return PDS_BAD_CMD;
      s.out.reset();
      s.out.push(AID_SF);
      for (const code of REPLIES) queryReply(s, code);
      queryReplyEnd(s);
      break;
    case SF_RP_QLIST:
      if (partition !== 0xff) return PDS_BAD_CMD;
      if (buf.length < 6) return PDS_BAD_CMD;
      s.out.reset();
      s.out.push(AID_SF);
      switch (buf[5]) {
        case SF_RPQ_LIST: {
          if (buf.length < 7) {
            queryReply(s, QR_NULL);
            break;
          }
          const wanted = buf.subarray(6);
          let any = false;
          for (const code of REPLIES) {
            if (!wanted.includes(code)) continue;
            queryReply(s, code);
            any = true;
          }
          if (!any) queryReply(s, QR_NULL);
          break;
        }
        case SF_RPQ_EQUIV:
        case SF_RPQ_ALL:
          for (const code of REPLIES) queryReply(s, code);
          break;
        default:
          return PDS_BAD_CMD;
      }
      queryReplyEnd(s);
      break;
    case SNA_CMD_RMA:
      if (partition !== 0x00) return PDS_BAD_CMD;
      readModified(s, AID_QREPLY, true);
      break;
    case SNA_CMD_RB:
      if (partition !== 0x00) return PDS_BAD_CMD;
      readBuffer(s, AID_QREPLY);
      break;
    case SNA_CMD_RM:
      if (partition !== 0x00) return PDS_BAD_CMD;
      readModified(s, AID_QREPLY, false);
      break;
    default:
      return PDS_BAD_CMD;
  }
  return PDS_OKAY_OUTPUT;
}

/** @param {State} s @param {number} v */
function push16(s, v) {
  s.out.push((v >> 8) & 0xff, v & 0xff);
}

/** @param {State} s @param {number} v */
function push32(s, v) {
  s.out.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
}

/** do_query_reply(): one query reply, length first. @param {State} s @param {number} code */
function queryReply(s, code) {
  const start = s.out.length;
  s.out.push(0, 0, 0x81, code);
  switch (code) {
    case 0x80:
      s.out.push(...REPLIES);
      break;
    case 0x81:
      s.out.push(0x01, 0x00);
      push16(s, s.maxCols);
      push16(s, s.maxRows);
      s.out.push(0x01);
      push32(s, XR_3279_2);
      push32(s, YR_3279_2);
      s.out.push(SW_3279_2, SH_3279_2);
      push16(s, s.maxCols * s.maxRows);
      break;
    case 0x84:
      s.out.push(0);
      push16(s, s.maxRows * s.maxCols);
      s.out.push(0);
      break;
    case 0x85:
      s.out.push(
        0x82,
        0x00,
        SW_3279_2,
        SH_3279_2,
        0x00,
        0x00,
        0x00,
        0x00,
        0x07,
        0x00,
        0x10,
        0x00,
      );
      push32(s, s.codePage.cgcsgid);
      s.out.push(0x01, 0x00, 0xf1, 0x03, 0xc3, 0x01, 0x36);
      break;
    case 0x86:
      s.out.push(0x00, 16, 0x00, 0xf4);
      for (let i = 0xf1; i < 0xf1 + 15; i++)
        s.out.push(i, s.mode3279 ? i : 0x00);
      break;
    case 0x87:
      s.out.push(5, 0x00, 0xf0, 0xf1, 0xf1, 0xf2, 0xf2, 0xf4, 0xf4, 0xf8, 0xf8);
      break;
    case 0x88:
      s.out.push(SF_SRM_FIELD, SF_SRM_XFIELD, SF_SRM_CHAR);
      break;
    case 0x95:
      push16(s, 0);
      push16(s, s.options.ftBufferSize);
      push16(s, s.options.ftBufferSize);
      push16(s, 0x0101);
      break;
    case 0xa1:
      push32(s, 0);
      push32(s, 0);
      s.out.push(6, 0xa7, 0xf3, 0xf2, 0xf7, 0xf0);
      break;
    case 0xa6:
      s.out.push(0x00, 0x00, 0x0b, 0x01, 0x00);
      push16(s, 80);
      push16(s, 24);
      push16(s, s.maxCols);
      push16(s, s.maxRows);
      break;
  }
  const len = s.out.length - start;
  s.out.bytes[start] = (len >> 8) & 0xff;
  s.out.bytes[start + 1] = len & 0xff;
}

/** @param {State} s */
function queryReplyEnd(s) {
  netOutput(s);
  kybdInhibit(s, true);
}

/** sf_erase_reset() @param {State} s @param {Uint8Array} buf */
function eraseReset(s, buf) {
  if (buf.length !== 4) return PDS_BAD_CMD;
  switch (buf[3]) {
    case SF_ER_DEFAULT:
      erase(s, false);
      return PDS_OKAY_NO_OUTPUT;
    case SF_ER_ALT:
      erase(s, true);
      return PDS_OKAY_NO_OUTPUT;
    default:
      return PDS_BAD_CMD;
  }
}

/** sf_set_reply_mode() @param {State} s @param {Uint8Array} buf */
function setReplyMode(s, buf) {
  if (buf.length < 5) return PDS_BAD_CMD;
  if (buf[3] !== 0x00) return PDS_BAD_CMD;
  const mode = buf[4];
  if (mode !== SF_SRM_FIELD && mode !== SF_SRM_XFIELD && mode !== SF_SRM_CHAR)
    return PDS_BAD_CMD;
  s.replyMode = mode;
  if (mode === SF_SRM_CHAR) {
    s.crmNattr = buf.length - 5;
    s.crmAttr = buf.slice(5);
  }
  return PDS_OKAY_NO_OUTPUT;
}

/** sf_create_partition(): only partition 0 exists; the checks are x3270's. @param {State} s @param {Uint8Array} buf */
function createPartition(s, buf) {
  if (buf.length > 3 && buf[3] !== 0x00) return PDS_BAD_CMD;
  if (buf.length > 4) {
    const uom = (buf[4] & 0xf0) >> 4;
    if (uom !== 0x0 && uom !== 0x02) return PDS_BAD_CMD;
    if ((buf[4] & 0x0f) > 0x2) return PDS_BAD_CMD;
  }
  cursorMove(s, 0);
  s.bufferAddr = 0;
  return PDS_OKAY_NO_OUTPUT;
}

/** sf_outbound_ds() @param {State} s @param {Uint8Array} buf */
function outboundDs(s, buf) {
  if (buf.length < 5) return PDS_BAD_CMD;
  if (buf[3] !== 0x00) return PDS_BAD_CMD;
  switch (buf[4]) {
    case SNA_CMD_W:
    case SNA_CMD_EW:
    case SNA_CMD_EWA: {
      if (buf[4] !== SNA_CMD_W) erase(s, s.screenAlt);
      if (buf.length <= 5) break;
      const rv = write(s, buf.subarray(4), buf[4] !== SNA_CMD_W);
      if (rv < 0) return rv;
      break;
    }
    case SNA_CMD_EAU:
      eraseAllUnprotected(s);
      break;
    default:
      return PDS_BAD_CMD;
  }
  return PDS_OKAY_NO_OUTPUT;
}
