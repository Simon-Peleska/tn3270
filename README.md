# tn3270

An IBM 3270 terminal in a browser tab. A Node server runs every session on
node3270 (`3270/`), a port of x3270's `b3270` that runs in-process; the page draws the screen onto a canvas of its own, with no
bundler and one runtime dependency. Share the URL and the other person sees the
same screen live.

```
browser ──WS── node (node3270) ──TN3270── mainframe
```

## Running it

You need Node 22. `b3270` and `s3270` (from the x3270 suite) on `PATH` are
optional: node3270's tests compare against them and skip without them. With
Nix, the flake brings all three:

```bash
nix develop          # or: direnv allow
npm start            # http://127.0.0.1:8017
```

There is no install step: the one runtime dependency, `ws`, is vendored in
`vendor/ws`. `npm install` only fetches the dev tooling (eslint, prettier,
tsc types) and re-copies `ws` from `node_modules` into `vendor/ws`. To update
`ws`, run `npm update ws && npm run vendor` and commit `vendor/ws`. If the
vendored copy and `package-lock.json` disagree, `npm test` fails and the server
logs E1008 at startup.

No mainframe? `npm run start:fake` starts a replayed host alongside the server
and points a session at it, which is also what the tests use. `npm run start:recording -- recording.json`
does the same with a session saved from the Recorder panel.

```bash
npm test             # node --test, no browser driver and no host needed
npm run test:browser # optional Chromium smoke test of the real page
npm run test:firefox # optional Firefox smoke test of the real page
npm run typecheck    # tsc over the JSDoc types; this is the "no any" gate
npm run fuzz -- -max_total_time=600 -fork=8 -ignore_crashes=1  # grow the corpus
node 3270/scripts/fuzz.mjs --corpus 3270/test/fuzz-corpus     # replay it against b3270
```

The optional browser smoke test needs `chromium` on `PATH` (or `CHROMIUM` set
to its executable). The Firefox one needs `firefox` and `geckodriver` on `PATH`
(or `FIREFOX` and `GECKODRIVER` set), e.g. from
`nix shell nixpkgs#firefox nixpkgs#geckodriver`.

Fuzzing has two stages. `npm run fuzz` is Jazzer.js's coverage-guided fuzzing
of host data streams through node3270 alone, in process, at a few thousand
inputs a second; it keeps the inputs that reach new code in
`3270/test/fuzz-corpus/` and saves crashes and hangs in
`3270/test/fuzz-findings/`. Anything after `--` goes to libFuzzer; `-fork` with
`-ignore_crashes=1` keeps fuzzing after a finding, which `-jobs` does not.
`scripts/fuzz.mjs --corpus` then plays every kept input through node3270 and a
real `b3270` (needs it on `PATH`) and reports where they differ. `npm test`
replays every file in `3270/test/fuzz-findings/`, so commit a finding once it's
fixed.

`npm test` also fuzzes macros: `test/macroreplay.test.js` types random input
against a fake host, then plays the session recording and the page's macro on
fresh sessions and checks they end on the same screen and cursor. A failure
prints its seed and the shrunk input; `MACRO_FUZZ_RUNS=2000 MACRO_FUZZ_SEED=7`
runs more or other seeds.

## What it does

- **Field hints.** `Ctrl-B` puts a letter on every typeable field; typing that
  letter moves the cursor there.
- **Shared by URL.** The first viewer types, the rest watch, and the screen is
  identical for everyone. A reload or a dropped network keeps the host session:
  the server holds it, and the page reconnects to it.
- **A real keyboard**, following PCOMM's 3270 layout — PF1–PF24, PA1–PA3, Attn,
  SysReq, Clear, EraseEOF, FieldMark — and every binding is changeable.
- **Panels that behave like a host application** for everything the browser
  itself offers: settings (with macros and the recorder under them) and the
  key bindings, each drawn into the terminal with a title, a command line and
  PF keys. `Alt+M` opens the menu; `0` and `1` go from there, and `=0` and
  `=1` jump from anywhere. `[Rec]` on the status row records the session as a
  script.
  Opening a panel is a keymap command, so that key is yours to change too.
- **Fit to window**: ask the host for a screen the size of the window rather than
  the model's 24×80, negotiated as IBM-DYNAMIC.

## Configuring it

`config.jsonc` — hand-parsed JSONC, comments and all. The host to dial, the
model, x3270 resources by name, session limits, the idle timeout, allowed hosts,
and where the log rolls. `TN3270_CONFIG=other.jsonc npm start` picks a different
one.

## The rest of the documentation

| File               | What is in it                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPECIFICATION.md` | What it does, from the outside: sessions, roles, the screen, the keyboard, the panels, the wire protocol, the config table, every error code |
| `ARCHITECTURE.md`  | Why it is built this way: who owns the screen, what the paint protocol carries, why all the UI lives inside the screen                       |
| `GOTCHAS.md`       | Things that cost time once and should not cost it twice                                                                                      |
| `TASKS.md`         | What is done and what is not                                                                                                                 |
