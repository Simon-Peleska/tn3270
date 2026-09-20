import { validateConfig } from '../server/config.js';
import { Session } from '../server/session.js';
import { FakeHost } from './fakehost.js';

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {import('../server/config.js').Config}
 */
export function testConfig(overrides = {}) {
  return validateConfig({
    server: { host: '127.0.0.1', port: 8017 },
    // The traces were recorded against a model 4 (43x80); see the `// rows 43`
    // header in each .trc file.
    b3270: { path: 'b3270', model: 4 },
    sessions: { idleTimeoutMs: 0 },
    logLevel: 'error',
    ...overrides,
  });
}

/**
 * @typedef {{ kind: 'screen', bytes: string }
 *   | { kind: 'message', message: import('../server/protocol.js').ServerMessage }} ViewerEvent
 */

/**
 * A viewer that records everything sent to it, so tests can assert on exactly
 * what a browser would have received. `events` keeps the two kinds interleaved,
 * which is the only way to check that a resize reaches the browser before the
 * bytes that assume it.
 *
 * @param {string} id
 * @returns {import('../server/session.js').Viewer & { screen: string[], messages: import('../server/protocol.js').ServerMessage[], events: ViewerEvent[] }}
 */
export function collectingViewer(id) {
  return {
    id,
    role: 'observer',
    hostColors: true,
    /** @type {string | null} */
    fieldColor: null,
    ip: '127.0.0.1',
    /** @type {string[]} */
    screen: [],
    /** @type {import('../server/protocol.js').ServerMessage[]} */
    messages: [],
    /** @type {ViewerEvent[]} */
    events: [],
    sendScreen(bytes) {
      this.screen.push(bytes);
      this.events.push({ kind: 'screen', bytes });
    },
    sendMessage(message) {
      this.messages.push(message);
      this.events.push({ kind: 'message', message });
    },
  };
}

/**
 * Wait for a condition rather than for a duration, so the suite stays fast and
 * does not flake under load.
 *
 * @param {() => boolean} predicate
 * @param {string} message
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export async function waitUntil(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Wait until b3270 has processed everything it had queued.
 *
 * b3270's stdout is a single ordered stream, so once the run-result for an
 * action we submit comes back, every indication that preceded it has already
 * been applied to the model. That makes this exact rather than a guess at how
 * long the host takes.
 *
 * @param {import('../server/session.js').Session} session
 * @returns {Promise<void>}
 */
export function settle(session) {
  const b3270 = session.b3270;
  const previous = b3270.handlers.onIndication;
  return new Promise((resolve) => {
    /** @type {string} */
    let tag = '';
    b3270.handlers.onIndication = (indication) => {
      previous(indication);
      const body = /** @type {Record<string, unknown>} */ (indication.body);
      if (indication.kind === 'run-result' && body['r-tag'] === tag) {
        b3270.handlers.onIndication = previous;
        resolve();
      }
    };
    tag = b3270.runActions([{ action: 'Reset' }]);
  });
}

/**
 * Bring up a fake host, a real b3270 and a Session wired together, then play
 * the first screen. This is the integration fixture every screen test uses.
 *
 * @param {string} traceFile
 * @param {{ records?: number, config?: Record<string, unknown> }} [options]
 */
export async function startTracedSession(traceFile, options = {}) {
  const host = await FakeHost.listen(traceFile, 0);
  const session = new Session(testConfig(options.config));

  // b3270 announces itself before it will accept anything.
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
