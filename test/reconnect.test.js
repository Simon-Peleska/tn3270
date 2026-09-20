import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_DELAY_MS, MAX_DELAY_MS, backoffDelay, reconnectStep } from '../public/reconnect.js';

test('the first retries are quick and every later one waits longer', () => {
  const delays = [0, 1, 2, 3].map((attempt) => backoffDelay(attempt, 0.5));
  assert.deepEqual(delays, [375, 750, 1500, 3000]);
  assert.ok(delays[0] < BASE_DELAY_MS, 'the first retry is worth trying almost at once');
});

test('no retry waits longer than the cap, however long the outage', () => {
  for (const attempt of [5, 10, 40, 1000]) {
    assert.ok(backoffDelay(attempt, 1) <= MAX_DELAY_MS, `attempt ${attempt} is capped`);
  }
  assert.equal(backoffDelay(1000, 1), MAX_DELAY_MS);
});

test('half of every delay is random, so browsers do not all retry on the same tick', () => {
  for (const attempt of [0, 3, 9]) {
    const earliest = backoffDelay(attempt, 0);
    const latest = backoffDelay(attempt, 1);
    assert.ok(earliest < latest, 'the jitter spreads the retries out');
    assert.equal(earliest * 2, latest, 'and never delays a retry by more than double');
  }
});

test('a session the server still has is reconnected to', () => {
  assert.equal(reconnectStep({ answered: true, sessionLive: true, msLeft: 1 }), 'reconnect');
  // Past the window, but the server decides, and it has not reaped the session.
  assert.equal(reconnectStep({ answered: true, sessionLive: true, msLeft: -60000 }), 'reconnect');
});

test('a server that has forgotten the session is not waited for', () => {
  assert.equal(reconnectStep({ answered: true, sessionLive: false, msLeft: 300000 }), 'fresh');
});

test('a server that does not answer is waited for until the window is gone', () => {
  assert.equal(reconnectStep({ answered: false, sessionLive: false, msLeft: 1 }), 'retry');
  assert.equal(reconnectStep({ answered: false, sessionLive: false, msLeft: 0 }), 'fresh');
  assert.equal(reconnectStep({ answered: false, sessionLive: false, msLeft: Infinity }), 'retry');
});
