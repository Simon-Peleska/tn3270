# Architecture

A web page that behaves like an IBM 3270 terminal. A Node server runs one
emulator per session in its own process — node3270 (`3270/`), a port of x3270's
`b3270 -json` on a pool of worker threads; the browser renders onto a canvas of
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

node3270 speaks `b3270 -json`'s **structured, incremental screen model**, the
same JSON indications byte for byte, such as

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

`Session` (`server/session.js`) owns a node3270 session, a `ScreenModel`, an
`OiaModel` and a `Set<Viewer>`. **It deliberately outlives every viewer.** A
browser reload, a dropped connection and a second person opening the same URL are
all just `attach` and `detach`; the host connection is never disturbed. A session
with no viewers is reaped after `sessions.idleTimeoutMs`.

- **attach** → assign a role, send `hello`, send `fullPaint()`.
- **screen indication** → apply to the model, mark rows dirty, `paintDelta()` → broadcast.
- **input** → only if `viewer.role === 'controller'` → translate to an emulator action → `run()`.
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
resolves only after its `run-result` and every indication before it have been
applied.

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
  server never sees. The list is in the file rather than generated, so the page
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

The frontend is plain ESM served straight out of `public/`, imported by URL,
with no bundler and no build step. `typescript` comes from the flake devShell,
not `package.json`: it is a dev tool, not a project dependency. `@types/node`
and `@types/ws` are devDependencies with zero runtime code, needed only to make
the strict type gate meaningful.
