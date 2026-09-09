import AppKit
import ApplicationServices
import CoreGraphics

/// Starts an application on the shared desktop, optionally on one screen.
@MainActor
public enum AppLauncher {

    /// Resolves `app` the way a person would mean it: a path to a bundle, a
    /// bundle identifier, or a plain name that is an app in one of the usual
    /// folders.
    public static func resolve(_ app: String) -> URL? {
        let workspace = NSWorkspace.shared
        if app.hasSuffix(".app") || app.hasPrefix("/") {
            let url = URL(fileURLWithPath: app)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        if app.contains("."), let url = workspace.urlForApplication(withBundleIdentifier: app) {
            return url
        }
        let name = app.hasSuffix(".app") ? app : "\(app).app"
        for folder in ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                       NSHomeDirectory() + "/Applications"] {
            let candidate = URL(fileURLWithPath: folder).appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    /// Starts one app and answers its pid.
    ///
    /// Injected so a test can prove the Accessibility preflight happens before
    /// anything is spawned, without spawning anything.
    public typealias Spawn = @MainActor (URL, [String]) async throws -> pid_t

    /// What a launch actually achieved, which is not the same as whether it
    /// started something.
    public struct Outcome: Sendable, Equatable {
        public let pid: pid_t?
        /// How many of the new app's windows were verified to be on the
        /// requested display afterwards, or nil when no display was requested
        /// and placement was therefore never attempted.
        ///
        /// Verified, not attempted: a window is counted only when reading its
        /// frame back attributes it to that display. Zero is the honest and
        /// important case — the app started and whatever it opened is wherever
        /// the app put it, usually the user's own screen — and it covers both
        /// no window appearing within the budget and windows that appeared and
        /// would not move. A caller that reports either as success is lying to
        /// someone who is about to be surprised.
        public let placedWindows: Int?

        public init(pid: pid_t?, placedWindows: Int?) {
            self.pid = pid
            self.placedWindows = placedWindows
        }

        /// True only when a placement was asked for and at least one window
        /// landed on the requested display.
        public var placed: Bool? { placedWindows.map { $0 > 0 } }
    }

    /// Which of a process's windows this launch is allowed to move.
    ///
    /// `openBeforeLaunch` is nil when the spawn created the process: every
    /// window it has is one the launch caused, and all of them are ours to
    /// place. It is the set of windows the process already had when the spawn
    /// returned in the other case — an app that ignored
    /// `createsNewApplicationInstance` and reused a process the user was
    /// already working in. Those windows are the user's; moving them onto a
    /// chat's screen would take away whatever they had open, so they are left
    /// exactly where they are.
    ///
    /// A window Accessibility cannot name (id 0) is indistinguishable from one
    /// that was already there, so in a reused process it is left alone too.
    /// Skipping a genuinely new window costs a placement the caller is told
    /// about; moving one of the user's windows cannot be undone.
    public static func newWindowIds(
        _ ids: [CGWindowID], openBeforeLaunch: Set<CGWindowID>?
    ) -> [CGWindowID] {
        guard let openBeforeLaunch else { return ids }
        return ids.filter { $0 != 0 && !openBeforeLaunch.contains($0) }
    }

    /// Launches the app and, when a display is named, moves the windows the
    /// launch created onto it.
    ///
    /// Every new window is moved, not just the first: some apps restore a
    /// session window alongside the new one, and anything skipped is stranded
    /// on the main display. Only windows the launch created, though — see
    /// `newWindowIds`.
    ///
    /// When a display is named, Accessibility is checked *before* anything is
    /// launched. Without it there is no way to find the new window and no way
    /// to move it, so launching first would put the app on the user's own
    /// screen and only then discover that the request could not be honoured —
    /// and nothing can put that window back.
    ///
    /// Even with the grant this cannot promise the window is never briefly
    /// visible elsewhere: the app is activated as it starts, and an ordinary
    /// app start paints its window where it pleases before there is anything
    /// to move.
    ///
    /// - Parameters:
    ///   - isTrusted: whether Accessibility is granted.
    ///   - spawn: how the app is started.
    public static func launch(
        app: String, arguments: [String], display: DisplayRecord?,
        isTrusted: @MainActor () -> Bool = { AXIsProcessTrusted() },
        spawn: Spawn = AppLauncher.workspaceSpawn
    ) async throws -> Outcome {
        guard let url = resolve(app) else {
            throw HelperError(.invalidInput, "no application matches '\(app)'")
        }
        if display != nil, !isTrusted() {
            throw HelperError(
                .permissionDenied,
                "Accessibility is required to open apps on a chat's screen; without it the window"
                    + " would open on your own screen")
        }

        // Taken before the spawn, so a pid that comes back having existed
        // already is recognisable as a process the app reused rather than one
        // the launch created.
        let pidsBeforeSpawn = Set(
            NSWorkspace.shared.runningApplications.map(\.processIdentifier))

        let pid: pid_t
        do {
            pid = try await spawn(url, arguments)
        } catch {
            throw HelperError(
                .backendUnavailable,
                "'\(app)' could not be launched: \(error.localizedDescription)")
        }
        guard let display else { return Outcome(pid: pid, placedWindows: nil) }

        // `createsNewApplicationInstance` is a request, not a guarantee: an app
        // that refuses a second instance hands back the pid of the one the user
        // is already working in. Its windows at this moment are the user's, and
        // this launch will not touch them.
        let openBeforeLaunch: Set<CGWindowID>? =
            pidsBeforeSpawn.contains(pid) ? WindowInspector.windowNumbers(pid: pid) : nil

        // Nothing in macOS carries "open this on that screen", so the window has
        // to be spotted after it appears. Ten seconds is the budget a cold app
        // start needs; past that the window is left where the app put it, and
        // the caller is told that no window was placed rather than being told
        // the launch succeeded.
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            let windows = WindowInspector.windowElements(pid: pid)
            let ids = windows.map(WindowInspector.windowNumber(of:))
            let ours = Set(newWindowIds(ids, openBeforeLaunch: openBeforeLaunch))
            let candidates = zip(windows, ids).filter { ours.contains($0.1) }.map(\.0)
            guard !candidates.isEmpty else { continue }
            return Outcome(
                pid: pid, placedWindows: await placeAll(candidates, on: display, app: app))
        }
        return Outcome(pid: pid, placedWindows: 0)
    }

    /// Moves each window onto `display` and answers how many are there
    /// afterwards.
    ///
    /// Windows that did not land on the first read get one more look a beat
    /// later: some apps accept a frame and then adjust it, and reporting such a
    /// window as stranded when it arrived a moment later would be its own kind
    /// of lie. Nothing is retried, closed or hidden — a window that will not
    /// move stays where the app wants it and is simply not counted.
    private static func placeAll(
        _ windows: [AXUIElement], on display: DisplayRecord, app: String
    ) async -> Int {
        var landed = 0
        var pending: [AXUIElement] = []
        var failures: [String] = []
        for (index, window) in windows.enumerated() {
            let placement = WindowInspector.place(
                window, on: display, inset: 60 + CGFloat(index) * 28)
            if placement.landed {
                landed += 1
            } else {
                pending.append(window)
                if let detail = placement.detail { failures.append(detail) }
            }
        }
        if !pending.isEmpty {
            try? await Task.sleep(nanoseconds: 250_000_000)
            landed += pending.filter { WindowInspector.isPlaced($0, on: display) }.count
        }
        if landed < windows.count {
            // Not an error: the launch happened and the reply says how many
            // windows landed. The AX codes only exist in the log, because the
            // record's shape is what the server decodes.
            helperLog(
                "launch of '\(app)': \(landed) of \(windows.count) windows on display"
                    + " \(display.id)"
                    + (failures.isEmpty ? "" : " (\(failures.joined(separator: "; ")))"))
        }
        return landed
    }

    /// The production spawn: a second instance through Launch Services, so a
    /// server's launch is its own process rather than a new window in whatever
    /// the user already had open.
    ///
    /// `activates` stays true. It is what brings the new app frontmost, which
    /// is what makes the window findable and, once placed, typeable into — a
    /// window placed on a chat's screen while the app stays in the background
    /// takes no keyboard input at all.
    public static func workspaceSpawn(url: URL, arguments: [String]) async throws -> pid_t {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = arguments
        configuration.activates = true
        configuration.createsNewApplicationInstance = true
        let running = try await NSWorkspace.shared.openApplication(
            at: url, configuration: configuration)
        return running.processIdentifier
    }
}
