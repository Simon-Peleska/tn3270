import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenModel } from '../server/screen.js';
import { OiaModel } from '../server/oia.js';
import { AppError } from '../server/errors.js';

/**
 * The incremental-update semantics of the screen indication, pinned down. These
 * are the rules the whole rendering path rests on.
 */

test('a text change writes characters and leaves the rest of the row alone', () => {
  const screen = new ScreenModel(24, 80);
  screen.takeDirtyRows();
  screen.applyScreen({ rows: [{ row: 1, changes: [{ column: 3, text: 'abc' }] }] });

  assert.equal(screen.rowText(0).slice(0, 6), '  abc ');
  assert.deepEqual(screen.takeDirtyRows(), [0], 'only the touched row should be sent');
});

test('a count change repaints attributes without touching the characters', () => {
  const screen = new ScreenModel(24, 80);
  screen.applyScreen({ rows: [{ row: 1, changes: [{ column: 1, text: 'hello' }] }] });
  screen.takeDirtyRows();

  screen.applyScreen({ rows: [{ row: 1, changes: [{ column: 1, count: 5, fg: 'red' }] }] });

  assert.equal(screen.rowText(0).slice(0, 5), 'hello');
  assert.equal(screen.cellAt(0, 0).fg, 'red');
  assert.equal(screen.cellAt(0, 5).fg, null);
});

test('an attribute the change does not mention stays as it was', () => {
  const screen = new ScreenModel(24, 80);
  screen.applyScreen({ rows: [{ row: 1, changes: [{ column: 1, text: 'ab', fg: 'red', bg: 'blue' }] }] });
  screen.applyScreen({ rows: [{ row: 1, changes: [{ column: 1, text: 'cd', fg: 'green' }] }] });

  const cell = screen.cellAt(0, 0);
  assert.equal(cell.ch, 'c');
  assert.equal(cell.fg, 'green');
  assert.equal(cell.bg, 'blue', 'an unmentioned background must be retained');
});

test('an empty gr clears the graphic rendition rather than setting it to ""', () => {
  const screen = new ScreenModel(24, 80);
  screen.applyScreen({ rows: [{ row: 1, changes: [{ column: 1, text: 'a', gr: 'underline' }] }] });
  assert.equal(screen.cellAt(0, 0).gr, 'underline');

  screen.applyScreen({ rows: [{ row: 1, changes: [{ column: 1, count: 1, gr: '' }] }] });
  assert.equal(screen.cellAt(0, 0).gr, null);
});

test('changes are clipped to the screen instead of overflowing into the next row', () => {
  const screen = new ScreenModel(24, 80);
  screen.applyScreen({ rows: [{ row: 1, changes: [{ column: 79, text: 'abcd' }] }] });

  assert.equal(screen.rowText(0).slice(78), 'ab');
  assert.equal(screen.rowText(1).trim(), '', 'the row below must be untouched');
});

test('out-of-range rows and columns are ignored', () => {
  const screen = new ScreenModel(24, 80);
  screen.applyScreen({
    rows: [
      { row: 99, changes: [{ column: 1, text: 'nope' }] },
      { row: 1, changes: [{ column: 999, text: 'nope' }] },
      { row: 0, changes: [{ column: 1, text: 'nope' }] },
    ],
  });
  assert.equal(screen.rowText(0).trim(), '');
});

test('cursor fields are individually optional and fall back to the previous value', () => {
  const screen = new ScreenModel(24, 80);
  screen.applyScreen({ cursor: { enabled: true, row: 5, column: 10 } });
  assert.deepEqual(screen.cursor, { row: 4, col: 9, enabled: true });

  screen.applyScreen({ cursor: { enabled: false } });
  assert.deepEqual(screen.cursor, { row: 4, col: 9, enabled: false });
});

test('erase blanks everything, adopts the new defaults and homes the cursor', () => {
  const screen = new ScreenModel(24, 80);
  screen.applyScreen({ rows: [{ row: 2, changes: [{ column: 1, text: 'gone', fg: 'red' }] }] });
  screen.applyScreen({ cursor: { enabled: true, row: 5, column: 5 } });

  screen.applyErase({ 'logical-rows': 24, 'logical-columns': 80, fg: 'blue', bg: 'neutralBlack' });

  assert.equal(screen.rowText(1).trim(), '');
  assert.equal(screen.cellAt(1, 0).fg, null);
  assert.equal(screen.defaultFg, 'blue');
  assert.equal(screen.defaultBg, 'neutralBlack');
  assert.deepEqual(screen.cursor, { row: 0, col: 0, enabled: true });
});

test('a screen-mode change resizes and dirties the whole screen', () => {
  const screen = new ScreenModel(24, 80);
  screen.takeDirtyRows();

  screen.applyScreenMode({ model: 4, rows: 43, columns: 80, color: true, oversize: false, extended: true });

  assert.equal(screen.rows, 43);
  assert.equal(screen.cols, 80);
  assert.equal(screen.takeDirtyRows().length, 43);
});

test('a monochrome screen-mode is recorded so no colour is invented', () => {
  const screen = new ScreenModel(24, 80);
  screen.applyScreenMode({ model: 2, rows: 24, columns: 80, color: false, oversize: false, extended: false });
  assert.equal(screen.color, false);
});

test('reading outside the screen is a stable error, not undefined', () => {
  const screen = new ScreenModel(24, 80);
  assert.throws(() => screen.cellAt(99, 0), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'E3004');
    return true;
  });
});

test('the OIA line is exactly as wide as the screen and shows the lock', () => {
  const oia = new OiaModel();
  oia.applyOia({ field: 'lock', value: 'system' });
  const text = oia.render(80, { row: 4, col: 9, enabled: true });

  assert.equal(text.length, 80);
  assert.ok(text.includes('X SYSTEM'), `expected a lock indicator in ${JSON.stringify(text)}`);
  assert.ok(text.trimEnd().endsWith('05/010'), `expected the cursor position in ${JSON.stringify(text)}`);
  assert.equal(oia.keyboardLocked, true);
});

test('the OIA leaves the browser its columns at the right, however full it is', () => {
  const oia = new OiaModel();
  oia.applyConnection({ state: 'connected-tn3270e', host: 'a-very-long-hostname.example.com:992' });
  oia.applyOia({ field: 'lock', value: 'system' });
  oia.applyOia({ field: 'insert', value: true });
  oia.applyOia({ field: 'typeahead', value: true });

  // '[Reset] [Settings]' is 18 columns, painted flush right by public/app.js
  // over a status line the server never writes into.
  const text = oia.render(80, { row: 23, col: 79, enabled: true });
  assert.equal(text.slice(-19), ' '.repeat(19), `the OIA wrote into the buttons: ${JSON.stringify(text)}`);
});

test('the OIA reflects the connection state', () => {
  const oia = new OiaModel();
  assert.equal(oia.connected, false);

  oia.applyConnection({ state: 'connected-tn3270e', host: 'mainframe:23' });
  assert.equal(oia.connected, true);
  assert.equal(oia.host, 'mainframe:23');
  // Once connected the operator wants to see *which* host, not the state name.
  assert.ok(oia.render(80, { row: 0, col: 0, enabled: true }).startsWith('mainframe:23'));
});
