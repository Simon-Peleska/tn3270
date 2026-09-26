import test from "node:test";
import assert from "node:assert/strict";
import { Settings, THEMES, DYNAMIC_OVERSIZE } from "../public/settings.js";

function fixture() {
  /** @type {Partial<import('../public/store.js').StoredSettings>[]} */
  const saved = [];
  const settings = new Settings((values) => saved.push(values));
  settings.models = [
    { model: 2, rows: 24, columns: 80 },
    { model: 3, rows: 32, columns: 80 },
    { model: 4, rows: 43, columns: 80 },
    { model: 5, rows: 27, columns: 132 },
  ];
  return { settings, saved };
}

test("only what differs from the defaults is saved, so a new default reaches the rest", () => {
  const { settings, saved } = fixture();
  settings.values.theme = "Amber";
  settings.save();
  assert.deepEqual(saved.at(-1), { theme: "Amber" });
  settings.reset(["theme"]);
  assert.deepEqual(saved.at(-1), {});
});

test("a saved theme and font are taken up by name, and an unknown one is ignored", () => {
  const { settings } = fixture();
  // Neither is the default, so the assertions fail if nothing was restored.
  settings.restoreSaved({ theme: "Amber", font: "IBM 3270" });
  assert.equal(settings.theme().name, "Amber");
  assert.equal(settings.font().name, "IBM 3270");

  settings.restoreSaved({ theme: "a theme from a later version" });
  assert.equal(
    settings.theme().name,
    "Amber",
    "a name we no longer know must not reset the choice",
  );
});

test("the optional maximum font size flag is saved and reset", () => {
  const { settings, saved } = fixture();
  settings.restoreSaved({ forceMaxFontSize: true });
  assert.equal(settings.values.forceMaxFontSize, true);
  settings.save();
  assert.deepEqual(saved.at(-1), { forceMaxFontSize: true });
  settings.reset(["forceMaxFontSize"]);
  assert.equal(settings.values.forceMaxFontSize, false);
  assert.deepEqual(saved.at(-1), {});
});

test("a size from a version that never saved one is left alone, and a text size is clamped", () => {
  const { settings } = fixture();
  settings.restoreSaved({
    screenSize: /** @type {'fit'} */ ("a size from a later version"),
    fitFontSize: 99,
  });
  assert.equal(settings.values.screenSize, null);
  assert.equal(settings.values.fitFontSize, 32);
});

test("a screen bigger than b3270 can hold is trimmed to fit its buffer", () => {
  // 16383 cells is b3270's whole buffer; more is refused outright.
  const { settings } = fixture();
  const [cols, rows] = settings
    .fitSize({ cols: 400, rows: 120 }, 2)
    .split("x")
    .map(Number);
  assert.equal(rows, 120);
  assert.ok((cols ?? 0) * (rows ?? 0) <= 16383, `${cols}x${rows}`);
});

test("a pane too narrow for the model still asks for the model", () => {
  // b3270 silently hands back the model's own size for anything below it.
  const { settings } = fixture();

  // 80 columns in a width that measured 38 halves the text, so the pane holds twice the rows.
  assert.equal(settings.fitSize({ cols: 38, rows: 42 }, 2), "80x90");
  assert.equal(settings.fitSize({ cols: 100, rows: 20 }, 5), "132x27");
  assert.equal(settings.fitSize({ cols: 38, rows: 5 }, 2), "80x24");

  const [cols, rows] = settings
    .fitSize({ cols: 4, rows: 40 }, 2)
    .split("x")
    .map(Number);
  assert.equal(cols, 80);
  assert.ok((cols ?? 0) * (rows ?? 0) <= 16383, `80x${rows}`);
});

test("the screen size in force is named rows first, the way a model is", () => {
  const { settings } = fixture();
  assert.equal(settings.describeSize(), "Model 2 - 24x80");
  settings.oversize = DYNAMIC_OVERSIZE;
  assert.equal(settings.describeSize(), "Dynamic - 62x160");
  settings.oversize = "166x51";
  assert.equal(settings.describeSize(), "Fit to window - 51x166");
  assert.equal(settings.fitsWindow(), true);
});

test("every theme's field colour stands out against both backgrounds it is drawn on", () => {
  for (const theme of THEMES) {
    const { field, background, black } = theme.colors;
    assert.ok(field !== undefined, `${theme.name} has no field colour`);
    // The page draws field blocks on `background`, the server over `black`.
    assert.notEqual(field, background, `${theme.name}: field on background`);
    assert.notEqual(field, black, `${theme.name}: field on ANSI black`);
  }
});

test("every theme's status row is legible, and Host On-Demand's is white", () => {
  for (const theme of THEMES) {
    const { statusForeground, statusBackground } = theme.colors;
    assert.notEqual(statusForeground, statusBackground, theme.name);
  }
  assert.equal(THEMES[0]?.name, "Host On-Demand", "the default theme");
  assert.equal(THEMES[0]?.colors.statusForeground, "#ffffff");
  assert.equal(THEMES[0]?.colors.statusBackground, "#000000");
});
