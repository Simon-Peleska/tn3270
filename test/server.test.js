import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFile, rm } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { INIT_SEQUENCE } from '../server/vt.js';
import { FakeHost } from './fakehost.js';
import { waitUntil } from './helpers.js';

/**
 * The whole stack as a browser meets it: a real node server, a real b3270, a
 * real WebSocket, and a fake host replaying a real trace. Nothing is mocked.
 */

/** @returns {Promise<number>} a port that was free a moment ago */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * @returns {Promise<{ port: number, stop: () => Promise<void> }>}
 */
async function startServer() {
  const port = await freePort();
  const configFile = `test/.tmp-config-${port}.jsonc`;
  await writeFile(
    configFile,
    JSON.stringify({
      server: { host: '127.0.0.1', port },
      b3270: { path: 'b3270', model: 4 },
      sessions: { idleTimeoutMs: 0 },
      logLevel: 'warn',
    }),
  );

  const child = spawn('node', ['server/main.js'], {
    env: { ...process.env, TN3270_CONFIG: configFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Logging is at warn here, so readiness is taken from the socket itself
  // rather than from a log line that a level change could silently remove.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));

  let ready = false;
  await waitUntil(() => {
    if (!ready) {
      fetch(`http://127.0.0.1:${port}/api/sessions`).then(() => { ready = true; }).catch(() => {});
    }
    return ready;
  }, 'the server to accept requests');

  return {
    port,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      await rm(configFile, { force: true });
    },
  };
}

/**
 * @param {string} url
 * @returns {Promise<{ socket: WebSocket, screen: string[], messages: Record<string, unknown>[] }>}
 */
async function openViewer(url) {
  const socket = new WebSocket(url);
  /** @type {string[]} */
  const screen = [];
  /** @type {Record<string, unknown>[]} */
  const messages = [];

  socket.on('message', (data, isBinary) => {
    if (isBinary) screen.push(Buffer.from(/** @type {Buffer} */ (data)).toString('utf8'));
    else messages.push(JSON.parse(String(data)));
  });

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, screen, messages };
}

test('two browsers share one session over the real server', async (t) => {
  const server = await startServer();
  const host = await FakeHost.listen('test/traces/reverse.trc', 0);
  t.after(async () => {
    await host.close();
    await server.stop();
  });

  const base = `http://127.0.0.1:${server.port}`;
  const created = await (await fetch(`${base}/api/sessions`, { method: 'POST' })).json();
  assert.match(String(created.id), /^[0-9a-f-]{36}$/);

  const first = await openViewer(`ws://127.0.0.1:${server.port}/ws/${created.id}`);
  t.after(() => first.socket.close());
  await waitUntil(() => first.messages.length > 0, 'the hello message');
  assert.equal(first.messages[0]?.['type'], 'hello');
  assert.equal(first.messages[0]?.['role'], 'controller');
  await waitUntil(() => first.screen.length > 0, 'the initial repaint');
  assert.ok(first.screen[0]?.startsWith(INIT_SEQUENCE));

  first.socket.send(JSON.stringify({ type: 'connect', host: `127.0.0.1:${host.port}` }));
  await host.waitForConnection();
  await host.sendRecords(1);
  await waitUntil(() => first.screen.join('').includes('_____'), 'the host screen to arrive');

  // The second browser joins a session that is already up and must be correct
  // straight away, without replaying anything.
  const second = await openViewer(`ws://127.0.0.1:${server.port}/ws/${created.id}`);
  t.after(() => second.socket.close());
  await waitUntil(() => second.screen.length > 0, 'the late viewer repaint');

  assert.equal(second.messages[0]?.['role'], 'observer');
  assert.ok(second.screen[0]?.includes('_____'), 'the late viewer must see the current screen');

  // The observer's input is refused with its code, and nothing is forwarded.
  second.socket.send(JSON.stringify({ type: 'text', value: 'x' }));
  await waitUntil(() => second.messages.some((m) => m['code'] === 'E4003'), 'the observer refusal');
});

test('the server refuses an unknown session and a bad upgrade path', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const missing = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${'0'.repeat(8)}-0000-0000-0000-000000000000`);
  await assert.rejects(new Promise((resolve, reject) => {
    missing.once('open', resolve);
    missing.once('error', reject);
  }), /404/);

  const wrong = new WebSocket(`ws://127.0.0.1:${server.port}/ws/nonsense`);
  await assert.rejects(new Promise((resolve, reject) => {
    wrong.once('open', resolve);
    wrong.once('error', reject);
  }), /404/);
});

test('static files and the session list are served', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>TN3270 Terminal<\/title>/);

  const bundle = await fetch(`${base}/vendor/dist/ghostty-web.js`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get('content-type'), 'text/javascript; charset=utf-8');

  const list = await (await fetch(`${base}/api/sessions`)).json();
  assert.ok(Array.isArray(list.sessions));
});

test('a path that tries to escape the public directory is refused', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  // Percent-encoded so fetch does not normalise the traversal away before it
  // reaches the server, which is the case that actually needs guarding.
  for (const path of ['/%2e%2e%2fconfig.jsonc', '/vendor/%2e%2e%2f%2e%2e%2fconfig.jsonc']) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
    const body = await response.json();
    assert.equal(response.status, 404, `${path} must not be served`);
    assert.equal(body.code, 'E6001');
  }
});
