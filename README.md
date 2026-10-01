# tn3270

An IBM 3270 terminal in a browser tab. A Node server runs every session on
node3270 (`3270/`), a port of x3270's `b3270` that runs in-process on a pool of
worker threads; the page draws the screen onto a canvas of its own, with no
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
npm install
npm start            # http://127.0.0.1:8017
```

No mainframe? `npm run start:fake` starts a replayed host alongside the server
and points a session at it, which is also what the tests use.

```bash
npm test             # node --test, no browser driver and no host needed
npm run test:browser # optional Chromium smoke test of the real page
npm run typecheck    # tsc over the JSDoc types; this is the "no any" gate
npm run fuzz -- -max_total_time=600 -jobs=8 -workers=8  # node3270 against b3270
```

The optional browser smoke test needs `chromium` on `PATH` (or `CHROMIUM` set
to its executable).

`npm run fuzz` is Jazzer.js's coverage-guided fuzzing of node3270 against a
real `b3270` (needs it on `PATH`). Anything after `--` goes to libFuzzer. It
keeps its corpus in `3270/test/fuzz-corpus/` and saves each mismatch, crash or
hang in `3270/test/fuzz-findings/`. `npm test` replays every file there, so
commit a finding once it's fixed.

## What it does

- **Up to four sessions in one page**, tiled edge to edge. `Ctrl-B` and a digit
  aims the keyboard at one; `Ctrl-B` and a shifted digit lays the panes out.
- **Shared by URL.** The first viewer types, the rest watch, and the screen is
  identical for everyone. A reload or a dropped network keeps the host session:
  the server holds it, and the page reconnects to it.
- **A real keyboard**, following PCOMM's 3270 layout — PF1–PF24, PA1–PA3, Attn,
  SysReq, Clear, EraseEOF, FieldMark — and every binding is changeable.
- **Panels that behave like a host application** for everything the browser
  itself offers: settings (with macros and the recorder under them) and the
  key bindings, each drawn into the terminal with a title, a command line and
  PF keys. `Alt+Space` opens the menu; `0` and `1` go from there, and `=0` and
  `=1` jump from anywhere. `[Rec]` on the status row records the session as a
  script.
  Opening a panel is a keymap command, so that key is yours to change too.
- **Fit to window**: ask the host for a screen the size of the pane rather than
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
