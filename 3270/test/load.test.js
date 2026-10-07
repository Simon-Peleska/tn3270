import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./load.js";

// The long runs and the numbers live in scripts/load.mjs; this keeps 1000 busy users honest on every run.
test(
  "1000 sessions connect and work at once without a single wrong answer",
  { timeout: 20_000 },
  async () => {
    const stats = await load({ sessions: 1000, seconds: 2 });
    assert.deepEqual(stats.errors.slice(0, 5), []);
    assert.equal(stats.open.count, 1000);
    assert.ok(stats.operations >= 1000, `only ${stats.operations} operations`);
  },
);
