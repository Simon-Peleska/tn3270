import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CASES, check, rawCase } from "./fuzz.js";
import { rng } from "./rng.js";
import { assertSameLines, noB3270 } from "./harness.js";

// Fuzz cases that once found a difference from b3270, replayed on every run.
// scripts/fuzz.mjs explores new seeds; add each one it catches here once fixed.
// npm run fuzz saves the crashes it catches in fuzz-findings/, all of which are replayed.

const FINDINGS = new URL("fuzz-findings/", import.meta.url);
const findings = existsSync(FINDINGS) ? readdirSync(FINDINGS) : [];

/** @type {Record<"keyboard" | "datastream", number[]>} */
const SEEDS = {
  keyboard: [5, 10, 34, 42, 50, 135, 9000087],
  datastream: [1, 700108, 409255822, 151094620],
};

describe(
  "fuzz seeds play out like b3270",
  { skip: noB3270, concurrency: 8 },
  () => {
    for (const [kind, seeds] of Object.entries(SEEDS))
      for (const seed of seeds)
        test(`${kind} ${seed}`, { timeout: 20_000 }, async () => {
          assert.equal(
            await check(
              `${kind} seed ${seed}`,
              CASES[/** @type {keyof typeof CASES} */ (kind)](rng(seed)),
            ),
            "",
          );
        });
    for (const file of findings)
      test(`Jazzer finding ${file}`, { timeout: 20_000 }, async () => {
        const data = readFileSync(new URL(file, FINDINGS));
        assert.equal(await check(`raw ${file}`, rawCase(data)), "");
      });
  },
);

test("b3270 flushing its cursor late on a busy machine is no difference", () => {
  const state = (/** @type {string} */ name) =>
    `{"connection":{"state":"${name}","host":"127.0.0.1","cause":"ui"}}`;
  const off = '{"screen":{"cursor":{"enabled":false}}}';
  const on = '{"screen":{"cursor":{"enabled":true,"row":1,"column":1}}}';
  const ours = [
    off,
    state("resolving"),
    state("tcp-pending"),
    state("telnet-pending"),
    on,
    state("connected-unbound"),
  ];
  const busy = [
    state("resolving"),
    state("tcp-pending"),
    state("telnet-pending"),
    off,
    on,
    state("connected-unbound"),
  ];
  assertSameLines(ours, busy);
});
