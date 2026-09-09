import AppKit
import ApplicationServices
import CoreGraphics

/// Whether a keystroke posted right now would land on the screen the caller
/// named.
///
/// A `CGEvent` keyboard post has no destination. Unlike a click, which carries
/// the coordinates that decide which window receives it, a key event goes to
/// whatever window has focus — on whichever screen that window happens to be.
/// So "type this on that display" is a claim the helper cannot make by posting
/// alone: measured on a real Mac, text sent for one managed display arrives in
/// a window on another the moment something else is frontmost.
///
/// This is the check that makes the claim true, or refuses it. It is not
/// isolation: the login session still has one keyboard and one focused window,
/// and focus can move between this read and the post. What it does buy is that
/// a batch aimed at a screen nothing on it has focus is refused outright rather
/// than typed into someone else's window.
@MainActor
public struct FocusGuard {
    /// Reported when focus is readable and the focused window belongs to
    /// another screen.
    public nonisolated static let elsewhereReason = "keyboard focus is on another screen"
    /// Reported when nothing frontmost publishes a focused window, so there is
    /// no window this can vouch for. Distinct from `elsewhereReason` because it
    /// is a different thing to fix: click into the window you meant.
    public nonisolated static let noFocusedWindowReason = "no window has keyboard focus"
    /// Reported when Accessibility is not granted, so focus cannot be read at
    /// all. Pointer events are unaffected: they carry their own target.
    public nonisolated static let untrustedReason =
        "Accessibility is required to confirm where typing would land"

    private let isTrusted: @MainActor () -> Bool
    private let focusedWindowFrame: @MainActor () -> CGRect?
    private let displayIds: @MainActor () -> [CGDirectDisplayID]
    private let boundsOfDisplay: @MainActor (CGDirectDisplayID) -> CGRect

    /// - Parameters:
    ///   - isTrusted: whether Accessibility is granted. Without it there is no
    ///     way to read focus, and the honest answer is to refuse to type.
    ///   - focusedWindowFrame: the frame, in the global point space
    ///     `CGDisplayBounds` uses, of the window a keystroke would reach.
    ///   - displayIds: every screen the focused window could be on. Attribution
    ///     needs a display's identity and its bounds and nothing else, so the
    ///     ids and `boundsOfDisplay` are what is injected rather than whole
    ///     `DisplayRecord`s.
    ///   - boundsOfDisplay: the bounds of one display.
    ///
    /// All four are injected so the decision can be tested without a screen, a
    /// grant, or whatever the developer running the tests has focused.
    public init(
        isTrusted: @escaping @MainActor () -> Bool = { AXIsProcessTrusted() },
        focusedWindowFrame: @escaping @MainActor () -> CGRect? = FocusGuard
            .systemFocusedWindowFrame,
        displayIds: @escaping @MainActor () -> [CGDirectDisplayID] = {
            DisplayRegistry.onlineDisplayIds()
        },
        boundsOfDisplay: @escaping @MainActor (CGDirectDisplayID) -> CGRect = {
            CGDisplayBounds($0)
        }
    ) {
        self.isTrusted = isTrusted
        self.focusedWindowFrame = focusedWindowFrame
        self.displayIds = displayIds
        self.boundsOfDisplay = boundsOfDisplay
    }

    /// Why a keyboard event must not be posted at `display` right now, or nil
    /// when it may.
    ///
    /// Typing is allowed only when `display` is the focused window's single
    /// owner under `DisplayAttribution` — the same rule that decides which
    /// screen `WindowInspector` lists that window on. A window mostly on the
    /// user's own screen and one pixel over this display's edge is refused, and
    /// so is one split exactly evenly between two screens: whose window it is
    /// cannot be told, and typing into it would be a guess.
    ///
    /// Read afresh for every keystroke rather than once per batch: focus moves
    /// while a sentence is being typed, and the rest of that sentence must not
    /// follow it.
    public func rejectionReason(display: DisplayRecord) -> String? {
        guard isTrusted() else { return FocusGuard.untrustedReason }
        guard let frame = focusedWindowFrame() else { return FocusGuard.noFocusedWindowReason }
        let owner = DisplayAttribution.owner(of: frame, among: screens(including: display.id))
        return owner == display.id ? nil : FocusGuard.elsewhereReason
    }

    /// The screens the focused window is attributed among.
    ///
    /// The requested display is always one of the candidates even if the screen
    /// list no longer mentions it, so a display that vanished between the
    /// caller resolving it and this read is judged by geometry rather than by
    /// being missing.
    private func screens(including target: CGDirectDisplayID) -> [DisplayAttribution.Screen] {
        var ids = displayIds()
        if !ids.contains(target) { ids.append(target) }
        return ids.map { .init(id: $0, bounds: boundsOfDisplay($0)) }
    }

    /// The frontmost application's focused window, through Accessibility.
    ///
    /// `kAXFocusedWindowAttribute` is the only attribute that answers "where
    /// would a keystroke go". `kAXMainWindowAttribute` is deliberately not a
    /// fallback: an app's main window is not necessarily the one taking input —
    /// a frontmost palette or popup holds focus while the main window sits
    /// behind it — so vouching with it would let a keystroke be approved
    /// against a window that was never going to receive it.
    ///
    /// Returns nil when Accessibility is not granted, when nothing is
    /// frontmost, or when the frontmost app publishes no focused window — all
    /// of which mean the same thing to a caller: there is no window this can
    /// vouch for.
    public static func systemFocusedWindowFrame() -> CGRect? {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            return nil
        }
        let application = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(
                application, kAXFocusedWindowAttribute as CFString, &value) == .success,
            let value,
            // `as? AXUIElement` succeeds for any CFType, so the type id is
            // checked explicitly before the cast, as in `WindowInspector`.
            CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return WindowInspector.frame(of: unsafeDowncast(value, to: AXUIElement.self))
    }
}
