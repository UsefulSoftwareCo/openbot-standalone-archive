/**
 * Which desktop, if any, this Linux server is attached to.
 *
 * Only the environment decides this, and only three answers are possible:
 * there is an X display to share, there is a Wayland compositor we cannot
 * drive, or there is no desktop at all and a managed X session is the offer.
 * Probing the display with `xdpyinfo` confirms the first answer later; it
 * cannot produce a different one.
 */

export type LinuxSessionDetection =
  | {
      readonly kind: "shared-x11";
      /** The value to put in `DISPLAY` for every tool, verbatim from the env. */
      readonly display: string;
      /** Cookie file the session's X server requires, when it named one. */
      readonly xauthority: string | null;
      /** Caveats worth showing the user even though the session works. */
      readonly notes: ReadonlyArray<string>;
    }
  | { readonly kind: "wayland-only"; readonly reason: string }
  | { readonly kind: "headless" };

export const WAYLAND_REASON =
  "This host runs a Wayland session with no X display. Wayland gives an application no way to capture the screen or inject input without a portal the user approves each session, so screen view and control are not available here. Starting the server from a session that sets DISPLAY (XWayland) makes the X11 half of the desktop available.";

/** XWayland answers X11 calls, but only for X11 clients: native Wayland
    windows are invisible to `xdotool` and to `ffmpeg -f x11grab`. Saying so is
    the difference between a confusing empty desktop and an understood one. */
export const XWAYLAND_NOTE =
  "This is an XWayland display inside a Wayland session. Only X11 windows appear in the capture and receive input; native Wayland windows do not.";

function trimmed(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.trim();
  return text.length === 0 ? null : text;
}

/**
 * Reads the session out of the process environment.
 *
 * `DISPLAY` wins whenever it is set, including inside a Wayland session:
 * XWayland is a real X server and the X11 half of that desktop is genuinely
 * shareable. The Wayland-only answer is reserved for a host where no X display
 * exists at all.
 */
export function detectLinuxSession(
  environment: Readonly<Record<string, string | undefined>>,
): LinuxSessionDetection {
  const display = trimmed(environment.DISPLAY);
  const waylandDisplay = trimmed(environment.WAYLAND_DISPLAY);
  const sessionType = trimmed(environment.XDG_SESSION_TYPE)?.toLowerCase() ?? null;
  const wayland = waylandDisplay !== null || sessionType === "wayland";

  if (display !== null) {
    return {
      kind: "shared-x11",
      display,
      xauthority: trimmed(environment.XAUTHORITY),
      notes: wayland ? [XWAYLAND_NOTE] : [],
    };
  }
  if (wayland) return { kind: "wayland-only", reason: WAYLAND_REASON };
  return { kind: "headless" };
}
