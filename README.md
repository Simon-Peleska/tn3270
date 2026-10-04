# tn3270

An IBM 3270 terminal in a browser tab. A Node server drives one real `b3270`
process per session; the page draws the screen onto a canvas of its own, with no
bundler and one runtime dependency. Share the URL and the other person sees the
same screen live.

```
browser ──WS── node ──NDJSON── b3270 ──TN3270── mainframe
```

## Running it

You need `b3270` (from the x3270 suite) on `PATH` and Node 22. With Nix, the
flake brings both:

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
npm run typecheck    # tsc over the JSDoc types; this is the "no any" gate
```

The optional browser smoke test needs `chromium` on `PATH` (or `CHROMIUM` set
to its executable).

`npm test` also fuzzes macros: `test/macroreplay.test.js` types random input
against a fake host, then plays the session recording and the page's macro on
fresh sessions and checks they end on the same screen and cursor. A failure
prints its seed and the shrunk input; `MACRO_FUZZ_RUNS=2000 MACRO_FUZZ_SEED=7`
runs more or other seeds.

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
  PF keys. `Alt+M` opens the menu; `0` and `1` go from there, and `=0` and
  `=1` jump from anywhere. `[Rec]` on the status row records the session as a
  script.
  Opening a panel is a keymap command, so that key is yours to change too.
- **Fit to window**: ask the host for a screen the size of the pane rather than
  the model's 24×80, negotiated as IBM-DYNAMIC.
- **Automation over REST**, speaking s3270's own `-httpd` protocol, so an
  existing s3270 client only changes its base URL. Available as soon as the
  session exists; protect this server behind authentication if clients should
  not be able to drive one another's sessions.

## Configuring it

`config.jsonc` — hand-parsed JSONC, comments and all. The host to dial, the
model, any `b3270` resource, session limits, the idle timeout, allowed hosts,
and where the log rolls. `TN3270_CONFIG=other.jsonc npm start` picks a different
one.

## The rest of the documentation

| File               | What is in it                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPECIFICATION.md` | What it does, from the outside: sessions, roles, the screen, the keyboard, the panels, the wire protocol, the config table, every error code |
| `ARCHITECTURE.md`  | Why it is built this way: who owns the screen, what the paint protocol carries, why all the UI lives inside the screen                       |
| `GOTCHAS.md`       | Things that cost time once and should not cost it twice                                                                                      |
| `TASKS.md`         | What is done and what is not                                                                                                                 |
