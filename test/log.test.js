import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLogFile, logger, setLogFile } from '../server/log.js';

/**
 * One file per test: the log is module-global, one per process.
 *
 * @param {import('node:test').TestContext} t
 * @param {number} maxBytes
 * @returns {string}
 */
function logFile(t, maxBytes) {
  const dir = mkdtempSync(join(tmpdir(), 'tn3270-log-'));
  const path = join(dir, 'tn3270.log');
  setLogFile(path, maxBytes);
  t.after(() => {
    closeLogFile();
    rmSync(dir, { recursive: true, force: true });
  });
  return path;
}

test('a session line carries the session id, and a viewer line its address too', (t) => {
  const path = logFile(t, 1024 * 1024);
  const log = logger('session', { session: 'a5dd6b0e-0000-4000-8000-000000000001' });

  log.info('connecting', { host: '127.0.0.1:4001' });
  log.with({ viewer: '9894d691', ip: '10.0.0.7' }).info('viewer attached', { role: 'controller' });

  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /INFO {2}session connecting session=a5dd6b0e-0000-4000-8000-000000000001 host=127\.0\.0\.1:4001/);
  assert.match(lines[1] ?? '', /session=a5dd6b0e-0000-4000-8000-000000000001 viewer=9894d691 ip=10\.0\.0\.7 role=controller/);
});

test('a field nobody filled in is left off the line', (t) => {
  const path = logFile(t, 1024 * 1024);

  logger('session', { session: 'abc', user: '' }).info('viewer attached', { ip: '10.0.0.7', role: '' });

  const line = readFileSync(path, 'utf8').trimEnd();
  assert.match(line, /session=abc ip=10\.0\.0\.7$/);
  assert.doesNotMatch(line, /user=|role=/);
});

test('the file rolls over once it passes its limit, keeping the lines before it', (t) => {
  const maxBytes = 4096;
  const path = logFile(t, maxBytes);
  const log = logger('session', { session: 'rolled' });

  // Enough to cross the limit once and no further.
  log.info('the first line of all');
  for (let i = 0; i < 30; i++) log.info('filler', { i, padding: 'x'.repeat(100) });
  log.info('the last line of all');

  const rolled = readFileSync(`${path}.1`, 'utf8');
  const current = readFileSync(path, 'utf8');

  assert.match(rolled, /the first line of all/);
  assert.match(current, /the last line of all/);
  assert.doesNotMatch(current, /the first line of all/);
  assert.ok(rolled.length >= maxBytes, `the rolled file should be full, was ${rolled.length}`);
  assert.ok(current.length < maxBytes, `the current file should have restarted, was ${current.length}`);
});

test('only the previous log is kept, however many times it rolls over', (t) => {
  const path = logFile(t, 4096);
  const log = logger('b3270', { session: 'rolled-twice' });

  for (let i = 0; i < 500; i++) log.info('filler', { i, padding: 'x'.repeat(100) });

  assert.ok(readFileSync(`${path}.1`, 'utf8').length > 0);
  assert.throws(() => readFileSync(`${path}.2`, 'utf8'), /ENOENT/);
});

test('an error keeps its stack, and its context, in the file', (t) => {
  const path = logFile(t, 1024 * 1024);
  const log = logger('session', { session: 'errs', ip: '10.0.0.7' });

  log.error(new Error('something broke'));

  const text = readFileSync(path, 'utf8');
  assert.match(text, /ERROR session \[E0000\] something broke session=errs ip=10\.0\.0\.7/);
  assert.match(text, /at /);
});
