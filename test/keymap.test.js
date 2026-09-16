import test from 'node:test';
import assert from 'node:assert/strict';
import { mapKey, buildLookup, DEFAULT_BINDINGS } from '../public/keymap.js';

const lookup = buildLookup(DEFAULT_BINDINGS);

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
  assert.deepEqual(mapKey(key({ key: 'Control', code: 'ControlRight', ctrlKey: true }), lookup), {
    kind: 'action', action: 'Enter', args: [],
  });
  assert.deepEqual(mapKey(key({ key: 'Enter', code: 'Enter' }), lookup), {
    kind: 'action', action: 'Newline', args: [],
  });
});

test('holding the Enter key down does not machine-gun the host', () => {
  assert.equal(mapKey(key({ key: 'Control', code: 'ControlRight', ctrlKey: true, repeat: true }), lookup), null);
});

test('holding down any other AID key is dropped the same way, but ordinary keys still repeat', () => {
  // Attn, PF and PA all unlock the keyboard and ask the host for a fresh
  // screen, exactly like Enter — a repeat of any of them is just as capable
  // of leaving a host like TSO keyboard-locked on a blank screen.
  assert.equal(mapKey(key({ key: 'Escape', code: 'Escape', repeat: true }), lookup), null);
  assert.equal(mapKey(key({ key: 'F3', code: 'F3', repeat: true }), lookup), null);
  assert.equal(mapKey(key({ key: 'Insert', code: 'Insert', altKey: true, repeat: true }), lookup), null);

  assert.deepEqual(mapKey(key({ key: 'Escape', code: 'Escape' }), lookup), { kind: 'action', action: 'Attn', args: [] });

  // Cursor movement and editing keys are not AIDs, so the OS's normal
  // key-repeat behaviour must keep working for them.
  assert.deepEqual(mapKey(key({ key: 'ArrowRight', code: 'ArrowRight', repeat: true }), lookup), {
    kind: 'action', action: 'Right', args: [],
  });
});

test('plain Ctrl combinations nothing binds are left to the browser', () => {
  assert.equal(mapKey(key({ key: 'a', code: 'KeyA', ctrlKey: true }), lookup), null);
});

test('Ctrl-C and Ctrl-Insert are the Copy command, not a 3270 action', () => {
  assert.deepEqual(mapKey(key({ key: 'c', code: 'KeyC', ctrlKey: true }), lookup), { kind: 'client', command: 'Copy' });
  assert.deepEqual(mapKey(key({ key: 'Insert', code: 'Insert', ctrlKey: true }), lookup), { kind: 'client', command: 'Copy' });
});

test('function keys are PF keys, shifted ones are the high twelve', () => {
  assert.deepEqual(mapKey(key({ key: 'F3', code: 'F3' }), lookup), { kind: 'action', action: 'PF', args: ['3'] });
  assert.deepEqual(mapKey(key({ key: 'F3', code: 'F3', shiftKey: true }), lookup), {
    kind: 'action', action: 'PF', args: ['15'],
  });
});

test('Escape is Attn, Shift-Escape is SysReq, PCOMM-style', () => {
  assert.deepEqual(mapKey(key({ key: 'Escape', code: 'Escape' }), lookup), { kind: 'action', action: 'Attn', args: [] });
  assert.deepEqual(mapKey(key({ key: 'Escape', code: 'Escape', shiftKey: true }), lookup), {
    kind: 'action', action: 'SysReq', args: [],
  });
});

test('Pause is Clear and Caps Lock is Reset, PCOMM-style', () => {
  assert.deepEqual(mapKey(key({ key: 'Pause', code: 'Pause' }), lookup), { kind: 'action', action: 'Clear', args: [] });
  assert.deepEqual(mapKey(key({ key: 'CapsLock', code: 'CapsLock' }), lookup), { kind: 'action', action: 'Reset', args: [] });
});

test('End is EraseEOF, Alt-End is EraseInput', () => {
  assert.deepEqual(mapKey(key({ key: 'End', code: 'End' }), lookup), { kind: 'action', action: 'EraseEOF', args: [] });
  assert.deepEqual(mapKey(key({ key: 'End', code: 'End', altKey: true }), lookup), {
    kind: 'action', action: 'EraseInput', args: [],
  });
});

test('Insert and Home carry PA1/PA2 on Alt, and Shift-Insert pastes instead of Dup', () => {
  assert.deepEqual(mapKey(key({ key: 'Insert', code: 'Insert' }), lookup), { kind: 'action', action: 'ToggleInsert', args: [] });
  assert.deepEqual(mapKey(key({ key: 'Insert', code: 'Insert', shiftKey: true }), lookup), { kind: 'client', command: 'Paste' });
  assert.deepEqual(mapKey(key({ key: 'Insert', code: 'Insert', altKey: true }), lookup), { kind: 'action', action: 'PA', args: ['1'] });

  assert.deepEqual(mapKey(key({ key: 'Home', code: 'Home' }), lookup), { kind: 'action', action: 'Home', args: [] });
  assert.deepEqual(mapKey(key({ key: 'Home', code: 'Home', shiftKey: true }), lookup), {
    kind: 'action', action: 'FieldMark', args: [],
  });
  assert.deepEqual(mapKey(key({ key: 'Home', code: 'Home', altKey: true }), lookup), { kind: 'action', action: 'PA', args: ['2'] });
});

test('Shift-PageUp is PA3, plain PageUp is unbound', () => {
  assert.deepEqual(mapKey(key({ key: 'PageUp', code: 'PageUp', shiftKey: true }), lookup), { kind: 'action', action: 'PA', args: ['3'] });
  assert.equal(mapKey(key({ key: 'PageUp', code: 'PageUp' }), lookup), null);
});

test('a printable key is text and Alt is otherwise left to the page', () => {
  assert.deepEqual(mapKey(key({ key: 'x', code: 'KeyX' }), lookup), { kind: 'text', value: 'x' });
  // Alt+Space opens the settings page; mapKey never sees it in practice, but
  // it must still refuse it since nothing binds the space bar.
  assert.equal(mapKey(key({ key: ' ', code: 'Space', altKey: true }), lookup), null);
});

test('a binding can be removed even with none left for its command', () => {
  const empty = buildLookup({ ...DEFAULT_BINDINGS, Attn: [] });
  assert.equal(mapKey(key({ key: 'Escape', code: 'Escape' }), empty), null);
});

test('rebinding a combo to a new command steals it from whatever had it, at the lookup level', () => {
  // buildLookup itself has no opinion on this — it is the keymap page's job to
  // remove a combo from its old command before adding it to a new one — but a
  // lookup built from bindings where that already happened must reflect it.
  const moved = buildLookup({ ...DEFAULT_BINDINGS, Attn: [], Clear: [...DEFAULT_BINDINGS.Clear, { code: 'Escape', shift: false, ctrl: false, alt: false }] });
  assert.deepEqual(mapKey(key({ key: 'Escape', code: 'Escape' }), moved), { kind: 'action', action: 'Clear', args: [] });
});
