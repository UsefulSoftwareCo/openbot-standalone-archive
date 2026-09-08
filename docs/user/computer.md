# Computer

The computer view shows the desktop of the machine your T3 Code server runs on,
live. It is your real desktop, not a sandbox: one pointer, one keyboard, and the
same windows you would see sitting in front of it. Open it from the computer
card in the conversation details rail.

## Taking control

Watching is always safe. To use the desktop yourself, choose **Take control**.
While you hold control the pointer and keyboard follow you, agents are refused,
and everyone else looking at the same computer sees that you are controlling.
Choose **Stop controlling** when you are done; agents can act again immediately.
Keys you are holding are released for you when you stop, close the view, or
switch away.

## Displays and windows

The display picker lists every screen the computer has. You can add a **managed
display** — an extra virtual screen on macOS, or a headless X screen on Linux —
to give work its own space without covering what is on your monitor. Managed
displays are temporary and disappear when the server stops.

The window list shows what is open. Selecting a window raises it and brings its
app to the front.

## Letting agents use it

Agents reach the same desktop through the `computer_*` tools: they can look,
click, type, focus a window, add a managed display, and open an app. Because the
desktop is shared, an agent's input waits for you and is refused outright while
you are controlling.

Turn this off with **Settings → Integrations → Agent computer access** in T3 Code
(the same server setting applies to OpenBot). You keep the computer view either
way; only the agents lose it.

## Permissions on macOS

macOS asks for two separate grants, both for **T3 Computer Helper**:

- **System Settings → Privacy & Security → Screen Recording** to see the screen.
- **System Settings → Privacy & Security → Accessibility** to move the pointer
  and type.

Granting one does not grant the other, and the computer view says which one is
missing.

## Linux

Linux needs a few packages and works either on your existing X11 session or on a
headless one T3 Code starts for itself. Wayland-only sessions are not supported.
See [Computer on Linux](./computer-linux.md).
