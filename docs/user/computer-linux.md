# Computer on Linux

On Linux the computer view works over X11. T3 Code can share the desktop you are
already signed in to, or start a headless desktop of its own on a machine that
has no screen at all.

## Install the tools

T3 Code drives the desktop with ordinary X11 programs, which are not installed by
default on most servers. The computer view lists exactly which ones are missing
and gives you the command for your distribution; these are the full sets.

Debian and Ubuntu:

```sh
sudo apt-get install -y xvfb xdotool ffmpeg openbox x11-utils x11-xserver-utils
```

Fedora and RHEL:

```sh
sudo dnf install -y xorg-x11-server-Xvfb xdotool ffmpeg openbox xdpyinfo xwininfo xrandr
```

Arch:

```sh
sudo pacman -S --needed xorg-server-xvfb xdotool ffmpeg openbox xorg-xdpyinfo xorg-xwininfo xorg-xrandr
```

`xdotool`, `ffmpeg`, `xdpyinfo`, and `xwininfo` are what a shared desktop needs;
on Debian and Ubuntu `xdpyinfo` and `xwininfo` both come from `x11-utils`.
`Xvfb` and `openbox` are only needed for managed X sessions. `xrandr` is
optional and adds one display per monitor instead of one for the whole screen.

## Your existing desktop

If the server starts from a session with `DISPLAY` set, the computer view shows
that desktop, and control moves the same pointer you use yourself. Nothing is
sandboxed: an agent clicking is the same as you clicking.

Two things are worth knowing:

- If the X server needs an authority cookie, start the server from a session
  where `XAUTHORITY` is set. A server started without it cannot open the display,
  and the computer view says so rather than showing a blank screen.
- On a machine that runs Wayland but sets `DISPLAY` through XWayland, only X11
  windows appear in the capture and only X11 windows receive input. Native
  Wayland windows are invisible to the view.

## A headless machine

On a server with no desktop, each chat still gets its own screen: the first time
anyone opens that chat's computer view, T3 Code starts an X server and a window
manager for it automatically, and its agent can open apps onto it with the
`computer_launch` tool. These managed sessions are temporary and stop, along
with everything running on them, when the T3 Code server stops.

## Wayland

A Wayland session with no X display is not supported, and the computer view says
so plainly instead of appearing broken. Wayland deliberately gives no
application a way to capture the screen or move the pointer without a portal the
user approves for each session, and T3 Code does not fake that.

Start the server from a session that sets `DISPLAY` and the X11 half of the
desktop becomes available through XWayland, with the caveats above.
