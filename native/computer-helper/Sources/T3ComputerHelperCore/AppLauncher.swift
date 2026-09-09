import AppKit

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
        /// How many of the new app's windows were moved onto the requested
        /// display, or nil when no display was requested and placement was
        /// therefore never attempted.
        ///
        /// Zero is the honest and important case: the app started, no window
        /// of it could be found within the budget, and whatever it did open is
        /// wherever the app put it — the user's own screen, usually. A caller
        /// that reports that as success is lying to someone who is about to be
        /// surprised.
        public let placedWindows: Int?

        public init(pid: pid_t?, placedWindows: Int?) {
            self.pid = pid
            self.placedWindows = placedWindows
        }

        /// True only when a placement was asked for and at least one window
        /// landed on the requested display.
        public var placed: Bool? { placedWindows.map { $0 > 0 } }
    }

    /// Launches the app and, when a display is named, moves the windows the
    /// launch created onto it.
    ///
    /// Every new window is moved, not just the first: some apps restore a
    /// session window alongside the new one, and anything skipped is stranded
    /// on the main display.
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

        let pid: pid_t
        do {
            pid = try await spawn(url, arguments)
        } catch {
            throw HelperError(
                .backendUnavailable,
                "'\(app)' could not be launched: \(error.localizedDescription)")
        }
        guard let display else { return Outcome(pid: pid, placedWindows: nil) }

        // Nothing in macOS carries "open this on that screen", so the window has
        // to be spotted after it appears. Ten seconds is the budget a cold app
        // start needs; past that the window is left where the app put it, and
        // the caller is told that no window was placed rather than being told
        // the launch succeeded.
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            let windows = WindowInspector.windowElements(pid: pid)
            guard !windows.isEmpty else { continue }
            for (index, window) in windows.enumerated() {
                WindowInspector.place(window, on: display, inset: 60 + CGFloat(index) * 28)
            }
            return Outcome(pid: pid, placedWindows: windows.count)
        }
        return Outcome(pid: pid, placedWindows: 0)
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
