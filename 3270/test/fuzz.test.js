import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { check } from "./fuzz.js";
import { noB3270 } from "./harness.js";

// Fuzz seeds that once found a difference from b3270, replayed on every run.
// scripts/fuzz.mjs explores new seeds; add each one it catches here once fixed.

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
              seed,
            ),
            "",
          );
        });
  },
);
