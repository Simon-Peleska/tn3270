import test from 'node:test';
import assert from 'node:assert/strict';
import { editableFieldText } from '../server/readbuffer.js';

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
