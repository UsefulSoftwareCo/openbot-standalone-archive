/**
 * Maximizing the computer viewer, in two tiers.
 *
 * The browser's own fullscreen is the better result but not a promise we can
 * make: `requestFullscreen` is missing on some engines and rejected on others
 * when the click is not trusted, when a permissions policy forbids it, or when
 * another element already owns fullscreen. So the in-app overlay is the tier we
 * always get — it is entered first and stays entered — and native fullscreen is
 * an upgrade layered on top of it. A refusal is not a failure the user has to
 * act on, only a note explaining why the page did not leave the browser frame.
 *
 * `native` exists so the two tiers can never disagree: it is true only while the
 * browser really owns the element, which is what tells the page that a
 * `fullscreenchange` back to nothing means the user pressed Escape at the
 * browser level and the overlay must come down with it.
 */

/** Why the browser is not showing native fullscreen. */
export type MaximizeDenial = "declined" | "unsupported";

/** What the viewer is showing, and what it is allowed to say about it. */
export interface MaximizeState {
  /** True while the viewer fills the viewport, by either tier. */
  readonly maximized: boolean;
  /** True only while the browser's own fullscreen owns the wrapper element. */
  readonly native: boolean;
  /** A short note about a refused fullscreen request, shown as information. */
  readonly hint: string | null;
}

/**
 * Everything that can move the viewer between tiers: the two buttons, the
 * outcome of a `requestFullscreen` call, the browser leaving fullscreen on its
 * own, and Escape.
 */
export type MaximizeEvent =
  | { readonly type: "clickMaximize" }
  | { readonly type: "clickExit" }
  | { readonly type: "nativeGranted" }
  | { readonly type: "nativeDenied"; readonly reason: MaximizeDenial }
  | { readonly type: "nativeExited" }
  | { readonly type: "escape"; readonly controlling: boolean };

/** The resting state: normal pane, no hint owed. */
export const NOT_MAXIMIZED: MaximizeState = { maximized: false, native: false, hint: null };

const DENIAL_HINTS: Record<MaximizeDenial, string> = {
  declined: "Browser declined fullscreen; showing maximized in the page",
  unsupported: "This browser has no fullscreen API",
};

/** The footer note for a refusal, phrased as information rather than an error. */
export function denialHint(reason: MaximizeDenial): string {
  return DENIAL_HINTS[reason];
}

/**
 * The next viewer state for one event. Pure: leaving the browser's fullscreen is
 * the caller's job, because only the caller can see `document.fullscreenElement`.
 *
 * Escape is ignored while this client holds the control lease, because those
 * keystrokes belong to the host — the hidden textarea is forwarding them to a
 * desktop where Escape means something. That is why the toolbar keeps a visible
 * exit button: it is the only way out that does not steal a key from the host.
 *
 * A native outcome that lands after the user has already left is dropped rather
 * than pulling them back in, and `nativeExited` only means something while the
 * browser actually owned the element, so an unrelated `fullscreenchange` cannot
 * collapse the in-app overlay.
 */
export function nextMaximizeState(current: MaximizeState, event: MaximizeEvent): MaximizeState {
  switch (event.type) {
    case "clickMaximize":
      return current.maximized ? current : { maximized: true, native: false, hint: null };
    case "clickExit":
      return NOT_MAXIMIZED;
    case "escape":
      return event.controlling || !current.maximized ? current : NOT_MAXIMIZED;
    case "nativeGranted":
      return current.maximized ? { maximized: true, native: true, hint: null } : current;
    case "nativeDenied":
      return current.maximized
        ? { maximized: true, native: false, hint: denialHint(event.reason) }
        : current;
    case "nativeExited":
      return current.native ? NOT_MAXIMIZED : current;
  }
}
