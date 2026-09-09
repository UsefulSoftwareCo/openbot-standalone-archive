import AppKit
import CoreGraphics
import Foundation

/// The helper, as one command loop.
///
/// Everything here runs on the main actor because CGVirtualDisplay,
/// ScreenCaptureKit and Accessibility all need the main run loop; the only work
/// that leaves it is JPEG encoding on ScreenCaptureKit's queue and the writer's
/// own serial queue.
@MainActor
public final class HelperService {
    private let displays = DisplayRegistry()
    private let input = InputController()
    /// Input batches run here rather than on the command chain, so a paced text
    /// event cannot hold up the commands that would stop it.
    private let inputJobs = InputJobQueue()
    private let capture = CaptureManager()
    /// Nil until a driver connects, and in socket mode until it authenticates.
    private var connection: Connection?
    /// The current writer, reachable from ScreenCaptureKit's queue.
    private let frameWriter = WriterBox()
    /// The tail of the command chain.
    ///
    /// Commands are handled strictly one at a time and in arrival order. Some
    /// of them await — a capture start, a screenshot — and without this chain a
    /// slow one would let the command behind it overtake it, which for input
    /// means a keystroke landing before the click that focused the field.
    ///
    /// Input joins this chain only long enough to be parsed and queued: its
    /// delivery is paced and can run for minutes, and nothing else may wait
    /// behind that.
    private var commandChain: Task<Void, Never>?
    private var authenticated: Bool
    private let token: String?
    private var lastPermissions: PermissionsRecord
    private var permissionTimer: Timer?
    /// The screens seen at the last reconfiguration, so the next one can name
    /// the ones that went away rather than only that something moved.
    private var knownDisplayIds: Set<CGDirectDisplayID> = []

    /// Called when the helper decides it is done, so `main` can tear the
    /// process down on the same path signals use.
    public var onShutdown: (@Sendable () -> Void)?

    public init(token: String?) {
        self.token = token
        // Stdio mode has no token, and its peer is our own parent, so there is
        // nothing to authenticate.
        self.authenticated = token == nil
        self.lastPermissions = HelperService.readPermissions()
    }

    // MARK: - Lifecycle

    public func start() {
        displays.startWatching()
        knownDisplayIds = Set(displays.list().map(\.id))
        displays.onDisplaysChanged = { [weak self] in
            Task { @MainActor in self?.displaysChanged() }
        }
        let frameWriter = self.frameWriter
        capture.onFrame = { displayId, width, height, jpeg in
            frameWriter.current()?.sendFrame(
                .frame(
                    id: nil, displayId: displayId, widthPx: width, heightPx: height,
                    capturedAtMs: Date().timeIntervalSince1970 * 1000, payload: jpeg))
        }
        capture.onStopped = { [weak self] displayId, message in
            Task { @MainActor in
                self?.emit(
                    .error(
                        id: nil, code: .captureFailed,
                        message: "capture of display \(displayId) stopped: \(message)"))
            }
        }
        // There is no notification when a TCC grant changes, and the server has
        // to be able to stop saying "denied" the moment the user says yes.
        // Two preflight calls every few seconds is cheap enough to just poll.
        let timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkPermissions() }
        }
        RunLoop.main.add(timer, forMode: .common)
        permissionTimer = timer
    }

    public func attach(connection: Connection, exitOnDisconnect: Bool) {
        self.connection?.stop()
        self.connection = connection
        self.frameWriter.set(connection.writer)
        self.authenticated = token == nil
        connection.start(
            queue: .main,
            onLine: { [weak self] line in
                Task { @MainActor in
                    self?.chain { await self?.handle(line: line) }
                }
            },
            onEnd: { [weak self] in
                Task { @MainActor in
                    // Through the same chain, or the disconnect tears the
                    // service down while the commands ahead of it are still
                    // queued and their replies are never written.
                    self?.chain { await self?.disconnected(exitOnDisconnect: exitOnDisconnect) }
                }
            })
    }

    /// Appends work to the chain, so everything the driver sends is handled in
    /// arrival order and no two pieces overlap.
    private func chain(_ work: @escaping @MainActor @Sendable () async -> Void) {
        let previous = commandChain
        commandChain = Task { @MainActor in
            await previous?.value
            await work()
        }
    }

    private func disconnected(exitOnDisconnect: Bool) async {
        // A driver that vanished mid-drag would otherwise leave the mouse
        // button down for the human sitting at this machine — and one that
        // vanished mid-sentence would keep typing into their session for
        // another two minutes. Cancel first, release second: releasing while
        // a batch is still delivering just presses everything again.
        inputJobs.cancelAll()
        input.releaseAll()
        await capture.stopAll()
        frameWriter.set(nil)
        connection?.stop()
        connection = nil
        if exitOnDisconnect { shutdown() }
    }

    /// Every exit path runs this. A virtual display that outlives its owner is
    /// a monitor the user can neither see nor remove, and a capture that
    /// outlives it holds the Screen Recording indicator on.
    public func shutdown() {
        permissionTimer?.invalidate()
        permissionTimer = nil
        inputJobs.cancelAll()
        input.releaseAll()
        displays.destroyAllManagedDisplays()
        let capture = self.capture
        Task { @MainActor in
            await capture.stopAll()
            // Cancelled batches answer their requests as they unwind, so let
            // the queue drain before the writer is flushed.
            await self.inputJobs.settle()
            // The reply to `shutdown` is still in the writer's queue.
            self.connection?.writer.flush()
            self.onShutdown?()
        }
    }

    /// Synchronous teardown for a signal handler, which cannot await.
    public func shutdownNow() {
        permissionTimer?.invalidate()
        permissionTimer = nil
        inputJobs.cancelAll()
        input.releaseAll()
        displays.destroyAllManagedDisplays()
        connection?.writer.flush()
    }

    // MARK: - Output

    private func emit(_ record: Record) {
        connection?.writer.send(record)
    }

    /// A screen appeared or disappeared.
    ///
    /// When one disappeared, whatever was held on it can no longer be released
    /// against it — the driver's own `release-all` would arrive for a display
    /// that is gone. Held state is global, so releasing here is both possible
    /// and the only thing that keeps an unplugged monitor from leaving a button
    /// down on the desktop the user is still sitting at.
    private func displaysChanged() {
        let current = Set(displays.list().map(\.id))
        let vanished = knownDisplayIds.subtracting(current)
        knownDisplayIds = current
        if !vanished.isEmpty, input.hasHeldInput { input.releaseAll() }
        emit(.event(name: "displays-changed"))
    }

    private func checkPermissions() {
        let current = HelperService.readPermissions()
        guard current != lastPermissions else { return }
        lastPermissions = current
        emit(.event(name: "permissions-changed"))
    }

    /// Reports, never prompts. `request-permissions` is the one command that
    /// may put a dialog on the user's screen, so a status poll cannot surprise
    /// someone with one.
    static func readPermissions() -> PermissionsRecord {
        PermissionsRecord(
            screenCapture: CGPreflightScreenCaptureAccess() ? .granted : .denied,
            accessibility: AXIsProcessTrusted() ? .granted : .denied)
    }

    // MARK: - Commands

    private func handle(line: Data) async {
        let command: Command
        do {
            command = try Command(line: line)
        } catch let error as HelperError {
            emit(.error(id: nil, code: error.code, message: error.message))
            return
        } catch {
            emit(.error(id: nil, code: .invalidInput, message: "\(error)"))
            return
        }

        if !authenticated {
            guard command.type == "auth", let offered = command.optionalString("token"),
                let token, constantTimeEquals(offered, token)
            else {
                // No error record: an unauthenticated peer learns nothing about
                // why it was refused, and the socket simply closes.
                helperLog("refusing a connection that did not authenticate")
                connection?.stop()
                connection = nil
                return
            }
            authenticated = true
            emit(.authOk)
            return
        }
        if command.type == "auth" {
            emit(.authOk)
            return
        }

        do {
            try await dispatch(command)
        } catch let error as HelperError {
            emit(.error(id: command.id, code: error.code, message: error.message))
        } catch {
            emit(.error(id: command.id, code: .backendUnavailable, message: "\(error)"))
        }
    }

    private func dispatch(_ command: Command) async throws {
        let id = try command.requiredId()
        switch command.type {
        case "hello":
            emit(
                .hello(
                    id: id, pid: ProcessInfo.processInfo.processIdentifier,
                    bundleId: Bundle.main.bundleIdentifier,
                    permissions: HelperService.readPermissions(), displays: displays.list()))

        case "displays":
            emit(.displays(id: id, displays: displays.list()))

        case "windows":
            emit(.windows(id: id, windows: try WindowInspector.list(displays: displays.list())))

        case "focus-window":
            try WindowInspector.focus(windowId: try command.string("windowId"))
            emit(.ok(id: id))

        case "screenshot":
            let display = try requireDisplay(command.displayId())
            let shot = try await capture.screenshot(
                display: display, maxWidthPx: try command.int("maxWidthPx"),
                quality: command.double("quality", default: 0.7))
            emit(
                .frame(
                    id: id, displayId: display.id, widthPx: shot.widthPx, heightPx: shot.heightPx,
                    capturedAtMs: Date().timeIntervalSince1970 * 1000, payload: shot.jpeg))

        case "capture-start":
            let display = try requireDisplay(command.displayId())
            try await capture.start(
                display: display, maxWidthPx: try command.int("maxWidthPx"),
                fps: try command.int("fps"), quality: command.double("quality", default: 0.6))
            emit(.ok(id: id))

        case "capture-stop":
            await capture.stop(displayId: try command.displayId())
            emit(.ok(id: id))

        case "input":
            let events = try command.inputEvents()
            let releases = events.contains(.event(.releaseAll))
            // Cancelling before this batch is queued is what makes `release-all`
            // prompt: it stops a text delivery that could otherwise run for
            // minutes, so the release runs behind a queue that drains at once
            // instead of after the sentence.
            if releases { inputJobs.cancelAll() }
            // Held buttons and keys are global, so a release has no target to
            // resolve — and the batch that most needs to be honoured is the one
            // sent about a display that has just been unplugged. A release-only
            // batch therefore skips the display entirely, and a mixed batch
            // whose display is gone still releases, rejecting only the events
            // that genuinely needed a screen. Resolving first is what used to
            // leave a button down on the desktop the user is looking at.
            guard !Command.isReleaseOnly(events) else {
                enqueueRelease(id: id, events: events, reason: "no display was named")
                return
            }
            let displayId = try command.displayId()
            guard let display = displays.find(displayId) else {
                let reason = "no display \(displayId) is attached"
                guard releases else { throw HelperError(.displayNotFound, reason) }
                enqueueRelease(id: id, events: events, reason: reason)
                return
            }
            // Deliberately not awaited here. The batch answers this command's id
            // when it finishes, and until then the command chain stays free for
            // `capture-stop`, `windows`, and the disconnect cleanup.
            inputJobs.enqueue { [weak self] in
                guard let self else { return }
                let result = await self.input.deliver(events: events, display: display)
                self.emit(
                    .inputResult(id: id, delivered: result.delivered, rejected: result.rejected))
            }

        case "create-display":
            let display = try displays.createDisplay(
                name: command.optionalString("name"),
                widthPx: try command.int("widthPx"), heightPx: try command.int("heightPx"),
                hiDpi: command.bool("hiDpi", default: true))
            emit(.display(id: id, display: display))

        case "destroy-display":
            let displayId = try command.displayId()
            // Input is no longer ordered against this command, so a batch
            // queued for a display that is going away would post at whatever
            // coordinates a destroyed display reports. Cancelling drains the
            // queue in milliseconds; waiting for it to type would not.
            inputJobs.cancelAll()
            await inputJobs.settle()
            // Release before the destroy, never after: once this screen is gone
            // a held button cannot be released against it, and it stays down.
            input.releaseAll()
            await capture.stop(displayId: displayId)
            try displays.destroyDisplay(displayId)
            emit(.ok(id: id))

        case "launch":
            // A named display that is not attached fails here rather than
            // quietly launching onto whatever screen the user is looking at.
            let target =
                command.optionalString("displayId") == nil
                ? nil : try requireDisplay(try command.displayId())
            let outcome = try await AppLauncher.launch(
                app: try command.string("app"), arguments: command.strings("args"),
                display: target)
            emit(.launched(id: id, pid: outcome.pid, placedWindows: outcome.placedWindows))

        case "request-permissions":
            // The only place a prompt may appear. Both calls are no-ops once
            // the grant exists, so a retry is safe.
            _ = CGRequestScreenCaptureAccess()
            _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
            let permissions = HelperService.readPermissions()
            lastPermissions = permissions
            emit(.permissions(id: id, permissions: permissions))

        case "shutdown":
            emit(.ok(id: id))
            shutdown()

        default:
            throw HelperError(.invalidInput, "unknown command '\(command.type)'")
        }
    }

    /// Queues an input batch that has no display to target. The releases in it
    /// run, and every other event comes back as a rejection carrying `reason`.
    ///
    /// It goes through the queue rather than running here so it still lands
    /// behind the batch it just cancelled: releasing while one is mid-delivery
    /// only presses everything again.
    private func enqueueRelease(id: Int, events: [ParsedInputEvent], reason: String) {
        inputJobs.enqueue { [weak self] in
            guard let self else { return }
            let result = self.input.releaseWithoutDisplay(events: events, reason: reason)
            self.emit(.inputResult(id: id, delivered: result.delivered, rejected: result.rejected))
        }
    }

    private func requireDisplay(_ id: CGDirectDisplayID) throws -> DisplayRecord {
        guard let display = displays.find(id) else {
            throw HelperError(.displayNotFound, "no display \(id) is attached")
        }
        return display
    }
}

/// Compares two secrets without leaking their common prefix through timing.
func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
    let left = Array(lhs.utf8)
    let right = Array(rhs.utf8)
    guard left.count == right.count else { return false }
    var difference: UInt8 = 0
    for index in left.indices { difference |= left[index] ^ right[index] }
    return difference == 0
}
