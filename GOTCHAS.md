# Gotchas

Things that cost time once and should not cost it twice.

## b3270 emits invalid JSON under a non-C locale

`run-result` carries a `time` field formatted with the C library's locale. Under
e.g. `de_DE` that is `"time":0,011` — a comma, which is not JSON, and the line is
lost. The child is therefore spawned with `LC_ALL=C` and `LC_NUMERIC=C`
(`server/b3270.js`). Symptom if it regresses: intermittent `E2003` immediately
after any action.

## The wiki's field names are not always b3270's

`Screen-mode indication` on the x3270 wiki documents `cols`. Real b3270 output is
`columns`. `erase` uses `logical-rows` / `logical-columns`. The typedefs follow
the real output, which was captured with `logLevel: "debug"` — do that first
before trusting any documented field name.

## b3270's default model is 4, not 2

`b3270` with no `-model` comes up as a model 4 (43×80). The vendored traces were
recorded on a model 4, which is why `test/helpers.js` overrides the config to
match; `config.jsonc` defaults to model 2 because that is what most hosts expect.

## There is no `Model` action; `Set(model, N)` is how the grid changes

b3270 answers `Model` with "Unknown action: Model". The working call is
`{"action":"Set","args":["model","2"]}`, which emits `screen-mode` and `erase`.
It is refused while a host connection is open — _"Cannot change model or oversize
while connected"_ — because the model is negotiated during connection setup, so
`Session#setModel` checks the connection state itself: rather than surfacing the
emulator's wording it parks the choice in `pendingModel`, disconnects, and
applies it when the connection is gone, reopening the same host.

## b3270 announces its geometry a few milliseconds after it starts

`ScreenModel` is constructed at 24×80 and b3270 corrects it in the first
`screen-mode`. Anything that reads the geometry (or the model list) before that
gets the placeholder, and the placeholder is a plausible size, so nothing looks
wrong. `session.ready` resolves on that first indication — wait on it, never on
`rows > 0`.

## `-httpd` has three traps worth knowing

- `-httpd 127.0.0.1:0` binds an ephemeral port and then reports the literal
  `:0`, so there is no way to learn which one. We bind a port ourselves, close
  it, and hand b3270 the number (`reserveRestEndpoint` in
  `server/restproxy.js`). A port taken again in between is not an exit: b3270
  says `httpd bind: Address already in use` as a popup indication and keeps
  running, and every REST call for that session then fails with `E7003`.
- `-cookiefile` is read once at startup, not per request. Deleting the file
  later changes nothing, and there is no indication saying when it has been
  read — so the file lives as long as the child does.
- Without `-cookiefile` the port is open to every process on the machine. It is
  the only authentication the httpd has.

## b3270 starts in the model's alternate size, s3270 at 24×80

Disconnected, `b3270 -model 4` reports `43 80` in the REST status line and
`s3270 -model 4` reports `24 80`; they agree once a host has set the size, and
they agree from the start on model 2, whose alternate size _is_ 24×80. The
proxy's comparison test therefore runs both sides at model 2, so that a
difference in the answer is a difference we caused.

## Autowrap must be turned off

`ESC[?7l`, once, before anything is painted (`INIT_SEQUENCE` in `server/vt.js`).
With autowrap on, writing a character into the last column of the last row wraps
and scrolls the whole screen, so every absolute cursor address after it is off by
a row. The failure looks like a rendering bug anywhere _except_ where it is.

## Building b3270 without X11

`--enable-b3270` alone is not enough: suite3270's configure enables every
component by default, so `configure` fails looking for X utilities. The unwanted
ones must be disabled explicitly (`--disable-x3270 --disable-c3270
--disable-tcl3270`), while `pr3287` and `x3270if` stay enabled because the b3270
build and install targets depend on them. `s3270` is headless as well and costs
nothing in the closure, so it is built too, as the oracle for the REST proxy's
comparison test. Its install target installs `pr3287` and `x3270if` a second
time, though, and two `install -c` runs racing over one path fail outright —
hence `enableParallelInstalling = false`. See `nix/b3270.nix`.

## ghostty-web in Node

- The bundle is built for the browser and touches `self` while loading, so
  `globalThis.self = globalThis` is needed before importing it headlessly
  (`test/ghostty.js`).
- The wasm is inlined as a base64 data URL in the ESM bundle, so no wasm path
  needs resolving in tests.
- The package's `exports` map does not expose `./dist/...`, so it must be
  imported as `'ghostty-web'`, not by subpath.
- The cell API is `getLine(y)` → array of cells, `getCursor()`, `getDimensions()`.
  There is no `readCell`, whatever the `GhosttyCell` typedef suggests.

## ghostty-web 0.4.0 blurs the canvas after every font-size change

`handleFontChange()` sets `canvas.width/height` in CSS pixels, throwing away the
device-pixel backing store `renderer.resize()` had just set up. On a HiDPI screen
every glyph goes soft. `fitFontSize()` in `public/app.js` calls
`renderer.resize()` and `renderer.render()` again afterwards to put it back.

## Browser measurements taken from CDP can disagree with the screenshot

An unfocused, automation-driven tab throttles `requestAnimationFrame`, so a
`ResizeObserver` callback coalesced into a frame has not run yet when the next
`javascript_exec` reads the DOM — while taking a screenshot _forces_ a frame.
That is how a screenshot showing a correctly refitted terminal sits next to a
measurement claiming it never resized. Screenshot first, then measure.

## An open WebSocket stops the server from shutting down

`server.close()` never calls back while a connection is alive, so SIGTERM would
hang forever. `server/main.js` terminates the `wss.clients` and calls
`server.closeAllConnections()` before closing.

## `settle()` does not mean the field map has arrived

The field map is a `ReadBuffer` the session asks for from `flush()`, which is
coalesced — so a `settle()` right after a screen change can submit its Reset
_before_ that read is even sent, and come back with `screen.fieldsFormatted`
still false. Anything to do with fields (Backspace's guard, paste, hints) then
falls back to its unformatted behaviour and the test quietly checks nothing.
Wait for `screen.fieldsFormatted` as well.

## `node --test test/` is not a directory scan

Node 22 treats the argument as a file path. Use the glob: `node --test
"test/*.test.js"` (quoted, so node expands it rather than the shell).

## `tsc --noEmit` ignores jsconfig.json

`tsc` only picks up `tsconfig.json` automatically. The type gate is
`tsc -p jsconfig.json`.

## `#000000` in a theme means "unset" to ghostty-web

`parseColorToHex()` packs a colour into `0xRRGGBB` and the WASM terminal reads 0
as "not set", so pure black — background, foreground or any of the sixteen
slots — silently becomes ghostty's own default instead. A black-background theme
comes up grey (`#1d1f21`) everywhere the host left the colour alone, and a
reverse-video cell over a black foreground gets ghostty's light grey. Every
theme is therefore passed through `terminalColors()`, which hands ghostty
`#010101` where the theme says black. Separately, the renderer skips its fill for
a `(0, 0, 0)` cell background, taking it for the cleared canvas, which would
leave the bars this page paints itself see-through on a light theme — `paint()`
shifts a pure black background by the same one bit.

## Typing into `reverse.trc` shows nothing

The input field in that trace is nondisplay. A `String` action there advances the
cursor and produces `"rows":[]` — that is correct, not a dropped update. Assert
on the cursor, not on visible text.
