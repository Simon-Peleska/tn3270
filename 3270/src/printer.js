// pr3287's telnet.c: a TN3270E printer session, which hands the text it prints out as events.
import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { NodeError } from "./errors.js";
import { PDS_OKAY_NO_OUTPUT, PrinterCtlr } from "./printer-ctlr.js";

const IAC = 0xff;
const DONT = 0xfe;
const DO = 0xfd;
const WONT = 0xfc;
const WILL = 0xfb;
const SB = 0xfa;
const AO = 0xf5;
const EOR = 0xef;
const SE = 0xf0;

const BINARY = 0;
const ECHO = 1;
const SGA = 3;
const TM = 6;
const TTYPE = 24;
const TELOPT_EOR = 25;
const TN3270E = 40;

const TTYPE_IS = 0;
const TTYPE_SEND = 1;

const E_ASSOCIATE = 0;
const E_CONNECT = 1;
const E_DEVICE_TYPE = 2;
const E_FUNCTIONS = 3;
const E_IS = 4;
const E_REJECT = 6;
const E_REQUEST = 7;
const E_SEND = 8;

const FUNC_BIND_IMAGE = 0;
const FUNC_RESPONSES = 2;
const ALL_FUNCS = 0b11111;

const DT_3270_DATA = 0;
const DT_SCS_DATA = 1;
const DT_BIND_IMAGE = 3;
const DT_UNBIND = 4;
const DT_NVT_DATA = 5;
const DT_SSCP_LU_DATA = 7;
const DT_PRINT_EOJ = 8;

const RQ_ALWAYS_RESPONSE = 2;
const RSP_NEGATIVE = 1;
const NEG_COMMAND_REJECT = 0;

const TERMINAL_TYPE = "IBM-3287-1";

const enc = (/** @type {string} */ s) => [...Buffer.from(s, "latin1")];

/**
 * @typedef {object} PrinterOptions
 * @property {string} host
 * @property {number} port
 * @property {tls.ConnectionOptions | false} tls
 * @property {string | null} assoc the display's LU to associate with
 * @property {string | null} lu the printer LU to connect to, when not associating
 * @property {import("./charset.js").CodePage} codePage
 * @property {import("./session.js").Logger} log
 */

/**
 * A printer LU, as pr3287 runs it. Events: "data" (text printed so far),
 * "eoj" (a job with output ended), "close" (with a NodeError, or nothing when the host hung up).
 */
export class PrinterSession extends EventEmitter {
  /** @param {PrinterOptions} options */
  constructor(options) {
    super();
    this.options = options;
    this.log = options.log;
    this.ctlr = new PrinterCtlr(options.codePage);
    /** @type {boolean[]} */
    this.myopts = [];
    /** @type {boolean[]} */
    this.hisopts = [];
    this.inE = false;
    this.negotiated = false;
    this.bound = false;
    this.eFuncs = ALL_FUNCS;
    this.xmitSeq = 0;
    /** @type {number[]} */
    this.record = [];
    /** @type {number[]} */
    this.sb = [];
    /** "data", "iac", "will", "wont", "do", "dont", "sb", "sb-iac" */
    this.state = "data";
    /** @type {NodeError | undefined} */
    this.failure = undefined;

    const { host, port } = options;
    this.log.info(`printer connecting to ${host}:${port}`);
    this.socket = options.tls
      ? tls.connect({
          host,
          port,
          servername: net.isIP(host) ? undefined : host,
          ...options.tls,
        })
      : net.connect({ host, port });
    this.socket.setNoDelay(true);
    this.socket.on("data", (/** @type {Buffer} */ buf) => {
      for (const c of buf) {
        if (this.failure) return;
        this.input(c);
      }
    });
    this.socket.on("error", (e) => {
      this.failure ??= new NodeError(
        "N4001",
        `printer ${host}:${port}: ${e.message}`,
        e,
      );
    });
    this.socket.on("close", () => {
      if (this.failure) this.log.warn(`printer closed\n${this.failure.stack}`);
      else this.log.info("printer disconnected");
      this.endJob();
      this.emit("close", this.failure);
    });
  }

  close() {
    this.socket.destroy();
  }

  /** @param {NodeError} err */
  fail(err) {
    this.failure ??= err;
    this.socket.destroy();
  }

  /** Hands out what printEoj() flushed, then says the job is over. */
  endJob() {
    const ended = this.ctlr.printEoj();
    this.emitData();
    if (ended) this.emit("eoj");
  }

  emitData() {
    const text = this.ctlr.take();
    if (text) this.emit("data", text);
  }

  /** @param {number[]} bytes */
  send(bytes) {
    this.log.debug(`printer > ${Buffer.from(bytes).toString("hex")}`);
    this.socket.write(Buffer.from(bytes));
  }

  /** @param {number} c */
  input(c) {
    switch (this.state) {
      case "data":
        if (c === IAC) this.state = "iac";
        else this.record.push(c);
        return;
      case "iac":
        this.state = "data";
        if (c === IAC) this.record.push(IAC);
        else if (c === EOR) this.endOfRecord();
        else if (c === WILL) this.state = "will";
        else if (c === WONT) this.state = "wont";
        else if (c === DO) this.state = "do";
        else if (c === DONT) this.state = "dont";
        else if (c === SB) {
          this.sb = [];
          this.state = "sb";
        } else if (c === AO && this.in3270() && !this.inE) this.endJob();
        return;
      case "will":
        this.state = "data";
        if (![SGA, BINARY, TELOPT_EOR, TTYPE, ECHO, TN3270E].includes(c)) {
          this.send([IAC, DONT, c]);
          return;
        }
        if (this.hisopts[c]) return;
        this.hisopts[c] = true;
        this.send([IAC, DO, c]);
        if (c === TELOPT_EOR && !this.myopts[TELOPT_EOR]) {
          this.myopts[TELOPT_EOR] = true;
          this.send([IAC, WILL, TELOPT_EOR]);
        }
        this.checkMode();
        return;
      case "wont":
        this.state = "data";
        if (!this.hisopts[c]) return;
        this.hisopts[c] = false;
        this.send([IAC, DONT, c]);
        this.checkMode();
        return;
      case "do":
        this.state = "data";
        if (![BINARY, TELOPT_EOR, TTYPE, SGA, TM, TN3270E].includes(c)) {
          this.send([IAC, WONT, c]);
          return;
        }
        if (c === TM) {
          this.send([IAC, WILL, TM]);
          return;
        }
        if (this.myopts[c]) return;
        this.myopts[c] = true;
        this.send([IAC, WILL, c]);
        this.checkMode();
        return;
      case "dont":
        this.state = "data";
        if (!this.myopts[c]) return;
        this.myopts[c] = false;
        this.send([IAC, WONT, c]);
        this.checkMode();
        return;
      case "sb":
        if (c === IAC) this.state = "sb-iac";
        else this.sb.push(c);
        return;
      case "sb-iac":
        this.state = "sb";
        if (c === IAC) this.sb.push(IAC);
        else if (c === SE) {
          this.state = "data";
          this.subnegotiation(this.sb);
        }
        return;
    }
  }

  in3270() {
    return (
      this.inE ||
      (!!this.myopts[BINARY] &&
        !!this.myopts[TELOPT_EOR] &&
        !!this.myopts[TTYPE] &&
        !!this.hisopts[BINARY] &&
        !!this.hisopts[TELOPT_EOR])
    );
  }

  checkMode() {
    const wasE = this.inE;
    this.inE = !!this.myopts[TN3270E];
    if (wasE && !this.inE) {
      this.negotiated = false;
      this.bound = false;
      this.eFuncs = ALL_FUNCS;
    }
    this.log.debug(
      `printer mode: ${this.inE ? "TN3270E" : this.in3270() ? "3270" : "NVT"}`,
    );
    if (this.options.assoc && !this.inE && this.anyOptionSet())
      this.fail(
        new NodeError(
          "N4002",
          "Host does not support TN3270E, cannot associate with specified LU",
        ),
      );
  }

  /** NVT is only a mode once something was negotiated: before that the session is starting. */
  anyOptionSet() {
    return this.myopts.some(Boolean) || this.hisopts.some(Boolean);
  }

  /** @param {number[]} sb */
  subnegotiation(sb) {
    this.log.debug(`printer < sb ${Buffer.from(sb).toString("hex")}`);
    if (sb[0] === TTYPE && sb[1] === TTYPE_SEND) {
      const lu = this.options.lu ? `@${this.options.lu}` : "";
      this.send([
        IAC,
        SB,
        TTYPE,
        TTYPE_IS,
        ...enc(TERMINAL_TYPE + lu),
        IAC,
        SE,
      ]);
      return;
    }
    if (sb[0] !== TN3270E || !this.myopts[TN3270E]) return;
    const op = sb[1];
    if (op === E_SEND && sb[2] === E_DEVICE_TYPE) {
      const { assoc, lu } = this.options;
      const target = assoc
        ? [E_ASSOCIATE, ...enc(assoc)]
        : lu
          ? [E_CONNECT, ...enc(lu)]
          : [];
      this.send([
        IAC,
        SB,
        TN3270E,
        E_DEVICE_TYPE,
        E_REQUEST,
        ...enc(TERMINAL_TYPE),
        ...target,
        IAC,
        SE,
      ]);
      return;
    }
    if (op === E_DEVICE_TYPE && sb[2] === E_IS) {
      const rest = Buffer.from(sb.slice(3)).toString("latin1");
      const [type, lu] = rest.split("\x01");
      this.log.info(`printer is ${type}${lu ? ` on LU ${lu}` : ""}`);
      this.sendFunctions(E_REQUEST);
      return;
    }
    if (op === E_DEVICE_TYPE && sb[2] === E_REJECT) {
      const what = this.options.assoc ? "associate with" : "connect to";
      this.fail(
        new NodeError(
          "N4003",
          `Cannot ${what} specified LU (reason ${sb[4] ?? "?"})`,
        ),
      );
      return;
    }
    if (op === E_FUNCTIONS) {
      let rcvd = 0;
      for (const f of sb.slice(3)) if (f < 5) rcvd |= 1 << f;
      if (sb[2] === E_REQUEST) {
        if (rcvd === this.eFuncs || this.eFuncs & ~rcvd) {
          this.eFuncs = rcvd;
          this.sendFunctions(E_IS);
          this.negotiated = true;
        } else {
          this.eFuncs &= rcvd;
          this.sendFunctions(E_REQUEST);
        }
        return;
      }
      if (sb[2] === E_IS) {
        if (rcvd & ~this.eFuncs) {
          this.send([IAC, WONT, TN3270E]);
          this.myopts[TN3270E] = false;
          this.checkMode();
          return;
        }
        this.eFuncs = rcvd;
        this.negotiated = true;
      }
    }
  }

  /** @param {number} how E_REQUEST or E_IS */
  sendFunctions(how) {
    const funcs = [0, 1, 2, 3, 4].filter((f) => this.eFuncs & (1 << f));
    this.send([IAC, SB, TN3270E, E_FUNCTIONS, how, ...funcs, IAC, SE]);
  }

  endOfRecord() {
    const record = Uint8Array.from(this.record);
    this.record = [];
    if (this.inE) {
      if (this.negotiated) this.eRecord(record);
    } else if (this.in3270()) {
      const rv = this.ctlr.processDs(record);
      this.emitData();
      this.sendReply(0, []);
      if (rv < 0) this.send([0x01, 0x6c, 0xd9, 0x04, 0x20, IAC, EOR]);
      else this.send([0x01, 0x6c, 0xd9, 0x02, 0x00, IAC, EOR]);
    }
  }

  /** A record behind its five-byte TN3270E header. @param {Uint8Array} record */
  eRecord(record) {
    if (record.length < 5) {
      this.log.warn(`N4004 printer record of ${record.length} bytes, ignored`);
      return;
    }
    const [dataType, , rsp, seq0, seq1] = record;
    const seq = [seq0, seq1];
    const data = record.subarray(5);
    switch (dataType) {
      case DT_3270_DATA:
      case DT_SCS_DATA: {
        if (this.eFuncs & (1 << FUNC_BIND_IMAGE) && !this.bound) return;
        const rv =
          dataType === DT_3270_DATA
            ? this.ctlr.processDs(data)
            : this.ctlr.processScs(data);
        this.emitData();
        // A reply carries the response, as pr3287 sends both while the record is processed.
        const responseRequired = this.sendReply(rsp, seq) ? 0 : rsp;
        if (rv < 0 && responseRequired !== 0) this.nak(seq);
        else if (
          rv === PDS_OKAY_NO_OUTPUT &&
          responseRequired === RQ_ALWAYS_RESPONSE
        )
          this.ack(seq);
        return;
      }
      case DT_BIND_IMAGE:
        if (!(this.eFuncs & (1 << FUNC_BIND_IMAGE))) return;
        this.bound = true;
        if (rsp) this.ack(seq);
        return;
      case DT_UNBIND:
        if (!(this.eFuncs & (1 << FUNC_BIND_IMAGE))) return;
        this.bound = false;
        this.endJob();
        if (rsp) this.ack(seq);
        this.ctlr.unbind();
        return;
      case DT_NVT_DATA:
      case DT_SSCP_LU_DATA:
        if (rsp) this.nak(seq);
        return;
      case DT_PRINT_EOJ:
        this.endJob();
        if (rsp) this.ack(seq);
        return;
    }
  }

  /** @param {number[]} seq */
  ack(seq) {
    this.send([0x02, 0x00, 0x00, ...this.seqBytes(seq), 0x00, IAC, EOR]);
  }

  /** @param {number[]} seq */
  nak(seq) {
    this.send([
      0x02,
      0x00,
      RSP_NEGATIVE,
      ...this.seqBytes(seq),
      NEG_COMMAND_REJECT,
      IAC,
      EOR,
    ]);
  }

  /** pr3287 only doubles an IAC in the second byte. @param {number[]} seq */
  seqBytes([seq0, seq1]) {
    return seq1 === IAC ? [seq0, seq1, IAC] : [seq0, seq1];
  }

  /** @param {number[]} bytes */
  doubled(bytes) {
    return bytes.flatMap((b) => (b === IAC ? [IAC, IAC] : [b]));
  }

  /**
   * Answers a Read Partition Query, acknowledging the record first when it asked to be.
   * @param {number} rsp @param {number[]} seq @returns {boolean} whether there was a reply
   */
  sendReply(rsp, seq) {
    const reply = this.ctlr.reply;
    if (!reply) return false;
    this.ctlr.reply = null;
    if (this.inE && rsp === RQ_ALWAYS_RESPONSE) this.ack(seq);
    const header = this.inE
      ? [0, 0, 0, (this.xmitSeq >> 8) & 0xff, this.xmitSeq & 0xff]
      : [];
    if (this.inE && this.eFuncs & (1 << FUNC_RESPONSES))
      this.xmitSeq = (this.xmitSeq + 1) & 0x7fff;
    this.send([...this.doubled([...header, ...reply]), IAC, EOR]);
    return true;
  }
}
