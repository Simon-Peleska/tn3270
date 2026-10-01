# Bugs found in b3270, and what node3270 does differently

Found by differential fuzzing node3270 against `b3270 -json` (`scripts/fuzz.mjs`), replaying
the same keystrokes and host data through both and comparing their JSON output line for line.

## 1. Typing over an SO right before a field attribute hangs the next field walk forever

**Where:** x3270's `kybd.c`, `key_Character()`'s SO-overwrite case — ported as-is into node3270's
`keyCharacter()` (`3270/src/kybd.js`) before the fix below.

**The bug:** a formatted 3270 screen always has at least one field attribute; every action that
walks "to the next field" (PF/PA, Enter, EraseEOF, EraseInput, DeleteField, FieldEnd, Erase All
Unprotected...) relies on that and loops `while (!is_field_attribute(addr))`. But typing a
character over an SO (Shift-Out, the DBCS start marker) that sits in the byte right before a
field attribute overwrites that attribute along with the SO — x3270 does this on purpose, to
turn `SO SI` into plain text, but it does not check whether the attribute it's overwriting was
the field's last one. Wipe out every field attribute on the screen this way, and the next field
walk never finds one to stop at. It spins at 100% CPU, forever. b3270 doesn't crash or log
anything; it just stops answering `run-result` for the stuck action.

**Where node3270 differs:** `hasFields()` in `3270/src/ctlr.js` additionally checks that a field
attribute is actually still there. The eight walks that used to trust `s.formatted` now call
`hasFields()` instead (`eraseAllUnprotected`, `readModified`'s formatted branch, `eraseEOF`,
`eraseInput`, `deleteField`, `fieldEnd`; `deleteWord` got a loop bound instead, since it can
legitimately hit a screen that's all blanks with no field attribute left and b3270 handles that
one fine). A screen with no field attributes left behaves like an unformatted one — which is a
guess at what should happen, not something x3270 documents, since the condition is a bug to begin
with. b3270 itself is unpatched and still hangs.

### Reproduce with the test harness (fastest)

```sh
cd 3270
node --test --test-name-pattern="typed away" test/stream.test.js
```

Both tests in that pattern construct the bug from scratch and were used as the regression tests
for the fix — comment out the `hasFields` guards in `src/ctlr.js` and `src/kybd.js` (or revert
to before this fix) and rerun to see them hang. `test/stream.test.js`'s `WIPE_EVERY_FIELD` is the
three actions that do it:

```js
["HexString", "0e99ee74"],  // types SO, then two DBCS bytes, then an SI — overwrites every FA
["SaveInput"],
["RestoreInput"],           // pastes the saved (now FA-less) screen back over itself
```

### Reproduce against the real b3270 binary

```sh
cd 3270
cat > /tmp/hang.mjs <<EOF
import { scenario, startB3270 } from "$PWD/test/harness.js";
await scenario(startB3270(), "three-fields.trc", [
  ["HexString", "0e99ee74"],
  ["SaveInput"],
  ["RestoreInput"],
  ["PF", 12],
]);
console.log("finished (would be unexpected)");
EOF
node /tmp/hang.mjs
# Error: FakeHost: no AID record — the harness's own 5 s wait for a reply gives up and throws;
# b3270 itself never answers. The harness's `finally` kills the child on its way out, so nothing
# is left running here — but b3270 does not exit on its own. Driving it by hand (not through
# this harness) leaves it spinning at 100% CPU until something kills -9 it.
```

### Reproduce by hand in the browser

1. `npm run start:fake` (from the repo root; `config.fake.jsonc` currently defaults to the
   node3270 engine — point `"engine"` at nothing, or delete the line, to test b3270 instead).
2. Open `http://127.0.0.1:8017`, connect to the replayed host.
3. Type a character or two, pick a field with a visible attribute, position the cursor on the
   byte right before that attribute, and type an SO byte there (DBCS input, or `HexString` via
   the Scripts/console panel: `0e99ee74`).
4. `SaveInput` then `RestoreInput` (both are regular actions; send them via the console or map
   them to keys).
5. Press any PF key, PA key, Enter, or Erase EOF/Erase Input. Against b3270 the UI locks up with
   no error — the keyboard stays locked since the `run-result` never comes back. Against
   node3270 the action completes immediately.

## 2. `RestoreInput` can hang b3270 outright — not reproduced in node3270

**Status:** confirmed against the real b3270 binary; node3270 was never affected, so there is
nothing to "fix" here — recorded for anyone who hits it.

Fuzz seed `keyboard 151094781` (`node scripts/fuzz.mjs --kind keyboard --from 151094781 --seconds 1`,
or replay it directly via `CASES.keyboard(151094781)` in `test/fuzz.js`) makes b3270 hang on a
`RestoreInput` call partway through a long action sequence (reverse-input mode is toggled on just
before it). node3270 runs the same sequence to completion without incident. It was not minimized
further since node3270 already agrees with correct behavior there; `scripts/fuzz.mjs`'s SKIP
path exists for exactly this case — a b3270 hang/crash that isn't node3270's bug to fix — and
logs it as `SKIP ... b3270 failed` rather than a diff.

## Why these were findable at all

`scripts/fuzz.mjs` gives each case a 10-second hang guard, so a hang on either side shows up as
a `FAIL ... HANG` (both sides reporting) or, when it's clearly b3270 alone, a `SKIP ... b3270
failed`. Bug 1 above was first seen as a `FAIL` where the fuzz run itself timed out with no
summary line — because the hang blocks the same Node event loop the 10-second guard runs on, in
whichever process reached it first. `scripts/fuzz.mjs` now prints its starting seed immediately
(`seeds from N`), so a round that locks up this way can still be identified and rerun with
`--from N`.
