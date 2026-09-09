# T3 Computer Helper

The macOS side of OpenBot's computer control. A small Swift `.app` that sees and
drives **the host's shared login session** — one pointer, one frontmost app,
shared by the human at the machine and by the agents. A managed display it
creates is another _screen_ on that same session, never a private desktop.

The server never talks to CoreGraphics itself. It launches this bundle and
speaks one line-framed protocol to it, so all the platform mechanics live behind
`ComputerBackend`.

## Build

```bash
pnpm build:computer-helper          # from the repo root
```

That runs `scripts/bundle.sh`, which builds with SwiftPM and assembles
`dist/T3ComputerHelper.app`. `dist/` and `.build/` are gitignored: the helper is
built on the machine that runs it.

Requires macOS 14 or newer at runtime and a Swift 6 toolchain to build.

```bash
swift build -c release              # compile only
swift test                          # the pure parts: key table, framing, geometry
```

## Signing, and why your permissions keep disappearing

Run this once per machine, before you grant anything:

```bash
scripts/make-signing-identity.sh
```

TCC records Screen Recording and Accessibility against a bundle identifier
**plus a code signature**. Two consequences:

- A bare SwiftPM executable can never hold either grant — it has no bundle
  identifier to record against. That is the whole reason this ships as an `.app`
  and the server launches `Contents/MacOS/T3ComputerHelper` rather than
  `.build/release/T3ComputerHelper`.
- **Ad-hoc signing pins the grant to the code hash**, which changes on every
  build. Without the signing identity above, every rebuild looks to TCC like a
  brand-new app and silently drops both grants — the helper starts reporting
  `denied` after a change that had nothing to do with permissions. A stable
  self-signed certificate pins the grant to the certificate instead, and the
  grants survive rebuilds.

`bundle.sh` uses the identity `T3 OpenBot Local Signing` when it exists and falls
back to ad-hoc with a warning when it does not.

## Launching it, and why through Launch Services

The server launches the helper with `/usr/bin/open -n -a`, into the GUI login
session, and then connects to a Unix domain socket the helper creates.

TCC does not attribute a permission request to the process that made it; it
walks up to a _responsible_ process. A helper spawned as an ordinary child of
the server is attributed to whatever started the server — an SSH session, a
terminal, `tailscaled`. The grant then lands somewhere the user cannot find, and
moves when the server is started a different way.

This is measurable here, not theoretical. The same bundle, probed two ways on
the same machine:

| launched as                         | `permissions.screenCapture`                     |
| ----------------------------------- | ----------------------------------------------- |
| `--stdio` child of a terminal       | `granted` (inherited from the terminal's grant) |
| `open -n -a` into the login session | `denied` (its own, ungranted, findable)         |

The second is the honest answer, and the one a user can act on: the entry in
System Settings › Privacy & Security is **T3 Computer Helper**, under bundle id
`codes.t3.openbot.computer-helper`.

`--stdio` remains as a diagnostic mode. Do not ship on it.

## Protocol

One JSON object per line, UTF-8. When a record declares `"payloadBytes": N`,
exactly `N` raw bytes follow the newline — so a reader counts bytes rather than
scanning a JPEG for a delimiter. Commands never carry a payload.

```
--stdio                                  commands on stdin, records on stdout, logs on stderr
--socket <path> --token <hex>            listen on a Unix socket (mode 0600)
  [--ready-file <path>] [--exit-on-disconnect]
```

In socket mode the first line from the client must be
`{"type":"auth","token":"<hex>"}`; anything else closes the connection without
explanation. Once listening, the helper writes one line to the ready file:

```json
{ "event": "ready", "pid": 1234, "socket": "/tmp/…/h.sock", "protocolVersion": 1 }
```

### Commands

Every command carries an `id` that its reply echoes.

| command                                                 | reply                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `hello`                                                 | `hello` with pid, bundle id, permissions and displays       |
| `displays`                                              | `displays`                                                  |
| `windows`                                               | `windows`                                                   |
| `focus-window` `{windowId}`                             | `ok`                                                        |
| `screenshot` `{displayId, maxWidthPx}`                  | `frame` with an `id` and a JPEG payload                     |
| `capture-start` `{displayId, maxWidthPx, fps, quality}` | `ok`, then unsolicited `frame` records                      |
| `capture-stop` `{displayId}`                            | `ok`                                                        |
| `input` `{displayId, events}`                           | `input-result` `{delivered, rejected}` — see below          |
| `create-display` `{name, widthPx, heightPx, hiDpi}`     | `display`                                                   |
| `destroy-display` `{displayId}`                         | `ok`                                                        |
| `launch` `{app, args, displayId}`                       | `launched` `{pid, placedWindows, placed}` — see below       |
| `request-permissions`                                   | `permissions` — **the only command that may show a prompt** |
| `shutdown`                                              | `ok`, then exit 0                                           |

### Input, and how it is cancelled

`input` is the one command that does not run on the command chain. Typing is
paced — 15ms between key phases, measured, because a faster string loses
characters — so one 4096-character `text` event is two minutes of work, and
nothing else may wait behind it. Batches run on their own serial queue: two
`input` commands still land in the order they arrived, while `capture-stop`,
`windows`, a disconnect and the next `input` are all served meanwhile. The
`input-result` arrives when the batch finishes, which for a long one is minutes
after the command; the server's deadline for `input` scales with the text in the
batch for that reason.

A `release-all` event cancels every input batch that is queued or in flight
before it releases anything, so stopping an agent mid-sentence takes
milliseconds instead of waiting out the sentence. A cancelled batch still
answers its own request: the text event it stopped inside comes back as
`{"index":N,"reason":"cancelled after 37 characters"}`, and the events it never
reached as `"cancelled"`. `delivered` counts only the events that fully landed.
Losing the driver and `shutdown` cancel the same way before releasing.

### Keyboard events and the display they were sent for

A click carries the coordinates that decide which window gets it. A key event
does not: `CGEvent` posts it to whatever window has focus, on whatever screen.
So an `input` batch naming a display cannot type "on" that display by posting
alone — measured on a real Mac, text sent for one managed display arrives in a
window on another the moment something else is frontmost.

Every keyboard event in a batch is therefore checked first, inside the same
serialized batch that posts it: the frontmost application's focused window
(`kAXFocusedWindowAttribute`, falling back to `kAXMainWindowAttribute`) must
overlap `CGDisplayBounds` of the display the batch named. When it does not, the
event is not posted and comes back as
`{"index":N,"reason":"keyboard focus is on another screen"}`, and so does every
keyboard event behind it in that batch. Without Accessibility the question
cannot be answered at all and the reason is
`"Accessibility is required to confirm where typing would land"`.

The check is re-read per keystroke, not once per batch: a long `text` event is
minutes of typing, and focus moving partway through stops it with
`"keyboard focus is on another screen after 37 characters"` rather than letting
the rest of the string follow focus.

Three deliberate exclusions. Pointer events carry their own target and are
judged only by their coordinates — clicking is how a caller moves focus back. A
key _up_ is always delivered, because it types nothing and refusing it would
leave held down whatever its key-down pressed. `release-all` likewise.

This is a guard, not isolation. The login session has one keyboard and one
focused window; focus can still move between the read and the post. What it
buys is that a batch aimed at a screen nothing on which has focus is refused
outright instead of typed into someone else's window.

### Launching onto a display

`launch` with a `displayId` checks Accessibility **before** it starts anything
and fails with `permission_denied` when the grant is missing. Without it the
new window can be neither found nor moved, so launching first would put the app
on the user's own screen and only then discover the request could not be
honoured — and nothing can put that window back.

With the grant, the helper waits up to ten seconds for the new process to open
windows and moves each of them onto the display. The reply says what actually
happened: `placedWindows` is how many were moved and `placed` is whether that
was any at all. Both are absent when no display was requested. `placedWindows:
0` means the app started and its windows are wherever the app put them; the
server surfaces that as a warning rather than reporting a launch that landed on
the requested screen.

Placement is after the fact, and honestly so: the app is activated as it starts
(that is what makes its window findable, and a background window takes no
keyboard input), so an ordinary app start may paint its window on the main
display for a moment before it is moved.

Unsolicited: `{"type":"event","event":"displays-changed"｜"permissions-changed"}`
and `frame` records while a capture is running. Failures are
`{"id","type":"error","code","message"}` where `code` is one of the
`OpenbotComputerError` codes the contract defines, so the server passes it
straight through.

### Coordinates

Every point on this wire is in the target display's **pixel** space, origin at
that display's top-left. The helper divides by the display's scale and adds
`CGDisplayBounds().origin` to reach the global point space CoreGraphics posts
events in.

Wheel deltas use the browser's sign convention: a positive `deltaY` moves the
page toward its end. macOS is the opposite, so the helper posts `wheel1 =
-deltaY` and `wheel2 = -deltaX`.

Keys are W3C `KeyboardEvent.code` values, which name physical positions and so
map one-to-one onto macOS virtual keycodes regardless of layout. Characters
travel as `text` events instead, typed as unicode strings with no table
involved.

## Exit paths

On `shutdown`, on SIGTERM/SIGINT, and on losing its driver with
`--exit-on-disconnect`, the helper cancels every input batch, releases every
held button and key, stops every capture, and destroys every virtual display it
created. A virtual display
that outlives its owner is a monitor the user can neither see nor remove.

## Known platform behaviour

- **A locked screen has no _active_ displays.** Measured on macOS 26.5:
  `CGGetActiveDisplayList` returns zero while the screen is locked, and
  `CGGetOnlineDisplayList` returns all of them. The helper enumerates the online
  list (dropping mirroring secondaries) so a locked Mac does not look like a
  host with no screens.
- **Windows come from Accessibility, not `CGWindowListCopyWindowInfo`.** Without
  Screen Recording that call does not fail, it returns an empty list. Silence is
  the worst failure mode available, and it would tie "what is on this screen?"
  to the same grant as the video stream.
- **`SCStream` and virtual displays.** Streams have been seen to misroute frames
  across virtual displays after they connect and disconnect. There is no
  filter-side fix; what avoids it is never stacking a new stream on one that has
  not finished stopping, so `capture-start` awaits the stop for that display
  first.
- **Each virtual display needs its own dispatch queue**, and its single mode's
  dimensions must equal `maxPixelsWide`/`maxPixelsHigh`. Get either wrong and
  the display is created but never comes online, with no error.
