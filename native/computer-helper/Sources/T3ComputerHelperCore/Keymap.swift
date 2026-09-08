import CoreGraphics

/// W3C `KeyboardEvent.code` to macOS virtual keycode.
///
/// A `code` names a physical position, not a character, which is exactly what a
/// virtual keycode is — so the table is layout-independent on both ends and a
/// French keyboard driving an English Mac still presses the key the user
/// pressed. Characters never travel this way; they travel as `text`, which is
/// posted as a unicode string and needs no table at all.
public enum Keymap {
    public static let virtualKeys: [String: CGKeyCode] = [
        // Letters, in the order the ANSI layout assigns them.
        "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7,
        "KeyC": 8, "KeyV": 9, "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15,
        "KeyY": 16, "KeyT": 17, "KeyO": 31, "KeyU": 32, "KeyI": 34, "KeyP": 35, "KeyL": 37,
        "KeyJ": 38, "KeyK": 40, "KeyN": 45, "KeyM": 46,

        // Digit row.
        "Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23,
        "Digit9": 25, "Digit7": 26, "Digit8": 28, "Digit0": 29,

        // Punctuation.
        "Equal": 24, "Minus": 27, "BracketRight": 30, "BracketLeft": 33, "Quote": 39,
        "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44, "Period": 47, "Backquote": 50,
        "IntlBackslash": 10, "IntlYen": 93, "IntlRo": 94,

        // Editing and whitespace.
        "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "CapsLock": 57,
        "Delete": 117, "Insert": 114, "Help": 114, "ContextMenu": 110,

        // Modifiers. Posted as their own down/up events so a held modifier
        // spans the keystrokes that follow it.
        "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "AltLeft": 58, "ControlLeft": 59,
        "ShiftRight": 60, "AltRight": 61, "ControlRight": 62, "Fn": 63,

        // Navigation.
        "Home": 115, "PageUp": 116, "End": 119, "PageDown": 121,
        "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,

        // Function row. F13-F20 exist on external keyboards and in remote
        // sessions, so the table does not stop at F12.
        "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100,
        "F9": 101, "F10": 109, "F11": 103, "F12": 111, "F13": 105, "F14": 107, "F15": 113,
        "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90,

        // Keypad.
        "NumpadDecimal": 65, "NumpadMultiply": 67, "NumpadAdd": 69, "NumLock": 71,
        "NumpadDivide": 75, "NumpadEnter": 76, "NumpadSubtract": 78, "NumpadEqual": 81,
        "Numpad0": 82, "Numpad1": 83, "Numpad2": 84, "Numpad3": 85, "Numpad4": 86,
        "Numpad5": 87, "Numpad6": 88, "Numpad7": 89, "Numpad8": 91, "Numpad9": 92,
        "NumpadClear": 71,
    ]

    public static func virtualKey(for code: String) -> CGKeyCode? {
        virtualKeys[code]
    }

    /// The flag a modifier key contributes while it is held, or nil for a key
    /// that is not a modifier.
    public static func flag(forHeldKey key: CGKeyCode) -> CGEventFlags? {
        switch key {
        case 56, 60: return .maskShift
        case 59, 62: return .maskControl
        case 58, 61: return .maskAlternate
        case 54, 55: return .maskCommand
        case 57: return .maskAlphaShift
        case 63: return .maskSecondaryFn
        default: return nil
        }
    }

    public static func flag(for modifier: InputModifier) -> CGEventFlags {
        switch modifier {
        case .shift: return .maskShift
        case .control: return .maskControl
        case .alt: return .maskAlternate
        case .meta: return .maskCommand
        }
    }

    public static func flags(for modifiers: [InputModifier]) -> CGEventFlags {
        modifiers.reduce(into: CGEventFlags()) { $0.insert(flag(for: $1)) }
    }
}

/// Pure coordinate and wheel arithmetic, kept out of the event-posting code so
/// it can be tested without moving the user's pointer.
public enum InputGeometry {
    /// A client point (display pixels, origin at that display's top-left) in the
    /// global point space CoreGraphics posts events in.
    public static func globalPoint(
        _ point: CGPoint, displayOrigin: CGPoint, scale: Double
    ) -> CGPoint {
        let divisor = scale > 0 ? scale : 1
        return CGPoint(
            x: displayOrigin.x + point.x / divisor,
            y: displayOrigin.y + point.y / divisor)
    }

    public static func isInside(_ point: CGPoint, widthPx: Int, heightPx: Int) -> Bool {
        point.x >= 0 && point.y >= 0 && point.x <= Double(widthPx) && point.y <= Double(heightPx)
    }

    /// Browser wheel deltas as macOS scroll-wheel axes.
    ///
    /// The signs are opposite. A browser reports a positive `deltaY` when the
    /// page moves toward its end; macOS reports a positive `wheel1` when the
    /// wheel turns up, which moves the page toward its start. Negating is what
    /// makes a wheel-down in the viewer scroll the Mac down, and the same
    /// argument holds for `deltaX` against `wheel2`.
    ///
    /// The clamp is not decoration: `CGEvent` takes `Int32` axes, and an
    /// unclamped cast of a large trackpad delta traps at runtime.
    public static func wheelAxes(deltaX: Double, deltaY: Double) -> (wheel1: Int32, wheel2: Int32) {
        (clampToInt32(-deltaY), clampToInt32(-deltaX))
    }

    static func clampToInt32(_ value: Double) -> Int32 {
        guard value.isFinite else { return 0 }
        let rounded = value.rounded()
        if rounded >= Double(Int32.max) { return Int32.max }
        if rounded <= Double(Int32.min) { return Int32.min }
        return Int32(rounded)
    }

    /// The capture size for a source display under a maximum width.
    ///
    /// Only ever downscales: asking ScreenCaptureKit to enlarge costs bandwidth
    /// and shows the viewer nothing it did not already have.
    public static func captureSize(
        sourceWidthPx: Int, sourceHeightPx: Int, maxWidthPx: Int
    ) -> (width: Int, height: Int) {
        guard sourceWidthPx > 0, sourceHeightPx > 0 else { return (2, 2) }
        let fit = min(1, Double(max(2, maxWidthPx)) / Double(sourceWidthPx))
        return (
            max(2, Int((Double(sourceWidthPx) * fit).rounded())),
            max(2, Int((Double(sourceHeightPx) * fit).rounded()))
        )
    }
}
