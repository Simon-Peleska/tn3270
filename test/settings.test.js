import test from "node:test";
import assert from "node:assert/strict";
import { SettingsPage, THEMES, FONTS } from "../public/settings.js";
import {
  key,
  enterKey,
  defaultKeymapDeps,
  drawn,
  recordedPuts,
} from "./keyevent.js";

/**
 * A fixed-pixel window whose cells grow with the text, as a monospace font's do.
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

/**
 * @param {SettingsPage} page
 * @returns {string[]} the keys of the fields, leaving out the headings
 */
function fieldKeys(page) {
  return page
    .rows()
    .filter((row) => row.gap !== true)
    .map((row) => row.key);
}

/** @param {(fontSize: number) => { cols: number, rows: number } | null} [fit] */
function fixture(fit = () => ({ cols: 158, rows: 60 })) {
  const calls = {
    /** @type {number} */ redraws: 0,
    /** @type {string[]} */ themes: [],
    /** @type {string[]} */ fonts: [],
    /** @type {number[]} */ models: [],
    /** @type {string[]} */ oversizes: [],
    /** @type {boolean[]} */ fieldBackgrounds: [],
    /** @type {(string | null)[]} */ hosts: [],
    /** @type {number} */ ends: 0,
    /** @type {string[]} */ went: [],
    /** @type {import('../public/store.js').StoredSettings[]} */ saved: [],
    /** @type {{ allowView: boolean, allowEdit: boolean }[]} */ sharing: [],
  };
  const page = new SettingsPage({
    ...defaultKeymapDeps,
    redraw: () => {
      calls.redraws += 1;
    },
    applyTheme: (theme) => calls.themes.push(theme.name),
    applyFont: (font) => calls.fonts.push(font.name),
    applyModel: (model) => calls.models.push(model),
    applyOversize: (value) => calls.oversizes.push(value),
    windowFit: fit,
    applyFieldBackground: (on) => calls.fieldBackgrounds.push(on),
    applySharing: (allowView, allowEdit) =>
      calls.sharing.push({ allowView, allowEdit }),
    connect: (host) => calls.hosts.push(host),
    end: () => {
      calls.ends += 1;
    },
    go: (id) => calls.went.push(id),
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

/**
 * Put the cursor on a field, the way Tab and the arrows do. The panel opens on
 * its command line, as an ISPF panel does.
 *
 * @param {SettingsPage} page
 * @param {string} key
 * @returns {void}
 */
function focus(page, key) {
  const index = page.rows().findIndex((row) => row.key === key);
  assert.notEqual(index, -1, `the panel has no ${key} field`);
  page.onCommand = false;
  page.selected = index;
}

test("opening draws the panel, and F3 closes it and asks for the screen back", () => {
  const { page, calls } = fixture();

  page.show();
  assert.equal(page.open, true);
  assert.ok(calls.redraws > 0, "the panel must have asked to be drawn");

  assert.equal(page.handleKey(key({ key: "F3" })), true);
  assert.equal(page.open, false);
  assert.equal(calls.ends, 1);
});

test("the command line takes the ISPF verbs: a jump, the menu and help", () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  for (const char of "=1") page.handleKey(key({ key: char }));
  page.handleKey(enterKey());
  assert.deepEqual(calls.went, ["macros"]);

  page.handleKey(key({ key: "F4" }));
  assert.deepEqual(calls.went, ["macros", "menu"]);

  page.handleKey(key({ key: "F1" }));
  assert.deepEqual(calls.went, ["macros", "menu", "help"]);
});

test("a command the panel does not know is answered on the panel, not swallowed", () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  for (const char of "zork") page.handleKey(key({ key: char }));
  page.handleKey(enterKey());

  assert.match(page.message, /zork/);
  assert.equal(page.open, true);
  assert.deepEqual(calls.went, []);
});

test("APPLY on the command line does what Enter on the panel does", () => {
  const { page, calls } = fixture();
  page.setModel(2);
  page.connected = true;
  page.show();

  focus(page, "model");
  page.handleKey(key({ key: "ArrowRight" }));
  page.onCommand = true;
  for (const char of "apply") page.handleKey(key({ key: char }));
  page.handleKey(enterKey());

  assert.deepEqual(calls.models, [3]);
  assert.equal(page.open, false);
});

test("a closed page consumes nothing", () => {
  const { page } = fixture();
  assert.equal(page.handleKey(key({ key: "a", code: "KeyA" })), false);
});

test("an open page swallows keys so the host is not typed at through it", () => {
  const { page } = fixture();
  page.show();
  assert.equal(page.handleKey(key({ key: "a", code: "KeyA" })), true);
  // ...except the browser's own shortcuts.
  assert.equal(
    page.handleKey(key({ key: "r", code: "KeyR", ctrlKey: true })),
    false,
  );
});

test("theme and font apply as you scroll through them and are saved by name", () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  page.handleKey(key({ key: "Tab" }));
  page.handleKey(key({ key: "ArrowRight" }));
  assert.deepEqual(calls.themes, [THEMES[1]?.name]);

  page.handleKey(key({ key: "ArrowDown" }));
  page.handleKey(key({ key: "ArrowRight" }));
  assert.deepEqual(calls.fonts, [FONTS[1]?.name]);

  assert.deepEqual(calls.saved.at(-1), {
    theme: THEMES[1]?.name,
    font: FONTS[1]?.name,
    model: null,
    screenSize: null,
    fitFontSize: 16,
    fieldBackground: true,
  });
  assert.deepEqual(calls.models, [], "the screen size must not have moved");
});

test("a saved theme and font are taken up by name, and an unknown one is ignored", () => {
  const { page } = fixture();
  // Neither is the default, so the assertions fail if nothing was restored.
  page.restoreSaved({ theme: "Amber", font: "IBM 3270" });
  assert.equal(page.theme().name, "Amber");
  assert.equal(page.font().name, "IBM 3270");

  page.restoreSaved({ theme: "a theme from a later version" });
  assert.equal(
    page.theme().name,
    "Amber",
    "a name we no longer know must not reset the choice",
  );
});

test("the controller can toggle sharing and shared editing, and turning sharing off takes editing with it", () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  assert.deepEqual(
    page
      .rows()
      .map((row) => row.key)
      .slice(-2),
    ["allowSharing", "allowSharedEditing"],
    "a controller is offered both, sharing on by default and editing off",
  );

  focus(page, "allowSharedEditing");
  page.handleKey(key({ key: "ArrowRight" }));
  assert.equal(page.allowSharedEditing, true);
  assert.deepEqual(calls.sharing.at(-1), { allowView: true, allowEdit: true });

  focus(page, "allowSharing");
  page.handleKey(key({ key: "ArrowLeft" }));
  assert.equal(page.allowSharing, false);
  assert.equal(
    page.allowSharedEditing,
    false,
    "nothing left to share with, nothing left to type into it",
  );
  assert.deepEqual(calls.sharing.at(-1), {
    allowView: false,
    allowEdit: false,
  });
  assert.deepEqual(
    fieldKeys(page),
    ["theme", "font", "model", "fit", "fieldBackground", "allowSharing"],
    "shared editing is only offered while sharing is on",
  );
});

test("the field background can be turned off, and comes back off next time", () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.setRole("observer");
  page.show();

  focus(page, "fieldBackground");
  page.handleKey(key({ key: "ArrowLeft" }));
  assert.equal(page.fieldBackground, false);
  assert.deepEqual(calls.fieldBackgrounds, [false]);
  assert.equal(calls.saved.at(-1)?.fieldBackground, false);

  page.handleKey(key({ key: "ArrowRight" }));
  assert.deepEqual(calls.fieldBackgrounds, [false, true]);

  const { page: next } = fixture();
  next.restoreSaved({ fieldBackground: false });
  assert.equal(next.fieldBackground, false);
});

test("an observer is not offered the sharing rows at all — it is not their session to share", () => {
  const { page } = fixture();
  page.connected = true;
  page.setRole("observer");
  page.show();

  assert.deepEqual(fieldKeys(page), [
    "theme",
    "font",
    "model",
    "fit",
    "fieldBackground",
  ]);
});

test("a screen size change waits for Enter and warns what it costs", () => {
  const { page, calls } = fixture();
  page.setModel(4);
  page.connected = true;
  page.show();

  focus(page, "model");
  page.handleKey(key({ key: "ArrowRight" }));

  assert.equal(page.pendingModel, 5);
  assert.deepEqual(calls.models, [], "nothing may happen before Enter");
  const text = drawn(page).text(0, 0, 24, 79);
  assert.match(text, /Model 5 - 27x132/);
  assert.match(text, /The host connection is dropped and reopened/);

  page.handleKey(enterKey());
  assert.deepEqual(calls.models, [5]);
  assert.equal(page.open, false);
  assert.equal(calls.ends, 1);
});

test("the dynamic screen is one more choice after the models, asked for as an oversize", () => {
  const { page, calls } = fixture();
  page.setModel(5);
  page.connected = true;
  page.show();

  focus(page, "model");
  page.handleKey(key({ key: "ArrowRight" }));

  assert.equal(page.rows()[page.selected]?.value, "Dynamic - 62x160");
  assert.equal(page.pendingOversize, "160x62");
  assert.deepEqual(
    fieldKeys(page),
    [
      "theme",
      "font",
      "model",
      "fieldBackground",
      "allowSharing",
      "allowSharedEditing",
    ],
    "a size asked for by name has nothing to fit to the window",
  );

  page.handleKey(enterKey());
  assert.deepEqual(calls.oversizes, ["160x62"]);
  assert.deepEqual(calls.models, [], "the model underneath it did not move");
});

test("leaving the dynamic screen goes back to a model on its own", () => {
  const { page } = fixture();
  page.setOversize("160x62");
  page.connected = true;
  page.show();

  assert.equal(
    page.fitsWindow(),
    false,
    "no window was measured for it, so nothing refits to one",
  );

  focus(page, "model");
  page.handleKey(key({ key: "ArrowLeft" }));
  assert.equal(page.rows()[page.selected]?.value, "Model 5 - 27x132");
  assert.equal(page.pendingOversize, "");

  page.setOversize("158x60");
  assert.equal(
    page.fitsWindow(),
    true,
    "a measured screen is the one that follows the window",
  );
});

test("fit to window asks for the screen the browser measured, on Enter", () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  focus(page, "fit");
  page.handleKey(key({ key: "ArrowRight" }));

  assert.equal(page.pendingOversize, "158x60");
  assert.deepEqual(calls.oversizes, [], "nothing may happen before Enter");
  const text = drawn(page).text(0, 0, 24, 79);
  assert.match(text, /158x60/);
  assert.match(text, /The host connection is dropped and reopened/);

  page.handleKey(enterKey());
  assert.deepEqual(calls.oversizes, ["158x60"]);
  assert.deepEqual(calls.models, [], "the model itself did not move");
});

test("fitting again turns it off, and the model is the floor", () => {
  // b3270 refuses an oversize below its model, so a narrow window asks for the
  // model's own columns, in text small enough to hold more rows than it measured.
  const { page } = fixture(() => ({ cols: 40, rows: 12 }));
  page.setModel(5);
  page.connected = true;
  page.show();

  focus(page, "fit");
  page.handleKey(key({ key: "ArrowRight" }));
  assert.equal(page.pendingOversize, "132x42");

  page.handleKey(key({ key: "ArrowLeft" }));
  assert.equal(page.pendingOversize, "", "off is the model on its own");
});

test("the text size appears with the fit and drives what it measures", () => {
  const { page, calls } = fixture(windowOf(1600, 800));
  page.connected = true;
  page.show();

  focus(page, "fit");
  assert.equal(
    fieldKeys(page).length,
    7,
    "the text size is not offered while the fit is off",
  );

  page.handleKey(key({ key: "ArrowRight" }));
  assert.equal(page.pendingOversize, "166x40");
  assert.equal(fieldKeys(page).length, 8);
  assert.equal(page.rows()[page.selected + 1]?.key, "fitSize");
  assert.equal(page.rows()[page.selected + 1]?.value, "16 px");

  page.handleKey(key({ key: "ArrowDown" }));
  page.handleKey(key({ key: "ArrowRight" }));
  assert.equal(page.fitFontSize, 17);
  assert.equal(page.pendingOversize, "156x38", "bigger text, fewer cells");
  assert.equal(
    calls.saved.at(-1)?.fitFontSize,
    17,
    "the text size is remembered",
  );

  page.handleKey(enterKey());
  assert.deepEqual(calls.oversizes, ["156x38"]);
});

test("the text size stops at both ends instead of wrapping round", () => {
  const { page } = fixture(windowOf(1600, 800));
  page.connected = true;
  page.show();

  focus(page, "fit");
  page.handleKey(key({ key: "ArrowRight" }));
  focus(page, "fitSize");

  for (let step = 0; step < 30; step++)
    page.handleKey(key({ key: "ArrowLeft" }));
  assert.equal(page.fitFontSize, 8);
  for (let step = 0; step < 60; step++)
    page.handleKey(key({ key: "ArrowRight" }));
  assert.equal(page.fitFontSize, 32);
});

test("a screen bigger than b3270 can hold is trimmed to fit its buffer", () => {
  // 16383 cells is b3270's whole buffer; more is refused outright.
  const { page } = fixture(() => ({ cols: 400, rows: 120 }));
  page.connected = true;
  page.show();

  focus(page, "fit");
  page.handleKey(key({ key: "ArrowRight" }));

  const [cols, rows] = page.pendingOversize.split("x").map(Number);
  assert.equal(rows, 120);
  assert.ok(
    (cols ?? 0) * (rows ?? 0) <= 16383,
    `${page.pendingOversize} does not fit the buffer`,
  );
});

test("a pane too narrow for the model still asks for the model", () => {
  // b3270 silently hands back the model's own size for anything below it.
  const { page } = fixture();

  // 80 columns in a width that measured 38 halves the text, so the pane holds twice the rows.
  assert.equal(page.fitSize({ cols: 38, rows: 42 }, 2), "80x90");
  assert.equal(page.fitSize({ cols: 100, rows: 20 }, 5), "132x27");

  assert.equal(page.fitSize({ cols: 38, rows: 5 }, 2), "80x24");

  const [cols, rows] = page
    .fitSize({ cols: 4, rows: 40 }, 2)
    .split("x")
    .map(Number);
  assert.equal(cols, 80);
  assert.ok(
    (cols ?? 0) * (rows ?? 0) <= 16383,
    `80x${rows} does not fit the buffer`,
  );
});

test("applying a screen size saves it as a choice, so another tab can ask for it again", () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  focus(page, "model");
  page.handleKey(key({ key: "ArrowRight" }));
  focus(page, "fit");
  page.handleKey(key({ key: "ArrowRight" }));
  page.handleKey(enterKey());

  assert.deepEqual(calls.models, [3]);
  assert.deepEqual(calls.oversizes, ["158x60"]);
  assert.equal(calls.saved.at(-1)?.model, 3);
  assert.equal(
    calls.saved.at(-1)?.screenSize,
    "fit",
    "the measured cells are this window, the choice is not",
  );

  const fresh = fixture().page;
  fresh.restoreSaved(calls.saved.at(-1) ?? {});
  assert.equal(fresh.savedModel, 3);
  assert.equal(fresh.savedSize, "fit");
});

test("the dynamic screen and a plain model are saved as themselves", () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  focus(page, "model");
  page.handleKey(key({ key: "ArrowLeft" }));
  assert.equal(
    page.pendingOversize,
    "160x62",
    "one step back from model 2 is the dynamic screen",
  );
  page.handleKey(enterKey());
  assert.equal(calls.saved.at(-1)?.screenSize, "dynamic");

  page.setOversize("160x62");
  page.show();
  focus(page, "model");
  page.handleKey(key({ key: "ArrowRight" }));
  page.handleKey(enterKey());
  assert.equal(calls.saved.at(-1)?.screenSize, "model");
});

test("a size from a version that never saved one is left to the server", () => {
  const { page } = fixture();
  page.restoreSaved({ theme: "Amber" });
  assert.equal(page.savedModel, null);
  assert.equal(
    page.savedSize,
    null,
    "no choice means the server default stands",
  );

  page.restoreSaved({
    screenSize: /** @type {'fit'} */ ("a size from a later version"),
  });
  assert.equal(page.savedSize, null);
});

test("nothing the page draws runs off the right edge", () => {
  // The grid cuts anything past the last column rather than wrapping it, so an
  // overrun is silent: catch it where it is written instead of where it lands.
  const { page } = fixture();
  page.setModel(2);
  page.connected = true;
  page.show();
  focus(page, "model");
  page.pendingModel = 5;
  page.pendingOversize = "166x40";

  for (const { col, text } of recordedPuts(page))
    assert.ok(
      col + text.length <= 80,
      `"${text}" starts at column ${col} and does not fit in 80`,
    );
});

test("cancel leaves the screen size exactly as it was", () => {
  const { page, calls } = fixture();
  page.setModel(2);
  page.connected = true;
  page.show();

  focus(page, "model");
  page.handleKey(key({ key: "ArrowRight" }));
  page.handleKey(key({ key: "F12" }));

  assert.deepEqual(calls.models, []);
  assert.equal(page.open, false);
  page.show();
  assert.equal(page.pendingModel, 2);
});

test("the server has the last word on the screen size", () => {
  const { page } = fixture();
  page.setModel(3);
  assert.equal(page.model, 3);
  assert.equal(page.pendingModel, 3);
});

test("the host field leads while disconnected, types, backspaces, and enter connects", () => {
  const { page, calls } = fixture();
  page.show();
  assert.equal(page.selected, 0, "disconnected, so the host field leads");

  for (const char of "127.1") page.handleKey(key({ key: char }));
  assert.equal(page.host, "127.1");

  page.handleKey(key({ key: "Backspace" }));
  assert.equal(page.host, "127.");

  page.handleKey(enterKey());
  assert.deepEqual(calls.hosts, ["127."]);
  assert.equal(
    page.open,
    true,
    "the page stays open until the server confirms it connected",
  );
});

test("a locked host is shown but not editable, and enter asks to reopen it", () => {
  const { page, calls } = fixture();
  page.setHostLocked(true);
  page.show();

  page.handleKey(key({ key: "x" }));
  assert.equal(
    page.host,
    "",
    "typing must not reach a host the server controls",
  );

  page.handleKey(enterKey());
  assert.deepEqual(calls.hosts, [null]);
});

test("arrow keys step past the host field onto the usual fields, and back", () => {
  const { page, calls } = fixture();
  page.show();
  assert.equal(page.selected, 0);

  page.handleKey(key({ key: "ArrowDown" }));
  assert.equal(page.selected, 1);
  page.handleKey(key({ key: "ArrowRight" }));
  assert.deepEqual(calls.themes, [THEMES[1]?.name]);

  page.handleKey(key({ key: "ArrowUp" }));
  assert.equal(page.selected, 0, "back on the host field");
});

test("the host field is gone once connected, and the usual fields start at the top", () => {
  const { page, calls } = fixture();
  page.connected = true;
  page.show();

  assert.equal(page.selected, 0);
  page.handleKey(key({ key: "Tab" }));
  page.handleKey(key({ key: "ArrowRight" }));
  assert.deepEqual(
    calls.themes,
    [THEMES[1]?.name],
    "field 0 is the theme, not the host, while connected",
  );
});

test("every theme's field colour stands out against both backgrounds it is drawn on", () => {
  for (const theme of THEMES) {
    const { field, background, black } = theme.colors;
    assert.ok(field !== undefined, `${theme.name} has no field colour`);
    // The page draws field blocks on `background`, the server over `black`.
    assert.notEqual(
      field,
      background,
      `${theme.name}'s field colour is its background`,
    );
    assert.notEqual(
      field,
      black,
      `${theme.name}'s field colour is its ANSI black`,
    );
  }
});

test("every theme's status row is legible, and Host On-Demand's is white", () => {
  for (const theme of THEMES) {
    const { statusForeground, statusBackground } = theme.colors;
    assert.notEqual(
      statusForeground,
      statusBackground,
      `${theme.name}'s status row is its own background`,
    );
  }

  assert.equal(THEMES[0]?.name, "Host On-Demand", "the default theme");
  assert.equal(THEMES[0]?.colors.statusForeground, "#ffffff");
  assert.equal(THEMES[0]?.colors.statusBackground, "#000000");
});
