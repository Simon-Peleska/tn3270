import test from 'node:test';
import assert from 'node:assert/strict';
import { keymapToText, parseKeymapText } from '../public/keymap-format.js';
import { DEFAULT_BINDINGS } from '../public/keymap.js';

test('the default bindings round-trip through the exported text', () => {
  const text = parseKeymapText(keymapToText(DEFAULT_BINDINGS));
  assert.deepEqual(text, DEFAULT_BINDINGS);
});

test('a function key, a Ctrl combo and Copy/Paste read as HOD-style lines', () => {
  const text = keymapToText(DEFAULT_BINDINGS);
  assert.match(text, /^F3=pf3$/m);
  assert.match(text, /^S-F3=pf15$/m);
  assert.match(text, /^C-C=copy$/m);
  assert.match(text, /^S-Insert=paste$/m);
});

test('a line for a command this app does not know is skipped, not thrown away entirely', () => {
  const bindings = parseKeymapText('F5=pf5\nF6=notarealcommand\n');
  assert.deepEqual(bindings, { PF5: [{ code: 'F5', shift: false, ctrl: false, alt: false }] });
});

test('a stray line with no "=" is ignored', () => {
  assert.deepEqual(parseKeymapText('not a binding line'), {});
});
