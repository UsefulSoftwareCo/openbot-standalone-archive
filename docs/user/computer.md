# Computer

Every top-level chat — a standalone chat or a project's main chat — has its own
screen: a virtual display on macOS, a headless X session on Linux. T3 Code
creates it the first time anyone opens that chat's computer view. A child chat
has no screen of its own; it works on its parent's. Open one from the
computer card in the conversation rail.

## Taking control

Watching is always safe. To use the screen yourself, choose **Take control**.
While you hold control the pointer and keyboard follow you and agents in that
chat are refused. Choose **Stop controlling** when done; the agent can act
again immediately. Keys you are holding are released when you stop, close the
view, or switch away.

## Windows and opening apps

The window list shows what is open on this chat's screen; selecting one raises
it. **Open app** launches onto this chat's screen, not wherever you are looking.

## Letting agents use it

Agents reach a chat's screen through the `computer_*` tools, automatically
scoped to the chat they run in — there is nothing to select. The screen is
shared, so an agent's input waits for you and is refused while you control it.

Turn this off with **Settings → Integrations → Agent computer access** (the
same server setting applies to OpenBot). You keep the view either way; only
agents lose it.

## Permissions on macOS

macOS asks for two separate grants, both for **T3 Computer Helper**. Granting
one does not grant the other, and the view says which is missing:

- **Screen Recording** (Privacy & Security) to see the screen.
- **Accessibility** (Privacy & Security) to move the pointer, type, and place
  windows — without it, opening an app is refused rather than landing
  somewhere unexpected.

## A shared session, honestly

On macOS, every chat's screen is an extra screen on the one session you are
signed into, which still has one pointer, one keyboard, and one frontmost app —
shared between you at the Mac and every chat's agent. Nothing is isolated or
sandboxed; it is more desks in the same room, not a room of your own.

On Linux, a managed screen is a separate X server with its own pointer, so it
does not compete for input. See [Computer on Linux](./computer-linux.md).
