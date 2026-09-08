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

    /// Launches the app and, when a display is named, moves the windows the
    /// launch created onto it.
    ///
    /// Every new window is moved, not just the first: some apps restore a
    /// session window alongside the new one, and anything skipped is stranded
    /// on the main display.
    public static func launch(
        app: String, arguments: [String], display: DisplayRecord?
    ) async throws -> pid_t? {
        guard let url = resolve(app) else {
            throw HelperError(.invalidInput, "no application matches '\(app)'")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = arguments
        configuration.activates = true
        // A second instance, so a server's launch is its own process rather
        // than a new window in whatever the user already had open.
        configuration.createsNewApplicationInstance = true

        let running: NSRunningApplication
        do {
            running = try await NSWorkspace.shared.openApplication(
                at: url, configuration: configuration)
        } catch {
            throw HelperError(
                .backendUnavailable,
                "'\(app)' could not be launched: \(error.localizedDescription)")
        }
        let pid = running.processIdentifier
        guard let display, AXIsProcessTrusted() else { return pid }

        // Nothing in macOS carries "open this on that screen", so the window has
        // to be spotted after it appears. Ten seconds is the budget a cold app
        // start needs; past that the window is left where the app put it rather
        // than the request failing.
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            let windows = WindowInspector.windowElements(pid: pid)
            guard !windows.isEmpty else { continue }
            for (index, window) in windows.enumerated() {
                WindowInspector.place(window, on: display, inset: 60 + CGFloat(index) * 28)
            }
            return pid
        }
        return pid
    }
}
