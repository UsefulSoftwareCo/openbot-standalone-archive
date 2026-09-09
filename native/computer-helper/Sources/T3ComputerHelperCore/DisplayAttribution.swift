import CoreGraphics

/// Which one display a rectangle is on.
///
/// One rule in one place, because three callers ask this question and they must
/// not answer it differently: `WindowInspector` to say which screen a window is
/// listed under, `FocusGuard` to decide whether a keystroke aimed at a screen
/// would land there, and `AppLauncher` to check that a window it moved actually
/// arrived. When the guard was the more permissive of them, a window one pixel
/// over the boundary was listed as being on the user's own screen and typed
/// into as if it were on the chat's.
///
/// Geometry is in the global point space `CGDisplayBounds` uses, which is also
/// the space Accessibility states window frames in, so the two compare without
/// a coordinate flip.
public enum DisplayAttribution {
    /// A display reduced to what attribution needs: an identity and where it
    /// sits in the global point space.
    public struct Screen: Sendable, Equatable {
        public let id: CGDirectDisplayID
        public let bounds: CGRect

        public init(id: CGDirectDisplayID, bounds: CGRect) {
            self.id = id
            self.bounds = bounds
        }
    }

    /// The single display that owns `frame`, or nil when no single one does.
    ///
    /// Ownership is the largest positive intersection area: a window straddling
    /// a boundary belongs to the screen holding most of it, and nowhere else.
    /// Nil covers the three cases that mean the same thing to every caller —
    /// there is no one screen this frame is on: nothing overlaps it, the only
    /// overlaps are zero-area edge touches (a window flush against a screen's
    /// left edge is entirely on the screen before it), or two screens hold
    /// exactly as much of it as each other.
    public static func owner(of frame: CGRect, among screens: [Screen]) -> CGDirectDisplayID? {
        var winner: CGDirectDisplayID?
        var largest: CGFloat = 0
        var tied = false
        for screen in screens {
            let overlap = frame.intersection(screen.bounds)
            guard !overlap.isNull else { continue }
            let area = overlap.width * overlap.height
            guard area > 0 else { continue }
            if area > largest {
                largest = area
                winner = screen.id
                tied = false
            } else if area == largest, screen.id != winner {
                tied = true
            }
        }
        return tied ? nil : winner
    }

    /// Whether `frame` is on `display` and on no other screen more.
    ///
    /// A nil frame is geometry that could not be read, which is not evidence of
    /// being anywhere: it answers false.
    public static func isOwned(
        _ frame: CGRect?, by display: CGDirectDisplayID, among screens: [Screen]
    ) -> Bool {
        guard let frame else { return false }
        return owner(of: frame, among: screens) == display
    }
}
