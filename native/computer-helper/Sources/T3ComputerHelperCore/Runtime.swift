import AppKit
import Foundation

/// Wires the helper to whichever transport it was started with, and owns the
/// exit paths.
@MainActor
public final class HelperRuntime {
    private let options: Options
    private let service: HelperService
    private var server: UnixSocketServer?
    /// A signal source is cancelled by ARC the moment its last reference goes
    /// away, taking the handler with it, so these have to outlive the loop that
    /// makes them.
    private var signalSources: [DispatchSourceSignal] = []

    public init(options: Options) {
        self.options = options
        switch options.mode {
        case .stdio:
            self.service = HelperService(token: nil)
        case let .socket(_, token, _):
            self.service = HelperService(token: token)
        }
    }

    public func start() throws {
        // Writing to a socket whose peer has gone would otherwise kill the
        // process outright instead of returning EPIPE.
        signal(SIGPIPE, SIG_IGN)
        service.onShutdown = { Task { @MainActor in exit(0) } }
        service.start()
        installSignalHandlers()

        switch options.mode {
        case .stdio:
            service.attach(
                connection: makeStdioConnection(), exitOnDisconnect: options.exitOnDisconnect)
        case let .socket(path, _, readyFile):
            let server = UnixSocketServer(path: path, queue: .main)
            try server.listen()
            server.accept { [weak self] connection in
                Task { @MainActor in
                    guard let self else { return }
                    self.service.attach(
                        connection: connection, exitOnDisconnect: self.options.exitOnDisconnect)
                }
            }
            self.server = server
            announceReady(socket: path, readyFile: readyFile)
        }
    }

    /// One JSON line, written to the ready file and to stdout. The server polls
    /// for the file because a Launch Services launch leaves it no pipe to read.
    private func announceReady(socket: String, readyFile: String?) {
        let ready: [String: Any] = [
            "event": "ready",
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "socket": socket,
            "protocolVersion": helperProtocolVersion,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: ready)) ?? Data("{}".utf8)
        var line = data
        line.append(0x0A)
        if let readyFile {
            // Written whole and then moved into place, so a server that reads
            // the moment the file appears never sees half a record.
            let temporary = readyFile + ".partial"
            try? line.write(to: URL(fileURLWithPath: temporary))
            try? FileManager.default.removeItem(atPath: readyFile)
            try? FileManager.default.moveItem(atPath: temporary, toPath: readyFile)
        }
        FileHandle.standardOutput.write(line)
    }

    private func installSignalHandlers() {
        for number in [SIGINT, SIGTERM] {
            // Ignore the default disposition first: without this the process
            // dies before the dispatch source ever runs, and the virtual
            // displays outlive it.
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                MainActor.assumeIsolated {
                    self?.service.shutdownNow()
                    self?.server?.shutdown()
                    exit(0)
                }
            }
            source.resume()
            signalSources.append(source)
        }
    }
}
