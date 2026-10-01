import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { check, fuzz, rng } from "./fuzz.js";
import { noB3270 } from "./harness.js";

// Fuzz cases that once found a difference from b3270, replayed on every run.
// scripts/fuzz.mjs explores new seeds; add each one it catches here once fixed.
// npm run fuzz saves what it catches in fuzz-findings/, all of which are replayed.

const FINDINGS = new URL("fuzz-findings/", import.meta.url);
const findings = existsSync(FINDINGS) ? readdirSync(FINDINGS) : [];

/** @type {Record<"keyboard" | "datastream" | "nvt", number[]>} */
const SEEDS = {
  keyboard: [5, 10, 34, 42, 50, 135, 9000087],
  datastream: [1, 700108, 409255822, 151094620],
  nvt: [3, 17, 33, 120],
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
              /** @type {"keyboard" | "datastream" | "nvt"} */ (kind),
              rng(seed),
              `seed ${seed}`,
            ),
            "",
          );
        });
    for (const file of findings)
      test(`Jazzer finding ${file}`, { timeout: 20_000 }, async () => {
        assert.equal(
          await fuzz(readFileSync(new URL(file, FINDINGS)), file),
          "",
        );
      });
  },
);
