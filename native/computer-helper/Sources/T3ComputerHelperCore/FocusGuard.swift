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
    /// Reported when focus is readable and is somewhere else.
    public nonisolated static let elsewhereReason = "keyboard focus is on another screen"
    /// Reported when Accessibility is not granted, so focus cannot be read at
    /// all. Pointer events are unaffected: they carry their own target.
    public nonisolated static let untrustedReason =
        "Accessibility is required to confirm where typing would land"

    private let isTrusted: @MainActor () -> Bool
    private let focusedWindowFrame: @MainActor () -> CGRect?
    private let boundsOfDisplay: @MainActor (CGDirectDisplayID) -> CGRect

    /// - Parameters:
    ///   - isTrusted: whether Accessibility is granted. Without it there is no
    ///     way to read focus, and the honest answer is to refuse to type.
    ///   - focusedWindowFrame: the frame, in the global point space
    ///     `CGDisplayBounds` uses, of the window a keystroke would reach.
    ///   - boundsOfDisplay: the bounds of one display.
    ///
    /// All three are injected so the decision can be tested without a screen,
    /// a grant, or whatever the developer running the tests has focused.
    public init(
        isTrusted: @escaping @MainActor () -> Bool = { AXIsProcessTrusted() },
        focusedWindowFrame: @escaping @MainActor () -> CGRect? = FocusGuard
            .systemFocusedWindowFrame,
        boundsOfDisplay: @escaping @MainActor (CGDirectDisplayID) -> CGRect = {
            CGDisplayBounds($0)
        }
    ) {
        self.isTrusted = isTrusted
        self.focusedWindowFrame = focusedWindowFrame
        self.boundsOfDisplay = boundsOfDisplay
    }

    /// Why a keyboard event must not be posted at `display` right now, or nil
    /// when it may.
    ///
    /// Read afresh for every keystroke rather than once per batch: focus moves
    /// while a sentence is being typed, and the rest of that sentence must not
    /// follow it.
    public func rejectionReason(display: DisplayRecord) -> String? {
        guard isTrusted() else { return FocusGuard.untrustedReason }
        guard let frame = focusedWindowFrame() else { return FocusGuard.elsewhereReason }
        return FocusGuard.windowIsOnDisplay(frame, displayBounds: boundsOfDisplay(display.id))
            ? nil : FocusGuard.elsewhereReason
    }

    /// True when a window's frame overlaps a display's bounds.
    ///
    /// The same attribution `WindowInspector` uses to say which screen a window
    /// is on, and it works for the same reason: AX states geometry in the
    /// top-left, primary-anchored point space `CGDisplayBounds` also uses, so
    /// the two frames compare without a coordinate flip.
    ///
    /// A window straddling two screens counts as being on both. That is the
    /// permissive direction on purpose: the job here is to stop typing that
    /// would plainly land on another screen, not to adjudicate a window
    /// someone dragged half-way across the boundary.
    public nonisolated static func windowIsOnDisplay(_ frame: CGRect, displayBounds: CGRect) -> Bool {
        let overlap = frame.intersection(displayBounds)
        return !overlap.isNull && overlap.width > 0 && overlap.height > 0
    }

    /// The frontmost application's focused window, through Accessibility.
    ///
    /// `kAXFocusedWindowAttribute` is the attribute that answers "where would a
    /// keystroke go". `kAXMainWindowAttribute` is the fallback for apps that
    /// keep no focused window while still owning the screen; without it a
    /// perfectly ordinary app would look like nothing has focus and every
    /// keystroke would be refused.
    ///
    /// Returns nil when Accessibility is not granted, when nothing is
    /// frontmost, or when the frontmost app publishes no window — all of which
    /// mean the same thing to a caller: there is no window this can vouch for.
    public static func systemFocusedWindowFrame() -> CGRect? {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            return nil
        }
        let application = AXUIElementCreateApplication(pid)
        for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            var value: CFTypeRef?
            guard
                AXUIElementCopyAttributeValue(application, attribute as CFString, &value)
                    == .success,
                let value,
                // `as? AXUIElement` succeeds for any CFType, so the type id is
                // checked explicitly before the cast, as in `WindowInspector`.
                CFGetTypeID(value) == AXUIElementGetTypeID()
            else { continue }
            let window = unsafeDowncast(value, to: AXUIElement.self)
            if let frame = WindowInspector.frame(of: window) { return frame }
        }
        return nil
    }
}
