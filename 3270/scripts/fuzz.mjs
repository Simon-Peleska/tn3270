// Differential fuzzing against b3270: random seeds until the time is up, several at once.
//   node scripts/fuzz.mjs [--kind keyboard|datastream|nvt|all] [--seconds 25] [--from SEED] [--jobs 8]
// Without --from, the seeds start at a random point; each failure prints its seed and steps,
// and test/fuzz.js's check(kind, rng(seed), ...) replays it. npm run fuzz is the coverage-guided
// alternative.

import { parseArgs } from "node:util";
import { CASES, check, rng } from "../test/fuzz.js";

const { values } = parseArgs({
  options: {
    kind: { type: "string", default: "all" },
    seconds: { type: "string", default: "25" },
    from: { type: "string" },
    jobs: { type: "string", default: "8" },
  },
});
const kinds = /** @type {(keyof typeof CASES)[]} */ (
  values.kind === "all" ? Object.keys(CASES) : [values.kind]
);
const deadline = Date.now() + Number(values.seconds) * 1000;
let seed = values.from ? Number(values.from) : Math.floor(Math.random() * 1e9);
const first = seed;
// A node3270 bug that blocks the event loop also blocks the hang guard and the summary; this
// line is then all there is to rerun the round with --from.
console.log(`seeds from ${first}`);
let runs = 0;
/** @type {string[]} */
const failures = [];
/** Cases b3270 itself hung or crashed on. @type {string[]} */
const skips = [];

async function worker() {
  while (Date.now() < deadline) {
    const mySeed = seed++;
    const kind = kinds[mySeed % kinds.length];
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const hang = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`fuzz ${kind} seed ${mySeed}: HANG, no end after 10 s`),
          ),
        10_000,
      );
    });
    try {
      const skipped = await Promise.race([
        check(kind, rng(mySeed), `seed ${mySeed}`),
        hang,
      ]);
      if (skipped) {
        skips.push(`${kind} ${mySeed}`);
        console.log(`SKIP ${skipped}\n`);
      }
    } catch (e) {
      failures.push(`${kind} ${mySeed}`);
      console.log(`FAIL ${/** @type {Error} */ (e).message}\n`);
    } finally {
      clearTimeout(timer);
    }
    runs++;
  }
}

await Promise.all(Array.from({ length: Number(values.jobs) }, worker));
console.log(
  `${runs} cases, seeds ${first}..${seed - 1}, ${failures.length} failed${failures.length ? `: ${failures.join(", ")}` : ""}, ${skips.length} skipped (b3270 failed)${skips.length ? `: ${skips.join(", ")}` : ""}`,
);
process.exit(failures.length ? 1 : 0);
