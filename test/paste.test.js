import test from 'node:test';
import assert from 'node:assert/strict';
import { pasteSegments } from '../server/paste.js';

/**
 * Builds a one-row array of cells from a picture string: '_' is an editable
 * blank, anything else is protected content holding that character.
 *
 * @param {string} picture
 * @returns {{ ch: string, editable: boolean }[]}
 */
function row(picture) {
  return [...picture].map((ch) => (ch === '_' ? { ch: ' ', editable: true } : { ch, editable: false }));
}

/**
 * Simulates what typing each segment onto b3270 would leave on the screen: a
 * PasteString skips over protected cells without writing them, the same as
 * pasteSegments assumed when it decided what to skip and what to consume.
 *
 * @param {{ ch: string, editable: boolean }[]} cells
 * @param {{ col: number, text: string }[]} segments one row's worth
 * @returns {string}
 */
function apply(cells, segments) {
  const result = cells.map((cell) => cell.ch);
  for (const { col, text } of segments) {
    let at = col;
    for (const ch of text) {
      while (!cells[at].editable) at++;
      result[at] = ch;
      at++;
    }
  }
  return result.join('');
}

test('text shorter than a run of fields overflows into the next one, skipping the gap between them', () => {
  const cells = row('___ ___ ___');
  const segments = pasteSegments(cells, true, cells.length, { row: 0, col: 0 }, '123456789');
  assert.equal(apply(cells, segments), '123 456 789');
});

test('a protected run matching the pasted text there is consumed, not skipped', () => {
  const cells = row('___456___');
  const segments = pasteSegments(cells, true, cells.length, { row: 0, col: 0 }, '123456789');
  assert.equal(apply(cells, segments), '123456789');
});

test('a protected run not matching the pasted text is skipped, and the input is not consumed', () => {
  const cells = row('___455___');
  const segments = pasteSegments(cells, true, cells.length, { row: 0, col: 0 }, '123456789');
  assert.equal(apply(cells, segments), '123455456');
});

test('a protected run matching by coincidence is left alone, not consumed, when there is room to spare', () => {
  const cells = row('_2_4____8___');
  const segments = pasteSegments(cells, true, cells.length, { row: 0, col: 0 }, '123456789');
  assert.equal(apply(cells, segments), '122434568789');
});

test('leading and trailing newlines are dropped before anything is typed', () => {
  const cells = row('_____');
  const segments = pasteSegments(cells, true, cells.length, { row: 0, col: 1 }, '\n\nhi\n\n');
  assert.deepEqual(segments, [{ row: 0, col: 1, text: 'hi' }]);
});

test('a newline in the middle jumps to the column the paste started at, one row down', () => {
  const cells = [...row('__________'), ...row('__________')];
  const segments = pasteSegments(cells, true, 10, { row: 0, col: 3 }, 'ab\ncd');
  assert.deepEqual(segments, [
    { row: 0, col: 3, text: 'ab' },
    { row: 1, col: 3, text: 'cd' },
  ]);
});

test('an unformatted screen has nothing to skip, so the text is typed straight through', () => {
  const cells = row('_-_-_');
  const segments = pasteSegments(cells, false, cells.length, { row: 0, col: 0 }, 'abcde');
  assert.deepEqual(segments, [{ row: 0, col: 0, text: 'abcde' }]);
});

test('text running off the end of the screen is truncated rather than wrapping around', () => {
  const cells = row('___');
  const segments = pasteSegments(cells, true, cells.length, { row: 0, col: 0 }, '12345');
  assert.deepEqual(segments, [{ row: 0, col: 0, text: '123' }]);
});
