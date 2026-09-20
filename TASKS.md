# Tasks and progress

Status as of 2026-09-07.

## Done

- [x] **Nix flake** — devShell with `nodejs_22`, `typescript`, `python3`, and a
      minimal `b3270` derivation built from the same `suite3270-4.5ga5` tarball
      nixpkgs uses, with X11 disabled. Verified: zero X11 libraries linked.
- [x] **Config** — `config.jsonc` plus a hand-written JSONC parser
      (`server/config.js`): comment stripper, trailing-comma stripper, typed
      validation with `E1xxx` codes. No dependency added for it.
- [x] **Error codes** — `server/errors.js`, six blocks, `AppError` carrying the
      code all the way to the UI.
- [x] **Logging** — `server/log.js`, levelled, structured, to stderr;
      `logLevel: "debug"` logs every line exchanged with b3270.
- [x] **b3270 driver** — `server/b3270.js`: spawn, NDJSON framing, `initialize`
      flattening, tagged action submission, clean stop via stdin EOF.
- [x] **Screen model** — `server/screen.js`: incremental `screen` application
      with per-cell attribute retention, `erase`, `screen-mode`, dirty-row
      tracking. `server/colors.js` for the x3270 palette and `gr` → SGR.
- [x] **OIA** — `server/oia.js`: lock, insert, typeahead, LU and connection state
      laid out across the full screen width.
- [x] **VT encoder** — `server/vt.js`: autowrap off, run-grouped rows, truecolor
      SGR, OIA row, cursor last; `fullRepaint()` and `delta()`.
- [x] **Fake host** — `test/fakehost.js`, a JS port of x3270's `playback.py`,
      plus four vendored traces and a `NOTICE`.
- [x] **Sessions** — `server/session.js`: `Session`, `Viewer`, `SessionRegistry`,
      attach/detach, controller promotion, burst coalescing, idle reaping.
- [x] **Server** — `server/main.js`: HTTP, static files, `/api/sessions`,
      WebSocket upgrade, graceful shutdown.
- [x] **Frontend** — `public/index.html`, `app.js`, `keymap.js`, `style.css`:
      ghostty-web renderer, binary frames → `write()`, text frames → status and
      in-place errors, capture-phase keymap, reconnect with backoff.
- [x] **Model picker** — the grid size is chooseable from the toolbar. The list
      is b3270's own `models` indication; the change goes server-side via
      `Set(model, N)`, and the new geometry reaches every viewer as a `screen`
      message sent immediately before the repaint that assumes it. Refused while
      connected (`E3006`), and the picker snaps back to the model in force.
- [x] **Auto-fit** — the terminal is drawn as large as the page allows without
      being cut off. Rows and columns belong to the model, so the font size is
      what scales; a `ResizeObserver` on the screen box refits on window
      resizes, model changes, and the error bar appearing.
- [x] **Tests** — 54, all passing:
  - the `testRender.py` assertions ported onto our model (`render.test.js`)
  - the WASM round-trip: our VT → ghostty's own parser → grid equals the model
    (`roundtrip.test.js`)
  - screen-indication semantics and the OIA (`screen.test.js`)
  - JSONC parsing, validation, the action allow-list (`config.test.js`)
  - multi-viewer behaviour against a real b3270, including a model change
    resizing every viewer before it repaints them (`session.test.js`)
  - the whole stack over real HTTP and real WebSockets (`server.test.js`)
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
npm test             # 54 passing
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
more that is not in the list: killing and restarting the *server* with two tabs
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

## Not done, deliberately

- **DBCS / `wide` graphic rendition.** The model records the flag; `vt.js` passes
  the character through unadorned. Double-width cells would need the encoder to
  reason about cell widths.
- **File transfer (IND$FILE) and printer sessions.** `pr3287` is built by the
  flake but unused.
- **Authentication.** The server binds to `127.0.0.1` by default and has no
  notion of users. Anyone who can reach the port can create a session and, unless
  `security.allowedHosts` is set, ask it to connect anywhere.
- **TLS.** Put a reverse proxy in front; the page picks `wss://` automatically
  when served over HTTPS.

## Next, if this continues

- Turn on `allowMultipleControllers` and see what shared typing actually feels
  like; the machinery is there, the UX question is open.
- A per-viewer cursor overlay so people can see where the others are looking.
- Reconnect currently redraws from scratch. That is correct but wasteful on a
  slow link; a sequence number per delta would let a viewer resume.
- Copy and paste: ghostty-web has a selection manager that is currently unused.
