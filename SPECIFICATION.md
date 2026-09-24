# Functional specification

What the thing does, from the outside.

## 1. Scope

A browser-based IBM 3270 terminal. The user opens a page, connects to a TN3270
host, sees the host's screen, and types on it. A second person opening the same
URL sees the same screen live.

Out of scope for this build: file transfer (IND$FILE), printer sessions
(`pr3287`), DBCS / double-width characters, scripting, and login/authentication.

## 2. Session lifecycle

A **session** is one `b3270` process and one host connection. b3270 _is_ one
terminal — one screen, one host connection, one keyboard — and its JSON protocol
has no notion of a second one, so a second session is a second process. Nothing
can be multiplexed onto a single b3270.

One page holds up to **4** sessions at once and shows one, two, three or four of
them side by side (§5, `Ctrl-B`). Every session it holds keeps its WebSocket open
even while it is off screen: the bytes of a background session are thrown away —
the server holds the screen and repaints it on demand — but its viewer has to
stay attached, or the idle timeout below would reap it.

A session on screen sits in a **pane**. Panes tile the page edge to edge — no
gaps, no frames, nothing between two screens but the theme's own background — and
the keyboard is aimed at exactly one of them. Clicking a pane aims the keyboard
at it; `Ctrl-B` and a digit does the same from the keyboard.

| Event                                        | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page opened with no `#fragment`              | A session is created; its id goes into the URL fragment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Page opened with `#<ids>`                    | The fragment is a comma-separated list, one slot per digit (`a,,c` is session 1 and 3). Each id is joined if it still exists; ids that are gone are reported once with `E3001`, and a session is created only if none survived                                                                                                                                                                                                                                                                                                                                                               |
| A digit with no session behind it is pressed | A session is created for that slot and appended to the fragment (`E5006` if the server refuses)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Browser reloads or the network drops         | The session is untouched. The page retries with exponential backoff and jitter for as long as the server would hold the session — `sessions.idleTimeoutMs`, which the `hello` told it — asking `/api/sessions` before each attempt: a server that does not answer is waited for, one that answers but no longer lists the session ends the waiting at once and the slot takes a new session (`E5014` if that fails). The reconnected page reloads itself, so a server that came back with newer page code is picked up; the fragment still names the same sessions, so it reattaches to them |
| Last viewer detaches                         | The session is kept alive for `sessions.idleTimeoutMs`, then closed. A viewer attaching inside that window cancels the reaping                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `b3270` exits                                | The session closes and every viewer is told (`E2002`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Sharing the URL is how a session is shared: there is no invite step, and sharing
a page that holds four sessions shares all four. But nobody gets in on the URL
alone — the owner is asked first (§3).

## 3. Roles

| Role           | May do                                         |
| -------------- | ---------------------------------------------- |
| **controller** | Type, press function keys, connect, disconnect |
| **observer**   | Watch                                          |

Whoever opens a session with nobody in it is its **owner**, and a controller.
Anyone else who opens the URL sees nothing but _Waiting for the session's owner
to let you in_ on the status row, while the owner's status row says
_alice wants to watch_ with **[Yes]** and **[No]**. The name is the user a
trusted proxy vouched for (`X-Remote-User`), else the address. Yes lets them in
as an observer; no sends them away with `E3008`, and their page does not try
again on its own. Several requests queue, one on the row at a time.

An observer has an **[Edit]** button, which asks the owner the same way
(_alice wants to edit_). Yes makes them a controller; no tells them `E3011`.
Only one guest edits at a time: letting a second one edit takes it from the
first, who is told `E3012`.

While guests are in, the owner has **[Stop sharing]**, which sends every guest
away (`E3009`) and forgets that they were let in, and while one edits,
**[Stop editing]**, which takes editing back (`E3012`) and leaves them
watching. A guest trying either, or answering a request, gets `E3010`.

The `hello` hands every viewer a pass, which the page keeps per tab (in
`sessionStorage`, never in the URL) and sends back when it reconnects. A reload
of the owner's page is the owner again; a reload of a guest's is let back in
without asking, as an observer. When the owner leaves, the guests stay as they
were and nobody is promoted: a newcomer waits until the owner comes back. A
session nobody is in is owned by the next one to open it.

An observer that tries to type gets error `E3006` in the page; nothing is sent to
the host.

## 4. The screen

- Geometry follows the model: 2 = 24×80, 3 = 32×80, 4 = 43×80, 5 = 27×132.
  `b3270.model` sets the starting model; the settings panel changes it afterwards.
  The list it offers is the one b3270 itself reports at startup, not a second
  copy of the table above. After model 5 the list offers **Dynamic - 62x160**:
  the model underneath it with a 160×62 oversize on top, which is the biggest
  screen an IBM host will bind. It sits with the models because it behaves like
  one — a size asked for by name, with no window measured for it — and it is
  what `b3270.oversize` starts every session at.
- **Fit to window** is the last choice in the same list, after the dynamic
  screen. The browser measures how many cells the session's pane would hold at a
  chosen text size and asks for exactly that many columns and rows, which b3270
  takes as an _oversize_ on top of the model last chosen and negotiates as
  IBM-DYNAMIC. Choosing a model puts the model's own size back. The screen is never smaller than the model — b3270 refuses that and quietly
  hands back the model's own screen — and never more than the 16383 cells b3270
  has a buffer for (`E4004`); a model change that the standing size no longer fits
  turns the oversize off rather than failing.
- A pane too narrow for the model's 80 columns asks for them anyway, drawn in
  text small enough to hold them, and asks for the extra rows that smaller text
  makes room for. Otherwise the screen would stop short of the bottom of the pane.
- The cell is measured at the text size being asked about rather than scaled from
  the one on screen, so two panes of the same size always ask for the same screen,
  and asking twice gives the same answer twice. A split is a grid of screens that
  line up, and fitting a pane that already fits changes nothing.
- The **text size** the fit is measured at is a row of its own, shown only while
  the fit is on, 8–32 px and saved in the browser. Bigger text means fewer cells.
  It is what the screen is measured _with_, not the font size on screen: that one
  goes on floating so the grid fills the window however it is resized afterwards.
- The size is negotiated with the host once, when the connection is opened, so
  changing either the model or the fit **drops the connection and reopens the
  same host**. The settings panel says so before it does it. Observers cannot
  change the size (`E3006`).
- A pane that changes size — a split, or the window being dragged — refits the
  sessions that have nothing to lose by it: one with no host on it, and one
  **nobody has typed at yet**. A session the operator has used keeps its screen
  and shrinks its text instead, because dropping a live connection to make a
  pane tidier is not a trade the page may make on its own. Typing counts from
  any viewer, and a session never becomes untouched again. A window drag waits
  until the window stops moving; a split refits at once. This only happens while
  the screen is one measured from the window: a model's own size and the dynamic
  screen were asked for by name and are left alone.
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

- The right of the OIA row holds `[Kbd] [Menu]`, painted by the browser
  over columns the server never writes into. Every pane carries its own, so a
  split is not a screen you have to switch away from to work on. **Menu** opens
  the primary option menu (§4.1), which is the way to every other panel.
  **Kbd** shows or hides the on-screen keyboard: four rows of host keys a PC
  keyboard lacks or hides — Enter, Clear, Reset, PA1–PA3, Attn, SysReq;
  Erase EOF, Erase input, Insert, Dup, Field mark, Home, BackTab, Tab;
  PF1–PF12; PF13–PF24 — in the screen's own colours, every key a bold
  `[label]` like the status row's buttons. The keys sit on a grid of twelve
  six-column cells, 72 columns centred in the pane, a key taking two cells when
  its label needs them, so PF13 is under PF1. It covers
  the bottom four rows of the screen, and the top four while the cursor is
  under it, so the field being typed in stays in view. A click anywhere in a
  key's cells sends it as if it had been pressed (a macro being
  recorded takes it too); a click on the keyboard is never a cursor move. It is drawn
  on the session being looked at only, not under a panel, and is not
  remembered across a reload.
- Colours are the sixteen 3270 host colours, rendered as truecolor from x3270's
  own palette. If the host reports no colour (a 3278), the screen is rendered
  monochrome green rather than being given invented colours.
- Graphic rendition maps `highlight`, `underline`, `blink` and `reverse` onto the
  corresponding SGR attributes.

### 4.1 Panels

Everything the browser itself offers — settings, macros, the recorder, the key
bindings — is a **panel**, drawn into the terminal in the shape TSO/ISPF puts on
a 3270, so that someone who knows ISPF already knows this. One panel is open at
a time, over the session it belongs to, and leaving it repaints the screen
underneath.

```
                           TN3270 Primary Option Menu    No panel is numbered 7
 Option ===> ________________________________________________________


    0  Settings     Colours, font and screen size
    1  Macros       Record, play back and trade keystroke macros
    2  Recorder     Capture screens and keys as a script
    3  Keys         What each key and key combination does
    H  Help         The keys and commands panels answer to
    X  Exit         Back to the session

    Type an option above, or =0 to =3 from any panel to jump straight to it.

 F1=Help  F3=Exit  F12=Cancel
```

- The **title** has row 1 to itself: there is no action bar, and no chrome of any
  kind above the panel.
- The menu's options are **point-and-shoot** fields, as ISPF's are: nothing is
  highlighted, and the cursor itself rests on the option number it would run.
  Everywhere else the line the cursor is on is lit, because those lines are
  values you are about to change.
- The **command line** is `Option ===>` on the menu and `Command ===>` on the
  rest. `More: - +` sits at its right end when the body scrolls that way.
- A short **message** — a refused command, a bad option — appears against the
  title in place, and clears on the next keystroke. A panel never navigates the
  page away to say something.
- Body lines that can be picked carry a number in the left margin. A form panel
  — settings, keys — runs an ISPF dot leader from the label out to the value:
  `Screen model . . . . . Model 4 - 43x80`.
- Settings ends in a **preview**: a few lines styled the way a host styles its
  screen — a title, an input field, the seven 3270 colours, intensified,
  underlined and reverse text, and the characters fonts disagree on (`0O 1lI`).
  It is drawn with the host's colour names, so it shows at once what a theme or
  font change does to a real screen, not just to the panel around it.
- A panel opened from another one is stacked on it, so F3 comes back one level
  at a time and lands on the session at the bottom. F4 goes straight to the
  menu; an `Alt` shortcut starts again from the session.

**Option numbers** are fixed, and `=n` jumps to one from wherever you are:

| Option | Panel                               |
| ------ | ----------------------------------- |
| `0`    | Settings                            |
| `1`    | Macros                              |
| `2`    | Recorder                            |
| `3`    | Keys                                |
| `H`    | Help                                |
| `X`    | Exit the panel, back to the session |

**Keys**, all of them ISPF's. A panel has no keyboard of its own: it answers to
the 3270 commands of §5, so a key means the same thing in a panel as it does on
the screen behind it, and rebinding one rebinds it in both places. The keys
named here are the commands' defaults.

| Command          | Key          | What it does                                                                   |
| ---------------- | ------------ | ------------------------------------------------------------------------------ |
| `Enter`          | Right Ctrl   | Runs the command line, or picks the line the cursor is on when it is empty     |
| `PF1`            | F1           | Help                                                                           |
| `PF3`, `Attn`    | F3, Esc      | Exit: back where the panel was opened from                                     |
| `PF4`            | F4           | Menu: the primary option menu                                                  |
| `PF7` / `PF8`    | F7 / F8      | Backward and forward a bodyful at a time                                       |
| `PF12`           | F12          | Cancel: leave without applying what was typed                                  |
| `Newline`, `Tab` | Enter, Tab   | The cursor between the command line and the body lines, stepping over headings |
| `Up` / `Down`    | Up / Down    | The same, a line at a time                                                     |
| `Left` / `Right` | Left / Right | Change the value the cursor is on                                              |

**Command line words**: `=n` to jump, a bare number to pick a line on this
panel, `END`/`EXIT`/`X`, `CANCEL`/`CAN`, `RETURN`/`RET`/`MENU`, `HELP`/`?`, the
name of any panel, and the words a panel adds of its own —
`APPLY`, `RENAME`, `DELETE`, `EXPORT`, `IMPORT`, `MARK`, `RECORD`, `STOP`,
`KEY`, `UNKEY`, `RESET`, `DEFAULTS`. A word that is none of these is answered on the panel.

Settings and keys are saved in the browser as what differs from the defaults,
so a default changed in a later version reaches everything the user left
alone. `RESET` puts them back: on Settings, `RESET` restores every setting and
`RESET THEME` (any word of a setting's name) just that one. A reset screen size
takes effect with the next session, not by reconnecting this one. On Keys,
`RESET` in the list restores the whole keymap, and inside a command just that
command; `RESET n` or `RESET PF3` restores one command from the list, and
`RESET ALL` restores everything from anywhere. A command put back takes its
default keys back from whatever they were bound to since.

Picking a key, on the Keys panel or for a macro, takes the whole combination:
a modifier going down is only on the way to the key, so `Ctrl+Enter` can be
pressed as it is typed, and a modifier counts on its own only when it is let go
with nothing pressed in between, which is how right Ctrl alone is bound. F12 or
Esc cancels. While a key is being picked every key goes to the panel, the
session prefix and the panel shortcuts included. AltGr is not a modifier here
or on the screen: Windows reports it as Ctrl+Alt, but a `\` or `{` typed with
it is the character, on a German keyboard as on any other.

A macro can have a key of its own: `KEY` on the Macros panel, with the cursor
on the macro, waits for a key picked that way and binds it.
`UNKEY` removes it. The list shows each macro's key after its step count. The
key is kept in the keymap, as a command named `Macro <name>` that the Keys
panel lists after the fixed ones, so it follows the keymap's one rule: a key
bound to a macro is taken from whatever had it, macro or command, and the Keys
panel can add, remove and reset it like any other. Renaming a macro keeps its
key; deleting it frees the key. On the screen that key plays the macro, and does
nothing while a macro is already playing or a panel is open. `RESET` on the
Keys panel takes every macro's key away with the rest. Macro keys are saved in
this browser but are not part of an exported keymap file, nor of an exported
macro file, which is Host On-Demand's format.

Opening a panel is a command like any other, so it is in the keymap of §5 and
can be rebound there: `Menu`, `Settings`, `Macros`, `Recorder` and `Keys`,
bound by default to `Alt+Space`, `Alt+,`, `Alt+M`, `Alt+R` and `Alt+K`. The
same combination pressed again closes the panel, and it opens its panel from
within another one. Ctrl and Meta are left to the browser while a panel is open, so
**Ctrl-C and Ctrl-V work in a panel as they do on the screen**: a copy with
nothing selected takes the command line or the field the cursor is on, and a
paste puts the clipboard's first line into whichever of the two the cursor is
on. A click lands the cursor where it was aimed, on the command line or on a
body line.

## 5. Keyboard

Printable characters are sent as text. Everything else follows IBM Personal
Communications' (PCOMM) default 3270 keyboard, not x3270's Ctrl-letter
mnemonics:

| Key                   | 3270 action                                        |
| --------------------- | -------------------------------------------------- |
| Enter (main)          | Newline                                            |
| Shift-Enter (main)    | BackNewline                                        |
| Right Ctrl            | Enter                                              |
| Ctrl-Enter, Fn-Enter  | Enter (Fn-Enter arrives as the keypad Enter)       |
| Tab / Shift-Tab       | Tab / BackTab                                      |
| Backspace, Delete     | Backspace, Delete                                  |
| Arrows, Home          | Up, Down, Left, Right, Home                        |
| Insert                | ToggleInsert                                       |
| Alt-Insert            | PA1                                                |
| Shift-Arrows          | select a rectangle from the cursor, as a drag does |
| Ctrl-C                | copy the selection, or the field under the cursor  |
| Ctrl-V, Shift-Insert  | paste the clipboard into the screen                |
| Shift-Home            | FieldMark                                          |
| Alt-Home              | PA2                                                |
| End                   | EraseEOF                                           |
| Alt-End               | EraseInput                                         |
| Shift-PageUp          | PA3                                                |
| Esc                   | Attn                                               |
| Shift-Esc             | SysReq                                             |
| Pause                 | Clear                                              |
| Caps Lock             | Reset                                              |
| F1–F12                | PF1–PF12                                           |
| Shift-F1–F12          | PF13–PF24                                          |
| Ctrl-B then 1–4       | aim the keyboard at that session                   |
| Ctrl-B then Shift-1–4 | show that many sessions at once                    |

`BackNewline` is Newline's mirror and the one name in the table b3270 has no
action for: the server finds the first typeable cell of the nearest row above
the cursor's — wrapping off the top of the screen to the bottom, as Newline
wraps off the bottom — from the field map it already keeps, and sends a cursor
move. A screen with no fields on it falls back to the start of the row above.

Keys pressed while the host has the keyboard (`X SYSTEM`, `X Wait`) are not
lost: the server queues them and runs them in the order they were pressed once
the host answers, each only after the one before it is done. Reset, Attn and
SysReq skip the queue, since they are how a user gets out of a wait, and Reset
throws away whatever was typed ahead, as it does on a 3270.

A PF or PA key held down pages on as fast as the host answers: a repeat that
comes while the last one is still out is dropped rather than queued, so letting
go stops the paging at once. Enter, Clear, Attn and SysReq do not repeat.

Plain Ctrl and Meta combinations are left to the browser, except Ctrl-B (the
session prefix, below) and Ctrl-C/Ctrl-V, which copy and paste the system
clipboard rather than reaching the host as 3270 actions. Alt is otherwise left
to the browser too, except the PA-key and Dup/FieldMark/EraseInput bindings
above, the session digits below, and whatever the panel commands of §4.1 are
bound to — by default `Alt+Space`, `Alt+,`, `Alt+M`, `Alt+R` and `Alt+K`, which
open a panel over the session and, pressed again, close it. While a panel is open the keys in this
table are its own (§4.1) and nothing reaches the host. There is no local echo:
what appears on screen is what the host put there.

`Ctrl-B` is a prefix in the tmux sense, and it is the browser's alone — neither
it nor the key after it ever reaches the host. While it is armed the status row
shows which digits hold a session and which are free; a digit for a free slot
opens a new session there, and anything that is not 1–4 cancels and puts the
status row back. Ctrl may be held down through the digit or let go; either works.
The digit is read from the key itself, not from what it prints, so Shift-2 is the
2 key on every keyboard layout.

**Shift** turns the same digit into the layout — how many sessions are on screen
rather than which one is typed at:

|           | Panes                                                            |
| --------- | ---------------------------------------------------------------- |
| `Shift-1` | one session filling the page: the one the keyboard is already on |
| `Shift-2` | sessions 1 and 2, side by side                                   |
| `Shift-3` | session 1 down the left half, 2 above 3 on the right             |
| `Shift-4` | quarters: 1 above 2 on the left, 3 above 4 on the right          |

A layout that names a session nobody has opened yet opens it. A session that was
off screen takes the pane the keyboard was on.

Splitting the page does **not** resize a session that has a host on it: the screen
size is negotiated when the connection is opened (§4), so resizing would drop and
reopen it. A connected pane keeps its screen and shrinks the text instead. A
session between hosts is refitted to its new pane, and the settings panel — which
measures the pane, not the window — refits a connected one on purpose.

A paste is typed into the screen with b3270's `PasteString`, not `String`: a
newline moves to the next line of input instead of sending Enter, and a
backslash is a backslash rather than the start of an escape. Ctrl-V arrives as a
browser paste event carrying the text; Shift-Insert does not, so it reads the
clipboard itself, which the browser asks the user's permission for. A paste of
more than 16384 characters is refused with `E4003` — b3270 types it one
character at a time, so a stray copy of a log file would block the session.

The page splits a paste into `segments` itself, against the screen it shows: one
stretch of editable cells each, since `PasteString` drops a character that lands
on a protected one. The server only moves the cursor to each and types it;
`text` is kept for the recorder. The field hints behind `Ctrl-B` and the field
`Ctrl-C` copies are worked out in the page too, from the cells the paints carry.
A password field is never painted with what was typed into it, so `Ctrl-C` there
copies nothing.

### Action allow-list

Only the actions in the table above may cross the wire. `b3270` accepts many
more, including actions that read files and run programs, so
`server/protocol.js` holds a strict allow-list rather than a pass-through. An
action outside it is refused with `E4002` and never reaches the emulator.

## 6. Wire protocol

One WebSocket at `/ws/<session-id>`.

**Server → browser.** Text frames only, each an object with a `type`:

```jsonc
{"type":"hello","sessionId":"…","rows":43,"cols":80,"model":4,"oversize":"","models":[{"model":2,"rows":24,"columns":80}],"role":"controller","owner":true,"pass":"…","viewers":1,"idleTimeoutMs":300000}
{"type":"screen","model":2,"rows":24,"cols":80,"oversize":""}
{"type":"paint","full":false,"color":true,"rows":[{"row":1,"runs":[{"col":3,"text":"____","fg":"red","gr":"underline","editable":true}]}],"cursor":{"row":1,"col":8,"on":true}}
{"type":"status","connection":"connected-tn3270e","host":"mainframe:23","lock":"system","insert":false,"typeahead":false,"role":"controller","viewers":2,"owner":true,"guests":1,"editor":null,"requests":[{"viewer":"ab12cd34","name":"alice","kind":"watch"}],"editRequested":false}
{"type":"waiting"}
{"type":"refused","code":"E3008","message":"bob did not let you in."}
{"type":"error","code":"E3006","message":"This session is being controlled by someone else."}
```

`paint` carries only the rows that changed, unless `full`, which also clears
every cell it does not mention and carries `defaultFg`/`defaultBg`. Colours are
b3270's own names and `gr` its own rendition string, passed through untouched:
what they look like is the browser's business, so a theme change costs no round
trip. `color: false` is a 3278 reporting no colour at all — monochrome green,
and no colour is invented.

`status` carries the operator information area as fields rather than as a
rendered line, because the buttons sharing that row are the browser's own and
only the browser knows where they sit.

`screen` is sent whenever the grid changes size, always immediately before the
repaint that assumes the new size. `oversize` is the fitted screen in force,
`<cols>x<rows>`, or empty when the model is at its own size. One ordered
WebSocket keeps them in that order, which is what stops a viewer applying a
paint to a grid of the wrong size.

`hello` carries `idleTimeoutMs`, the server's own hold time for a viewer-less
session (`0` when reaping is off), so a page whose socket drops knows how long
reconnecting to it is worth trying.

**Browser → server.** Text frames only:

```jsonc
{"type":"text","value":"abc"}
{"type":"paste","text":"one\ntwo","segments":[{"row":3,"col":10,"text":"one"},{"row":4,"col":10,"text":"two"}]}
{"type":"action","action":"PF","args":["3"]}
{"type":"connect","host":"mainframe:23"}
{"type":"disconnect"}
{"type":"model","model":4}
{"type":"oversize","value":"158x60"}
{"type":"askEdit"}
{"type":"answer","viewer":"ab12cd34","allow":true}
{"type":"stopSharing"}
{"type":"stopEditing"}
```

`/ws/<session-id>?pass=…` brings back the pass from an earlier `hello`.

### HTTP

| Method | Path                        | Result                                                                                        |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------- |
| `POST` | `/api/sessions`             | Creates a session → `201 {id, rows, cols, model}`, after b3270 has reported its real geometry |
| `GET`  | `/api/sessions`             | Lists sessions → `{sessions:[{id, viewers, connection, host}], defaultHost}`                  |
| `GET`  | `/api/sessions/<id>/3270/…` | Forwarded to that session's emulator; see REST below                                          |
| `GET`  | anything else               | Static files from `public/`                                                                   |

Errors are JSON: `{"code":"E6001","message":"…"}` with a matching status.

### REST

Every session's b3270 serves s3270's own `-httpd` interface on a loopback port
of its own, and everything under `/3270/` is forwarded there unchanged and
answered verbatim — status, content type and body:

```bash
curl "http://127.0.0.1:8017/api/sessions/$ID/3270/rest/json/Query(CodePage)"
curl "http://127.0.0.1:8017/api/sessions/$ID/3270/rest/text/String(hello)"
curl "http://127.0.0.1:8017/api/sessions/$ID/3270/rest/stext/Ascii1(1,1,80)"
```

So the protocol is s3270's, documented at
<https://x3270.miraheze.org/wiki/HTTP_server>: `json`, `text` and `stext`
flavours, the `{result, result-err, status}` envelope, s3270's action syntax and
s3270's own error wording. An existing s3270 REST client changes its base URL
and nothing else.

The emulator's port is bound to loopback and guarded by a per-session
`x3270-security` cookie the proxy supplies, so it can only be reached through
this server. REST calls ignore the controller/observer rule of section 3: an
automation client acts whoever else is watching, and watchers see the result.

Every session takes REST calls from the moment it exists; there is no switch
over it. That is what a deployment for **automation with no browser on it**
needs — a session created over `POST /api/sessions` and driven only over REST
has no controller who could turn one on — but it does mean whoever can reach
this server can drive any session it is holding, including one someone is
sitting at. Reaching the server is therefore the boundary, and a deployment that
needs a narrower one puts authentication in front of it (section 8).

## 7. Configuration

`config.jsonc`, overridable with the `TN3270_CONFIG` environment variable. JSONC:
`//` and `/* */` comments and trailing commas are accepted.

| Setting                         | Default              | Meaning                                                                                                                                                                               |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.host`                   | `127.0.0.1`          | Listen address                                                                                                                                                                        |
| `server.port`                   | `8017`               | Listen port                                                                                                                                                                           |
| `b3270.path`                    | `b3270`              | Executable, resolved from `PATH`                                                                                                                                                      |
| `b3270.model`                   | `2`                  | 3270 model a session starts on, 2–5; changeable from the settings panel                                                                                                               |
| `b3270.defaultHost`             | `null`               | Connect new sessions here; `null` starts disconnected                                                                                                                                 |
| `b3270.extraArgs`               | `[]`                 | Appended verbatim, e.g. `["-cafile","/path/ca.pem"]`                                                                                                                                  |
| `b3270.settings`                | `{"nopSeconds": 60}` | b3270 resources, each passed as `-xrm`. `nopSeconds` sends a TELNET NOP after that many quiet seconds, so a firewall or NAT never drops the host connection as idle; `0` turns it off |
| `sessions.maxSessions`          | `16`                 | Refuses more with `E3002`                                                                                                                                                             |
| `sessions.maxViewersPerSession` | `8`                  | Refuses more with `E3003`                                                                                                                                                             |
| `sessions.idleTimeoutMs`        | `300000`             | Viewer-less session lifetime; `0` disables reaping                                                                                                                                    |
| `security.allowedHosts`         | `[]`                 | Empty = any host. An entry with a port matches exactly; without one, any port on that host                                                                                            |
| `security.trustProxyHeaders`    | `false`              | Take the client's address from `X-Forwarded-For` and their name from `X-Remote-User`. Only with a reverse proxy in front that sets both                                               |
| `logLevel`                      | `info`               | `debug` logs every line exchanged with b3270                                                                                                                                          |
| `logFile`                       | `log/tn3270.log`     | Kept as well as stderr, and rolled over to `<logFile>.1`; `""` is stderr only                                                                                                         |
| `logMaxBytes`                   | `10485760`           | Size at which the log rolls over, so the pair is never more than twice this                                                                                                           |

## 8. Error codes

Every code is fixed for the lifetime of the project and appears both in the log
and in the page. The blocks are subsystems, and a code belongs to the subsystem
that decides it is an error rather than to the file that throws it: `E1xxx`
config, `E2xxx` b3270, `E3xxx` session, `E4xxx` client messages, `E5xxx`
browser, `E6xxx` server transport, `E7xxx` the REST proxy.

| Code    | Meaning                                                |
| ------- | ------------------------------------------------------ |
| `E1001` | Config file could not be read                          |
| `E1002` | Config file is not valid JSONC                         |
| `E1003` | Config value has the wrong type                        |
| `E1004` | Config value is out of range                           |
| `E1005` | Config value is not a usable b3270 resource name       |
| `E2001` | b3270 could not be spawned                             |
| `E2002` | b3270 exited unexpectedly                              |
| `E2003` | b3270 emitted a line that is not valid JSON            |
| `E2004` | b3270 reported a protocol error                        |
| `E2005` | b3270 action failed                                    |
| `E2006` | b3270 stdin is closed                                  |
| `E3001` | Session not found                                      |
| `E3002` | Session limit reached                                  |
| `E3003` | Session has too many viewers                           |
| `E3004` | Screen indication referenced a cell outside the screen |
| `E3005` | Host address is not allowed by config                  |
| `E3006` | Input rejected: viewer is an observer                  |
| `E3008` | The session's owner did not let the viewer in          |
| `E3009` | The session's owner stopped sharing it                 |
| `E3010` | Only the session's owner may answer or stop sharing    |
| `E3011` | The session's owner did not let the viewer edit        |
| `E3012` | The session's owner took editing back                  |
| `E4001` | WebSocket message was not valid JSON                   |
| `E4002` | WebSocket message had an unknown type                  |
| `E4003` | Pasted text is too large to type into a screen         |
| `E4004` | Oversize screen has more cells than b3270 can hold     |
| `E5001` | Terminal renderer failed to initialise                 |
| `E5002` | WebSocket connection to the server failed              |
| `E5003` | Settings could not be read from the browser database   |
| `E5004` | Settings could not be saved to the browser database    |
| `E5005` | Clipboard could not be read for a Shift+Insert paste   |
| `E5006` | Another terminal session could not be opened           |
| `E5008` | Macros could not be read from the browser database     |
| `E5009` | Macros could not be saved to the browser database      |
| `E5010` | A macro file could not be read                         |
| `E5011` | The keymap could not be saved to the browser database  |
| `E5012` | A keymap file could not be read                        |
| `E5013` | The keymap could not be read from the browser database |
| `E5014` | A dropped session could not be restarted               |
| `E6001` | Static file not found                                  |
| `E6002` | WebSocket upgrade path is not a session                |
| `E6003` | WebSocket closed unexpectedly                          |
| `E6004` | Server could not start                                 |
| `E6005` | Log file could not be opened                           |
| `E6006` | Log file could not be written or rolled over           |
| `E7002` | REST is not available for this session                 |
| `E7003` | REST request to b3270 failed                           |
| `E0000` | An error with no code of its own; see the log          |

Errors are shown as a dismissible bar at the top of the page. The page is never
navigated away from.

## 9. Running it

```bash
nix develop            # node, typescript, and X11-free b3270 and s3270
npm install
npm test               # 204 tests: unit, integration, and the WASM round-trip
npm run typecheck      # tsc --strict over JSDoc; the "no any" gate
npm start              # http://127.0.0.1:8017
```

Without a mainframe, replay a recorded host:

```bash
npm run start:fake     # the replay on :4001 plus a server that connects to it
```

The page opens straight onto `test/traces/fields.trc`: a title, two ordinary
input fields and a non-display one, so typing and pasting are visible. The
replay is stopped along with the server, and serves any number of sessions at
once. `npm run fakehost` starts it on its own, for pointing something else at
it.
