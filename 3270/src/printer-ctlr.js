import { CS_BASE, CS_GE, ebcdicToUnicode } from "./charset.js";

// Port of pr3287's Common/pr3287/ctlr.c and sf.c with pr3287's default options: the 3270 and
// SCS data streams laid out as plain text pages. Text is kept as code points rather than the
// locale's bytes, so it comes out as UTF-8 whatever the host's code page.

export const PDS_OKAY_NO_OUTPUT = 0;
export const PDS_OKAY_OUTPUT = 1;
export const PDS_BAD_CMD = -1;

const MAX_UNF_MPP = 256;
const MAX_BUF = MAX_UNF_MPP * MAX_UNF_MPP;
const UNF_MPP = 132;
const MAX_MPP = 132;
const MAX_MPL = 108;
const LINE_LENGTHS = [132, 40, 64, 80];

const VISIBLE = 0x01;
const INVISIBLE = 0x02;
const FCORDER_NOP = 0x01;
const FF = 0x0c;
const CR = 0x0d;
const NL = 0x15;
const EM = 0x19;

/** Bytes past a record's end read as zeros, as they did in pr3287's buffers. */
const SLACK = 1024;

export class PrinterCtlr {
  /** @param {import("./charset.js").CodePage} cp */
  constructor(cp) {
    this.cp = cp;
    /** Text for the job, not yet taken. */
    this.out = "";
    /** A job has had output since the last end of job: pr3287's open print command. */
    this.jobOpen = false;
    /** A query reply waiting to go to the host, without TELNET framing. @type {number[] | null} */
    this.reply = null;

    this.page = new Uint32Array(MAX_BUF);
    this.baddr = 0;
    this.pageInitted = false;
    this.any3270Printable = false;
    this.any3270Output = false;
    this.wccLineLength = 0;
    this.lineLength = UNF_MPP;
    this.defaultCs = 0;

    /** @type {string[]} */
    this.uoData = [];
    this.uoCol = 0;
    this.uoMaxcol = 0;

    /** @type {number[]} */
    this.linebuf = Array(MAX_MPP + 2).fill(0x20);
    /** @type {number[][]} */
    this.trnbuf = Array.from({ length: MAX_MPP + 2 }, () => []);
    this.htabs = new Uint8Array(MAX_MPP + 1);
    this.vtabs = new Uint8Array(MAX_MPL + 1);
    this.lm = 1;
    this.tm = 1;
    this.bm = 1;
    this.mpp = MAX_MPP;
    this.mpl = 1;
    this.scsAny = false;
    this.pp = 1;
    this.line = 1;
    this.scsInitted = false;
    this.anyScsOutput = false;
    /** @type {Uint8Array} */
    this.scsLeftover = new Uint8Array(0);
    this.scsDbcsSubfield = 0;
    this.scsCs = 0;
  }

  /** The text produced since the last call. */
  take() {
    const text = this.out;
    this.out = "";
    return text;
  }

  /** @param {string} s */
  stash(s) {
    this.jobOpen = true;
    this.out += s;
  }

  /** process_ds(): a 3270 command, without its TN3270E header. @param {Uint8Array} record */
  processDs(record) {
    if (!record.length) return PDS_OKAY_NO_OUTPUT;
    switch (record[0]) {
      case 0x0f:
      case 0x6f:
        this.erase();
        return PDS_OKAY_NO_OUTPUT;
      case 0x0d:
      case 0x7e:
      case 0x05:
      case 0xf5:
        this.erase();
        this.baddr = 0;
        this.write(record);
        return PDS_OKAY_NO_OUTPUT;
      case 0x01:
      case 0xf1:
        this.write(record);
        return PDS_OKAY_NO_OUTPUT;
      case 0x11:
      case 0xf3:
        return this.writeStructuredField(record);
      case 0x03:
        return PDS_OKAY_NO_OUTPUT;
      default:
        return PDS_BAD_CMD;
    }
  }

  /** ctlr_write(): buf starts with the command, then the WCC. @param {Uint8Array} record */
  write(record) {
    const len = record.length;
    if (len < 2) return;
    const buf = padded(record);
    if (!this.pageInitted) {
      this.page.fill(0);
      this.pageInitted = true;
      this.baddr = 0;
    }
    this.defaultCs = 0;
    this.wccLineLength = buf[1] & 0x30;
    this.lineLength = LINE_LENGTHS[this.wccLineLength >> 4];
    const startField = (/** @type {number} */ fa) =>
      this.add((fa & 0x0c) === 0x0c ? INVISIBLE : VISIBLE);
    for (let i = 2; i < len; i++) {
      const c = buf[i];
      switch (c) {
        case 0x1d: // SF
          i++;
          startField(buf[i]);
          break;
        case 0x11: {
          // SBA
          i += 2;
          const xbaddr = decodeBaddr(buf[i - 1], buf[i]);
          if (xbaddr >= MAX_BUF) {
            this.baddr = 0;
            return;
          }
          if (this.wccLineLength) this.baddr = xbaddr;
          else while (this.baddr < xbaddr) this.add(0x20);
          break;
        }
        case 0x13: // IC
        case 0x05: // PT
          break;
        case 0x3c: {
          // RA
          i += 2;
          const xbaddr = decodeBaddr(buf[i - 1], buf[i]);
          i++;
          const ge = buf[i] === 0x08;
          if (ge) i++;
          const r = buf[i];
          // pr3287 lets the address be MAX_BUF, which it never reaches: it loops forever.
          if (xbaddr >= MAX_BUF || xbaddr < this.baddr) {
            this.baddr = 0;
            return;
          }
          let u;
          if (r === FF || r === CR || r === NL || r === EM) u = r;
          else if (r <= 0x3f) u = 0;
          else u = ebcdicToUnicode(this.cp, r, ge ? CS_GE : CS_BASE);
          while (this.baddr < xbaddr) this.add(u);
          break;
        }
        case 0x12: // EUA
          i += 2;
          break;
        case 0x08: // GE
          i++;
          this.add(ebcdicToUnicode(this.cp, buf[i], CS_GE));
          break;
        case 0x2c: // MF
          i++;
          i += buf[i] * 2;
          break;
        case 0x29: {
          // SFE
          i++;
          const pairs = buf[i];
          let anyFa = false;
          for (let n = 0; n < pairs; n++) {
            i++;
            if (buf[i] === 0xc0) {
              i++;
              startField(buf[i]);
              anyFa = true;
            } else i++;
          }
          if (!anyFa) startField(0);
          this.add(0);
          break;
        }
        case 0x28: // SA
          i++;
          if (buf[i] === 0x00) this.defaultCs = 0;
          else if (buf[i] === 0x43)
            this.defaultCs = buf[i + 1] === 0xf1 ? 1 : 0;
          i++;
          break;
        case FF:
        case CR:
        case NL:
        case EM:
          this.add(c);
          break;
        case 0x1c: // DUP
          this.add(0x2a);
          break;
        case 0x1e: // FM
          this.add(0x3b);
          break;
        default:
          if (c <= 0x3f) this.add(0);
          else this.add(ebcdicToUnicode(this.cp, c, this.defaultCs));
      }
    }
  }

  /** ctlr_add() @param {number} u */
  add(u) {
    let c = u;
    if (c < 0x20) {
      if (this.wccLineLength) {
        if (c !== FF && c !== VISIBLE && c !== INVISIBLE) c = 0;
      } else if (c !== CR && c !== NL && c !== FF && c !== EM) c = 0x20;
    }
    this.page[this.baddr] = c;
    this.baddr = (this.baddr + 1) % MAX_BUF;
    this.any3270Output = true;
    // pr3287's -emflush, on by default: each unformatted EM prints at once.
    if (!this.wccLineLength && c === EM) {
      this.dumpUnformatted();
      this.baddr = 1;
      this.any3270Output = false;
    }
  }

  /** ctlr_erase() */
  erase() {
    if (this.wccLineLength) this.dumpFormatted();
    else this.dumpUnformatted();
    if (this.anyScsOutput) this.dumpScsLine(true, false);
    this.page.fill(0);
    this.any3270Output = false;
    this.baddr = 0;
  }

  /** print_eoj(): prints what is pending; true when that ended a job that had output. */
  printEoj() {
    if (this.any3270Output) {
      if (this.wccLineLength) this.dumpFormatted();
      else this.dumpUnformatted();
    }
    if (this.anyScsOutput) this.dumpScsLine(true, false);
    const ended = this.jobOpen;
    this.jobOpen = false;
    this.pageInitted = false;
    this.any3270Printable = false;
    return ended;
  }

  /** print_unbind(): the next SCS job starts on a fresh virtual printer. */
  unbind() {
    this.scsInitted = false;
  }

  /**
   * uoutput(): one character of unformatted output, a line at a time. A CR goes back to the
   * start of the line the way a printer does, so later spaces don't overwrite what's there.
   * @param {string} c
   */
  uoutput(c) {
    if (c === "\r") {
      this.uoCol = 0;
    } else if (c === "\n" || c === "\f") {
      for (let i = 0; i < this.uoMaxcol; i++) this.stash(this.uoData[i]);
      this.stash(c);
      this.uoCol = this.uoMaxcol = 0;
    } else {
      if (c !== " " || this.uoCol >= this.uoMaxcol) this.uoData[this.uoCol] = c;
      this.uoCol++;
      if (c !== " ") this.any3270Printable = true;
      if (this.uoCol > this.uoMaxcol) this.uoMaxcol = this.uoCol;
    }
  }

  /** dump_unformatted(): the page as a stream with CR, NL, FF and EM controls. */
  dumpUnformatted() {
    if (!this.any3270Output) return;
    let prcol = 0;
    let done = false;
    for (let i = 0; i < MAX_BUF && !done; i++) {
      const c = this.page[i];
      switch (c) {
        case 0:
        case FCORDER_NOP:
          break;
        case CR:
          this.uoutput("\r");
          prcol = 0;
          break;
        case NL:
          this.uoutput("\n");
          prcol = 0;
          break;
        case FF:
          this.uoutput("\f");
          prcol = 0;
          break;
        case EM:
          if (prcol !== 0) this.uoutput("\n");
          done = true;
          break;
        default:
          if (++prcol > UNF_MPP) {
            this.uoutput("\n");
            prcol = 0;
          }
          this.uoutput(String.fromCodePoint(c));
      }
    }
    if (!done) this.uoutput("\n");
    this.page.fill(0);
    this.uoData = [];
    this.uoCol = this.uoMaxcol = 0;
    this.any3270Output = false;
  }

  /**
   * dump_formatted(): the page as lines of the WCC's length, trailing blanks and empty lines
   * dropped, invisible fields printed as spaces.
   */
  dumpFormatted() {
    if (!this.any3270Output) return;
    let visible = true;
    let newlines = 0;
    let dataWithoutNewline = false;
    let at = 0;
    for (let i = 0; i < MAX_UNF_MPP; i++) {
      let blanks = 0;
      let anyData = false;
      for (let j = 0; j < this.lineLength && at < MAX_BUF; j++) {
        const c = this.page[at++];
        switch (c) {
          case VISIBLE:
            visible = true;
            blanks++;
            break;
          case INVISIBLE:
            visible = false;
            blanks++;
            break;
          case FF:
            if (newlines) {
              this.stash("\n".repeat(newlines));
              newlines = 0;
              dataWithoutNewline = false;
            }
            this.stash("\f");
            blanks++;
            break;
          case 0:
            blanks++;
            break;
          case 0x20:
            blanks++;
            anyData = true;
            dataWithoutNewline = true;
            break;
          default:
            if (newlines) {
              this.stash("\n".repeat(newlines));
              newlines = 0;
            }
            if (blanks) {
              this.stash(" ".repeat(blanks));
              blanks = 0;
            }
            anyData = true;
            dataWithoutNewline = true;
            this.stash(visible ? String.fromCodePoint(c) : " ");
            if (visible) this.any3270Printable = true;
        }
      }
      if (anyData) newlines++;
    }
    if (dataWithoutNewline) this.stash("\n");
    this.page.fill(0);
    this.any3270Output = false;
  }

  // The SCS virtual 3287. Columns and lines count from 1, as in pr3287.

  initScsHoriz() {
    this.mpp = MAX_MPP;
    this.lm = 1;
    this.htabs.fill(0);
    this.htabs[1] = 1;
  }

  initScsVert() {
    this.mpl = 1;
    this.tm = 1;
    this.bm = this.mpl;
    // pr3287 sets the first tab stop, then clears every one.
    this.vtabs.fill(0);
  }

  initScs() {
    if (this.scsInitted) return;
    this.initScsHoriz();
    this.initScsVert();
    this.pp = 1;
    this.line = 1;
    this.scsAny = false;
    this.linebuf.fill(0x20);
    for (const trn of this.trnbuf) trn.length = 0;
    this.scsLeftover = new Uint8Array(0);
    this.scsDbcsSubfield = 0;
    this.scsCs = 0;
    this.scsInitted = true;
  }

  /**
   * dump_scs_line(): prints the line without its trailing spaces, then a newline if there
   * was anything or always_nl asks for one.
   * @param {boolean} resetPp @param {boolean} alwaysNl
   */
  dumpScsLine(resetPp, alwaysNl) {
    let anyData = false;
    let last = this.mpp;
    while (
      last >= 1 &&
      this.trnbuf[last].length === 0 &&
      this.linebuf[last] === 0x20
    )
      last--;
    if (last >= 1) {
      for (let j = 1; j <= last; j++) {
        if (this.trnbuf[j].length) {
          this.stash(String.fromCharCode(...this.trnbuf[j]));
          this.trnbuf[j].length = 0;
        }
        if (j < last || this.linebuf[j] !== 0x20) {
          if (this.linebuf[j] === FCORDER_NOP) continue;
          anyData = true;
          this.scsAny = true;
          this.stash(
            this.linebuf[j] ? String.fromCodePoint(this.linebuf[j]) : " ",
          );
        }
      }
      this.linebuf.fill(0x20);
    }
    if (anyData || alwaysNl) {
      this.stash("\n");
      this.line++;
    }
    if (resetPp) this.pp = this.lm;
    this.anyScsOutput = false;
  }

  /** scs_formfeed(): with a page length set, newlines to the next page's top margin. @param {boolean} explicit */
  scsFormfeed(explicit) {
    if (explicit) this.scsAny = false;
    if (this.mpl > 1) {
      while (this.line <= this.mpl) {
        this.stash("\n");
        this.line++;
      }
      this.line = 1;
      while (this.line < this.tm) {
        this.stash("\n");
        this.line++;
      }
    } else this.line = 1;
  }

  /** add_scs(): a printable character, wrapping at the MPP and paging at the bottom margin. @param {number} u */
  addScs(u) {
    if (this.line > this.bm) this.scsFormfeed(false);
    if (this.pp > this.mpp) this.dumpScsLine(true, true);
    if (u !== 0x20) this.linebuf[this.pp] = u;
    this.pp++;
    this.anyScsOutput = true;
  }

  /**
   * process_scs(): SCS orders may straddle records, so an incomplete one waits for the next.
   * @param {Uint8Array} record
   */
  processScs(record) {
    const len = this.scsLeftover.length + record.length;
    const buf = new Uint8Array(len + SLACK);
    buf.set(this.scsLeftover);
    buf.set(record, this.scsLeftover.length);
    this.scsLeftover = new Uint8Array(0);
    this.initScs();
    const leftover = (/** @type {number} */ from) => {
      this.scsLeftover = buf.slice(from, len);
      return len;
    };
    for (let i = 0; i < len; i++) {
      const c = buf[i];
      switch (c) {
        case 0x16: // BS
          if (this.pp !== 1) this.pp--;
          if (this.scsDbcsSubfield && this.pp !== 1) this.pp--;
          break;
        case 0x0d: // CR
          this.pp = this.lm;
          break;
        case 0x14: // ENP
        case 0x24: // INP
          break;
        case 0x0c: // FF
          this.dumpScsLine(true, false);
          this.scsFormfeed(true);
          break;
        case 0x05: {
          // HT
          let t = this.pp + 1;
          while (t <= this.mpp && !this.htabs[t]) t++;
          if (t <= this.mpp) this.pp = t;
          else this.addScs(0x20);
          break;
        }
        case 0x1e: // IRS
        case 0x15: // NL
          this.dumpScsLine(true, true);
          break;
        case 0x0b: {
          // VT
          let t = this.line + 1;
          while (t <= MAX_MPL && !this.vtabs[t]) t++;
          if (t <= MAX_MPL) {
            this.dumpScsLine(false, true);
            while (this.line < t) {
              this.stash("\n");
              this.line++;
            }
          } else this.dumpScsLine(false, true);
          break;
        }
        case 0x04: // VCS
        case 0x25: // LF
          this.dumpScsLine(false, true);
          break;
        case 0x08: // GE
          if (i + 1 >= len) {
            i = leftover(i);
            break;
          }
          i++;
          this.addScs(0x20);
          break;
        case 0x28: // SA
          if (i + 2 >= len) {
            i = leftover(i);
            break;
          }
          if (buf[i + 1] === 0x00) {
            this.scsDbcsSubfield = 0;
            this.scsCs = 0;
          } else if (buf[i + 1] === 0x42 && this.scsCs !== buf[i + 2]) {
            if (this.scsCs === 0xf8) this.scsDbcsSubfield = 0;
            else if (buf[i + 2] === 0xf8) this.scsDbcsSubfield = 1;
            this.scsCs = buf[i + 2];
          }
          i += 2;
          break;
        case 0x35: {
          // TRN: bytes passed through untranslated
          if (i + 1 >= len) {
            i = leftover(i);
            break;
          }
          i++;
          const cnt = buf[i];
          if (i + cnt - 1 >= len) {
            i = leftover(i - 1);
            break;
          }
          this.trnbuf[this.pp].push(...buf.subarray(i + 1, i + 1 + cnt));
          this.anyScsOutput = true;
          i += cnt;
          this.scsDbcsSubfield = 0;
          break;
        }
        case 0x2b: // SET
          if (i + 2 >= len || i + buf[i + 2] - 1 >= len) {
            i = leftover(i);
            break;
          }
          i = this.scsSet(buf, len, i + 1);
          break;
        case 0x0e: // SO
          this.scsDbcsSubfield = 1;
          break;
        case 0x0f: // SI
          this.scsDbcsSubfield = 0;
          break;
        default:
          if (c <= 0x3f) this.addScs(0x20);
          else this.addScs(ebcdicToUnicode(this.cp, c, CS_BASE));
      }
    }
    return PDS_OKAY_NO_OUTPUT;
  }

  /**
   * The SET orders after their first byte, at buf[i]: horizontal format (line length, left
   * margin, tabs), line density, vertical format (page length, margins, tabs). Returns
   * where it stopped reading, quirks and all, as process_scs_contig() leaves cp.
   * @param {Uint8Array} buf @param {number} len @param {number} i
   */
  scsSet(buf, len, i) {
    switch (buf[i]) {
      case 0xc1: {
        // SHF
        this.initScsHoriz();
        let cnt = buf[++i];
        if (cnt < 2) return i;
        if (!--cnt || i + 1 >= len) return i;
        this.mpp = buf[++i];
        if (!this.mpp || this.mpp > MAX_MPP) this.mpp = MAX_MPP;
        if (!--cnt || i + 1 >= len) return i;
        this.lm = buf[++i];
        if (this.lm < 1 || this.lm >= this.mpp) this.lm = 1;
        if (!--cnt || i + 1 >= len) return i;
        i++;
        while (--cnt && i + 1 < len) {
          const tab = buf[++i];
          if (tab >= 1 && tab <= this.mpp) this.htabs[tab] = 1;
        }
        return i;
      }
      case 0xc6: // SLD
        i++;
        if (i >= len || buf[i] !== 2) return i;
        return i + 1;
      case 0xc2: {
        // SVF
        this.initScsVert();
        i++;
        if (i >= len) return i;
        let cnt = buf[i];
        if (cnt < 2) return i;
        i++;
        cnt--;
        if (!cnt || i >= len) return i;
        this.mpl = buf[i];
        if (!this.mpl || this.mpl > MAX_MPL) this.mpl = 1;
        if (cnt < 2) {
          this.bm = this.mpl;
          return i;
        }
        i++;
        cnt--;
        if (!cnt || i >= len) return i;
        this.tm = buf[i];
        if (this.tm < 1 || this.tm >= this.mpl) this.tm = 1;
        if (cnt < 2) return i;
        i++;
        cnt--;
        if (!cnt || i >= len) return i;
        this.bm = buf[i];
        if (this.bm < this.tm || this.bm >= this.mpl) this.bm = this.mpl;
        if (cnt < 2) return i;
        i++;
        cnt--;
        while (cnt > 1 && i < len) {
          const tab = buf[i];
          // pr3287 checks vertical tabs against the line length.
          if (tab >= 1 && tab <= this.mpp) this.vtabs[tab] = 1;
          i++;
          cnt--;
        }
        return i;
      }
      default:
        return i + buf[i + 1];
    }
  }

  /** write_structured_field() from sf.c. @param {Uint8Array} record */
  writeStructuredField(record) {
    let at = 1;
    let left = record.length - 1;
    let rv = PDS_OKAY_NO_OUTPUT;
    let badCmd = false;
    while (left > 0) {
      if (left < 2) return rv || PDS_BAD_CMD;
      let fieldlen = (record[at] << 8) + record[at + 1];
      if (fieldlen === 0) fieldlen = left;
      if (fieldlen < 3 || fieldlen > left) return rv || PDS_BAD_CMD;
      const field = record.subarray(at, at + fieldlen);
      let rvThis = PDS_BAD_CMD;
      if (field[2] === 0x01) rvThis = this.sfReadPart(field);
      else if (field[2] === 0x03)
        rvThis =
          fieldlen === 4 && (field[3] === 0x00 || field[3] === 0x80)
            ? PDS_OKAY_NO_OUTPUT
            : PDS_BAD_CMD;
      else if (field[2] === 0x09)
        rvThis =
          fieldlen >= 5 && field[3] === 0x00 && field[4] <= 0x02
            ? PDS_OKAY_NO_OUTPUT
            : PDS_BAD_CMD;
      else if (field[2] === 0x40) rvThis = this.sfOutboundDs(field);
      if (rvThis < 0) badCmd = true;
      else rv |= rvThis;
      at += fieldlen;
      left -= fieldlen;
    }
    return badCmd && !rv ? PDS_BAD_CMD : rv;
  }

  /** @param {Uint8Array} field */
  sfOutboundDs(field) {
    if (field.length < 5 || field[3] !== 0x00) return PDS_BAD_CMD;
    const cmd = field[4];
    if (cmd === 0xf1 || cmd === 0xf5 || cmd === 0x7e) {
      if (field.length > 5) this.write(field.subarray(4));
      return PDS_OKAY_NO_OUTPUT;
    }
    return cmd === 0x6f ? PDS_OKAY_NO_OUTPUT : PDS_BAD_CMD;
  }

  /** Read Partition: only the queries get an answer, in this.reply. @param {Uint8Array} field */
  sfReadPart(field) {
    const len = field.length;
    if (len < 5) return PDS_BAD_CMD;
    const partition = field[3];
    /** @type {number[]} */
    let codes;
    if (field[4] === 0x02) {
      if (partition !== 0xff) return PDS_BAD_CMD;
      codes = SUPPORTED_REPLIES;
    } else if (field[4] === 0x03) {
      if (partition !== 0xff || len < 6) return PDS_BAD_CMD;
      const type = field[5];
      if (type === 0x00) {
        const asked = field.subarray(6);
        codes = SUPPORTED_REPLIES.filter((code) => asked.includes(code));
        if (codes.length === 0) codes = [0xff];
      } else if (type === 0x40 || type === 0x80) codes = SUPPORTED_REPLIES;
      else return PDS_BAD_CMD;
    } else return PDS_BAD_CMD;
    this.reply = [0x88, ...codes.flatMap((code) => this.queryReply(code))];
    return PDS_OKAY_OUTPUT;
  }

  /** do_query_reply(): one query reply structured field. @param {number} code */
  queryReply(code) {
    const be16 = (/** @type {number} */ n) => [(n >> 8) & 0xff, n & 0xff];
    /** @type {number[]} */
    let body;
    switch (code) {
      case 0x85: {
        const g = this.cp.cgcsgid;
        // GE and CGCSGID present, 10x20 cells, then the base set and the APL set.
        body = [0x82, 0x00, 10, 20, 0, 0, 0, 0, 0x07];
        body.push(
          0x00,
          0x10,
          0x00,
          g >>> 24,
          (g >> 16) & 0xff,
          (g >> 8) & 0xff,
          g & 0xff,
        );
        body.push(0x01, 0x10, 0xf1, 0x03, 0xc3, 0x01, 0x36);
        break;
      }
      case 0xa6:
        body = [
          0,
          0,
          0x0b,
          0x01,
          0x00,
          ...be16(72),
          ...be16(66),
          ...be16(66),
          ...be16(72),
        ];
        break;
      case 0xff:
        body = [];
        break;
      case 0x80:
        body = [...SUPPORTED_REPLIES];
        break;
      case 0x81:
        // 12/14-bit addressing, 66x72 in millimetres at x3270's made-up resolution.
        body = [0x01, 0x00, ...be16(66), ...be16(72), 0x01];
        body.push(
          ...be16(5),
          ...be16(252),
          ...be16(13),
          ...be16(594),
          10,
          20,
          ...be16(0),
        );
        break;
      case 0x86:
        body = [0x00, 16, 0x00, 0xf4];
        for (let c = 0xf1; c <= 0xff; c++) body.push(c, c);
        break;
      case 0x87:
        body = [5, 0x00, 0xf0, 0xf1, 0xf1, 0xf2, 0xf2, 0xf4, 0xf4, 0xf8, 0xf8];
        break;
      case 0x88:
        body = [0x00, 0x01, 0x02];
        break;
      case 0x84:
        body = [0, ...be16(72 * 66), 0];
        break;
      default:
        // 0x95, DDM
        body = [...be16(0), ...be16(2048), ...be16(2048), ...be16(0x0101)];
    }
    return [...be16(body.length + 4), 0x81, code, ...body];
  }
}

/** The query replies pr3287 gives with a single-byte code page, in its order. */
const SUPPORTED_REPLIES = [
  0x80, 0x81, 0x84, 0x85, 0x86, 0x87, 0x88, 0xa6, 0x95,
];

/** @param {number} c1 @param {number} c2 */
function decodeBaddr(c1, c2) {
  return (c1 & 0xc0) === 0
    ? ((c1 & 0x3f) << 8) | c2
    : ((c1 & 0x3f) << 6) | (c2 & 0x3f);
}

/** @param {Uint8Array} record */
function padded(record) {
  const buf = new Uint8Array(record.length + SLACK);
  buf.set(record);
  return buf;
}
