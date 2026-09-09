import AppKit
import ApplicationServices

/// The AX API has no public way back to a CoreGraphics window id, and a window
/// needs a stable id to be named on the wire twice running.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(
    _ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>
) -> AXError

/// What is on the shared desktop, through Accessibility.
///
/// Deliberately not `CGWindowListCopyWindowInfo`. Without Screen Recording that
/// call does not fail, it returns an empty list — measured on macOS 15.7, where
/// it reported zero windows while AX listed every one. Silence is the worst
/// failure mode available, and it would tie "what is on this screen?" to the
/// same grant as the video stream, so a host that can place windows and forward
/// clicks could not say what it had placed. AX needs only the Accessibility
/// grant the helper already holds to move windows and post input, so window
/// inspection costs no extra permission.
@MainActor
public enum WindowInspector {

    public static func list(displays: [DisplayRecord]) throws -> [WindowRecord] {
        guard AXIsProcessTrusted() else {
            throw HelperError(
                .permissionDenied,
                "Accessibility permission is required to list windows")
        }
        let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        var records: [WindowRecord] = []
        for application in NSWorkspace.shared.runningApplications
        where application.activationPolicy == .regular {
            let pid = application.processIdentifier
            let app = application.localizedName ?? "unknown"
            for element in windowElements(pid: pid) {
                let number = windowNumber(of: element)
                guard let frame = frame(of: element) else { continue }
                let display = bestDisplay(for: frame, among: displays)
                let local = display.map { localFrame(frame, on: $0) } ?? frame
                records.append(
                    WindowRecord(
                        id: "\(pid):\(number)",
                        displayId: display?.id,
                        title: stringAttribute(element, kAXTitleAttribute) ?? "",
                        app: app,
                        pid: pid,
                        x: local.origin.x, y: local.origin.y,
                        width: local.width, height: local.height,
                        focused: (boolAttribute(element, kAXMainAttribute) ?? false)
                            && pid == frontmostPid,
                        minimized: boolAttribute(element, kAXMinimizedAttribute) ?? false))
            }
        }
        return records
    }

    /// Raises a window and activates its app, which is the pair that actually
    /// moves focus: raising alone leaves the app behind whatever was frontmost.
    public static func focus(windowId: String) throws {
        guard AXIsProcessTrusted() else {
            throw HelperError(
                .permissionDenied,
                "Accessibility permission is required to focus a window")
        }
        let parts = windowId.split(separator: ":", maxSplits: 1)
        guard parts.count == 2, let pid = pid_t(parts[0]), let number = CGWindowID(parts[1]) else {
            throw HelperError(.invalidInput, "'\(windowId)' is not a 'pid:windowId' handle")
        }
        for element in windowElements(pid: pid) {
            guard windowNumber(of: element) == number else { continue }
            AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
            AXUIElementPerformAction(element, kAXRaiseAction as CFString)
            NSRunningApplication(processIdentifier: pid)?.activate()
            return
        }
        throw HelperError(.windowNotFound, "no window \(windowId) is open")
    }

    /// What a move achieved, which is not what asking for it achieved: an app
    /// may refuse a frame, clamp it, or accept the call and put the window
    /// somewhere else entirely.
    public struct Placement: Sendable, Equatable {
        /// True when the window is attributed to the requested display now.
        public let landed: Bool
        /// Why the request itself did not go through, when it did not: the AX
        /// result codes, for the log. A window can fail to land with no detail
        /// at all — every call succeeded and the app moved itself back.
        public let detail: String?

        public init(landed: Bool, detail: String?) {
            self.landed = landed
            self.detail = detail
        }
    }

    /// Moves one window onto a display, used after launching an app there, and
    /// reports whether it is there afterwards.
    ///
    /// Nothing in macOS carries "open this on that screen": an app places its
    /// own new windows from a saved position, almost always on the main
    /// display. Spotting the window and moving it is the only way to honour the
    /// caller's intent.
    ///
    /// The frame is read back rather than assumed. `AXUIElementSetAttributeValue`
    /// reports only that the app accepted the message: a window pinned to a
    /// size, a full-screen space, or an app that repositions itself all end
    /// with the window somewhere the caller did not ask for, and a launch that
    /// counted the attempts would claim a screen it never reached.
    public static func place(_ window: AXUIElement, on display: DisplayRecord, inset: CGFloat)
        -> Placement
    {
        let bounds = CGDisplayBounds(display.id)
        var origin = CGPoint(x: bounds.minX + inset, y: bounds.minY + inset)
        var size = CGSize(width: bounds.width - inset * 2, height: bounds.height - inset * 2)
        var failures: [String] = []
        if let value = AXValueCreate(.cgPoint, &origin) {
            let result = AXUIElementSetAttributeValue(
                window, kAXPositionAttribute as CFString, value)
            if result != .success { failures.append("position AXError \(result.rawValue)") }
        }
        if let value = AXValueCreate(.cgSize, &size) {
            let result = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value)
            if result != .success { failures.append("size AXError \(result.rawValue)") }
        }
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        return Placement(
            landed: isPlaced(window, on: display),
            detail: failures.isEmpty ? nil : failures.joined(separator: ", "))
    }

    /// Whether a window is on `display` right now, by the same attribution
    /// `list` and `FocusGuard` use.
    ///
    /// Also read a beat after a move: some apps accept a frame and then adjust
    /// it, so one read immediately after the set is not the last word.
    public static func isPlaced(_ window: AXUIElement, on display: DisplayRecord) -> Bool {
        DisplayAttribution.isOwned(frame(of: window), by: display.id, among: onlineScreens())
    }

    /// Every screen on this session, as attribution candidates.
    static func onlineScreens() -> [DisplayAttribution.Screen] {
        DisplayRegistry.onlineDisplayIds().map {
            .init(id: $0, bounds: CGDisplayBounds($0))
        }
    }

    public static func windowElements(pid: pid_t) -> [AXUIElement] {
        let app = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
            let windows = value as? [AXUIElement]
        else { return [] }
        return windows
    }

    public static func windowNumbers(pid: pid_t) -> Set<CGWindowID> {
        var numbers: Set<CGWindowID> = []
        for element in windowElements(pid: pid) {
            let number = windowNumber(of: element)
            // 0 means AX could not name the window. Keeping it would make every
            // unnameable new window look like one that was already there.
            if number != 0 { numbers.insert(number) }
        }
        return numbers
    }

    /// The CoreGraphics id of one window, or 0 when AX cannot name it.
    public static func windowNumber(of element: AXUIElement) -> CGWindowID {
        var number: CGWindowID = 0
        _ = _AXUIElementGetWindow(element, &number)
        return number
    }

    /// The display a window is listed under, by the shared attribution rule.
    ///
    /// `bounds` is injected so the mapping can be exercised on fixtures — and
    /// so a test can prove this and `FocusGuard` answer the same question the
    /// same way, which is the whole reason both go through
    /// `DisplayAttribution`.
    static func bestDisplay(
        for frame: CGRect, among displays: [DisplayRecord],
        bounds: (CGDirectDisplayID) -> CGRect = { CGDisplayBounds($0) }
    ) -> DisplayRecord? {
        let screens = displays.map { DisplayAttribution.Screen(id: $0.id, bounds: bounds($0.id)) }
        guard let owner = DisplayAttribution.owner(of: frame, among: screens) else { return nil }
        return displays.first { $0.id == owner }
    }

    /// A global point-space frame in one display's pixel space, which is the
    /// space every coordinate on this wire is stated in.
    static func localFrame(_ frame: CGRect, on display: DisplayRecord) -> CGRect {
        let origin = CGDisplayBounds(display.id).origin
        let scale = display.scale > 0 ? display.scale : 1
        return CGRect(
            x: (frame.origin.x - origin.x) * scale,
            y: (frame.origin.y - origin.y) * scale,
            width: frame.width * scale,
            height: frame.height * scale)
    }

    static func frame(of window: AXUIElement) -> CGRect? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionValue)
                == .success,
            AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeValue)
                == .success,
            let positionValue, let sizeValue
        else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        // `as? AXValue` always succeeds for any CFType, so the type id is
        // checked explicitly before the cast.
        guard CFGetTypeID(positionValue) == AXValueGetTypeID(),
            CFGetTypeID(sizeValue) == AXValueGetTypeID()
        else { return nil }
        let position = unsafeDowncast(positionValue, to: AXValue.self)
        let extent = unsafeDowncast(sizeValue, to: AXValue.self)
        guard
            AXValueGetValue(position, .cgPoint, &origin),
            AXValueGetValue(extent, .cgSize, &size)
        else { return nil }
        return CGRect(origin: origin, size: size)
    }

    static func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return nil }
        return value as? String
    }

    static func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var value: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return nil }
        return (value as? NSNumber)?.boolValue
    }
}
