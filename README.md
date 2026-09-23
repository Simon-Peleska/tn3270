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
npm install
npm start            # http://127.0.0.1:8017
```

No mainframe? `npm run start:fake` starts a replayed host alongside the server
and points a session at it, which is also what the tests use.

```bash
npm test             # node --test, no browser driver and no host needed
npm run typecheck    # tsc over the JSDoc types; this is the "no any" gate
```

## What it does

- **Up to four sessions in one page**, tiled edge to edge. `Ctrl-B` and a digit
  aims the keyboard at one; `Ctrl-B` and a shifted digit lays the panes out.
- **Shared by URL.** The first viewer types, the rest watch, and the screen is
  identical for everyone. A reload or a dropped network keeps the host session:
  the server holds it, and the page reconnects to it.
- **A real keyboard**, following PCOMM's 3270 layout — PF1–PF24, PA1–PA3, Attn,
  SysReq, Clear, EraseEOF, FieldMark — and every binding is changeable.
- **ISPF panels** for everything the browser itself offers: settings, macros, a
  recorder and the key bindings, each drawn into the terminal with a title, a
  command line and PF keys. `Alt+Space` opens the primary option menu; the
  numbers `0` to `3` go from there, and `=0` to `=3` jump from anywhere.
  Opening a panel is a keymap command, so that key is yours to change too.
- **Fit to window**: ask the host for a screen the size of the pane rather than
  the model's 24×80, negotiated as IBM-DYNAMIC.
- **Automation over REST**, speaking s3270's own `-httpd` protocol, so an
  existing s3270 client only changes its base URL. Off until the controller
  turns it on for their session.

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
