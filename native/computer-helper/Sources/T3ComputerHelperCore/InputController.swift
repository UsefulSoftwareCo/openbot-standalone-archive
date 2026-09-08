import AppKit
import CoreGraphics

/// Posts real input on the shared desktop.
///
/// A click warps the cursor and leaves it there. That is deliberate, not a
/// shortcut: `CGEvent.postToPid` delivers input without moving the pointer, but
/// it also delivers without focus, and focus is what moves `NSScreen.main` and
/// what Chrome and Electron require before they will accept a synthetic event
/// at all. The human and the agent share one pointer because they share one
/// login session, which is what the product says on the tin.
@MainActor
public final class InputController {
    /// One source for every synthesised event.
    ///
    /// Synthesising input makes macOS suppress real hardware events for a short
    /// interval, which a watching human reads as the pointer being taken away.
    /// Permitting local events throughout the suppression interval keeps the
    /// physical mouse and keyboard live while an agent works.
    private let source: CGEventSource? = {
        let source = CGEventSource(stateID: .combinedSessionState)
        let permitEverything: CGEventFilterMask = [
            .permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents,
        ]
        source?.setLocalEventsFilterDuringSuppressionState(
            permitEverything, state: .eventSuppressionStateSuppressionInterval)
        source?.setLocalEventsFilterDuringSuppressionState(
            permitEverything, state: .eventSuppressionStateRemoteMouseDrag)
        return source
    }()

    /// Held state, so a drag posts drag events, a held modifier reaches the
    /// keystrokes after it, and a disconnect can be cleaned up by one
    /// `release-all` instead of guesswork.
    private var heldButtons: Set<MouseButton> = []
    private var heldKeys: Set<CGKeyCode> = []
    private var lastGlobalPoint = CGPoint.zero

    /// Measured, not guessed: at 6ms a receiving app silently swallowed roughly
    /// half of a typed string. Events are posted to the HID tap and delivered
    /// asynchronously, so typing faster than the target's event loop loses
    /// characters with no error anywhere. 15ms types about 33 characters a
    /// second and arrives complete.
    private let keystrokeGapMicroseconds: UInt32 = 15_000
    private let clickGapMicroseconds: UInt32 = 40_000

    public init() {}

    public var isTrusted: Bool { AXIsProcessTrusted() }

    /// Delivers a batch in order, reporting per-event rejections rather than
    /// failing the batch: one unknown key should not lose the sentence
    /// after it.
    public func deliver(
        events: [ParsedInputEvent], display: DisplayRecord
    ) -> (delivered: Int, rejected: [InputRejection]) {
        var delivered = 0
        var rejected: [InputRejection] = []
        for (index, entry) in events.enumerated() {
            switch entry {
            case let .rejected(reason):
                rejected.append(InputRejection(index: index, reason: reason))
            case let .event(event):
                if let reason = perform(event, on: display) {
                    rejected.append(InputRejection(index: index, reason: reason))
                } else {
                    delivered += 1
                }
            }
        }
        return (delivered, rejected)
    }

    /// Returns nil on success, or the reason this event was rejected.
    private func perform(_ event: InputEvent, on display: DisplayRecord) -> String? {
        func global(_ point: CGPoint) -> CGPoint? {
            guard InputGeometry.isInside(point, widthPx: display.widthPx, heightPx: display.heightPx)
            else { return nil }
            let origin = CGDisplayBounds(display.id).origin
            return InputGeometry.globalPoint(point, displayOrigin: origin, scale: display.scale)
        }

        switch event {
        case let .move(point):
            guard let target = global(point) else { return offDisplay(point, display) }
            move(to: target)
            return nil

        case let .button(button, down, point):
            guard let target = global(point) else { return offDisplay(point, display) }
            move(to: target)
            postButton(button, down: down, at: target, clickState: 1)
            if down { heldButtons.insert(button) } else { heldButtons.remove(button) }
            return nil

        case let .click(button, count, point, modifiers):
            guard let target = global(point) else { return offDisplay(point, display) }
            move(to: target)
            let flags = Keymap.flags(for: modifiers).union(heldFlags())
            for index in 1...count {
                postButton(button, down: true, at: target, clickState: index, flags: flags)
                usleep(clickGapMicroseconds)
                postButton(button, down: false, at: target, clickState: index, flags: flags)
                if index < count { usleep(clickGapMicroseconds) }
            }
            return nil

        case let .scroll(point, deltaX, deltaY):
            guard let target = global(point) else { return offDisplay(point, display) }
            let axes = InputGeometry.wheelAxes(deltaX: deltaX, deltaY: deltaY)
            guard
                let scroll = CGEvent(
                    scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                    wheel1: axes.wheel1, wheel2: axes.wheel2, wheel3: 0)
            else { return "scroll event could not be created" }
            scroll.location = target
            scroll.flags = heldFlags()
            scroll.post(tap: .cghidEventTap)
            return nil

        case let .key(code, down, modifiers):
            guard let key = Keymap.virtualKey(for: code) else { return unknownKey(code) }
            postKey(key, down: down, extra: Keymap.flags(for: modifiers))
            if down { heldKeys.insert(key) } else { heldKeys.remove(key) }
            return nil

        case let .keyPress(code, modifiers):
            guard let key = Keymap.virtualKey(for: code) else { return unknownKey(code) }
            let extra = Keymap.flags(for: modifiers)
            postKey(key, down: true, extra: extra)
            usleep(8_000)
            postKey(key, down: false, extra: extra)
            return nil

        case let .text(text):
            type(text)
            return nil

        case .releaseAll:
            releaseAll()
            return nil
        }
    }

    private func offDisplay(_ point: CGPoint, _ display: DisplayRecord) -> String {
        "point (\(Int(point.x)), \(Int(point.y))) is outside display \(display.id)"
            + " (\(display.widthPx)x\(display.heightPx))"
    }

    private func unknownKey(_ code: String) -> String {
        "unknown key code '\(code)'; expected a W3C KeyboardEvent.code such as 'KeyA' or 'ArrowLeft'"
    }

    /// Releases every button and key this connection is holding.
    ///
    /// The shared desktop is why this exists: a viewer that disconnects
    /// mid-drag would otherwise leave the mouse button down for the human
    /// sitting at the machine.
    public func releaseAll() {
        for button in heldButtons {
            postButton(button, down: false, at: lastGlobalPoint, clickState: 1)
        }
        heldButtons.removeAll()
        for key in heldKeys {
            postKey(key, down: false, extra: [])
        }
        heldKeys.removeAll()
    }

    private func heldFlags() -> CGEventFlags {
        heldKeys.reduce(into: CGEventFlags()) { flags, key in
            if let flag = Keymap.flag(forHeldKey: key) { flags.insert(flag) }
        }
    }

    private func move(to point: CGPoint) {
        CGWarpMouseCursorPosition(point)
        // Without re-associating, the cursor stays pinned where the warp left
        // it and the physical mouse stops moving it.
        CGAssociateMouseAndMouseCursorPosition(1)
        lastGlobalPoint = point
        // A move while a button is held is a drag; posting `mouseMoved` instead
        // makes every drag in the UI look like a hover.
        let type: CGEventType =
            heldButtons.contains(.left) ? .leftMouseDragged
            : heldButtons.contains(.right) ? .rightMouseDragged
            : heldButtons.contains(.middle) ? .otherMouseDragged
            : .mouseMoved
        let button: CGMouseButton =
            heldButtons.contains(.left) ? .left
            : heldButtons.contains(.right) ? .right
            : heldButtons.contains(.middle) ? .center : .left
        guard
            let event = CGEvent(
                mouseEventSource: source, mouseType: type, mouseCursorPosition: point,
                mouseButton: button)
        else { return }
        event.flags = heldFlags()
        event.post(tap: .cghidEventTap)
    }

    private func postButton(
        _ button: MouseButton, down: Bool, at point: CGPoint, clickState: Int,
        flags: CGEventFlags? = nil
    ) {
        let type: CGEventType
        let cgButton: CGMouseButton
        switch button {
        case .left:
            type = down ? .leftMouseDown : .leftMouseUp
            cgButton = .left
        case .right:
            type = down ? .rightMouseDown : .rightMouseUp
            cgButton = .right
        case .middle:
            type = down ? .otherMouseDown : .otherMouseUp
            cgButton = .center
        }
        guard
            let event = CGEvent(
                mouseEventSource: source, mouseType: type, mouseCursorPosition: point,
                mouseButton: cgButton)
        else { return }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        event.flags = flags ?? heldFlags()
        event.post(tap: .cghidEventTap)
        lastGlobalPoint = point
    }

    private func postKey(_ key: CGKeyCode, down: Bool, extra: CGEventFlags) {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
        else { return }
        var flags = extra.union(heldFlags())
        // A modifier's own down event must carry its flag, or the app sees the
        // keypress without the modifier it is announcing.
        if down, let own = Keymap.flag(forHeldKey: key) { flags.insert(own) }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    /// Types literal text into whatever has focus.
    ///
    /// Virtual key 0 with an attached unicode string types the character
    /// whatever the active keyboard layout is, which no keycode table can do.
    /// Graphemes, not scalars, so an emoji or a combining accent arrives whole.
    private func type(_ text: String) {
        for character in text {
            let units = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            else { continue }
            down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            down.post(tap: .cghidEventTap)
            usleep(keystrokeGapMicroseconds)
            up.post(tap: .cghidEventTap)
            usleep(keystrokeGapMicroseconds)
        }
    }
}
