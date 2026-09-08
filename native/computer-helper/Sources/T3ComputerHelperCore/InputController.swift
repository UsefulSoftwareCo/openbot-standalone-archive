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
    ///
    /// Deliberately global rather than keyed by display. There is one physical
    /// keyboard and one pointer on this login session however many screens it
    /// has, and cleanup has to keep working for the display that is no longer
    /// there — which is exactly the case a per-display map could not serve.
    private var heldButtons: Set<MouseButton> = []
    private var heldKeys: Set<CGKeyCode> = []
    private var lastGlobalPoint = CGPoint.zero

    /// Measured, not guessed: at 6ms a receiving app silently swallowed roughly
    /// half of a typed string. Events are posted to the HID tap and delivered
    /// asynchronously, so typing faster than the target's event loop loses
    /// characters with no error anywhere. 15ms types about 33 characters a
    /// second and arrives complete.
    private let keystrokeGap = Duration.milliseconds(15)
    private let clickGapMicroseconds: UInt32 = 40_000

    public init() {}

    public var isTrusted: Bool { AXIsProcessTrusted() }

    /// What one event did.
    private enum EventOutcome {
        case delivered
        case rejected(String)
        /// A text event that cancellation stopped, and how many graphemes it
        /// managed to type first.
        case cancelled(typed: Int)
    }

    /// Delivers a batch in order, reporting per-event rejections rather than
    /// failing the batch: one unknown key should not lose the sentence
    /// after it.
    ///
    /// Cancelling the surrounding task stops the batch promptly — a long text
    /// event stops mid-string — and every event that did not run comes back as
    /// a rejection, so the driver is told what was dropped instead of having to
    /// infer it from a count.
    public func deliver(
        events: [ParsedInputEvent], display: DisplayRecord
    ) async -> (delivered: Int, rejected: [InputRejection]) {
        var delivered = 0
        var rejected: [InputRejection] = []
        var cancelled = false
        for (index, entry) in events.enumerated() {
            switch entry {
            case let .rejected(reason):
                rejected.append(InputRejection(index: index, reason: reason))
            case let .event(event):
                if cancelled || Task.isCancelled {
                    cancelled = true
                    rejected.append(InputRejection(index: index, reason: "cancelled"))
                    continue
                }
                switch await perform(event, on: display) {
                case .delivered:
                    delivered += 1
                case let .rejected(reason):
                    rejected.append(InputRejection(index: index, reason: reason))
                case let .cancelled(typed):
                    cancelled = true
                    rejected.append(
                        InputRejection(
                            index: index, reason: "cancelled after \(typed) characters"))
                }
            }
        }
        return (delivered, rejected)
    }

    /// Performs one event. Only `text` awaits; everything else is a handful of
    /// posts and stays synchronous inside the job.
    private func perform(_ event: InputEvent, on display: DisplayRecord) async -> EventOutcome {
        func global(_ point: CGPoint) -> CGPoint? {
            guard InputGeometry.isInside(point, widthPx: display.widthPx, heightPx: display.heightPx)
            else { return nil }
            let origin = CGDisplayBounds(display.id).origin
            return InputGeometry.globalPoint(point, displayOrigin: origin, scale: display.scale)
        }

        switch event {
        case let .move(point):
            guard let target = global(point) else { return .rejected(offDisplay(point, display)) }
            move(to: target)
            return .delivered

        case let .button(button, down, point):
            guard let target = global(point) else { return .rejected(offDisplay(point, display)) }
            move(to: target)
            postButton(button, down: down, at: target, clickState: 1)
            if down { heldButtons.insert(button) } else { heldButtons.remove(button) }
            return .delivered

        case let .click(button, count, point, modifiers):
            guard let target = global(point) else { return .rejected(offDisplay(point, display)) }
            move(to: target)
            let flags = Keymap.flags(for: modifiers).union(heldFlags())
            for index in 1...count {
                postButton(button, down: true, at: target, clickState: index, flags: flags)
                usleep(clickGapMicroseconds)
                postButton(button, down: false, at: target, clickState: index, flags: flags)
                if index < count { usleep(clickGapMicroseconds) }
            }
            return .delivered

        case let .scroll(point, deltaX, deltaY):
            guard let target = global(point) else { return .rejected(offDisplay(point, display)) }
            let axes = InputGeometry.wheelAxes(deltaX: deltaX, deltaY: deltaY)
            guard
                let scroll = CGEvent(
                    scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                    wheel1: axes.wheel1, wheel2: axes.wheel2, wheel3: 0)
            else { return .rejected("scroll event could not be created") }
            scroll.location = target
            scroll.flags = heldFlags()
            scroll.post(tap: .cghidEventTap)
            return .delivered

        case let .key(code, down, modifiers):
            guard let key = Keymap.virtualKey(for: code) else { return .rejected(unknownKey(code)) }
            postKey(key, down: down, extra: Keymap.flags(for: modifiers))
            if down { heldKeys.insert(key) } else { heldKeys.remove(key) }
            return .delivered

        case let .keyPress(code, modifiers):
            guard let key = Keymap.virtualKey(for: code) else { return .rejected(unknownKey(code)) }
            let extra = Keymap.flags(for: modifiers)
            postKey(key, down: true, extra: extra)
            usleep(8_000)
            postKey(key, down: false, extra: extra)
            return .delivered

        case let .text(text):
            switch await type(text) {
            case .completed:
                return .delivered
            case let .cancelled(typed):
                return .cancelled(typed: typed)
            }

        case .releaseAll:
            releaseAll()
            return .delivered
        }
    }

    private func offDisplay(_ point: CGPoint, _ display: DisplayRecord) -> String {
        "point (\(Int(point.x)), \(Int(point.y))) is outside display \(display.id)"
            + " (\(display.widthPx)x\(display.heightPx))"
    }

    private func unknownKey(_ code: String) -> String {
        "unknown key code '\(code)'; expected a W3C KeyboardEvent.code such as 'KeyA' or 'ArrowLeft'"
    }

    /// True while a button or key is still down.
    ///
    /// Cleanup paths that are not answering a request — a monitor being
    /// unplugged — use this so they post releases only when something is
    /// actually held.
    public var hasHeldInput: Bool { !heldButtons.isEmpty || !heldKeys.isEmpty }

    /// Delivers the `release-all` events of a batch whose display could not be
    /// resolved, and rejects the rest.
    ///
    /// Every other event kind names a point or expects a focused screen, so
    /// those genuinely need the display and come back as rejections. The
    /// release does not, and running it here is what keeps an unplugged monitor
    /// from leaving a button down on the desktop the user is still looking at.
    ///
    /// - Parameter reason: why the other events could not run, reported per
    ///   event so the driver learns what was dropped.
    public func releaseWithoutDisplay(
        events: [ParsedInputEvent], reason: String
    ) -> (delivered: Int, rejected: [InputRejection]) {
        // Before anything else in the batch is judged: cleanup must not depend
        // on the outcome of the events around it.
        if events.contains(.event(.releaseAll)) { releaseAll() }
        var delivered = 0
        var rejected: [InputRejection] = []
        for (index, entry) in events.enumerated() {
            switch entry {
            case let .rejected(why):
                rejected.append(InputRejection(index: index, reason: why))
            case .event(.releaseAll):
                delivered += 1
            case .event:
                rejected.append(InputRejection(index: index, reason: reason))
            }
        }
        return (delivered, rejected)
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

    /// Types literal text into whatever has focus, paced and cancellable.
    ///
    /// Virtual key 0 with an attached unicode string types the character
    /// whatever the active keyboard layout is, which no keycode table can do.
    /// The pacing and the cancellation live in `TextDeliveryJob`; this supplies
    /// the posting.
    private func type(_ text: String) async -> TextDeliveryJob.Outcome {
        let source = self.source
        let job = TextDeliveryJob(text: text, gap: keystrokeGap) { grapheme, phase in
            guard
                let event = CGEvent(
                    keyboardEventSource: source, virtualKey: 0, keyDown: phase == .down)
            else { return }
            let units = Array(grapheme.utf16)
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            event.post(tap: .cghidEventTap)
        }
        return await job.run()
    }
}
