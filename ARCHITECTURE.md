# Architecture

A web page that behaves like an IBM 3270 terminal. A Node server drives one
`b3270` process per session; the browser renders with `ghostty-web`.

```
browser                          node server                        host
┌──────────────────────┐      ┌───────────────────────────┐      ┌──────┐
│ ghostty-web Terminal │◀─bin─┤  vt.js ◀── ScreenModel    │◀─────┤ b3270│◀─TN3270─▶ mainframe
│  (renderer only)     │      │        (authoritative)    │NDJSON└──────┘
│ keymap.js            │──txt─▶ Session ──▶ b3270 stdin   │
└──────────────────────┘  WS  └───────────────────────────┘
                                     │ broadcast
                              ┌──────┴──────┐
                          viewer A      viewer B (observer)
```

## The one hard problem

`b3270 -json` speaks a **structured, incremental screen model**: newline-delimited
JSON such as

```json
{
  "screen": {
    "cursor": { "enabled": true, "row": 2, "column": 9 },
    "rows": [
      {
        "row": 1,
        "changes": [
          { "column": 3, "text": "____", "fg": "neutralBlack", "bg": "red" }
        ]
      }
    ]
  }
}
```

Two properties of that format decide everything else:

- _"a screen indication does not specify the entire contents of the screen; it is
  an incremental update to what is already displayed"_
- _"if a particular screen attribute is not specified, then it stays the same"_

`ghostty-web`, meanwhile, consumes an **ANSI/VT byte stream** (`term.write()`).

So somebody has to hold the whole screen and translate model → VT.

**That somebody is the server.** `server/screen.js` holds the authoritative
`ScreenModel`; `server/vt.js` renders it, either as a delta (changed rows only)
or as a complete repaint.

This single decision is also what makes multiple viewers work. Because the
server already owns the full screen, a browser that joins an hour into a session
is handed a repaint and is instantly correct, and every attached browser gets the
same delta bytes. Had the translation lived in the browser, each viewer would
need its own shadow buffer fed from the beginning of time, and joining late would
be impossible.

The cost, accepted deliberately: **there is no local echo.** A keystroke travels
browser → server → b3270 → screen indication → VT → browser. On localhost or a
LAN this is a few milliseconds. It is also _required_ for a coherent shared
session — one authoritative screen, one ordered input stream.

## Transport: why WebSocket, not SSE

Both were evaluated.

SSE plus a `POST` per keystroke does work, and `EventSource` reconnects for free.
Against it:

- `EventSource` is downstream-only and **text-only**, so screen bytes would need
  base64 or an escaping scheme.
- Every keystroke costs a full HTTP request.
- The deciding point: **two independent channels give no ordering guarantee
  between input events.** Our deltas are incremental against a shared shadow
  buffer, and our inputs must reach b3270's single stdin in the order typed. A
  transport that can reorder them is the wrong transport.

WebSocket gives ordered, full-duplex, binary-capable framing over one connection
at 2–6 bytes of overhead per message. Polling was excluded by requirement and
would have been wrong here regardless. WebTransport was considered and rejected:
mandatory TLS and certificates, weaker support, no benefit at this scale.

A useful side effect of binary framing:

| Frame type | Carries                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| **binary** | VT bytes for the terminal                                                                                        |
| **text**   | JSON control messages (`hello`, `screen`, `status`, `error`; `action`, `text`, `connect`, `disconnect`, `model`) |

The frame type _is_ the discriminator, so neither direction needs an envelope.

## Sessions and viewers

`Session` (`server/session.js`) owns a `b3270` process, a `ScreenModel`, an
`OiaModel` and a `Set<Viewer>`. **It deliberately outlives every viewer.** A
browser reload, a dropped connection and a second person opening the same URL are
all just `attach` and `detach`; the host connection is never disturbed. A session
with no viewers is reaped after `sessions.idleTimeoutMs`.

- **attach** → assign a role, send `hello`, send `fullRepaint()` as one binary frame.
- **screen indication** → apply to the model, mark rows dirty, `delta()` → broadcast.
- **input** → only if `viewer.role === 'controller'` → translate to a b3270 action → stdin.
- **detach** → if the controller left, promote another viewer, so the session
  never becomes permanently read-only.

That reaping window is also the reconnect budget, so the server tells the
browser how wide it is in the `hello` instead of both sides guessing. When a
socket drops, `public/reconnect.js` backs off exponentially with jitter and the
page asks `/api/sessions` before each attempt — a browser is never told why a
WebSocket failed, so "the server is down" and "the session was reaped" are
indistinguishable from the socket alone, and they need opposite answers: wait
for the first, start a new session for the second. A reconnect that gets as far
as a `hello` reloads the page, so a server that came back with newer page code
is actually picked up; the URL fragment is left alone, so the reloaded page
attaches to the same sessions. The reload hangs off the `hello` and not the
socket opening, because an attach the server refuses (E3007) opens a socket too
and would otherwise reload forever.

A `Viewer` is just `{ id, role, sendScreen, sendMessage }`. Nothing about it
knows what a WebSocket is, which is why the tests attach a plain collector object
and exercise the real broadcast path with nothing mocked.

Indications arrive in bursts; `scheduleFlush()` coalesces a burst with
`setImmediate` so viewers never see a half-applied screen and the wire stays
quiet.

### The multi-viewer seam

Extra viewers are observers today. Making everyone a controller is the config
flag `sessions.allowMultipleControllers`, and it is genuinely a one-line change
in `Session#attach` rather than a redesign — because **there are no locks
anywhere**. Concurrent input cannot corrupt anything: every keystroke from every
viewer funnels into a single ordered stdin queue, and the resulting screen comes
back to everyone identically.

## REST: the emulator's own interface, forwarded

`b3270` carries s3270's REST interface — the same httpd code, linked into both
programs — so a session's own emulator serves it and `server/restproxy.js` only
forwards: `/api/sessions/<id>/3270/…` goes to `127.0.0.1:<session port>/3270/…`
and the answer is copied back verbatim. Nothing here parses an action, and
existing s3270 `-httpd` automation only has to change its base URL.

Each session gets its own loopback port and a random cookie, written to a 0600
file and passed as `-cookiefile`; the proxy adds the `x3270-security` header, so
another local process that guesses the port is refused with 403. The port is
bound and released by us before spawning rather than left to b3270's `:0`, which
picks a port but never reports which.

REST calls are exempt from the controller/observer rule: an automation client
drives the session whoever else is watching. That is safe for the screen model
because b3270 still emits its indications on the JSON stream for actions that
arrived over httpd, so viewers see the result the same as any other change.

It is not automatically safe for the person watching, though, so the controller
owns a switch over it — **Allow automation**, off until asked for — and the proxy
is the one place it is checked: one `session.allowAutomation` test in
`proxyRestRequest` before anything is forwarded, `E7004` and a 403 when it is
off. b3270 itself is left alone; its httpd keeps listening and keeps its cookie,
because a switch that respawns the emulator would cost the session its host
connection. `sessions.allowAutomation` moves the starting point rather than
capping it, which is what a browserless automation deployment sets — there is no
controller there to ask.

## Screen size: who decides what

Two different things are called "size", and keeping them apart is what makes the
picker and the auto-fit simple.

**The grid** — rows × columns — belongs to the 3270 model, and the _server_ owns
it. The browser never picks a size: it asks with `{"type":"model"}`, b3270
answers with a `screen-mode` indication, and only then does the session tell
every viewer the new geometry. So the emulator's opinion is the only one, and a
second viewer is resized by the same message as the first.

Ordering is the subtle part. A repaint is meaningless to a viewer still holding a
43-row terminal, so the `screen` message is sent **immediately before**
`repaintAll()`. One ordered WebSocket per viewer is what turns "before" into a
guarantee; `test/session.test.js` asserts the two events are adjacent and in that
order, for the controller and the observer alike.

b3270 also refuses a model change while connected — the model is negotiated with
the host — so `Session#setModel` checks the connection state first rather than
letting the emulator's own wording surface. A connected session parks the choice
in `pendingModel`, disconnects, applies it once the connection is gone, and
reopens the same host; `setOversize` does the same with `pendingOversize`. The
settings page warns before it does this, but the server does not rely on that.

The model list in the picker comes from b3270's `models` indication at startup,
so the frontend holds no copy of the 3270 model table.

**The pixels** are the browser's problem, and only the browser's. Rows and
columns are fixed by the model and cannot be traded away for space, which leaves
the font size as the single free variable: `public/app.js` measures the box the
page gives the screen and `public/fitfont.js` picks the largest size whose cells
still fit. A cell measures `ceil(fontSize × k)`, and that rounding is why the
search walks both ways: the ratio between the box and the cells in it now is a
good guess but a quantised one, landing below the answer as readily as above it,
so it walks down until the grid fits and then up while the next size still does.
A `ResizeObserver` on the screen box refits — coalesced into one animation frame,
since dragging a window edge fires it continuously.

## VT encoding: the details that bite

- **`ESC[?7l` (autowrap off), once, before anything is painted.** With autowrap
  on, writing a character into the last column of the last row wraps and scrolls
  the entire screen, corrupting every absolute cursor address after it. This is
  the easiest way to get this feature subtly and confusingly wrong.
- The terminal is `rows + 1` tall. The extra bottom line is the **OIA**, the
  status line a real 3270 draws: connection state, the `X SYSTEM` keyboard lock,
  and the cursor position. Without it a user cannot tell _why_ typing does
  nothing.
- Each row is painted by grouping contiguous cells with identical attributes into
  runs: one `ESC[{row};{col}H`, one SGR, then the text.
- Every SGR starts with a `0` reset, so a run never inherits attributes from
  whatever the terminal happened to be in. Colours are truecolor
  (`38;2;r;g;b` / `48;2;r;g;b`) taken from x3270's own palette in `colors.js`;
  `gr` maps `highlight→1`, `underline→4`, `blink→5`, `reverse→7`.
- Cursor last: `ESC[{row};{col}H` then `ESC[?25h` or `ESC[?25l`.
- A `screen-mode` with `"color": false` means the host reports **no colour at
  all**. Render monochrome green; do not invent colours.

## Keyboard

Ghostty is a **renderer only**. `term.onData` is deliberately unused: it would
VT-encode the keypress and force us to decode it back, which is lossy, and 3270
keys — PA1, Clear, Attn, Reset, EraseEOF — have no VT equivalent at all.

Instead `public/keymap.js` puts a capture-phase `keydown` listener on the
container and maps `KeyboardEvent` → 3270 action, with printable characters
becoming `String("…")`. The bindings follow PCOMM's default 3270 keyboard
layout rather than x3270's. The map is small and self-contained, so it can be
made configurable later without touching the transport.

## All UI lives inside the terminal

`public/index.html` is just a `<div id="screen">` around the ghostty-web
canvas. **Every piece of chrome — the panels, the error banner, the buttons on
the OIA line — is drawn as VT bytes into that same `Terminal`, never as native
HTML/DOM/CSS.** `settings.js` explains why at its own top: a second focus model,
a second keybinding set, and a second fit-to-window problem are exactly the
complexity this rule avoids. One renderer, one input path, one thing to keep
sized and focused.

The pattern (see `errorOverlayBytes()` and `buttonBytes()` in
`public/app.js`): build a string of VT escapes, wrap the cursor move in
`ESC 7` / `ESC 8` (save/restore) so painting chrome never steals the real 3270
cursor, and re-write it after every host update so it survives the next
repaint or delta. Mouse hit-testing works the same way in reverse:
`terminal.renderer`'s public `getCanvas()` / `charWidth` / `charHeight` turn a
click's pixel coordinates back into a `{row, col}` cell to compare against
where the chrome was drawn.

## Panels

Since everything is drawn into a 3270 screen anyway, the dialogs are shaped like
the ones a 3270 user already knows: ISPF panels. That is not decoration — it is
where the whole interaction model comes from, and copying it is cheaper than
inventing one. A title, `Option ===>` / `Command ===>`, dot leaders,
`More: - +`, F1/F3/F4/F7/F8/F12, point-and-shoot options and `=n` jumps are a
design nobody has to be taught.

`public/panel.js` owns the shape and `Panel` owns the behaviour: the command
line, the cursor and its stops, scrolling, the PF keys, click routing, copy and
paste. A page — `settings.js`, `macros.js`, `recorder.js`, `keymap-page.js`,
`menu.js` — says what its `lines()` are and what picking one does, and gets all
of that for free. Two hooks exist for the awkward 10%: `typed()` for a page's
own editable field, and `override()` for a modal state (naming a macro, waiting
for a key to bind) that has to take every keystroke before the generic handling.

`public/app.js` is the registry: it holds the pages, the `trail` of how the
current one was reached, the Alt-key table that opens one from the session, and
the clipboard and click wiring that hands `Ctrl-C` / `Ctrl-V` / a mouse click to
whichever panel is open instead of to the host. `F3` pops one level of the
trail, `F4` unwinds to the menu, an Alt shortcut starts a fresh one. Nothing
about navigation lives in a page.

Ctrl and Meta deliberately fall through `Panel.handleKey`, which is what keeps
reload, devtools, copy and paste working while a panel is open. `panel.js` has
no runtime import from `settings.js` — only an erased JSDoc `import()` for the
`Theme` type — because the pages import it, and a cycle would be a real one.

## Errors

Per `CLAUDE.md`, every error site carries a stable code, shown in the logs _and_
in the UI, surfaced **in place** — the page is never navigated away from, because
a redirect would throw away the session the user is looking at.

| Block   | Area      |
| ------- | --------- |
| `E1xxx` | config    |
| `E2xxx` | b3270     |
| `E3xxx` | session   |
| `E4xxx` | websocket |
| `E5xxx` | frontend  |
| `E6xxx` | http      |

Codes are an identity, not a label: once assigned to a site, a code never
changes. See `server/errors.js`.

## Logging

Every line goes to stderr and, unless `logFile` is empty, to a file that rolls
over into a single `<logFile>.1` at `logMaxBytes` — two files, a bounded amount
of disk, and no dependency to do it.

A line is `<time> <LEVEL> <scope> <message> <key=value>...`, and the scope is
the subsystem — `http`, `session`, `b3270`, `registry` — never an identity. Who
a line is about is a field instead, because that is what makes a whole session's
history one `grep session=<id>` across all four subsystems. A logger carries
that context bound to it (`logger('session', { session: id })`) rather than
every call site remembering to pass it, and `log.with({ ip, user })` narrows one
to a single viewer, so its attach, its messages and its close all name who they
came from. A field nobody filled in is left off the line, so `user=` appears
only once something knows it.

Who that is comes from the socket by default. `security.trustProxyHeaders` says
a reverse proxy is in front, and then the address is the leftmost
`X-Forwarded-For` entry and the user is `X-Remote-User` — headers any client
could otherwise set for itself, which is why believing them is a decision the
operator makes and not the default. `user` is empty until something
authenticates: an NTLM handshake terminated at that proxy is what would fill it
in, and `Viewer.user` is where it would land.

## Testing strategy

No browser driver and no mainframe are needed.

1. `test/fakehost.js` is a JS port of x3270's `playback.py`: it listens, replays
   a `.trc` trace as a TN3270 host, and does the timing-mark handshake.
2. A **real** `b3270` connects to it, and a **real** `Session` consumes the
   indications.
3. `test/ghostty.js` loads ghostty-web's WASM parser headlessly in Node, so our
   VT bytes are checked against _the exact parser the browser runs_.
4. `test/server.test.js` spawns the real HTTP server and drives it over real
   WebSockets, including the two-browsers-one-session case.

Waiting is always on a condition, never a duration. Where b3270's own timing is
involved, `settle()` submits an action and waits for its `run-result`: because
b3270's stdout is a single ordered stream, that reply proves every earlier
indication has already been applied.

## Layout

```
flake.nix  nix/b3270.nix   node, typescript, X11-free b3270 and s3270
config.jsonc                settings (hand-parsed JSONC, no dependency)
jsconfig.json               checkJs + strict → the "no any" gate

server/
  main.js       http, static files, /api/sessions, ws upgrade
  config.js     JSONC → validated Config
  errors.js     the stable error-code table
  log.js        structured logging to stderr and a rolling file
  b3270.js      spawn, NDJSON framing, action submission
  screen.js     ScreenModel: the authoritative shadow buffer
  colors.js     3270 colour name → RGB, gr → SGR
  vt.js         ScreenModel → VT bytes (delta and fullRepaint)
  oia.js        OIA field state → status line
  session.js    Session, Viewer, SessionRegistry
  protocol.js   wire typedefs and the action allow-list
  restproxy.js  forwards /3270/ to the session's own b3270 httpd

public/
  index.html    a div around the canvas, and nothing else
  app.js        sessions, panes, the panel registry, clipboard and clicks
  keymap.js     KeyboardEvent → 3270 action
  panel.js      the ISPF panel frame and the Panel base class
  menu.js       the primary option menu and the help panel
  settings.js   macros.js  recorder.js  keymap-page.js   the panels
  reconnect.js  fitfont.js  store.js  style.css
test/           fakehost.js, ghostty.js, helpers.js, traces/, *.test.js
```

## Dependencies

Two runtime dependencies, both agreed before adding:

- **`ws`** — WebSocket server. Node has no built-in one.
- **`ghostty-web`** — the renderer, served straight out of `node_modules` at
  `/vendor/` so its wasm resolves against its own module URL. No bundler.

`typescript` comes from the flake devShell, not `package.json`: it is a dev tool,
not a project dependency. `@types/node` and `@types/ws` are devDependencies with
zero runtime code, needed only to make the strict type gate meaningful.
