import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_TOP, PANELS, Panel, ROW_COMMAND, TEXT_LEFT, actionBar, bodyHeight, dotted, panelIdForOption, parseCommand } from '../public/panel.js';
import { HelpPage, MenuPage } from '../public/menu.js';
import { SettingsPage, THEMES } from '../public/settings.js';
import { MacrosPage } from '../public/macros.js';
import { RecorderPage } from '../public/recorder.js';
import { KeymapPage } from '../public/keymap-page.js';

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

/** @extends {Panel<import('../public/panel.js').PanelDeps>} */
class ListPanel extends Panel {
  /**
   * @param {import('../public/panel.js').PanelDeps} deps
   * @param {number} [count]
   */
  constructor(deps, count = 4) {
    super('settings', deps);
    this.count = count;
    /** @type {string[]} */
    this.picked = [];
    /** @type {number[]} */
    this.changed = [];
  }

  /**
   * @override
   * @returns {import('../public/panel.js').PanelLine[]}
   */
  lines() {
    /** @type {import('../public/panel.js').PanelLine[]} */
    const lines = [{ text: 'A heading', gap: true }];
    for (let index = 1; index <= this.count; index++) {
      lines.push({ option: String(index), text: `Line ${index}`, value: `value ${index}` });
    }
    return lines;
  }

  /**
   * @override
   * @returns {string}
   */
  title() {
    return 'A Test Panel';
  }

  /**
   * @override
   * @returns {void}
   */
  activate() {
    this.picked.push(this.lines()[this.selected]?.text ?? '');
  }

  /**
   * @override
   * @param {number} step
   * @returns {void}
   */
  change(step) {
    this.changed.push(step);
  }

  /**
   * @override
   * @param {string} word
   * @returns {boolean}
   */
  word(word) {
    if (word !== 'KNOWN') return false;
    this.picked.push('the word');
    return true;
  }
}

/** @param {number} [count] */
function fixture(count = 4) {
  const calls = {
    /** @type {string[]} */ written: [],
    /** @type {number} */ ends: 0,
    /** @type {string[]} */ went: [],
  };
  const deps = {
    write: (/** @type {string} */ bytes) => calls.written.push(bytes),
    geometry: () => ({ cols: 80, rows: 25 }),
    theme: () => THEMES[0],
    end: () => { calls.ends += 1; },
    go: (/** @type {string} */ id) => calls.went.push(id),
  };
  return { page: new ListPanel(deps, count), calls, deps };
}

test('the command line knows the ISPF verbs, a jump and a line number', () => {
  assert.deepEqual(parseCommand(''), { kind: 'none' });
  assert.deepEqual(parseCommand('  =3 '), { kind: 'jump', option: '3' });
  assert.deepEqual(parseCommand('end'), { kind: 'end' });
  assert.deepEqual(parseCommand('X'), { kind: 'end' });
  assert.deepEqual(parseCommand('cancel'), { kind: 'cancel' });
  assert.deepEqual(parseCommand('return'), { kind: 'return' });
  assert.deepEqual(parseCommand('?'), { kind: 'help' });
  assert.deepEqual(parseCommand('12'), { kind: 'select', option: '12' });
  assert.deepEqual(parseCommand('apply'), { kind: 'word', word: 'APPLY' });
});

test('every numbered panel is reachable by its number, and nothing else is', () => {
  assert.equal(panelIdForOption('0'), 'settings');
  assert.equal(panelIdForOption('3'), 'keymap');
  assert.equal(panelIdForOption('h'), 'help');
  assert.equal(panelIdForOption('9'), null);
  assert.equal(panelIdForOption(''), null);
});

test('the action bar lists every panel, and its columns match what it drew', () => {
  const bar = actionBar();
  for (const panel of PANELS) {
    const span = bar.spans.find((entry) => entry.id === panel.id);
    assert.ok(span !== undefined, `${panel.name} is not on the action bar`);
    assert.equal(bar.text.slice(span.start - 1, span.end), panel.name);
  }
});

test('a dot leader fills the label out to the width, and a long label is cut to it', () => {
  assert.equal(dotted('Theme', 12), 'Theme . . . ');
  assert.equal(dotted('A label too long for this', 8).length, 8);
});

test('the panel opens on its command line and Tab walks onto the body, skipping headings', () => {
  const { page } = fixture();
  page.show();
  assert.equal(page.onCommand, true);

  page.handleKey(key({ key: 'Tab' }));
  assert.equal(page.onCommand, false);
  assert.equal(page.selected, 1, 'the heading is stepped over');

  page.handleKey(key({ key: 'ArrowDown' }));
  assert.equal(page.selected, 2);

  page.handleKey(key({ key: 'ArrowUp' }));
  page.handleKey(key({ key: 'ArrowUp' }));
  assert.equal(page.onCommand, true, 'up from the first field is the command line again');
});

test('left and right change the field the cursor is on, and never the command line', () => {
  const { page } = fixture();
  page.show();

  page.handleKey(key({ key: 'ArrowRight' }));
  assert.deepEqual(page.changed, [], 'nothing to change on the command line');

  page.handleKey(key({ key: 'Tab' }));
  page.handleKey(key({ key: 'ArrowRight' }));
  page.handleKey(key({ key: 'ArrowLeft' }));
  assert.deepEqual(page.changed, [1, -1]);
});

test('a line number typed on the command line picks that line', () => {
  const { page } = fixture();
  page.show();

  for (const char of '3') page.handleKey(key({ key: char }));
  page.handleKey(key({ key: 'Enter' }));

  assert.deepEqual(page.picked, ['Line 3']);
  assert.equal(page.command, '', 'the command line is cleared once it has run');
});

test('a number no line carries is answered on the panel', () => {
  const { page } = fixture();
  page.show();
  for (const char of '9') page.handleKey(key({ key: char }));
  page.handleKey(key({ key: 'Enter' }));
  assert.match(page.message, /9/);
  assert.deepEqual(page.picked, []);
});

test('the PF keys do what ISPF says they do', () => {
  const { page, calls } = fixture();
  page.show();

  page.handleKey(key({ key: 'F1' }));
  assert.deepEqual(calls.went, ['help']);

  page.handleKey(key({ key: 'F4' }));
  assert.deepEqual(calls.went, ['help', 'menu']);

  page.handleKey(key({ key: 'F3' }));
  assert.equal(page.open, false);
  assert.equal(calls.ends, 1);
});

test('a jump command reaches any panel, and a bad one says so', () => {
  const { page, calls } = fixture();
  page.show();

  for (const char of '=2') page.handleKey(key({ key: char }));
  page.handleKey(key({ key: 'Enter' }));
  assert.deepEqual(calls.went, ['recorder']);

  for (const char of '=7') page.handleKey(key({ key: char }));
  page.handleKey(key({ key: 'Enter' }));
  assert.deepEqual(calls.went, ['recorder'], 'nothing is numbered 7');
  assert.match(page.message, /7/);
});

test('a panel named on the action bar can be typed instead of its number', () => {
  const { page, calls } = fixture();
  page.show();
  for (const char of 'macros') page.handleKey(key({ key: char }));
  page.handleKey(key({ key: 'Enter' }));
  assert.deepEqual(calls.went, ['macros']);
});

test("a word the panel knows is its own, and one it does not is refused", () => {
  const { page } = fixture();
  page.show();

  for (const char of 'known') page.handleKey(key({ key: char }));
  page.handleKey(key({ key: 'Enter' }));
  assert.deepEqual(page.picked, ['the word']);

  for (const char of 'unknown') page.handleKey(key({ key: char }));
  page.handleKey(key({ key: 'Enter' }));
  assert.match(page.message, /unknown is not a command here/i);
});

test('a list longer than the body scrolls, and says which way there is more', () => {
  const { page, calls } = fixture(40);
  page.show();
  const height = bodyHeight(25);

  page.handleKey(key({ key: 'F8' }));
  assert.equal(page.selected, height, 'a page down from the top lands a body deeper in');
  assert.match(calls.written.at(-1) ?? '', /More: -\+/);

  page.handleKey(key({ key: 'F7' }));
  assert.equal(page.selected, 1, 'and a page back lands on the first line again');
  assert.match(calls.written.at(-1) ?? '', /More: {2}\+/);
});

test('a click lands where it was aimed: the action bar, the command line, or a line', () => {
  const { page, calls } = fixture();
  page.show();

  const macros = actionBar().spans.find((span) => span.id === 'macros');
  page.clicked(1, macros?.start ?? 1);
  assert.deepEqual(calls.went, ['macros']);

  page.clicked(BODY_TOP + 2, 10);
  assert.equal(page.onCommand, false);
  assert.equal(page.selected, 2);

  page.clicked(ROW_COMMAND, 20);
  assert.equal(page.onCommand, true);
});

test('copy and paste work on the panel, as they do on the screen', () => {
  const { page } = fixture();
  page.show();

  page.paste('=3\nand a second line');
  assert.equal(page.command, '=3', 'only the first line is a command');
  assert.equal(page.copy(), '=3');

  page.command = '';
  page.handleKey(key({ key: 'Tab' }));
  page.handleKey(key({ key: 'ArrowDown' }));
  assert.equal(page.copy(), 'value 2', 'with the cursor in the body, the field is what is copied');
});

test('an open panel swallows keys, but leaves the browser its own', () => {
  const { page } = fixture();
  page.show();
  assert.equal(page.handleKey(key({ key: 'q' })), true);
  assert.equal(page.handleKey(key({ key: 'r', ctrlKey: true })), false);
  page.close();
  assert.equal(page.handleKey(key({ key: 'q' })), false);
});

test('nothing a panel draws runs off the right edge', () => {
  // Autowrap is off, so a line wider than the screen is silently cut, not wrapped.
  const { page, calls } = fixture(40);
  page.show();
  page.say('a message about something');

  const drawn = calls.written.at(-1) ?? '';
  for (const move of drawn.matchAll(/\x1b\[\d+;(\d+)H((?:\x1b\[[0-9;]*m)*)([^\x1b]*)/g)) {
    const column = Number(move[1]);
    const text = move[3] ?? '';
    assert.ok(column + text.length - 1 <= 80, `"${text}" starts at column ${column} and does not fit in 80`);
  }
});

test('nothing any panel writes is wider than an 80-column screen', () => {
  // Autowrap is off and the text starts in column 2, so anything longer is cut.
  const deps = {
    write: () => {},
    geometry: () => ({ cols: 80, rows: 25 }),
    theme: () => THEMES[0],
    end: () => {},
    go: () => {},
    dispatch: () => {},
    waitForUnlock: () => Promise.resolve(),
    persist: () => {},
    exportFile: () => {},
    importFiles: () => Promise.resolve([]),
    error: () => {},
    applyTheme: () => {},
    applyFont: () => {},
    applyModel: () => {},
    applyOversize: () => {},
    windowFit: () => ({ cols: 80, rows: 25 }),
    applyHostColors: () => {},
    applySharing: () => {},
    applyAutomation: () => {},
    connect: () => {},
  };
  const pages = [
    new MenuPage(deps),
    new HelpPage(deps),
    new SettingsPage(deps),
    new MacrosPage(deps),
    new RecorderPage(deps),
    new KeymapPage(deps),
  ];
  for (const page of pages) {
    for (const note of page.notes()) {
      assert.ok(note.length <= 79, `${page.id} note is ${note.length} long: ${note}`);
    }
    const legend = page.keys().join('  ');
    assert.ok(legend.length <= 79, `${page.id} legend is ${legend.length} long: ${legend}`);

    const labelWidth = page.labelWidth();
    for (const line of page.lines()) {
      const text = line.text ?? '';
      const value = line.value ?? '';
      if (value === '') continue;
      assert.ok(text.length <= labelWidth, `${page.id} label "${text}" is wider than its ${labelWidth}`);
      const right = TEXT_LEFT + labelWidth + value.length + (line.field === true ? 2 : 0);
      assert.ok(right <= 80, `${page.id} value "${value}" ends at column ${right}`);
    }
  }
});

test('the primary option menu opens the panel behind each number', () => {
  /** @type {string[]} */
  const went = [];
  let ends = 0;
  const menu = new MenuPage({
    write: () => {},
    geometry: () => ({ cols: 80, rows: 25 }),
    theme: () => THEMES[0],
    end: () => { ends += 1; },
    go: (id) => went.push(id),
  });
  menu.show();

  for (const char of '1') menu.handleKey(key({ key: char }));
  menu.handleKey(key({ key: 'Enter' }));
  assert.deepEqual(went, ['macros']);

  for (const char of 'x') menu.handleKey(key({ key: char }));
  menu.handleKey(key({ key: 'Enter' }));
  assert.equal(menu.open, false);
  assert.equal(ends, 1);
});

test('the help panel lists the keys, the commands and the shortcuts', () => {
  const help = new HelpPage({
    write: () => {},
    geometry: () => ({ cols: 80, rows: 25 }),
    theme: () => THEMES[0],
    end: () => {},
    go: () => {},
  });
  const text = help.lines().map((line) => `${line.text ?? ''} ${line.value ?? ''}`).join('\n');
  assert.match(text, /F3/);
  assert.match(text, /=0 to =3/);
  assert.match(text, /Alt-Space/);
});
