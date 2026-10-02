import { createServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Replays a recorded x3270 trace; a port of x3270's Common/Test/playback.py.
 * `< 0xADDR <hex>` lines are host bytes; a record ends with TELNET EOR `ff ef`.
 */

const IAC_DO_TIMING_MARK = Buffer.from([0xff, 0xfd, 0x06]);
const IAC_WONT_TIMING_MARK = "fffc06";

/** The fake host's self-signed certificate, for an emulator's caFile. */
export const FAKEHOST_CA = fileURLToPath(
  new URL("tls/fakehost.crt", import.meta.url),
);

/**
 * @param {string} file
 * @returns {string[]} hex payloads, in order
 */
export function parseTrace(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  /** @type {string[]} */
  const payloads = [];
  for (const line of lines) {
    if (!/^< 0x[0-9a-f]+ +/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const hex = parts[2];
    if (hex) payloads.push(hex);
  }
  return payloads;
}

export class FakeHost {
  /**
   * @param {string} traceFile
   * @param {number} [port] 0 picks a free port.
   * @param {{ tls?: boolean }} [options] tls serves TLS with FAKEHOST_CA.
   * @returns {Promise<FakeHost>}
   */
  static async listen(traceFile, port = 0, options = {}) {
    const host = new FakeHost(traceFile, options);
    await new Promise((resolve, reject) => {
      host.server.once("error", reject);
      host.server.listen(port, "127.0.0.1", () => {
        host.server.removeListener("error", reject);
        resolve(undefined);
      });
    });
    return host;
  }

  /** @param {string} traceFile @param {{ tls?: boolean }} [options] */
  constructor(traceFile, { tls = false } = {}) {
    /** @type {string[]} */
    this.payloads = parseTrace(traceFile);
    /** @type {number} */
    this.cursor = 0;
    /** @type {import('node:net').Socket | null} */
    this.socket = null;
    /** @type {string} */
    this.received = "";
    /** @type {Array<() => void>} */
    this.waiters = [];

    /** @param {import('node:net').Socket} socket */
    const onConnection = (socket) => {
      this.socket = socket;
      // A record and the timing mark after it are two small writes; Nagle would hold the second
      // for the delayed ACK of the first, 40 ms a step.
      socket.setNoDelay(true);
      socket.on("data", (chunk) => {
        this.received += chunk.toString("hex");
        this.wake();
      });
      socket.on("error", () => {});
      socket.on("close", () => this.wake());
      this.wake();
    };
    this.server = tls
      ? createTlsServer(
          {
            key: readFileSync(new URL("tls/fakehost.key", import.meta.url)),
            cert: readFileSync(FAKEHOST_CA),
          },
          onConnection,
        )
      : createServer(onConnection);
  }

  /** Rechecks every waitUntil now, for a change that came from elsewhere than the socket. */
  wake() {
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** @returns {number} */
  get port() {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("FakeHost is not listening on a TCP port");
    }
    return address.port;
  }

  /**
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async waitForConnection(timeoutMs = 5000) {
    await this.waitUntil(
      () => this.socket !== null,
      timeoutMs,
      "emulator did not connect",
    );
  }

  /**
   * @param {number} [count]
   * @returns {Promise<void>}
   */
  async sendRecords(count = 1) {
    await this.waitForConnection();
    const socket = this.socket;
    if (socket === null) throw new Error("no connection");

    let remaining = count;
    while (remaining > 0 && this.cursor < this.payloads.length) {
      const hex = this.payloads[this.cursor++];
      socket.write(Buffer.from(hex, "hex"));
      if (hex.endsWith("ffef")) remaining--;
    }
    if (remaining > 0)
      throw new Error(`trace ran out before ${count} record(s) were sent`);

    await this.sendTimingMark();
  }

  /**
   * The only reliable way to know the emulator consumed everything: it must answer WONT.
   * @returns {Promise<void>}
   */
  async sendTimingMark() {
    const socket = this.socket;
    if (socket === null) throw new Error("no connection");
    const before = this.received.length;
    socket.write(IAC_DO_TIMING_MARK);
    await this.waitUntil(
      () => this.received.slice(before).endsWith(IAC_WONT_TIMING_MARK),
      5000,
      "emulator did not answer the timing mark",
    );
  }

  /**
   * @param {() => boolean} predicate
   * @param {number} timeoutMs
   * @param {string} message
   * @returns {Promise<void>}
   */
  async waitUntil(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`FakeHost: ${message}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    }
  }

  /** @returns {Promise<void>} */
  async close() {
    if (this.socket !== null) {
      this.socket.destroy();
      this.socket = null;
    }
    await new Promise((resolve) => this.server.close(() => resolve(undefined)));
  }
}

// Also runnable directly: npm run fakehost
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))
) {
  const args = process.argv.slice(2);
  const tls = args.includes("--tls");
  const [traceFile, portArg] = args.filter((arg) => arg !== "--tls");
  if (traceFile) {
    const host = await FakeHost.listen(
      traceFile,
      portArg ? Number(portArg) : 4001,
      { tls },
    );
    process.stdout.write(
      `fake host replaying ${traceFile} on 127.0.0.1:${host.port}${tls ? " over TLS" : ""}\n`,
    );

    // The whole trace from the top per connection: a reconnect would otherwise
    // hang in telnet negotiation with nothing to draw.
    host.server.on(tls ? "secureConnection" : "connection", (socket) => {
      for (const hex of host.payloads) socket.write(Buffer.from(hex, "hex"));
      process.stdout.write(
        `emulator connected; sent ${host.payloads.length} payload(s)\n`,
      );
    });
  }
}
