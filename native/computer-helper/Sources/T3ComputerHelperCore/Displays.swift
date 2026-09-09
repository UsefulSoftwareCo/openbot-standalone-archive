import AppKit
import CoreGraphics
import T3VirtualDisplay

/// The screens on this login session, and the virtual ones we own.
///
/// A managed display is another *screen* on the same session, not a private
/// desktop. Nothing here ever touches a physical display's mode, arrangement or
/// mirroring: the user is looking at those.
@MainActor
public final class DisplayRegistry {
    /// Called when the display list moves under us — hotplug, resolution
    /// change, or a virtual display the window server took away.
    public var onDisplaysChanged: (@Sendable () -> Void)?

    private var managed: Set<CGDirectDisplayID> = []
    private var nextManagedIndex = 1

    public init() {}

    /// Registers for CoreGraphics reconfiguration callbacks and for the window
    /// server terminating one of our virtual displays.
    public func startWatching() {
        DisplayRegistry.current = self
        CGDisplayRegisterReconfigurationCallback(
            { _, flags, _ in
                // `beginConfiguration` is the "about to change" half; reporting
                // it would publish a list that is still the old one.
                guard !flags.contains(.beginConfigurationFlag) else { return }
                Task { @MainActor in DisplayRegistry.current?.publishChange() }
            }, nil)
        T3VirtualDisplayHost.shared().onTerminated = { displayID in
            Task { @MainActor in
                DisplayRegistry.current?.managed.remove(displayID)
                DisplayRegistry.current?.publishChange()
            }
        }
    }

    /// The registry the C reconfiguration callback belongs to. There is exactly
    /// one per process and the callback takes no context we control, so a
    /// main-actor static is the honest way to name it.
    private static var current: DisplayRegistry?

    private func publishChange() {
        onDisplaysChanged?()
    }

    /// Every screen on this session.
    public func list() -> [DisplayRecord] {
        DisplayRegistry.onlineDisplayIds()
            .enumerated()
            .map { index, id in record(for: id, ordinal: index + 1) }
    }

    /// The ids of every screen on this session, in the window server's order.
    ///
    /// The *online* list, not the active one. Measured on macOS 26.5: while the
    /// screen is locked `CGGetActiveDisplayList` reports zero displays and
    /// `CGGetOnlineDisplayList` still reports all of them. Using the active list
    /// would make every display vanish from the UI the moment the user locked
    /// their Mac, which reads as a broken host rather than a locked one.
    /// Secondary displays in a mirroring set are dropped so a mirrored pair is
    /// one entry, which is what the active list was giving us.
    ///
    /// Static because attribution needs the screen list without needing the
    /// registry that owns the virtual ones: `FocusGuard` runs inside an input
    /// batch and asks only where the screens are.
    public static func onlineDisplayIds() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetOnlineDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count))
            .filter { CGDisplayMirrorsDisplay($0) == kCGNullDirectDisplay }
    }

    public func find(_ id: CGDirectDisplayID) -> DisplayRecord? {
        list().first { $0.id == id }
    }

    public func isManaged(_ id: CGDirectDisplayID) -> Bool { managed.contains(id) }

    public func mainDisplayId() -> CGDirectDisplayID { CGMainDisplayID() }

    /// Pixels per point for one display, used to turn a client's pixel point
    /// back into the point space CoreGraphics posts events in.
    public func scale(of id: CGDirectDisplayID) -> Double {
        let bounds = CGDisplayBounds(id)
        guard bounds.width > 0 else { return 1 }
        return Double(pixelSize(of: id).width) / Double(bounds.width)
    }

    private func record(for id: CGDirectDisplayID, ordinal: Int) -> DisplayRecord {
        let size = pixelSize(of: id)
        let bounds = CGDisplayBounds(id)
        let scale = bounds.width > 0 ? Double(size.width) / Double(bounds.width) : 1
        let isManaged = managed.contains(id)
        return DisplayRecord(
            id: id,
            name: name(of: id) ?? (isManaged ? "Managed Display \(ordinal)" : "Display \(ordinal)"),
            kind: isManaged ? .managedVirtual : .physical,
            widthPx: size.width,
            heightPx: size.height,
            scale: scale,
            main: CGDisplayIsMain(id) != 0)
    }

    /// The backing pixel dimensions.
    ///
    /// `CGDisplayPixelsWide` reports the *mode* size, which on a scaled Retina
    /// display is points, not pixels. The display mode's `pixelWidth` is the
    /// only value that matches what a capture actually produces, so a frame and
    /// the coordinates a client sends back agree.
    private func pixelSize(of id: CGDirectDisplayID) -> (width: Int, height: Int) {
        if let mode = CGDisplayCopyDisplayMode(id), mode.pixelWidth > 0 {
            return (mode.pixelWidth, mode.pixelHeight)
        }
        return (CGDisplayPixelsWide(id), CGDisplayPixelsHigh(id))
    }

    private func name(of id: CGDirectDisplayID) -> String? {
        NSScreen.screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id
        }?.localizedName
    }

    // MARK: - Managed displays

    public func createDisplay(name: String?, widthPx: Int, heightPx: Int, hiDpi: Bool) throws -> DisplayRecord {
        let label = name ?? "OpenBot Display \(nextManagedIndex)"
        let id = T3VirtualDisplayHost.shared().createDisplay(
            named: label, width: UInt32(widthPx), height: UInt32(heightPx), hiDPI: hiDpi)
        guard id != 0 else {
            throw HelperError(
                .captureFailed,
                "the window server refused a \(widthPx)x\(heightPx) virtual display")
        }
        nextManagedIndex += 1
        managed.insert(id)
        publishChange()
        guard let record = find(id) else {
            // Created but not yet in the active list; report what we asked for
            // rather than failing a request that in fact succeeded.
            return DisplayRecord(
                id: id, name: label, kind: .managedVirtual, widthPx: widthPx, heightPx: heightPx,
                scale: hiDpi ? 2 : 1, main: false)
        }
        return record
    }

    public func destroyDisplay(_ id: CGDirectDisplayID) throws {
        guard managed.contains(id) else {
            throw HelperError(
                .displayNotFound,
                "display \(id) was not created by this helper, so it will not be destroyed")
        }
        managed.remove(id)
        _ = T3VirtualDisplayHost.shared().destroyDisplay(id)
        publishChange()
    }

    /// Called on every exit path. A virtual display that outlives its owner is
    /// a monitor the user can neither see nor remove.
    public func destroyAllManagedDisplays() {
        managed.removeAll()
        T3VirtualDisplayHost.shared().destroyAllDisplays()
    }
}
