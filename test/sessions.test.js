import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SESSIONS, SessionPrefix, paneAreas, parseSessionHash, sessionHash, switcherText } from '../public/sessions.js';

/**
 * @param {{ key?: string, code?: string, ctrlKey?: boolean, altKey?: boolean,
 *   metaKey?: boolean, shiftKey?: boolean }} init
 * @returns {KeyboardEvent}
 */
function key(init) {
  return /** @type {KeyboardEvent} */ ({
    key: init.key ?? '',
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    repeat: false,
  });
}

test('Ctrl-B and a digit picks a session', () => {
  const prefix = new SessionPrefix();

  assert.deepEqual(prefix.handleKey(key({ key: 'b', ctrlKey: true })), { action: 'arm' });
  assert.equal(prefix.armed, true);
  assert.deepEqual(prefix.handleKey(key({ key: '2' })), { action: 'switch', index: 1 });
  assert.equal(prefix.armed, false);

  // Once it has fired, a digit is just a digit again.
  assert.deepEqual(prefix.handleKey(key({ key: '2' })), { action: 'ignore' });
});

test('the digit counts whether or not Ctrl is still held', () => {
  const prefix = new SessionPrefix();
  prefix.handleKey(key({ key: 'b', ctrlKey: true }));

  // Ctrl going down on the way to the digit is a keystroke of its own, and
  // letting it cancel the switcher would make holding Ctrl down a broken habit.
  assert.deepEqual(prefix.handleKey(key({ key: 'Control', ctrlKey: true })), { action: 'ignore' });
  assert.equal(prefix.armed, true);
  assert.deepEqual(prefix.handleKey(key({ key: '1', ctrlKey: true })), { action: 'switch', index: 0 });
});

test('anything that is not a session number cancels instead of reaching the host', () => {
  const prefix = new SessionPrefix();

  for (const pressed of ['x', 'Escape', '0', String(MAX_SESSIONS + 1), 'Enter']) {
    prefix.handleKey(key({ key: 'b', ctrlKey: true }));
    assert.deepEqual(prefix.handleKey(key({ key: pressed })), { action: 'cancel' }, pressed);
    assert.equal(prefix.armed, false, pressed);
  }
});

test('a letter matching an offered hint picks it instead of cancelling', () => {
  const prefix = new SessionPrefix();
  prefix.handleKey(key({ key: 'b', ctrlKey: true }));
  assert.deepEqual(prefix.handleKey(key({ key: 'n' }), ['n', 'e']), { action: 'hint', letter: 'n' });

  // With no hints offered, the same letter just cancels as before.
  prefix.handleKey(key({ key: 'b', ctrlKey: true }));
  assert.deepEqual(prefix.handleKey(key({ key: 'n' })), { action: 'cancel' });
});

test('the prefix is Ctrl-B alone', () => {
  const prefix = new SessionPrefix();

  assert.deepEqual(prefix.handleKey(key({ key: 'b' })), { action: 'ignore' });
  assert.deepEqual(prefix.handleKey(key({ key: 'b', ctrlKey: true, altKey: true })), { action: 'ignore' });
  assert.deepEqual(prefix.handleKey(key({ key: 'a', ctrlKey: true })), { action: 'ignore' });
  assert.equal(prefix.armed, false);
  // Caps Lock does not change what the key is.
  assert.deepEqual(prefix.handleKey(key({ key: 'B', ctrlKey: true })), { action: 'arm' });
});

test('a shifted digit lays the screen out instead of switching to a session', () => {
  const prefix = new SessionPrefix();

  prefix.handleKey(key({ key: 'b', ctrlKey: true }));
  assert.deepEqual(prefix.handleKey(key({ key: '!', code: 'Digit1', shiftKey: true })), { action: 'layout', panes: 1 });
  prefix.handleKey(key({ key: 'b', ctrlKey: true }));
  assert.deepEqual(prefix.handleKey(key({ key: '$', code: 'Digit4', shiftKey: true })), { action: 'layout', panes: 4 });

  // A German keyboard prints " over the 2 and a US one prints @, so the
  // character is no use: the digit has to come from the key itself.
  prefix.handleKey(key({ key: 'b', ctrlKey: true }));
  assert.deepEqual(prefix.handleKey(key({ key: '"', code: 'Digit2', shiftKey: true })), { action: 'layout', panes: 2 });

  // And a shifted key that is not a digit still just cancels.
  prefix.handleKey(key({ key: 'b', ctrlKey: true }));
  assert.deepEqual(prefix.handleKey(key({ key: 'X', code: 'KeyX', shiftKey: true })), { action: 'cancel' });
});

test('each layout fills the same two-by-two grid', () => {
  assert.equal(paneAreas(1).length, 1);
  assert.equal(paneAreas(2).length, 2);
  assert.equal(paneAreas(3).length, 3);
  assert.equal(paneAreas(4).length, 4);

  // One session fills the grid; two split it down the middle.
  assert.equal(paneAreas(1)[0], '1 / 1 / 3 / 3');
  assert.deepEqual([...paneAreas(2)], ['1 / 1 / 3 / 2', '1 / 2 / 3 / 3']);

  // Three is one big session on the left with two stacked on the right: the
  // first pane spans both rows, the others take one each in the second column.
  const three = paneAreas(3);
  assert.equal(three[0], '1 / 1 / 3 / 2');
  assert.equal(three[1], '1 / 2 / 2 / 3');
  assert.equal(three[2], '2 / 2 / 3 / 3');

  // Four is quarters, 1 and 2 on the left, 3 and 4 on the right.
  assert.deepEqual([...paneAreas(4)], ['1 / 1 / 2 / 2', '2 / 1 / 3 / 2', '1 / 2 / 2 / 3', '2 / 2 / 3 / 3']);
});

test('the fragment keeps every session in the slot its digit points at', () => {
  assert.deepEqual(parseSessionHash('#one,,three'), ['one', null, 'three', null]);
  assert.deepEqual(parseSessionHash('one'), ['one', null, null, null]);
  assert.deepEqual(parseSessionHash(''), [null, null, null, null]);

  assert.equal(sessionHash(['one', null, 'three', null]), 'one,,three');
  assert.equal(sessionHash(['one', null, null, null]), 'one');
  assert.equal(sessionHash([null, null, null, null]), '');

  // A shared address has to come back as the same four slots it left as.
  const ids = ['a', null, 'c', null];
  assert.deepEqual(parseSessionHash(sessionHash(ids)), ids);
});

test('the switcher shows which session is on screen and which digits are free', () => {
  const text = switcherText(['a', null, 'c', null], 2);
  assert.match(text, /Ctrl-B/);
  assert.match(text, / 1 /);
  assert.match(text, / 2\+/);
  assert.match(text, /\[3\]/);
  assert.match(text, / 4\+/);
});
