# Tasks and progress

Status as of 2026-09-20.

## Done

- [x] **Nix flake** — devShell with `nodejs_22`, `typescript`, `python3`, and a
      minimal `b3270` derivation built from the same `suite3270-4.5ga5` tarball
      nixpkgs uses, with X11 disabled. Verified: zero X11 libraries linked.
      `s3270` is built alongside it, for the REST proxy's comparison test; it
      is headless too, and adds nothing to the closure.
- [x] **Config** — `config.jsonc` plus a hand-written JSONC parser
      (`server/config.js`): comment stripper, trailing-comma stripper, typed
      validation with `E1xxx` codes. No dependency added for it.
- [x] **Error codes** — `server/errors.js`, seven blocks, `AppError` carrying the
      code all the way to the UI.
- [x] **Logging** — `server/log.js`, levelled, structured, to stderr;
      `logLevel: "debug"` logs every line exchanged with b3270.
- [x] **b3270 driver** — `server/b3270.js`: spawn, NDJSON framing, `initialize`
      flattening, tagged action submission, clean stop via stdin EOF.
- [x] **Screen model** — `server/screen.js`: incremental `screen` application
      with per-cell attribute retention, `erase`, `screen-mode`, dirty-row
      tracking.
- [x] **OIA** — `server/oia.js`: lock, insert, typeahead, LU and connection
      state, sent to the browser as fields for `public/oia.js` to lay out.
- [x] **Paint encoder** — `server/paint.js`: run-grouped rows carrying b3270's
      own colour names and `gr` string; `fullPaint()` and `paintDelta()`.
- [x] **Fake host** — `test/fakehost.js`, a JS port of x3270's `playback.py`,
      plus four vendored traces and a `NOTICE`.
- [x] **Sessions** — `server/session.js`: `Session`, `Viewer`, `SessionRegistry`,
      attach/detach, controller promotion, burst coalescing, idle reaping.
- [x] **Server** — `server/main.js`: HTTP, static files, `/api/sessions`,
      WebSocket upgrade, graceful shutdown.
- [x] **Static delivery** — no bundler, no build step: gzip, an ETag on every
      file, and a year of `immutable` on the vendored fonts, with a preload list
      written out in `index.html` so every module and every font arrives in one
      wave. 777 KB of files reach a cold browser as 320 KB; a reconnect's reload
      costs a few `304`s.
- [x] **REST** — `server/restproxy.js`: each session's b3270 runs its own
      `-httpd` on a loopback port guarded by a per-session cookie, and
      `/api/sessions/<id>/3270/…` is forwarded to it untouched. s3270's REST
      interface, because it _is_ s3270's REST interface — verified byte for byte
      against a real `s3270 -httpd`.
- [x] **Frontend** — `public/index.html`, `app.js`, `keymap.js`: one ordered
      text channel, paints into a `Grid`, status and in-place errors,
      capture-phase keymap. The markup is a `<canvas>` in a box and four CSS
      rules inlined beside it, and no code ever changes it.
- [x] **Renderer** — `public/canvas.js` and `public/grid.js`: the page has one
      `Screen`, one canvas, and every pane is a `Pane` on it — pure data, two
      grids each, host and overlay. `Screen.layout()` hands each pane its share
      of the page and the font size that fits it; a frame clears the canvas edge
      to edge and redraws every pane, so nothing can be left behind. Backgrounds
      then glyphs, every fill edge snapped to the device pixel grid,
      rectangular selection, a cursor that leaves the character under it
      legible, and `paneAt()` routing a click to the pane it landed in. 992
      lines with `grid.js`, `colors.js`, `oia.js` and `fitfont.js` in place of a
      682 KB bundle and a 423 KB wasm VT parser, which a fixed grid of
      single-width cells never needed.
- [x] **Model picker** — the grid size is chooseable from the toolbar. The list
      is b3270's own `models` indication; the change goes server-side via
      `Set(model, N)`, and the new geometry reaches every viewer as a `screen`
      message sent immediately before the repaint that assumes it. Refused while
      connected (`E3006`), and the picker snaps back to the model in force.
- [x] **Auto-fit** — the terminal is drawn as large as the page allows without
      being cut off. Rows and columns belong to the model, so the font size is
      what scales; a `ResizeObserver` on the screen box refits on window
      resizes, model changes, and the error bar appearing. The search
      (`public/fitfont.js`) walks both ways from its estimate, because a cell is
      a whole number of pixels and the estimate is as likely to land short as
      over.
- [x] **Reconnect** — a dropped page retries with exponential backoff and jitter
      for as long as the server holds a viewer-less session (`sessions.idleTimeoutMs`,
      sent in the `hello`), asking `/api/sessions` between attempts to tell a
      server that is down from a session that was reaped. A reconnect that
      reaches a `hello` reloads the page — same sessions, possibly newer page
      code (`public/reconnect.js`).
- [x] **Logging** — every line goes to stderr and to a rolling file
      (`logFile`, rolled over to `<logFile>.1` at `logMaxBytes`, 10 MB by
      default). Lines carry the session id they belong to and, where a browser
      caused them, the address and user it came from. With
      `security.trustProxyHeaders` on, those two come from `X-Forwarded-For`
      and `X-Remote-User` — where an NTLM handshake terminated at a proxy would
      hand its result over.
- [x] **Tests** — 317, all passing:
  - the `testRender.py` assertions ported onto our model (`render.test.js`)
  - the round-trip: our paints → the browser's own `Grid` equals the model,
    over real traced b3270 output (`roundtrip.test.js`, `grid.test.js`)
  - screen-indication semantics and the OIA (`screen.test.js`)
  - JSONC parsing, validation, the action allow-list (`config.test.js`)
  - multi-viewer behaviour against a real b3270, including a model change
    resizing every viewer before it repaints them (`session.test.js`)
  - the whole stack over real HTTP and real WebSockets (`server.test.js`)
  - the REST proxy against a real `s3270 -httpd` as the oracle
    (`restproxy.test.js`)
  - the reconnect arithmetic and idle reaping (`reconnect.test.js`,
    `session.test.js`)
  - the font fit against a brute-force search over every size (`fitfont.test.js`)
  - mouse selection against a recording 2D context, so what a click leaves on
    the screen is asserted rather than looked at (`canvas.test.js`)
  - log rollover, and the session id, address and user on the lines, forwarded
    or not (`log.test.js`, `server.test.js`)
  - what a browser is actually sent: gzip, the ETag and its `304`, the fonts'
    `immutable` year, and the preload list held against the real import graph
    (`server.test.js`)
- [x] **Type gate** — `tsc -p jsconfig.json` with `checkJs` and `strict`, clean.
      No `any` anywhere.
- [x] **Docs** — `ARCHITECTURE.md`, `SPECIFICATION.md`, `GOTCHAS.md`, this file.
- [x] **Windows b3270** — the flake's `b3270.nix` cross-builds a `b3270.exe` via
      `pkgsCross.mingwW64` (package `b3270-windows`, `x86_64-linux` build machine
      only — Nix has no way to run a Windows build itself). Windows TLS comes from
      the native SChannel/CryptoAPI libraries (`crypt32`/`secur32`) that mingw
      already links, and its libexpat is vendored and self-built by the suite, so
      neither `openssl` nor `expat` is a dependency there.
- [x] **CI** — `.github/workflows/build.yml` builds `b3270` and `b3270-windows`
      through the flake on `ubuntu-latest` and uploads both binaries as artifacts.

## Verification

```bash
nix develop
npm install
npm run typecheck    # clean
npm test             # 317 passing
npm start            # http://127.0.0.1:8017
```

By hand, without a mainframe:

1. `npm run start:fake`
2. Open the page, type into the Name field, confirm it shows and the OIA line is
   live.
3. Open the same URL (including the `#fragment`) in a second window: it shows the
   identical screen immediately and then tracks the first live.
4. Type in the first window — both update. Type in the second — refused, with the
   observer role shown.
5. Kill the fake host: connection state changes and error codes appear in the
   page, in place.

All five were walked through in a real browser on 2026-09-07 and passed, plus one
more that is not in the list: killing and restarting the _server_ with two tabs
attached. Both tabs recovered on their own, each with a fresh session id — the
`opened` flag in `connectSocket` is what distinguishes "the link dropped, retry
the same session" from "the server is new, get another session".

The picker and the auto-fit were walked through the same way on 2026-09-07:

6. The picker is filled from b3270 (all four models with their real sizes) and
   the grid is maximal in the page at every one of them — 80 columns at 31px in
   a 2544px box, 132 columns at 19px in the same box, one size larger overflows
   in both cases.
7. Shrinking the page refits the grid down; restoring it grows the grid back.
8. While connected the picker is disabled, and a change forced through anyway is
   refused with `E3006` shown in place, the screen untouched and the picker back
   on the model in force.
9. A model change made by the controller resizes the observer's grid too, and
   updates its (disabled) picker.

The renderer was walked through the same way on 2026-09-23, against the fake
host:

10. The screen, the field tint, the block cursor with the character under it
    still legible, and `Alt+Space` into the menu, the settings panel and back.
11. `Ctrl-B` into two and four panes: each pane its own screen, its own status
    line, refitted to its width.
12. All sixteen themes and all nine fonts cycled with Left/Right: every theme
    repainted in its own colours, every font re-measured and re-fitted to its
    own cell.
13. A box selection across a field boundary, `Ctrl-C`, and paste back into the
    screen: the copy is rectangular and trimmed per row.
14. Enter with no host to answer it locks the keyboard and Reset clears it —
    each of the two reaching the viewer as its own `status`, which is what
    `waitForUnlock()` and macro playback wait on.
15. Killing the host: `connection`, `connected` and `lock` all change, the
    status line says so, and the pane opens its settings over the session.
16. Two tabs on one session URL: identical screens, the second refused in place
    with `E3006`, and it tracks the first live.

The one-canvas rewrite was walked through the same way on 2026-09-23, against
the fake host, reading the canvas back rather than trusting the screenshots:

17. One canvas the size of the screen box, with all of 1, 2, 3 and 4 panes tiled
    onto it, each fitted to its own share — two side by side get exactly half the
    width each, centred in it.
18. A click routes to the pane it lands in, in every pane of a three-pane split,
    and one above a pane's first row is ignored rather than clamped onto it.
19. Panels, error bars and the status line stay scoped to their pane; the other
    panes are untouched by them.
20. A drag highlights in its own pane, and the click that follows takes the
    highlight off and leaves one cursor with its character still legible — the
    bug that started this.
21. Shrinking the screen box refits and redraws every pane in one frame.
22. A pane whose screen cannot shrink past `MIN_FONT_SIZE` is cut off at its own
    edge and not at its neighbour's, which the `overflow: hidden` on the old
    per-pane `<div>` used to do and `Screen.renderPane()`'s clip does now.

The delivery was measured in a real browser on 2026-09-23, from the Resource
Timing entries rather than from the server's side of it:

23. 22 requests, no duplicate — a font asked for twice would mean the
    `crossorigin` on its preload was missing. All eighteen modules start
    together and are done inside one wave; the fonts start with them instead of
    waiting for `app.js` to run.
24. A reload — which is what a reconnect does — transfers about 6 KB: a `304`
    per module and no font traffic at all.
25. A gzipped TrueType arrives as 108,596 bytes, decodes to the full 255,248,
    and `new FontFace(...)` parses it, so halving the fonts costs nothing at
    the other end.

The seams a fractional device-pixel ratio used to leave were looked for by
reading the canvas back rather than by eye, with `devicePixelRatio` forced to
1.4 and a cell of 15.4 × 33.6 device pixels: no full-height dark column across
the reverse-video status row, and none across a five-row selection either way.

## Not done, deliberately

- **DBCS / `wide` graphic rendition.** The model records the flag; `paint.js`
  passes the character through unadorned. Double-width cells would need both
  the grid and the renderer to reason about cell widths.
- **File transfer (IND$FILE) and printer sessions.** `pr3287` is built by the
  flake but unused.
- **Authentication.** The server binds to `127.0.0.1` by default and has no
  notion of users. Anyone who can reach the port can create a session and, unless
  `security.allowedHosts` is set, ask it to connect anywhere.
- **TLS.** Put a reverse proxy in front; the page picks `wss://` automatically
  when served over HTTPS.

## Next, if this continues

- A per-viewer cursor overlay so people can see where the others are looking.
- Reconnect currently redraws from scratch. That is correct but wasteful on a
  slow link; a sequence number per delta would let a viewer resume.
