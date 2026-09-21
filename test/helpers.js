import { validateConfig } from "../server/config.js";
import { Session } from "../server/session.js";
import { FakeHost } from "./fakehost.js";

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {import('../server/config.js').Config}
 */
export function testConfig(overrides = {}) {
  return validateConfig({
    server: { host: "127.0.0.1", port: 8017 },
    // The traces were recorded against a model 4 (43x80).
    b3270: { path: "b3270", model: 4 },
    sessions: { idleTimeoutMs: 0 },
    logLevel: "error",
    ...overrides,
  });
}

/**
 * @typedef {{ kind: 'screen', bytes: string }
 *   | { kind: 'message', message: import('../server/protocol.js').ServerMessage }} ViewerEvent
 */

/**
 * `events` interleaves both kinds, so a test can check a resize arrives before
 * the bytes that assume it.
 *
 * @param {string} id
 * @returns {import('../server/session.js').Viewer & { screen: string[], messages: import('../server/protocol.js').ServerMessage[], events: ViewerEvent[] }}
 */
export function collectingViewer(id) {
  return {
    id,
    role: "observer",
    hostColors: true,
    /** @type {string | null} */
    fieldColor: null,
    ip: "127.0.0.1",
    /** @type {string[]} */
    screen: [],
    /** @type {import('../server/protocol.js').ServerMessage[]} */
    messages: [],
    /** @type {ViewerEvent[]} */
    events: [],
    sendScreen(bytes) {
      this.screen.push(bytes);
      this.events.push({ kind: "screen", bytes });
    },
    sendMessage(message) {
      this.messages.push(message);
      this.events.push({ kind: "message", message });
    },
  };
}

/**
 * @param {() => boolean} predicate
 * @param {string} message
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export async function waitUntil(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * b3270's stdout is one ordered stream: once our own run-result comes back,
 * every indication before it has been applied to the model.
 *
 * @param {import('../server/session.js').Session} session
 * @returns {Promise<void>}
 */
export function settle(session) {
  const b3270 = session.b3270;
  const previous = b3270.handlers.onIndication;
  return new Promise((resolve) => {
    /** @type {string} */
    let tag = "";
    b3270.handlers.onIndication = (indication) => {
      previous(indication);
      const body = /** @type {Record<string, unknown>} */ (indication.body);
      if (indication.kind === "run-result" && body["r-tag"] === tag) {
        b3270.handlers.onIndication = previous;
        resolve();
      }
    };
    tag = b3270.runActions([{ action: "Reset" }]);
  });
}

/**
 * @param {string} traceFile
 * @param {{ records?: number, config?: Record<string, unknown> }} [options]
 */
export async function startTracedSession(traceFile, options = {}) {
  const host = await FakeHost.listen(traceFile, 0);
  const session = new Session(testConfig(options.config));

  await session.ready;

  session.connect(`127.0.0.1:${host.port}`);
  await host.waitForConnection();
  await host.sendRecords(options.records ?? 1);

  return {
    host,
    session,
    /** @returns {Promise<void>} */
    async close() {
      session.close();
      await host.close();
    },
  };
}
