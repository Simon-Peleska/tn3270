# Architecture

A web page that behaves like an IBM 3270 terminal. A Node server runs one
emulator per session inside the server process — node3270 (`3270/`), a port of x3270's
`b3270 -json`, all on one thread; the browser renders onto a canvas of
its own.

```
browser                          node server                        host
┌──────────────────────┐      ┌───────────────────────────┐      ┌──────┐
│ canvas.js ◀── grid.js│◀─────┤  paint.js ◀── ScreenModel │◀─────┤ node │◀─TN3270─▶ mainframe
│  (renderer only)     │ JSON │           (authoritative) │ JSON │ 3270 │
│ keymap.js            │──────▶ Session ──▶ run(actions)  │      └──────┘
└──────────────────────┘  WS  └───────────────────────────┘
                                     │ broadcast
                              ┌──────┴──────┐
                          viewer A      viewer B (observer)
```

## The one hard problem

`b3270 -json` describes the screen **incrementally**: a screen indication says
"row 1 column 3 went red" and means nothing to anyone who doesn't hold the rest
of the screen. So somebody has to hold the whole screen.

**That somebody is the server.** node3270 speaks b3270's indications except for
this one: its screen indication only names the rows that changed,

```json
{
  "screen": {
    "cursor": { "enabled": true, "row": 2, "column": 9 },
    "rows": [1]
  }
}
```

and leaves them drawn in the emulator's render (`ui.saved`), which
`server/screen.js`'s `ScreenModel` reads cell by cell. There is one copy of the
screen, and no change descriptions to build or apply. `server/paint.js` ships the
named rows as a delta, or the whole screen as a repaint.

b3270's own screen indications live on as a test adapter, `3270/test/b3270.js`,
so the conformance tests still compare node3270 with real b3270 line by line;
`3270/test/rows.test.js` checks that the rows named are all that changed.

This single decision is also what makes multiple viewers work. Because the
server already owns the full screen, a browser that joins an hour into a session
is handed a repaint and is instantly correct, and every attached browser gets the
same delta. Had the accumulation lived in the browser, each viewer would need its
own shadow buffer fed from the beginning of time, and joining late would be
impossible.

The cost, accepted deliberately: **there is no local echo.** A keystroke travels
browser → server → node3270 → screen indication → paint → browser. On localhost or
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
  buffer, and our inputs must reach the emulator in the order typed. A
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

`Session` (`server/session.js`) owns a node3270 session, a `ScreenModel`, an
`OiaModel` and a `Set<Viewer>`. **It deliberately outlives every viewer.** A
browser reload, a dropped connection and a second person opening the same URL are
all just `attach` and `detach`; the host connection is never disturbed. A session
with no viewers is reaped after `sessions.idleTimeoutMs`.

- **attach** → assign a role, send `hello`, send `fullPaint()`.
- **screen indication** → mark the named rows dirty, `paintDelta()` → broadcast. Size, cursor and colours are read straight from the emulator; a size change is announced at flush time.
- **input** → only if `viewer.role === 'controller'` → translate to an emulator action → `run()`.
- **detach** → if the controller left, promote another viewer, so the session
  never becomes permanently read-only.

When a socket drops, `public/reconnect.js` backs off exponentially with jitter
and the page opens the socket again. It keeps waiting while the server does not
answer; a session the server no longer has closes the socket with `E3001`, and
the page creates a fresh one. A reconnect that gets as far as a `hello`
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

### Logon

A logon (`Session.logon`) waits for a screen holding `logon.readyText`, types
user, Newline, password, Enter, and waits for `logon.doneText`. While it runs,
`loggingOn` holds every paint back and refuses input, so nobody sees the sign-on
screen or types into it; when it ends, for good or ill, the whole screen is
painted at once. The done-wait starts before the typing, because a run with
Enter only returns once the host unlocks the keyboard, and a host that never
does must still hit the timeout. The typed input is kept out of undo history
and the debug log.

Single sign-on starts it on connect, with the `X-Remote-User` name and a
PassTicket from z/OS DCAS (`server/dcas.js`, IBM's Format 2 over mutual TLS).
Any failure — config, DCAS, timeouts — sends the owner a `logon` message, and
the page opens the logon dialog, which posts to `/api/sessions/<id>/logon` and
runs the same `logon` with what the owner typed. A wrong password is not
recognised as such: the host simply never shows `doneText`, and it ends as
`E3021`.

### The multi-viewer seam

Extra viewers come in only on the owner's yes, as observers, and at most one of
them is let edit beside the owner (SPECIFICATION §3). Two controllers at once
needed no redesign — because **there are no locks anywhere**. Concurrent input cannot corrupt anything: every keystroke from every
viewer funnels into the session's one input queue, which hands the emulator the next
input only once it has finished the last, and the resulting screen comes back to
everyone identically.

## Errors

Per `CLAUDE.md`, every error site carries a stable code, shown in the logs _and_
in the UI, surfaced **in place** — the page is never navigated away from, because
a redirect would throw away the session the user is looking at.

| Block   | Area      |
| ------- | --------- |
| `E1xxx` | config    |
| `E2xxx` | emulator  |
| `E3xxx` | session   |
| `E4xxx` | websocket |
| `E5xxx` | frontend  |
| `E6xxx` | http      |
| `E7xxx` | retired   |
| `E8xxx` | user data |

Codes are an identity, not a label: once assigned to a site, a code never
changes. See `server/errors.js`.

## Logging

Every line goes to stderr and, unless `logFile` is empty, to a file that rolls
over into a single `<logFile>.1` at `logMaxBytes` — two files, a bounded amount
of disk, and no dependency to do it.

A line is `<time> <LEVEL> <scope> <message> <key=value>...`, and the scope is
the subsystem — `http`, `session`, `registry` — never an identity. Who
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
The page cannot fit its first screen until it knows the font, so the server
writes settings, macros and keymap into `index.html` itself and the first
screen waits on no request. Recordings can run to megabytes and only matter
once the user replays one, so the page fetches them from
`GET /api/userdata/recordings` after it has started. `PUT /api/userdata/<key>`
replaces one key.

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
2. A **real** node3270 connects to it, and a **real** `Session` consumes the
   indications. node3270's own suite (`3270/test/`) replays the same traces
   through a real `b3270` and demands identical output.
3. `public/grid.js` has no DOM in it, so `test/roundtrip.test.js` imports _the
   exact decoder the browser runs_ and compares it against the `ScreenModel`
   the paints came from, cell for cell, over real emulator output.
4. `test/server.test.js` spawns the real HTTP server and drives it over real
   WebSockets, including the two-browsers-one-session case.

Waiting is always on a condition, never a duration. Where the emulator's own
timing is involved, `settle()` runs an action and waits for it to finish: a run
resolves only after every indication it caused has been applied.

## Serving the page

There is no bundler and no build step. The frontend is thirty ES modules
served as thirty files — the same files `node --test` imports and the same
ones a browser gets opening `index.html` off disk. What a bundle would have
bought is bought in `index.html` and `sendFile()` (`server/main.js`) instead,
without anything standing between the source and what runs.

- **Every module is preloaded**, by a `modulepreload` list written out in
  `index.html`. Without it a browser discovers the modules one import layer at
  a time, a round trip each; with it they all start at once. The list is in
  the file rather than generated, so the page is what it says it is;
  `test/server.test.js` walks the real import graph and fails if one is
  missing.
- **The page is written per user** (`sendPage()`): at a marker comment in
  `index.html` the server puts a `preload` for the one font this user has
  chosen, their theme's background, so a dark theme never flashes black or
  white, and their settings as JSON. The fit waits on the font, so it goes in
  the first wave; the other eight are fetched only if chosen. The page is
  `no-store`, since it changes whenever a setting does.
- **A session starts at its saved size.** The page measures its screen and
  asks for the model and oversize in `POST /api/sessions`, so the emulator is
  created at that size and never has to drop the host to resize.
- **Fonts are immutable** for a year. They are vendored and never edited, they
  are three quarters of the page's weight, and they are the one thing a
  reconnect should never fetch twice.
- **Everything else is compressed once and revalidated.** A file is read,
  brotli- and gzip-compressed at their highest levels, and kept in memory
  until its size or modification time changes, so a deploy that only touches
  `public/` is still a copy, not a restart. It goes out `no-cache` with an
  ETag: a reload asks about each file and gets a bodyless `304` for what has
  not changed. Open pages keep their old code until their next reload.

## Layout

```
flake.nix  nix/b3270.nix   node, typescript, X11-free b3270 and s3270 as oracles
3270/                       node3270: the emulator, a port of x3270
config.jsonc                settings (hand-parsed JSONC, no dependency)
jsconfig.json               checkJs + strict → the "no any" gate

server/
  main.js       http, static files, /api/sessions, ws upgrade
  config.js     JSONC → validated Config
  errors.js     the stable error-code table
  log.js        structured logging to stderr and a rolling file
  indications.js the emulator's JSON indications, as types
  screen.js     ScreenModel: the authoritative shadow buffer
  paint.js      ScreenModel → paint messages (paintDelta and fullPaint)
  oia.js        OIA field state, as fields
  session.js    Session and Viewer
  registry.js   session creation, lookup, and limits
  protocol.js   wire typedefs and the action allow-list
  userdata.js   settings, keymap, macros, recordings in a shared SQLite file

public/
  index.html    the canvas, the inlined CSS, the preloads, and nothing else
  app.js        the session, clipboard and clicks, routed to a panel when one is open
  grid.js       the cell buffer: applyPaint, put, rectangular text, the field under a cell
  hints.js      Ctrl-B's field hint letters and the prefix that shows them
  paste.js      a paste split into one segment per stretch of editable cells
                (run by the server, and by local-host.js for panels)
  canvas.js     Screen: the one canvas, the two grids on it, and the drawing
  colors.js     3270 colour name → ANSI slot, gr → flags
  oia.js        the status line, composed from the last status and cursor
  keymap.js     KeyboardEvent → 3270 action, and the Keymap the Keys panel edits
  local-host.js a 3270 host in the page: messages in, paint messages out
  paint-runs.js groups equal-style cells for host and panel paints
  panels.js     the panels, a host application on local-host.js
  settings.js   settings behavior; themes.js holds the static palettes
  session-api.js browser calls to create and list sessions
  macros.js  recorder.js   what the panels change
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
