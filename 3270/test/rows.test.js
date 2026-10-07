import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scenario, startOurs } from "./harness.js";
import { CASES } from "./fuzz.js";
import { blank, createRendered, eaEmpty, render } from "../src/ui.js";
import { rng } from "./rng.js";
import { sameCell } from "./b3270.js";

// Without b3270's screen indications the emulator draws only the rows it finds changed into
// one render, which the web server reads. The fuzz cases check that this render is always the
// whole screen drawn afresh, and that every row it changed in is reported. No b3270 needed.

/** @typedef {import("../src/session.js").State} State */
/** @typedef {import("../src/ui.js").Rendered} Rendered */

/** @param {Rendered} r */
const copy = (r) => ({
  cc: r.cc.slice(),
  fg: r.fg.slice(),
  bg: r.bg.slice(),
  gr: r.gr.slice(),
});

/** Fails on the first screen indication whose render or row list is wrong. */
function rowChecker() {
  /** @type {Rendered | null} */
  let before = null;
  let screens = 0;
  /** @param {State} s @param {string} kind @param {any} body */
  const watch = (s, kind, body) => {
    if (kind !== "screen" || !body.rows) return;
    screens++;
    const drawn = /** @type {import("../src/ui.js").Ui} */ (s.ui).saved;
    const fresh = createRendered(drawn.cc.length);
    if (eaEmpty(s)) blank(s, fresh);
    else render(s, fresh, null);
    for (let i = 0; i < drawn.cc.length; i++) {
      const at = `row ${((i / s.maxCols) | 0) + 1} column ${(i % s.maxCols) + 1}`;
      assert.ok(sameCell(drawn, fresh, i), `${at} isn't drawn afresh`);
    }
    if (before?.cc.length === drawn.cc.length) {
      for (let row = 0; row < s.rows; row++) {
        let same = true;
        for (let i = row * s.maxCols; i < (row + 1) * s.maxCols && same; i++)
          same = sameCell(before, drawn, i);
        if (!same)
          assert.ok(body.rows.includes(row + 1), `row ${row + 1} not reported`);
      }
    }
    before = copy(drawn);
  };
  return { watch, screens: () => screens };
}

describe("the rendered rows stay true to the cells", { concurrency: 8 }, () => {
  for (const kind of /** @type {(keyof typeof CASES)[]} */ (Object.keys(CASES)))
    for (let seed = 1; seed <= 25; seed++)
      test(`${kind} seed ${seed}`, { timeout: 20_000 }, async () => {
        const { trace, actions } = CASES[kind](rng(seed));
        const checker = rowChecker();
        await scenario(startOurs(false, checker.watch), trace, actions);
        assert.ok(checker.screens() > 0, "the screen was never drawn");
      });
});
