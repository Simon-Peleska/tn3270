import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsPage, THEMES, FONTS } from '../public/settings.js';

/**
 * The settings page is drawn as VT into the terminal, so it holds no DOM and can
 * be driven here exactly as a keyboard would drive it.
 */

/**
 * @param {{ key?: string, code?: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean }} init
 * @returns {KeyboardEvent}
 */
function key(init) {
  return /** @type {KeyboardEvent} */ ({
    key: init.key ?? '',
    code: init.code ?? '',
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: false,
    repeat: false,
  });
}

/**
 * The browser measures its own window; here it is a window of a fixed pixel
 * size, with cells that grow with the text the way a monospace font's do.
 *
 * @param {number} width
 * @param {number} height
 * @returns {(fontSize: number) => { cols: number, rows: number }}
 */
function windowOf(width, height) {
  return (fontSize) => ({
    cols: Math.floor(width / (fontSize * 0.6)),
    rows: Math.floor(height / (fontSize * 1.2)) - 1,
  });
}

/** @param {(fontSize: number) => { cols: number, rows: number } | null} [fit] what the window would hold */
function fixture(fit = () => ({ cols: 158, rows: 60 })) {
  const calls = {
    /** @type {string[]} */ written: [],
    /** @type {string[]} */ themes: [],
    /** @type {string[]} */ fonts: [],
    /** @type {number[]} */ models: [],
    /** @type {string[]} */ oversizes: [],
    /** @type {boolean[]} */ hostColors: [],
    /** @type {(string | null)[]} */ hosts: [],
    /** @type {number} */ restores: 0,
    /** @type {import('../public/store.js').StoredSettings[]} */ saved: [],
  };
  const page = new SettingsPage({
    write: (bytes) => calls.written.push(bytes),
    geometry: () => ({ cols: 80, rows: 25 }),
    applyTheme: (theme) => calls.themes.push(theme.name),
    applyFont: (font) => calls.fonts.push(font.name),
    applyModel: (model) => calls.models.push(model),
    applyOversize: (value) => calls.oversizes.push(value),
    windowFit: fit,
    applyHostColors: (enabled) => calls.hostColors.push(enabled),
    connect: (host) => calls.hosts.push(host),
    restore: () => { calls.restores += 1; },
    persist: (values) => calls.saved.push(values),
  });
  page.models = [
    { model: 2, rows: 24, columns: 80 },
    { model: 3, rows: 32, columns: 80 },
    { model: 4, rows: 43, columns: 80 },
    { model: 5, rows: 27, columns: 132 },
  ];
  return { page, calls };
}

test('alt+space opens and closes the page, and closing asks for the screen back', () => {
  const { page, calls } = fixture();

  assert.equal(page.handleKey(key({ code: 'Space', altKey: true })), true);
  assert.equal(page.open, true);
  assert.ok(calls.written.length > 0, 'the page must have been drawn');

  assert.equal(page.handleKey(key({ code: 'Space', altKey: true })), true);
  assert.equal(page.open, false);
  assert.equal(calls.restores, 1);
});

test('a closed page consumes nothing', () => {
  const { page } = fixture();
  assert.equal(page.handleKey(key({ key: 'a', code: 'KeyA' })), false);
});

test('an open page swallows keys so the host is not typed at through it', () => {
  const { page } = fixture();
  page.show();
  assert.equal(page.handleKey(key({ key: 'a', code: 'KeyA' })), true);
  // ...except the browser's own shortcuts.
  assert.equal(page.handleKey(key({ key: 'r', code: 'KeyR', ctrlKey: true })), false);
});

test('theme and font apply as you scroll through them and are saved by name', () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  page.handleKey(key({ key: 'ArrowRight' }));
  assert.deepEqual(calls.themes, [THEMES[1]?.name]);

  page.handleKey(key({ key: 'ArrowDown' }));
  page.handleKey(key({ key: 'ArrowRight' }));
  assert.deepEqual(calls.fonts, [FONTS[1]?.name]);

  assert.deepEqual(calls.saved.at(-1), {
    theme: THEMES[1]?.name,
    font: FONTS[1]?.name,
    model: 2,
    hostColors: true,
    fitFontSize: 16,
  });
  assert.deepEqual(calls.models, [], 'the screen size must not have moved');
});

test('a saved theme and font are taken up by name, and an unknown one is ignored', () => {
  const { page } = fixture();
  page.restoreSaved({ theme: 'Amber', font: 'Fira Mono' });
  assert.equal(page.theme().name, 'Amber');
  assert.equal(page.font().name, 'Fira Mono');

  page.restoreSaved({ theme: 'a theme from a later version' });
  assert.equal(page.theme().name, 'Amber', 'a name we no longer know must not reset the choice');
});

test('host colours default on, and either arrow key flips the saved toggle', () => {
  const { page, calls } = fixture();
  assert.equal(page.hostColors, true);

  page.connected = true;
  page.show();
  page.selected = 4;
  page.handleKey(key({ key: 'ArrowRight' }));

  assert.equal(page.hostColors, false);
  assert.deepEqual(calls.hostColors, [false]);
  assert.deepEqual(calls.saved.at(-1), {
    theme: THEMES[0]?.name,
    font: FONTS[0]?.name,
    model: 2,
    hostColors: false,
    fitFontSize: 16,
  });

  page.restoreSaved({ hostColors: false });
  assert.equal(page.hostColors, false);
});

test('a screen size change waits for Enter and warns what it costs', () => {
  const { page, calls } = fixture();
  page.setModel(4);
  page.connected = true;
  page.show();

  page.handleKey(key({ key: 'ArrowDown' }));
  page.handleKey(key({ key: 'ArrowDown' }));
  page.handleKey(key({ key: 'ArrowRight' }));

  assert.equal(page.pendingModel, 5);
  assert.deepEqual(calls.models, [], 'nothing may happen before Enter');
  const drawn = calls.written.at(-1) ?? '';
  assert.match(drawn, /Model 5 - 27x132/);
  assert.match(drawn, /The host connection is dropped and reopened/);

  page.handleKey(key({ key: 'Enter' }));
  assert.deepEqual(calls.models, [5]);
  assert.equal(page.open, false);
  assert.equal(calls.restores, 1);
});

test('fit to window asks for the screen the browser measured, on Enter', () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  page.selected = 3;
  page.handleKey(key({ key: 'ArrowRight' }));

  assert.equal(page.pendingOversize, '158x60');
  assert.deepEqual(calls.oversizes, [], 'nothing may happen before Enter');
  const drawn = calls.written.at(-1) ?? '';
  assert.match(drawn, /158x60/);
  assert.match(drawn, /The host connection is dropped and reopened/);

  page.handleKey(key({ key: 'Enter' }));
  assert.deepEqual(calls.oversizes, ['158x60']);
  assert.deepEqual(calls.models, [], 'the model itself did not move');
});

test('fitting again turns it off, and the model is the floor', () => {
  // b3270 refuses an oversize smaller than the model it is running, so a
  // window too small to hold the model has to ask for the model's own size.
  const { page } = fixture(() => ({ cols: 40, rows: 12 }));
  page.setModel(5);
  page.connected = true;
  page.show();

  page.selected = 3;
  page.handleKey(key({ key: 'ArrowRight' }));
  assert.equal(page.pendingOversize, '132x27');

  page.handleKey(key({ key: 'ArrowLeft' }));
  assert.equal(page.pendingOversize, '', 'off is the model on its own');
});

test('the text size appears with the fit and drives what it measures', () => {
  const { page, calls } = fixture(windowOf(1600, 800));
  page.connected = true;
  page.show();

  page.selected = 3;
  assert.equal(page.rows().length, 5, 'the text size is not offered while the fit is off');

  page.handleKey(key({ key: 'ArrowRight' }));
  assert.equal(page.pendingOversize, '166x40');
  assert.equal(page.rows().length, 6);
  assert.equal(page.rows()[4]?.key, 'fitSize');
  assert.equal(page.rows()[4]?.value, '16 px');

  page.handleKey(key({ key: 'ArrowDown' }));
  page.handleKey(key({ key: 'ArrowRight' }));
  assert.equal(page.fitFontSize, 17);
  assert.equal(page.pendingOversize, '156x38', 'bigger text, fewer cells');
  assert.equal(calls.saved.at(-1)?.fitFontSize, 17, 'the text size is remembered');

  page.handleKey(key({ key: 'Enter' }));
  assert.deepEqual(calls.oversizes, ['156x38']);
});

test('the text size stops at both ends instead of wrapping round', () => {
  const { page } = fixture(windowOf(1600, 800));
  page.connected = true;
  page.show();

  page.selected = 3;
  page.handleKey(key({ key: 'ArrowRight' }));
  page.selected = 4;

  for (let step = 0; step < 30; step++) page.handleKey(key({ key: 'ArrowLeft' }));
  assert.equal(page.fitFontSize, 8);
  for (let step = 0; step < 60; step++) page.handleKey(key({ key: 'ArrowRight' }));
  assert.equal(page.fitFontSize, 32);
});

test('a screen bigger than b3270 can hold is trimmed to fit its buffer', () => {
  // 16383 cells is the whole 3270 buffer b3270 allocates; asking for more is
  // refused outright, which would be a mystery from a page that just measured
  // a very large window.
  const { page } = fixture(() => ({ cols: 400, rows: 120 }));
  page.connected = true;
  page.show();

  page.selected = 3;
  page.handleKey(key({ key: 'ArrowRight' }));

  const [cols, rows] = (page.pendingOversize.split('x')).map(Number);
  assert.equal(rows, 120);
  assert.ok((cols ?? 0) * (rows ?? 0) <= 16383, `${page.pendingOversize} does not fit the buffer`);
});

test('nothing the page draws runs off the right edge', () => {
  // Autowrap is off, so a line wider than the screen is silently cut in half
  // rather than wrapping — which is exactly how the size warning first shipped.
  const { page, calls } = fixture();
  page.setModel(2);
  page.connected = true;
  page.show();
  page.selected = 2;
  page.pendingModel = 5;
  page.pendingOversize = '166x40';
  page.draw();

  const drawn = calls.written.at(-1) ?? '';
  for (const move of drawn.matchAll(/\x1b\[\d+;(\d+)H((?:\x1b\[[0-9;]*m)*)([^\x1b]*)/g)) {
    const column = Number(move[1]);
    const text = move[3] ?? '';
    assert.ok(
      column + text.length - 1 <= 80,
      `"${text}" starts at column ${column} and does not fit in 80`,
    );
  }
});

test('escape leaves the screen size exactly as it was', () => {
  const { page, calls } = fixture();
  page.setModel(2);
  page.connected = true;
  page.show();

  page.handleKey(key({ key: 'ArrowDown' }));
  page.handleKey(key({ key: 'ArrowDown' }));
  page.handleKey(key({ key: 'ArrowRight' }));
  page.handleKey(key({ key: 'Escape' }));

  assert.deepEqual(calls.models, []);
  assert.equal(page.open, false);
  // Reopening must not still be holding the size the user walked away from.
  page.show();
  assert.equal(page.pendingModel, 2);
});

test('the server has the last word on the screen size', () => {
  const { page } = fixture();
  page.setModel(3);
  assert.equal(page.model, 3);
  assert.equal(page.pendingModel, 3);
});

test('the host field leads while disconnected, types, backspaces, and enter connects', () => {
  const { page, calls } = fixture();
  page.show();
  assert.equal(page.selected, 0, 'disconnected, so the host field leads');

  for (const char of '127.1') page.handleKey(key({ key: char }));
  assert.equal(page.host, '127.1');

  page.handleKey(key({ key: 'Backspace' }));
  assert.equal(page.host, '127.');

  page.handleKey(key({ key: 'Enter' }));
  assert.deepEqual(calls.hosts, ['127.']);
  assert.equal(page.open, true, 'the page stays open until the server confirms it connected');
});

test('a locked host is shown but not editable, and enter asks to reopen it', () => {
  const { page, calls } = fixture();
  page.setHostLocked(true);
  page.show();

  page.handleKey(key({ key: 'x' }));
  assert.equal(page.host, '', 'typing must not reach a host the server controls');

  page.handleKey(key({ key: 'Enter' }));
  assert.deepEqual(calls.hosts, [null]);
});

test('arrow keys step past the host field onto the usual fields, and back', () => {
  const { page, calls } = fixture();
  page.show();
  assert.equal(page.selected, 0);

  page.handleKey(key({ key: 'ArrowDown' }));
  assert.equal(page.selected, 1);
  page.handleKey(key({ key: 'ArrowRight' }));
  assert.deepEqual(calls.themes, [THEMES[1]?.name]);

  page.handleKey(key({ key: 'ArrowUp' }));
  assert.equal(page.selected, 0, 'back on the host field');
});

test('the host field is gone once connected, and the usual fields start at the top', () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  assert.equal(page.selected, 0);
  page.handleKey(key({ key: 'ArrowRight' }));
  assert.deepEqual(calls.themes, [THEMES[1]?.name], 'field 0 is the theme, not the host, while connected');
});

test("every theme's field colour stands out against both backgrounds it is drawn on", () => {
  for (const theme of THEMES) {
    const { field, background, black } = theme.colors;
    assert.ok(field !== undefined, `${theme.name} has no field colour`);
    // This page draws the field blocks on `background`; the server paints the
    // host's typeable fields over `black`, where a host's default background
    // lands. Matching either one makes the field invisible on that screen.
    assert.notEqual(field, background, `${theme.name}'s field colour is its background`);
    assert.notEqual(field, black, `${theme.name}'s field colour is its ANSI black`);
  }
});
