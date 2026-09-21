import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { writeFile, rm } from 'node:fs/promises';
import { Session } from '../server/session.js';
import { AppError } from '../server/errors.js';
import { reserveRestEndpoint, proxyRestRequest } from '../server/restproxy.js';
import { FakeHost } from './fakehost.js';
import { testConfig, waitUntil, collectingViewer } from './helpers.js';

/**
 * An httpd opens a little after its process does and says nothing when it has.
 *
 * @param {string} url
 * @param {string} [cookie]
 * @returns {Promise<void>}
 */
async function waitForAnswer(url, cookie) {
  /** @type {Record<string, string>} */
  const headers = cookie === undefined ? {} : { cookie: `x3270-security=${cookie}` };
  let answered = false;
  await waitUntil(() => {
    if (!answered) {
      fetch(url, { headers }).then(() => { answered = true; }).catch(() => {});
    }
    return answered;
  }, `${url} to answer`);
}

/** @returns {Promise<number>} a port that was free a moment ago */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

/**
 * @param {{ defaultHost?: string, model?: number, automation?: boolean }} [options]
 * @returns {Promise<{ port: number, stop: () => Promise<void> }>}
 */
async function startServer(options = {}) {
  const port = await freePort();
  const configFile = `test/.tmp-config-rest-${port}.jsonc`;
  await writeFile(
    configFile,
    JSON.stringify({
      server: { host: '127.0.0.1', port },
      b3270: { path: 'b3270', model: options.model ?? 4, ...(options.defaultHost ? { defaultHost: options.defaultHost } : {}) },
      // Off is the shipped default, so a REST test says so rather than assuming it.
      sessions: { idleTimeoutMs: 0, allowAutomation: options.automation ?? true },
      logLevel: 'warn',
      logFile: '',
    }),
  );

  const child = spawn('node', ['server/main.js'], {
    env: { ...process.env, TN3270_CONFIG: configFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));

  await waitForAnswer(`http://127.0.0.1:${port}/api/sessions`);

  return {
    port,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      await rm(configFile, { force: true });
    },
  };
}

test('GET /api/sessions/<id>/3270/rest/json/<action> answers one action, s3270-httpd style', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;

  const created = await (await fetch(`${base}/api/sessions`, { method: 'POST' })).json();

  const ok = await fetch(`${base}/api/sessions/${created.id}/3270/rest/json/Query(CodePage)`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /application\/json/);
  const okBody = await ok.json();
  assert.match(okBody.result[0], /cpgid/);
  assert.deepEqual(okBody['result-err'], [false]);
  assert.equal(okBody.status.split(' ').length, 12);

  const failed = await fetch(`${base}/api/sessions/${created.id}/3270/rest/json/BogusAction()`);
  assert.equal(failed.status, 400);
  const failedBody = await failed.json();
  assert.match(failedBody.result[0], /Unknown action/);
  assert.deepEqual(failedBody['result-err'], [true]);

  const missingSession = await fetch(`${base}/api/sessions/${'0'.repeat(8)}-0000-0000-0000-000000000000/3270/rest/json/Query(CodePage)`);
  assert.equal(missingSession.status, 404);
  assert.equal((await missingSession.json()).code, 'E3001');
});

test('the text and stext flavours are forwarded too, not just json', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const sessionBase = await newSessionBase(server.port);

  const text = await fetch(`${sessionBase}/3270/rest/text/Query(CodePage)`);
  assert.equal(text.status, 200);
  assert.match(text.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(await text.text(), /cpgid/);

  // stext prefixes the status line: one request, answer and state together.
  const stext = await fetch(`${sessionBase}/3270/rest/stext/Query(CodePage)`);
  assert.equal(stext.status, 200);
  const lines = (await stext.text()).trim().split(/\r?\n/);
  assert.ok(lines[0]?.startsWith('L U U N N'), `status line first, got ${JSON.stringify(lines[0])}`);
});

// From suite3270's s3270/Test/testHttpd.py, checked by substring as it does.
test('json error responses match s3270\'s own httpd test suite (ported from testHttpd.py)', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const sessionBase = `${await newSessionBase(server.port)}/3270/rest/json`;

  for (const [path, mustContain] of [
    ['', 'Missing'],
    ['/', 'Missing'],
    ['/Sebfp(monoCase)', 'Sebfp'],
    ['/Foo(', 'Syntax'],
  ]) {
    const response = await fetch(`${sessionBase}${path}`);
    assert.equal(response.status, 400, path);
    const body = await response.json();
    assert.ok('result' in body && 'status' in body, path);
    assert.match(body.result[0], new RegExp(mustContain), path);
  }

  // A toggle name with no second argument is a query, not a set.
  const query = await fetch(`${sessionBase}/Set(monoCase)`);
  assert.equal(query.status, 200);
  assert.equal((await query.json()).result[0], 'false');
});

test('an awkward argument survives the proxy and reaches the screen', async (t) => {
  const host = await FakeHost.listen('test/traces/fields.trc', 0);
  const server = await startServer({ defaultHost: `127.0.0.1:${host.port}` });
  t.after(async () => {
    await server.stop();
    await host.close();
  });

  const sessionBase = await newSessionBase(server.port);
  await host.waitForConnection();
  await host.sendRecords(1);

  // PasteString's argument is hex, so characters that break action syntax survive the round trip.
  const text = 'a, b "c"';
  const hex = Buffer.from(text, 'utf8').toString('hex');
  /** @param {string} call */
  const rest = async (call) => {
    const response = await fetch(`${sessionBase}/3270/rest/json/${encodeURIComponent(call)}`);
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await rest('Home()')).status, 200);
  const pasted = await rest(`PasteString(${hex})`);
  assert.equal(pasted.status, 200, JSON.stringify(pasted.body));

  const read = await rest('Ascii1(3,1,60)');
  assert.match(read.body.result[0], /^ Name: +a, b "c" *$/);
});

test('the emulator\'s own REST port is shut to anyone without the session cookie', async (t) => {
  const endpoint = await reserveRestEndpoint();
  const session = new Session(testConfig(), endpoint);
  t.after(() => session.close());
  await session.ready;

  const url = `http://127.0.0.1:${endpoint.port}/3270/rest/json/Query(CodePage)`;
  await waitForAnswer(url, endpoint.cookie);

  const uninvited = await fetch(url);
  assert.equal(uninvited.status, 403, 'a local process that guesses the port must still be refused');
  assert.match(await uninvited.text(), /cookie/i);

  const wrong = await fetch(url, { headers: { cookie: 'x3270-security=not-the-cookie' } });
  assert.equal(wrong.status, 403);
});

test('a session with no REST endpoint fails the call with E7002 rather than a crash', async (t) => {
  const session = new Session(testConfig());
  t.after(() => session.close());
  await session.ready;

  await assert.rejects(
    () => proxyRestRequest(
      /** @type {any} */ ({ method: 'GET', headers: {} }),
      /** @type {any} */ ({}),
      session,
      '/3270/rest/json/Query(CodePage)',
    ),
    (err) => err instanceof AppError && err.code === 'E7002',
  );
});

test('a REST call runs even for a viewer sharing would refuse', async (t) => {
  const endpoint = await reserveRestEndpoint();
  const session = new Session(testConfig(), endpoint);
  t.after(() => session.close());
  await session.ready;

  const controller = collectingViewer('controller');
  const observer = collectingViewer('observer');
  session.attach(controller);
  session.attach(observer);
  session.allowSharing = true;
  session.allowSharedEditing = false;

  session.handleClientMessage(observer, { type: 'action', action: 'PF', args: ['3'] });
  assert.ok(observer.messages.some((m) => (m.type === 'error' ? m.code : '') === 'E3006'), 'the observer must be refused over the WebSocket');

  const url = `http://127.0.0.1:${endpoint.port}/3270/rest/json/Query(CodePage)`;
  await waitForAnswer(url, endpoint.cookie);
  const answer = await fetch(url, { headers: { cookie: `x3270-security=${endpoint.cookie}` } });
  assert.equal(answer.status, 200, 'the REST call must still go through');
});

test('the proxy is shut with 403 and E7004 until the controller opens it, and shuts again on request', async (t) => {
  const server = await startServer({ automation: false });
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;

  const created = await (await fetch(`${base}/api/sessions`, { method: 'POST' })).json();
  const call = () => fetch(`${base}/api/sessions/${created.id}/3270/rest/json/Query(CodePage)`);

  const refused = await call();
  assert.equal(refused.status, 403, 'a session nobody has opened up takes no REST calls');
  assert.equal((await refused.json()).code, 'E7004');

  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${created.id}`);
  t.after(() => socket.close());
  /** @type {Record<string, unknown>[]} */
  const messages = [];
  socket.on('message', (data, isBinary) => {
    if (!isBinary) messages.push(JSON.parse(String(data)));
  });
  await waitUntil(() => messages.some((m) => m['type'] === 'hello'), 'the viewer to say hello');
  assert.equal(messages[0]?.['allowAutomation'], false);

  socket.send(JSON.stringify({ type: 'automation', allowed: true }));
  await waitUntil(() => messages.some((m) => m['type'] === 'status' && m['allowAutomation'] === true), 'automation to be allowed');
  assert.equal((await call()).status, 200, 'the controller turning it on is enough: nothing restarts');

  socket.send(JSON.stringify({ type: 'automation', allowed: false }));
  await waitUntil(() => messages.some((m) => m['type'] === 'status' && m['allowAutomation'] === false), 'automation to be denied again');
  assert.equal((await call()).status, 403);
});

/** @returns {string | null} */
function findS3270() {
  const candidate = process.env['S3270_PATH'] ?? 's3270';
  const probe = spawnSync(candidate, ['--version'], { stdio: 'pipe' });
  return probe.error === undefined || probe.error === null ? candidate : null;
}

test('comparison: what we forward is byte for byte what a real s3270 -httpd answers', async (t) => {
  const s3270 = findS3270();
  if (s3270 === null) {
    t.skip('no s3270 binary found on PATH or $S3270_PATH');
    return;
  }

  const oraclePort = await freePort();
  // Model 2 both sides: on any larger one the status line geometry differs while
  // disconnected, b3270 starting at the model's size and s3270 at 24x80.
  const oracle = spawn(s3270, ['-model', '2', '-httpd', `127.0.0.1:${oraclePort}`], { stdio: 'pipe' });
  t.after(() => oracle.kill());
  await waitForAnswer(`http://127.0.0.1:${oraclePort}/3270/rest/json/Query(CodePage)`);

  const server = await startServer({ model: 2 });
  t.after(() => server.stop());
  const sessionBase = await newSessionBase(server.port);

  for (const flavour of ['json', 'text', 'stext']) {
    for (const call of ['Query(CodePage)', 'Set(monoCase)', 'BogusAction()', 'PF()', 'Ascii1(1,1,10)']) {
      const path = `/3270/rest/${flavour}/${call}`;
      const [ours, theirs] = await Promise.all([
        fetch(`${sessionBase}${path}`),
        fetch(`http://127.0.0.1:${oraclePort}${path}`),
      ]);
      const [ourBody, theirBody] = await Promise.all([ours.text(), theirs.text()]);
      assert.equal(ours.status, theirs.status, `status for ${path}`);
      assert.equal(ours.headers.get('content-type'), theirs.headers.get('content-type'), `content type for ${path}`);
      assert.equal(ourBody, theirBody, `body for ${path}`);
    }
  }
});

/**
 * @param {number} port
 * @returns {Promise<string>} the base URL of a fresh session on that server
 */
async function newSessionBase(port) {
  const created = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' })).json();
  return `http://127.0.0.1:${port}/api/sessions/${created.id}`;
}
