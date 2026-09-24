import { validateConfig } from "../server/config.js";
import { Session } from "../server/session.js";
import { FakeHost } from "./fakehost.js";
import { Grid } from "../public/grid.js";

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
 * `messages` is the whole ordered stream, paints included, so a test can check
 * that a resize arrives before the paint that assumes it. `grid` is the same
 * decoder the browser runs, fed every paint as it arrives.
 *
 * @param {string} id
 * @returns {import('../server/session.js').Viewer & { messages: import('../server/protocol.js').ServerMessage[], paints: import('../server/protocol.js').PaintMessage[], grid: Grid, closed: boolean }}
 */
export function collectingViewer(id) {
  return {
    id,
    role: "observer",
    ip: "127.0.0.1",
    /** @type {import('../server/protocol.js').ServerMessage[]} */
    messages: [],
    /** @type {import('../server/protocol.js').PaintMessage[]} */
    paints: [],
    grid: new Grid(1, 1),
    closed: false,
    sendMessage(message) {
      this.messages.push(message);
      if (message.type !== "paint") return;
      this.paints.push(message);
      this.grid.applyPaint(message);
    },
    close() {
      this.closed = true;
    },
  };
}

/**
 * Attaches a second viewer the way a browser does: it asks, the owner says yes.
 *
 * @param {import('../server/session.js').Session} session
 * @param {import('../server/session.js').Viewer} owner
 * @param {import('../server/session.js').Viewer} guest
 * @returns {void}
 */
export function letIn(session, owner, guest) {
  session.attach(guest);
  session.handleClientMessage(owner, {
    type: "answer",
    viewer: guest.id,
    allow: true,
  });
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
 * every indication before it has been applied to the model. Input the session
 * has queued goes first, or the Reset would overtake it.
 *
 * @param {import('../server/session.js').Session} session
 * @returns {Promise<void>}
 */
export async function settle(session) {
  await waitUntil(
    () => session.inputQueue.length === 0 && session.inputTag === null,
    "the queued input to run",
  );
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
