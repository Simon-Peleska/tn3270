import test from 'node:test';
import assert from 'node:assert/strict';
import { mapKey } from '../public/keymap.js';

/**
 * The map only ever reads a handful of fields off the event, so a plain object
 * is a faithful stand-in and the tests need no browser.
 *
 * @param {{ key?: string, code?: string, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean, shiftKey?: boolean, repeat?: boolean }} init
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
    repeat: init.repeat ?? false,
  });
}

test('the 3270 key positions are kept: right Ctrl is Enter, Enter is New line', () => {
  assert.deepEqual(mapKey(key({ key: 'Control', code: 'ControlRight', ctrlKey: true })), {
    kind: 'action', action: 'Enter', args: [],
  });
  assert.deepEqual(mapKey(key({ key: 'Enter', code: 'Enter' })), {
    kind: 'action', action: 'Newline', args: [],
  });
});

test('holding the Enter key down does not machine-gun the host', () => {
  assert.equal(mapKey(key({ key: 'Control', code: 'ControlRight', ctrlKey: true, repeat: true })), null);
});

test('holding down any other AID key is dropped the same way, but ordinary keys still repeat', () => {
  // Clear, PF and PA all unlock the keyboard and ask the host for a fresh
  // screen, exactly like Enter — a repeat of any of them is just as capable
  // of leaving a host like TSO keyboard-locked on a blank screen.
  assert.equal(mapKey(key({ key: 'Escape', code: 'Escape', repeat: true })), null);
  assert.equal(mapKey(key({ key: 'F3', code: 'F3', repeat: true })), null);
  assert.equal(mapKey(key({ key: '1', code: 'Digit1', ctrlKey: true, repeat: true })), null);

  assert.deepEqual(mapKey(key({ key: 'Escape', code: 'Escape' })), { kind: 'action', action: 'Clear', args: [] });

  // Cursor movement and editing keys are not AIDs, so the OS's normal
  // key-repeat behaviour must keep working for them.
  assert.deepEqual(mapKey(key({ key: 'ArrowRight', code: 'ArrowRight', repeat: true })), {
    kind: 'action', action: 'Right', args: [],
  });
});

test('left Control still means the control bindings', () => {
  assert.deepEqual(mapKey(key({ key: 'a', code: 'KeyA', ctrlKey: true })), {
    kind: 'action', action: 'Attn', args: [],
  });
});

test('function keys are PF keys, shifted ones are the high twelve', () => {
  assert.deepEqual(mapKey(key({ key: 'F3', code: 'F3' })), { kind: 'action', action: 'PF', args: ['3'] });
  assert.deepEqual(mapKey(key({ key: 'F3', code: 'F3', shiftKey: true })), {
    kind: 'action', action: 'PF', args: ['15'],
  });
});

test('a printable key is text and Alt is left to the page', () => {
  assert.deepEqual(mapKey(key({ key: 'x', code: 'KeyX' })), { kind: 'text', value: 'x' });
  // Alt+Space opens the settings page, so nothing with Alt may reach the host.
  assert.equal(mapKey(key({ key: ' ', code: 'Space', altKey: true })), null);
});
