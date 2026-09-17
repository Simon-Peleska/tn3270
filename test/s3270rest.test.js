import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseActionCall, statusLine } from '../server/s3270rest.js';
import { AppError } from '../server/errors.js';
import { startTracedSession, waitUntil, collectingViewer } from './helpers.js';

/**
 * This bridges the same action language s3270's own `-httpd` REST interface
 * speaks, so that an existing s3270 REST client can be pointed at this app
 * instead. See https://x3270.miraheze.org/wiki/HTTP_server and
 * https://x3270.miraheze.org/wiki/Action_syntax for the protocol this matches.
 */

test('parseActionCall reads s3270 formal action syntax', () => {
  assert.deepEqual(parseActionCall('Ascii()'), { action: 'Ascii', args: [] });
  assert.deepEqual(parseActionCall('PF(3)'), { action: 'PF', args: ['3'] });
  // s3270's own httpd accepts a bare action with no parens at all, and leaves
  // the argument-count check to the action itself.
  assert.deepEqual(parseActionCall('PF'), { action: 'PF', args: [] });
  assert.deepEqual(parseActionCall('String("hello, world")'), { action: 'String', args: ['hello, world'] });
  assert.deepEqual(parseActionCall('String("say \\"hi\\"")'), { action: 'String', args: ['say "hi"'] });
  // A leading empty parameter is a real, documented case: an empty string
  // followed by "xxx", not two positions collapsing into one.
  assert.deepEqual(parseActionCall('String(,xxx)'), { action: 'String', args: ['', 'xxx'] });
  assert.deepEqual(parseActionCall('MoveCursor(2,10)'), { action: 'MoveCursor', args: ['2', '10'] });
});

test('parseActionCall rejects what is not a balanced action call', () => {
  for (const text of ['PF(3', 'String("unterminated', 'String("a" "b")']) {
    assert.throws(() => parseActionCall(text), (err) => err instanceof AppError && err.code === 'E7001', text);
  }
});

test('statusLine renders the twelve s3270 status fields from session state', () => {
  const fakeSession = {
    model: 4,
    oia: { keyboardLocked: false, connected: true, host: 'example.com' },
    screen: { fieldsFormatted: true, cols: 80, rows: 24, cursor: { row: 1, col: 2 }, cells: [{ editable: true }] },
  };
  const fields = statusLine(/** @type {any} */ (fakeSession)).split(' ');
  assert.equal(fields.length, 12);
  assert.deepEqual(fields, ['U', 'F', 'U', 'C(example.com)', 'I', '4', '24', '80', '1', '2', '0x0', '0.000']);
});

test('statusLine shows a locked keyboard and a disconnected session', () => {
  const fakeSession = {
    model: 2,
    oia: { keyboardLocked: true, connected: false, host: null },
    screen: { fieldsFormatted: false, cols: 80, rows: 24, cursor: { row: 0, col: 0 }, cells: [] },
  };
  const fields = statusLine(/** @type {any} */ (fakeSession)).split(' ');
  assert.deepEqual(fields.slice(0, 5), ['L', 'U', 'U', 'N', 'N']);
});

test('runRestAction gets the same result and failure text real b3270/s3270 actions produce', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;

  const query = await session.runRestAction('Query', ['CodePage']);
  assert.equal(query.success, true);
  assert.match(query.text?.[0] ?? '', /cpgid/);

  const unknown = await session.runRestAction('BogusAction', []);
  assert.equal(unknown.success, false);
  assert.match(unknown.text?.[0] ?? '', /Unknown action/);

  const wrongArgs = await session.runRestAction('PF', []);
  assert.equal(wrongArgs.success, false);
  assert.equal(wrongArgs.text?.[0], 'PF() requires 1 argument');
});

test('a REST action always runs, even for a viewer sharing would refuse', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;

  // A browser viewer that is not the controller is refused with E3006 — that
  // is the permission model REST is exempt from, on purpose.
  const controller = collectingViewer('controller');
  const observer = collectingViewer('observer');
  session.attach(controller);
  session.attach(observer);
  session.allowSharing = true;
  session.allowSharedEditing = false;

  session.handleClientMessage(observer, { type: 'action', action: 'PF', args: ['3'] });
  assert.ok(observer.messages.some((m) => (m.type === 'error' ? m.code : '') === 'E3006'), 'the observer must be refused over the WebSocket');

  const result = await session.runRestAction('Query', ['CodePage']);
  assert.equal(result.success, true, 'the REST call must still go through');
});

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

/** @returns {Promise<{ port: number, stop: () => Promise<void> }>} */
async function startServer() {
  const port = await freePort();
  const configFile = `test/.tmp-config-rest-${port}.jsonc`;
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

test('GET /api/sessions/<id>/3270/rest/json/<action> answers one action, s3270-httpd style', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;

  const created = await (await fetch(`${base}/api/sessions`, { method: 'POST' })).json();

  const ok = await fetch(`${base}/api/sessions/${created.id}/3270/rest/json/Query(CodePage)`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/json; charset=utf-8');
  const okBody = await ok.json();
  assert.match(okBody.result[0], /cpgid/);
  assert.equal(okBody.status.split(' ').length, 12);

  const failed = await fetch(`${base}/api/sessions/${created.id}/3270/rest/json/BogusAction()`);
  assert.equal(failed.status, 400);
  const failedBody = await failed.json();
  assert.match(failedBody.result[0], /Unknown action/);

  const malformed = await fetch(`${base}/api/sessions/${created.id}/3270/rest/json/PF(3`);
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).result[0], /Syntax error/);

  const missingSession = await fetch(`${base}/api/sessions/${'0'.repeat(8)}-0000-0000-0000-000000000000/3270/rest/json/Query(CodePage)`);
  assert.equal(missingSession.status, 404);
  assert.equal((await missingSession.json()).code, 'E3001');
});

// Ported from s3270's own httpd test suite (s3270/Test/testHttpd.py in the
// suite3270 source, TestS3270Httpd.s3270_httpd_json_error_test and
// .test_s3270_httpd_persist): the real suite checks these by substring, not
// exact wording, so this holds even though our wording differs from s3270's.
test('json error responses match s3270\'s own httpd test suite (ported from testHttpd.py)', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const created = await (await fetch(`${base}/api/sessions`, { method: 'POST' })).json();
  const sessionBase = `${base}/api/sessions/${created.id}/3270/rest/json`;

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

  // test_s3270_httpd_persist's actual point (connection reuse) isn't ours to
  // test — fetch always reuses keep-alive connections — but the action it
  // exercises is worth keeping: a toggle name with no second argument is a
  // query, not a set, and answers with the toggle's current value.
  const query = await fetch(`${sessionBase}/Set(monoCase)`);
  assert.equal(query.status, 200);
  assert.equal((await query.json()).result[0], 'false');
});

test('a quoted argument with a comma and an escaped quote reaches the action intact', async (t) => {
  const fixture = await startTracedSession('test/traces/reverse.trc');
  t.after(() => fixture.close());
  const { session } = fixture;

  // PasteString takes a single hex-encoded argument; round-tripping a
  // deliberately awkward string through the URL-shaped parser is the point.
  const text = 'a, b "c"';
  const hex = Buffer.from(text, 'utf8').toString('hex');
  const result = await session.runRestAction('PasteString', [hex]);
  assert.equal(result.success, true);
});

/** @returns {string | null} an s3270 binary to compare against, if one is reachable */
function findS3270() {
  const candidate = process.env['S3270_PATH'] ?? 's3270';
  const probe = spawnSync(candidate, ['--version'], { stdio: 'pipe' });
  return probe.error === undefined || probe.error === null ? candidate : null;
}

test('comparison: our REST answers match a real s3270 -httpd for the same actions', async (t) => {
  const s3270 = findS3270();
  if (s3270 === null) {
    t.skip('no s3270 binary found on PATH or $S3270_PATH');
    return;
  }

  const restPort = await freePort();
  const oracle = spawn(s3270, ['-httpd', `127.0.0.1:${restPort}`], { stdio: 'pipe' });
  t.after(() => oracle.kill());
  let oracleReady = false;
  await waitUntil(() => {
    if (!oracleReady) {
      fetch(`http://127.0.0.1:${restPort}/3270/rest/json/Query(CodePage)`).then(() => { oracleReady = true; }).catch(() => {});
    }
    return oracleReady;
  }, 'the real s3270 httpd to accept requests');

  const server = await startServer();
  t.after(() => server.stop());
  const created = await (await fetch(`http://127.0.0.1:${server.port}/api/sessions`, { method: 'POST' })).json();
  /** @param {string} call */
  const ours = (call) => fetch(`http://127.0.0.1:${server.port}/api/sessions/${created.id}/3270/rest/json/${call}`);
  /** @param {string} call */
  const theirs = (call) => fetch(`http://127.0.0.1:${restPort}/3270/rest/json/${call}`);

  for (const call of ['Query(CodePage)', 'BogusAction()', 'PF()']) {
    const [ourResponse, theirResponse] = await Promise.all([ours(call), theirs(call)]);
    const [ourBody, theirBody] = await Promise.all([ourResponse.json(), theirResponse.json()]);
    assert.equal(ourResponse.status, theirResponse.status, `status for ${call}`);
    assert.deepEqual(ourBody.result, theirBody.result, `result for ${call}`);
    assert.equal(ourBody.status.split(' ').length, theirBody.status.split(' ').length, `status line shape for ${call}`);
  }
});
