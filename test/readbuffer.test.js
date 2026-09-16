import test from 'node:test';
import assert from 'node:assert/strict';
import { editableFieldText, fieldMap } from '../server/readbuffer.js';

test('an unprotected field with typed text is trimmed to its content', () => {
  const lines = [
    'Start1: 2 8',
    'StartOffset: 87',
    'Cursor1: 2 24',
    'CursorOffset: 103',
    'Contents: SF(c0=cd,41=f4) 20 20 68 65 6c 6c 6f 20 77 6f 72 6c 64 20 20 00 00 00',
  ];
  assert.equal(editableFieldText(lines), 'hello world');
});

test('an empty unprotected field (all null cells) trims down to an empty string', () => {
  const lines = [
    'Start1: 2 8',
    'StartOffset: 87',
    'Contents: SF(c0=cc,41=f4) 00 00 00 00 00 00',
  ];
  assert.equal(editableFieldText(lines), '');
});

test('a protected field (the 0x20 attribute bit set) is refused', () => {
  const lines = ['Contents: SF(c0=e0) 54 45 58 54'];
  assert.equal(editableFieldText(lines), null);
});

test('no field under the cursor (ReadBuffer(Field) failed) is refused', () => {
  assert.equal(editableFieldText([]), null);
  assert.equal(editableFieldText(["can't do that"]), null);
});

/**
 * @param {boolean[]} map
 * @param {number} cols
 * @returns {string[]} one string per row, '.' unmarked and '#' marked
 */
function picture(map, cols) {
  const rows = [];
  for (let i = 0; i < map.length; i += cols) {
    rows.push(map.slice(i, i + cols).map((cell) => (cell ? '#' : '.')).join(''));
  }
  return rows;
}

test('cells after an unprotected attribute are typeable, and the attribute itself never is', () => {
  const lines = [
    'SF(c0=f0) 55 73 65 72 SF(c0=cd,41=f4) 00 00 00 SF(c0=f0)',
    'SF(c0=f0) 4f 4b 20 20 20 20 20 20 20',
  ];
  assert.deepEqual(picture(fieldMap(lines, 2, 10).editable, 10), [
    '......###.',
    '..........',
  ]);
});

test('a field runs past the end of a row and the last field on the screen wraps round to the first', () => {
  const lines = [
    '00 00 00 00 00',
    '00 SF(c0=f0) 41 42 43',
    '00 00 00 SF(c0=cc) 00',
  ];
  assert.deepEqual(picture(fieldMap(lines, 3, 5).editable, 5), [
    '#####',
    '#....',
    '....#',
  ]);
});

test('SA tokens carry an attribute for the next cell and take up no column of their own', () => {
  const lines = ['SF(c0=cd,41=f4) SA(42=f4) 41 SA(41=f2) 42 43'];
  assert.deepEqual(picture(fieldMap(lines, 1, 4).editable, 4), ['.###']);
});

test('an unformatted screen has no fields, so nothing is marked typeable', () => {
  const lines = ['41 42 43 44', '45 46 47 48'];
  const map = fieldMap(lines, 2, 4);
  assert.deepEqual(map.editable.some(Boolean), false);
  assert.deepEqual(map.hidden.some(Boolean), false);
});

test('rows b3270 did not return stay with whatever protection was in force', () => {
  const lines = ['SF(c0=cd) 00 00 00'];
  assert.deepEqual(picture(fieldMap(lines, 2, 4).editable, 4), ['.###', '####']);
});

test('a non-display field (the 0x0c intensity bits set) is marked hidden, an ordinary one is not', () => {
  // c0=cd is protect=0, intensity=11 (non-display) — a password-style field.
  // c0=c0 is protect=0, intensity=00 (ordinary) — a ordinary unprotected one.
  const lines = ['SF(c0=cd) 41 42 SF(c0=c0) 43 44'];
  assert.deepEqual(picture(fieldMap(lines, 1, 6).hidden, 6), ['.##...']);
});
