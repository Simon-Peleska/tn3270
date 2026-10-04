# Architecture

A web page that behaves like an IBM 3270 terminal. A Node server drives one
`b3270` process per session; the browser renders onto a canvas of its own.

```
browser                          node server                        host
┌──────────────────────┐      ┌───────────────────────────┐      ┌──────┐
│ canvas.js ◀── grid.js│◀─────┤  paint.js ◀── ScreenModel │◀─────┤ b3270│◀─TN3270─▶ mainframe
│  (renderer only)     │ JSON │           (authoritative) │NDJSON└──────┘
│ keymap.js            │──────▶ Session ──▶ b3270 stdin   │
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

So somebody has to hold the whole screen, or an update that says "row 1 column 3
went red" means nothing.

**That somebody is the server.** `server/screen.js` holds the authoritative
`ScreenModel`; `server/paint.js` ships it, either as a delta (changed rows only)
or as a complete repaint.

This single decision is also what makes multiple viewers work. Because the
server already owns the full screen, a browser that joins an hour into a session
is handed a repaint and is instantly correct, and every attached browser gets the
same delta. Had the accumulation lived in the browser, each viewer would need its
own shadow buffer fed from the beginning of time, and joining late would be
impossible.

The cost, accepted deliberately: **there is no local echo.** A keystroke travels
browser → server → b3270 → screen indication → paint → browser. On localhost or
a LAN this is a few milliseconds. It is also _required_ for a coherent shared
session — one authoritative screen, one ordered input stream.

## Transport: why WebSocket, not SSE

Both were evaluated.

SSE plus a `POST` per keystroke does work, and `EventSource` reconnects for free.
Against it:

- `EventSource` is downstream-only, so input needs a second channel anyway.
- Every keystroke costs a full HTTP request.
- The deciding point: **two independent channels give no ordering guarantee
  between input events.** Our deltas are incremental against a shared shadow
  buffer, and our inputs must reach b3270's single stdin in the order typed. A
  transport that can reorder them is the wrong transport.

WebSocket gives ordered, full-duplex framing over one connection at 2–6 bytes of
overhead per message. Polling was excluded by requirement and would have been
wrong here regardless. WebTransport was considered and rejected: mandatory TLS
and certificates, weaker support, no benefit at this scale.

Everything travels as **one ordered text channel**: `paint` alongside `hello`,
`screen`, `status`, `error` one way, `action`, `text`, `connect`,
`disconnect`, `model` the other, each an object with a `type`. Screen updates
used to be binary frames, which made the frame type the discriminator and cost a
separate "did the geometry message arrive before the repaint that assumes it"
worry. One channel with one envelope answers that by construction.

## Sessions and viewers

`Session` (`server/session.js`) owns a `b3270` process, a `ScreenModel`, an
`OiaModel` and a `Set<Viewer>`. **It deliberately outlives every viewer.** A
browser reload, a dropped connection and a second person opening the same URL are
all just `attach` and `detach`; the host connection is never disturbed. A session
with no viewers is reaped after `sessions.idleTimeoutMs`.

- **attach** → assign a role, send `hello`, send `fullPaint()`.
- **screen indication** → apply to the model, mark rows dirty, `paintDelta()` → broadcast.
- **input** → only if `viewer.role === 'controller'` → translate to a b3270 action → stdin.
- **detach** → if the controller left, promote another viewer, so the session
  never becomes permanently read-only.

When a socket drops, `public/reconnect.js` backs off exponentially with jitter
and the page asks `/api/sessions` before each attempt. It keeps waiting while the
server does not answer; once it does, the session list decides whether to
reattach or create a fresh session. A reconnect that gets as far as a `hello`
reloads the page, so a server that came back with newer page code is picked up;
the URL fragment stays unchanged. The reload hangs off `hello`, not socket
opening, because an attach the server refuses opens a socket too. A viewer the
owner sends away gets a `refused` message first, and its page does not reconnect.

The Sessions panel can terminate a session with `DELETE /api/sessions/<id>`.
The request carries the private owner pass from `hello`; the server checks it
before closing the session and its viewers. Knowing a session ID or being an
admitted guest is not enough.

A `Viewer` is just `{ id, role, sendMessage, close }`. Nothing about it knows what a
WebSocket is, which is why the tests attach a plain collector object and
exercise the real broadcast path with nothing mocked. One paint object serves
every viewer, because nothing in it depends on who is looking.

Indications arrive in bursts; `scheduleFlush()` coalesces a burst with
`setImmediate` so viewers never see a half-applied screen and the wire stays
quiet.

### The multi-viewer seam

Extra viewers come in only on the owner's yes, as observers, and at most one of
them is let edit beside the owner (SPECIFICATION §3). Two controllers at once
needed no redesign — because **there are no locks anywhere**. Concurrent input cannot corrupt anything: every keystroke from every
viewer funnels into the session's one input queue, which hands b3270 the next
input only once it has finished the last, and the resulting screen comes back to
everyone identically.

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

There is no per-session switch over it: a session is reachable over REST from
the moment it exists, because the deployment this proxy is for drives sessions
with no browser attached to ask. The cost is that reaching this server is the
whole of the boundary — anyone who can is a controller of every session on it —
so an install that needs a narrower one authenticates in front.

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

## The paint protocol

`server/paint.js` walks each dirty row and starts a new run wherever the style
breaks. A run says where it goes, what it says, and **b3270's own words for how
it looks**:

```jsonc
{
  "type": "paint",
  "full": true, // true clears every cell not mentioned
  "color": true, // false = a 3278: mono green, do not invent colours
  "defaultFg": "green", // on a full paint only; what an omitted fg means
  "defaultBg": "neutralBlack",
  "rows": [
    {
      "row": 0,
      "runs": [
        {
          "col": 3,
          "text": "____",
          "fg": "red",
          "gr": "underline",
          "editable": true,
        },
        { "col": 7, "text": "Field:" },
      ],
    },
  ],
  "cursor": { "row": 1, "col": 8, "on": true },
}
```

- `fg`/`bg` are the colour names straight off a `Cell` (`server/screen.js`) —
  `red`, `deepBlue`, `neutralWhite` — and `gr` is b3270's comma-separated
  rendition string, `"underline,highlight"`, passed through untouched. The
  server does no colour work at all; the name → RGB table is
  `public/colors.js`, and the browser is where a theme is applied.
- Omitting a key means the screen default, or `false` for `editable`. That
  keeps a run readable in a log without a decoder ring.
- `editable` comes off the field map the session already tracks. The tint that
  marks a typeable field is a theme colour, so it is the renderer that puts it
  on — and a host that named its own background keeps it.

`public/grid.js` is the browser's half: `applyPaint()` and nothing else in the
way. `test/roundtrip.test.js` drives a real traced session and asserts the
`Grid` and the `ScreenModel` agree cell for cell, which is what keeps the two
halves honest.

A pane is `rows + 1` tall. The extra bottom line is the **OIA**, the status
line a real 3270 draws: connection state, the `X SYSTEM` keyboard lock, and the
cursor position. Without it a user cannot tell _why_ typing does nothing. It is
sent as fields — `StatusMessage` carries `connection`, `host`, b3270's raw
`lock` word, `insert` and `typeahead` — and `public/oia.js` composes the
line, because the buttons sharing that row are the browser's too. A server that
rendered the string would have to be told how many columns to leave for them.

## Keyboard

`public/canvas.js` is a **renderer only** — it knows how to draw a grid and
nothing about what put it there. 3270 keys (PA1, Clear, Attn, Reset, EraseEOF)
have no character to encode anyway.

`public/keymap.js` puts a capture-phase `keydown` listener on the
container and maps `KeyboardEvent` → 3270 action, with printable characters
becoming `String("…")`. The bindings follow PCOMM's default 3270 keyboard
layout rather than x3270's. The map is small and self-contained, so it can be
made configurable later without touching the transport.

## All UI lives inside the screen

`public/index.html` is a `<main id="screen">` around a `<canvas>`, with its
handful of CSS rules inlined, and that is the entire markup of the application.
Nothing ever adds, moves or removes an element — the two `createElement` calls
in `app.js` are the browser's download and file-picker APIs, which take an
element or nothing at all, and neither one is ever visible. **Every piece of
chrome — the panels, the error banner, the buttons on the OIA line — is drawn
as cells into that same canvas, never as native HTML/DOM/CSS.**
A second focus model, a second keybinding set and a second fit-to-window
problem are exactly the complexity this rule avoids. One renderer, one input path, one thing to keep sized and
focused.

There is **one** canvas on the page, and it is the whole of the page's drawing
surface: every pane, in every layout, is drawn onto it. A `Pane` is not a canvas
and not an element — it is two `Grid`s plus the rectangle it occupies, pure data
with no DOM in it. `Screen` owns the canvas: `layout()` gives each pane its
share of the page (`paneShares()` in `sessions.js`) and the font size that fits
it, and `render()` clears the canvas edge to edge and redraws every pane from
its grids. Nothing paints a region on its own, so nothing can be left behind —
the previous frame is gone before the new one starts. `redraw()` in
`public/app.js` is the only path to a frame, and every state change goes through
it; every geometry change goes through `applyLayout()`, which fits and then
redraws.

The two grids are `host`, what the server painted, and `overlay`, what this page
drew on top. An overlay cell wins wherever its character is not `null`, colours
and all, so a panel never inherits the field tint underneath it and taking the
overlay off puts the host's screen back with no round trip. `drawChrome()` in
`public/app.js` is the single place that composes a pane's overlay — clear, then
the panel or the status row, then the switcher, an error and the hint letters —
so there is exactly one ordering to reason about and no bookkeeping of what was
drawn where. Mouse hit-testing runs the same way in reverse: one `click`
listener on the one canvas, and `screen.paneAt(clientX, clientY)` turns the
point into a `{pane, row, col}` to compare against where the chrome was drawn.

## Panels

Since everything is drawn into a 3270 screen anyway, the dialogs are host
applications, the way a 3270 user already knows them: a title, `Command ===>`,
a one-cell field in front of each list line for `S`/`E`/`D`/`R`, F3/F4/F7/F8
and `=n` jumps. Copying that is cheaper than inventing an interaction model,
and nobody has to be taught it.

The panels speak the server's protocol, as JavaScript objects instead of JSON.
`public/local-host.js` is a small 3270 host that runs in the page: it takes the
same `text`, `action` and `paste` messages `send()` would put on the socket and
answers with a full paint message, which `Grid.applyPaint` draws like any other.
It owns the field logic — typing, insert, Tab, the erase keys, the cursor — so
an application only has to say what is on the screen (`screen(rows, cols)`:
texts and named fields) and what an AID key does with the field values
(`aid(aid, values)`).

`public/panels.js` is that application. It keeps a stack of screens, turns each
one into texts and fields, and on Enter commits any open edit field, then runs
the command line or the line letters from top to bottom. Every screen is a list
of items. An item says what each letter does on its line (`s`, `e`, `d`, `r`,
or an `edit` that opens a field), so a new setting is one entry in `items()`.
The state it changes lives outside it, in plain classes: `Settings`
(`settings.js`), `Keymap` (`keymap.js`), `Macros` (`macros.js`) and `Recorder`
(`recorder.js`). They know nothing about screens.

`public/app.js` coordinates sessions, drawing, and input. While a panel is open, typed text, actions,
pastes and clicks go to `panels.receive` instead of `send`, copy reads the
panel's grid, and `drawChrome()` puts `panels.paint()` on the overlay. The
status row is drawn on top as always. Opening a panel is a keymap command like
any other (`PANEL_COMMANDS` in `public/keymap.js`), claimed in the window's
capture handler so it works from inside another panel as well as from the
session. Ctrl and Meta combinations nothing binds fall through to the browser,
which keeps reload and devtools working while a panel is open.

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
| `E7xxx` | REST      |
| `E8xxx` | user data |

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

## User data

Settings, the keymap, macros and recordings live on the server, in the SQLite
file `userDataFile` names, one row per owner and key holding the JSON the page
sent. The owner is `user:<X-Remote-User>` when a proxy names one and
`ip:<address>` otherwise, so without one everybody behind a NAT shares a set.
`GET /api/userdata` returns all four keys in one round trip, which matters
because the page cannot fit its first screen until it knows the font;
`PUT /api/userdata/<key>` replaces one.

The file is shared on purpose. A blue/green deploy runs both servers against
it at once, which is why it is SQLite and not a JSON file: WAL lets one
process write while the other reads, `busy_timeout` makes a writer wait out the
other's lock instead of failing, and every write is one upsert, so neither
side ever sees half of the other's. Two tabs saving one key: the last one wins,
as it did in IndexedDB. WAL needs both processes on one machine — a network
filesystem cannot share its memory-mapped index. Log files are the opposite
case: rollover renames the file, which two writers cannot share, so the
default `logFile` carries `{port}` and each instance gets its own.

`node:sqlite` is built into Node 22, so this is no dependency, at the cost of
an `ExperimentalWarning` on startup. It is synchronous; a write is one small
statement and the event loop does not notice. The page chains the saves of
one key, since two requests in flight could otherwise arrive in either order.

Before this, the page kept the same four keys in IndexedDB. `public/store.js`
still reads them once for a key the server has nothing for and sends them up,
and leaves them where they are, so rolling back finds them too.

## Testing strategy

No browser driver and no mainframe are needed.

1. `test/fakehost.js` is a JS port of x3270's `playback.py`: it listens, replays
   a `.trc` trace as a TN3270 host, and does the timing-mark handshake.
2. A **real** `b3270` connects to it, and a **real** `Session` consumes the
   indications.
3. `public/grid.js` has no DOM in it, so `test/roundtrip.test.js` imports _the
   exact decoder the browser runs_ and compares it against the `ScreenModel`
   the paints came from, cell for cell, over real b3270 output.
4. `test/server.test.js` spawns the real HTTP server and drives it over real
   WebSockets, including the two-browsers-one-session case.

Waiting is always on a condition, never a duration. Where b3270's own timing is
involved, `settle()` submits an action and waits for its `run-result`: because
b3270's stdout is a single ordered stream, that reply proves every earlier
indication has already been applied.

## Serving the page

There is no bundler and no build step. The frontend is eighteen ES modules
served as eighteen files — the same files `node --test` imports and the same
ones a browser gets opening `index.html` off disk. What a bundle would have
bought is bought in `index.html` and `sendFile()` (`server/main.js`) instead,
without anything standing between the source and what runs.

- **Everything is preloaded**, by a list written out in `index.html`: a
  `modulepreload` per module and a `preload` per font. Without it a browser
  discovers the modules one import layer at a time, a round trip each; with it
  they all start at once. The fonts go in the same wave because the fit cannot
  start until one has loaded, and which font is wanted is a stored setting the
  static page cannot know. The list is in the file rather than generated, so the page
  is what it says it is; `test/server.test.js` walks the real import graph and
  fails if one is missing.
- **Fonts are immutable** for a year. They are vendored and never edited, they
  are three quarters of the page's weight, and they are the one thing a
  reconnect should never fetch twice.
- **Everything else is read from disk on every request**, with no compression
  and no validators: neither made a noticeable difference, and both were code
  to keep right. A deploy that only touches `public/` is a copy, not a
  restart, and the sessions a restart would end carry on. Open pages keep
  their old code until their next reload.

A cold browser fetches about 830 KB in one wave, 610 KB of it fonts; a
reconnect's reload fetches the 230 KB of page code again and no fonts.

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
  paint.js      ScreenModel → paint messages (paintDelta and fullPaint)
  oia.js        OIA field state, as fields
  session.js    Session and Viewer
  registry.js   session creation, lookup, and limits
  protocol.js   wire typedefs and the action allow-list
  restproxy.js  forwards /3270/ to the session's own b3270 httpd
  userdata.js   settings, keymap, macros, recordings in a shared SQLite file

public/
  index.html    the canvas, the inlined CSS, the preloads, and nothing else
  app.js        sessions, panes, clipboard and clicks, routed to a panel when one is open
  grid.js       the cell buffer: applyPaint, put, rectangular text, the field under a cell
  hints.js      Ctrl-B's field hint letters
  paste.js      a paste split into one segment per stretch of editable cells
                (run by the server, and by local-host.js for panels)
  canvas.js     Pane: two grids and a rectangle; Screen: the page's one canvas
  colors.js     3270 colour name → ANSI slot, gr → flags
  oia.js        the status line, composed from the last status and cursor
  keymap.js     KeyboardEvent → 3270 action, and the Keymap the Keys panel edits
  local-host.js a 3270 host in the page: messages in, paint messages out
  paint-runs.js groups equal-style cells for host and panel paints
  panels.js     the panels, a host application on local-host.js
  settings.js   settings behavior; themes.js holds the static palettes
  session-api.js browser calls to create and list sessions
  macros.js  recorder.js   what the panels change
  sessions.js   the Ctrl-B prefix, the URL fragment, and how panes split the page
  reconnect.js  fitfont.js  store.js
test/           fakehost.js, recordinghost.js, helpers.js, traces/, *.test.js
```

## Dependencies

One runtime dependency:

- **`ws`** — WebSocket server. Node has no built-in one.

SQLite is Node's own `node:sqlite`, not a package.

The frontend is plain ESM served straight out of `public/`, imported by URL,
with no bundler and no build step. `typescript` comes from the flake devShell,
not `package.json`: it is a dev tool, not a project dependency. `@types/node`
and `@types/ws` are devDependencies with zero runtime code, needed only to make
the strict type gate meaningful.
