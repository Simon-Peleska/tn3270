# Functional specification

What the thing does, from the outside.

## 1. Scope

A browser-based IBM 3270 terminal. The user opens a page, connects to a TN3270
host, sees the host's screen, and types on it. A second person opening the same
URL sees the same screen live.

Out of scope for this build: file transfer (IND$FILE), printer sessions
(`pr3287`), DBCS / double-width characters, scripting, and login/authentication.

## 2. Session lifecycle

A **session** is one `b3270` process and one host connection.

| Event | Behaviour |
|---|---|
| Page opened with no `#fragment` | A session is created; its id goes into the URL fragment |
| Page opened with `#<session-id>` | That session is joined if it still exists, otherwise a new one is created and `E3001` is shown |
| Browser reloads or the network drops | The session is untouched; the page reconnects with backoff and receives a full repaint |
| Last viewer detaches | The session is kept alive for `sessions.idleTimeoutMs`, then closed |
| `b3270` exits | The session closes and every viewer is told (`E2002`) |

Sharing the URL is the whole sharing mechanism. There is no separate invite step.

## 3. Roles

| Role | May do |
|---|---|
| **controller** | Type, press function keys, connect, disconnect |
| **observer** | Watch |

The first viewer to attach is the controller; the rest observe. If the controller
leaves, another viewer is promoted immediately, so a session never becomes
permanently read-only.

Setting `sessions.allowMultipleControllers` to `true` makes every viewer a
controller. This is safe — all input is serialised through b3270's single stdin —
but two people typing into one screen is inherently chaotic, so it is off by
default.

An observer that tries to type gets error `E4003` in the page; nothing is sent to
the host.

## 4. The screen

- Geometry follows the model: 2 = 24×80, 3 = 32×80, 4 = 43×80, 5 = 27×132.
  `b3270.model` sets the starting model; the settings page changes it afterwards.
  The list it offers is the one b3270 itself reports at startup, not a second
  copy of the table above.
- **Fit to window** asks for a bigger screen than the model has: the browser
  measures how many cells its window would hold at a chosen text size and asks
  for exactly that many columns and rows, which b3270 takes as an *oversize* and
  negotiates as IBM-DYNAMIC. Turning it off puts the model's own size back. The
  screen is never smaller than the model — b3270 refuses that — and never more
  than the 16383 cells b3270 has a buffer for (`E4006`); a model change that the
  standing size no longer fits turns the oversize off rather than failing.
- The **text size** the fit is measured at is a row of its own, shown only while
  the fit is on, 8–32 px and saved in the browser. Bigger text means fewer cells.
  It is what the screen is measured *with*, not the font size on screen: that one
  goes on floating so the grid fills the window however it is resized afterwards.
- The size is negotiated with the host once, when the connection is opened, so
  changing either the model or the fit **drops the connection and reopens the
  same host**. The settings page says so before it does it. Observers cannot
  change the size (`E4003`).
- A size change resizes the grid for **every** viewer, not just the one who
  asked.
- The grid is drawn as large as the page allows without being cut off. Rows and
  columns belong to the session and cannot be traded away, so the font size is
  what scales — on a window resize, on a size change, and when the error bar
  appears or is dismissed.
- Below the screen is one extra row, the **OIA** (Operator Information Area):

  ```
  mainframe:23              X SYSTEM                          Insert   02/009
  └ connection or host      └ keyboard lock          insert/typeahead ┘  └ cursor row/col
  ```

  The lock indicator is the only way a user can tell why the keyboard is dead, so
  it is rendered faithfully: `X Not Connected`, `X SYSTEM`, `X Wait`,
  `X Protected`, `X Numeric`, `X Operator Error`, and so on. An unrecognised lock
  value is shown verbatim as `X <value>` rather than swallowed.
- Colours are the sixteen 3270 host colours, rendered as truecolor from x3270's
  own palette. If the host reports no colour (a 3278), the screen is rendered
  monochrome green rather than being given invented colours.
- Graphic rendition maps `highlight`, `underline`, `blink` and `reverse` onto the
  corresponding SGR attributes.

## 5. Keyboard

Printable characters are sent as text. Everything else:

| Key | 3270 action |
|---|---|
| Enter | Enter |
| Tab / Shift-Tab | Tab / BackTab |
| Backspace, Delete | Backspace, Delete |
| Arrows, Home, End | Up, Down, Left, Right, Home, End |
| Insert | ToggleInsert |
| Ctrl-V, Shift-Insert | paste the clipboard into the screen |
| Esc | Attn |
| F1–F12 | PF1–PF12 |
| Shift-F1–F12 | PF13–PF24 |
| Ctrl-1 / Ctrl-2 / Ctrl-3 | PA1 / PA2 / PA3 |
| Ctrl-R | Reset |
| Ctrl-A | Attn |
| Ctrl-C | copy the selection, or the field under the cursor |
| Ctrl-E | EraseEOF |
| Ctrl-U | EraseInput |
| Ctrl-D | Dup |
| Ctrl-F | FieldMark |
| Ctrl-S | SysReq |

Alt and Meta combinations are left to the browser. There is no local echo: what
appears on screen is what the host put there.

A paste is typed into the screen with b3270's `PasteString`, not `String`: a
newline moves to the next line of input instead of sending Enter, and a
backslash is a backslash rather than the start of an escape. Ctrl-V arrives as a
browser paste event carrying the text; Shift-Insert does not, so it reads the
clipboard itself, which the browser asks the user's permission for. A paste of
more than 16384 characters is refused with `E4005` — b3270 types it one
character at a time, so a stray copy of a log file would block the session.

### Action allow-list

Only the actions in the table above may cross the wire. `b3270` accepts many
more, including actions that read files and run programs, so
`server/protocol.js` holds a strict allow-list rather than a pass-through. An
action outside it is refused with `E4002` and never reaches the emulator.

## 6. Wire protocol

One WebSocket at `/ws/<session-id>`.

**Server → browser.** Binary frames are VT bytes, written straight to the
terminal. Text frames are JSON:

```jsonc
{"type":"hello","sessionId":"…","rows":43,"cols":80,"model":4,"oversize":"","models":[{"model":2,"rows":24,"columns":80}],"role":"controller","viewers":1}
{"type":"screen","model":2,"rows":24,"cols":80,"oversize":""}
{"type":"status","connection":"connected-tn3270e","host":"mainframe:23","locked":false,"role":"controller","viewers":2}
{"type":"error","code":"E4003","message":"This session is being controlled by someone else."}
```

`screen` is sent whenever the grid changes size, always immediately before the
repaint that assumes the new size. `oversize` is the fitted screen in force,
`<cols>x<rows>`, or empty when the model is at its own size. One ordered
WebSocket keeps them in that order, which is what stops a viewer writing
new-sized bytes into an old-sized terminal.

**Browser → server.** Text frames only:

```jsonc
{"type":"text","value":"abc"}
{"type":"paste","text":"one\ntwo"}
{"type":"action","action":"PF","args":["3"]}
{"type":"connect","host":"mainframe:23"}
{"type":"disconnect"}
{"type":"model","model":4}
{"type":"oversize","value":"158x60"}
```

### HTTP

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/sessions` | Creates a session → `201 {id, rows, cols, model}`, after b3270 has reported its real geometry |
| `GET` | `/api/sessions` | Lists sessions → `{sessions:[{id, viewers, connection, host}], defaultHost}` |
| `GET` | `/vendor/…` | ghostty-web, served from `node_modules` |
| `GET` | anything else | Static files from `public/` |

Errors are JSON: `{"code":"E6001","message":"…"}` with a matching status.

## 7. Configuration

`config.jsonc`, overridable with the `TN3270_CONFIG` environment variable. JSONC:
`//` and `/* */` comments and trailing commas are accepted.

| Setting | Default | Meaning |
|---|---|---|
| `server.host` | `127.0.0.1` | Listen address |
| `server.port` | `8017` | Listen port |
| `b3270.path` | `b3270` | Executable, resolved from `PATH` |
| `b3270.model` | `2` | 3270 model a session starts on, 2–5; changeable from the settings page |
| `b3270.defaultHost` | `null` | Connect new sessions here; `null` starts disconnected |
| `b3270.extraArgs` | `[]` | Appended verbatim, e.g. `["-cafile","/path/ca.pem"]` |
| `sessions.maxSessions` | `16` | Refuses more with `E3002` |
| `sessions.maxViewersPerSession` | `8` | Refuses more with `E3003` |
| `sessions.idleTimeoutMs` | `300000` | Viewer-less session lifetime; `0` disables reaping |
| `sessions.allowMultipleControllers` | `false` | Let every viewer type |
| `security.allowedHosts` | `[]` | Empty = any host. An entry with a port matches exactly; without one, any port on that host |
| `logLevel` | `info` | `debug` logs every line exchanged with b3270 |

## 8. Error codes

Every code is fixed for the lifetime of the project and appears both in the log
and in the page.

| Code | Meaning |
|---|---|
| `E1001` | Config file could not be read |
| `E1002` | Config file is not valid JSONC |
| `E1003` | Config value has the wrong type |
| `E1004` | Config value is out of range |
| `E2001` | b3270 could not be spawned |
| `E2002` | b3270 exited unexpectedly |
| `E2003` | b3270 emitted a line that is not valid JSON |
| `E2004` | b3270 reported a protocol error |
| `E2005` | b3270 action failed |
| `E2006` | b3270 stdin is closed |
| `E3001` | Session not found |
| `E3002` | Session limit reached |
| `E3003` | Session has too many viewers |
| `E3004` | Screen indication referenced a cell outside the screen |
| `E3005` | Host address is not allowed by config |
| `E3006` | *Retired* — the screen model can now be changed under a connection |
| `E4001` | WebSocket message was not valid JSON |
| `E4002` | WebSocket message had an unknown type |
| `E4003` | Input rejected: viewer is an observer |
| `E4004` | WebSocket closed unexpectedly |
| `E4005` | Pasted text is too large to type into a screen |
| `E4006` | Oversize screen has more cells than b3270 can hold |
| `E5001` | Terminal renderer failed to initialise |
| `E5002` | WebSocket connection to the server failed |
| `E5003` | Settings could not be read from the browser database |
| `E5004` | Settings could not be saved to the browser database |
| `E5005` | Clipboard could not be read for a Shift+Insert paste |
| `E6001` | Static file not found |
| `E6002` | HTTP request failed |
| `E6003` | WebSocket upgrade path is not a session |
| `E6004` | Server could not start |
| `E0000` | An error with no code of its own; see the log |

Errors are shown as a dismissible bar at the top of the page. The page is never
navigated away from.

## 9. Running it

```bash
nix develop            # node, typescript, and an X11-free b3270
npm install
npm test               # 106 tests: unit, integration, and the WASM round-trip
npm run typecheck      # tsc --strict over JSDoc; the "no any" gate
npm start              # http://127.0.0.1:8017
```

Without a mainframe, replay a recorded host:

```bash
node test/fakehost.js test/traces/reverse.trc 4001
```

then connect the page to `127.0.0.1:4001`.
