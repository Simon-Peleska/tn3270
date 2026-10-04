// Differential fuzzing against b3270: random seeds until the time is up, several at once.
//   node scripts/fuzz.mjs [--kind keyboard|datastream|nvt|all] [--seconds 25] [--from SEED] [--jobs 8]
// Without --from, the seeds start at a random point; each failure prints its seed and steps,
// and test/fuzz.js's check(..., CASES[kind](rng(seed))) replays it.
//   node scripts/fuzz.mjs --corpus test/fuzz-corpus [--jobs 8]
// plays every input npm run fuzz kept against b3270 instead; a failure names its file.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CASES, check, rawCase } from "../test/fuzz.js";
import { rng } from "../test/rng.js";

const { values } = parseArgs({
  options: {
    kind: { type: "string", default: "all" },
    seconds: { type: "string", default: "25" },
    from: { type: "string" },
    jobs: { type: "string", default: "8" },
    corpus: { type: "string" },
  },
});
const kinds = /** @type {(keyof typeof CASES)[]} */ (
  values.kind === "all" ? Object.keys(CASES) : [values.kind]
);
const corpusDir = values.corpus;
const corpus = corpusDir ? readdirSync(corpusDir) : null;
const deadline = Date.now() + Number(values.seconds) * 1000;
let seed = values.from ? Number(values.from) : Math.floor(Math.random() * 1e9);
const first = seed;
// A node3270 bug that blocks the event loop also blocks the hang guard and the summary; this
// line is then all there is to rerun the round with --from.
if (!corpus) console.log(`seeds from ${first}`);
let runs = 0;
/** @type {string[]} */
const failures = [];
/** Cases b3270 itself hung or crashed on. @type {string[]} */
const skips = [];

/**
 * The next case to play: a corpus file until none are left, or else a seed until the time is up.
 * @returns {[string, ReturnType<typeof rawCase>] | null}
 */
function next() {
  if (corpus && corpusDir) {
    const file = corpus.pop();
    if (file === undefined) return null;
    return [`raw ${file}`, rawCase(readFileSync(join(corpusDir, file)))];
  }
  if (Date.now() >= deadline) return null;
  const mySeed = seed++;
  const kind = kinds[mySeed % kinds.length];
  return [`${kind} seed ${mySeed}`, CASES[kind](rng(mySeed))];
}

async function worker() {
  for (let job = next(); job; job = next()) {
    const [label, fuzzCase] = job;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const hang = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`fuzz ${label}: HANG, no end after 10 s`)),
        10_000,
      );
    });
    try {
      const skipped = await Promise.race([check(label, fuzzCase), hang]);
      if (skipped) {
        skips.push(label);
        console.log(`SKIP ${skipped}\n`);
      }
    } catch (e) {
      failures.push(label);
      console.log(`FAIL ${/** @type {Error} */ (e).message}\n`);
    } finally {
      clearTimeout(timer);
    }
    runs++;
  }
}

await Promise.all(Array.from({ length: Number(values.jobs) }, worker));
console.log(
  `${runs} cases${corpus ? "" : `, seeds ${first}..${seed - 1}`}, ${failures.length} failed${failures.length ? `: ${failures.join(", ")}` : ""}, ${skips.length} skipped (b3270 failed)${skips.length ? `: ${skips.join(", ")}` : ""}`,
);
process.exit(failures.length ? 1 : 0);
