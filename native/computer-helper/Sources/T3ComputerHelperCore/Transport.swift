import Foundation

/// Splits an inbound byte stream into NDJSON lines.
///
/// Commands never carry a binary payload, so the inbound direction needs no
/// length framing — only a guard against a peer that never sends a newline,
/// which would otherwise grow this buffer without bound.
public struct LineFramer: Sendable {
    public static let maximumLineBytes = 1 << 20

    private var buffer = Data()

    public init() {}

    public mutating func feed(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer = buffer[buffer.index(after: newline)...]
            if !line.isEmpty { lines.append(Data(line)) }
        }
        if buffer.count > Self.maximumLineBytes {
            throw HelperError(.invalidInput, "command line exceeded \(Self.maximumLineBytes) bytes")
        }
        return lines
    }
}

/// Writes framed records to one file descriptor.
///
/// Frames are the reason this exists. A capture at 12fps outruns a slow reader,
/// and queueing every frame turns a stalled consumer into unbounded memory. So
/// frames are counted while in flight and dropped past a small backlog, while
/// replies and events are never dropped: losing a reply would hang a request.
///
/// SAFETY: `@unchecked Sendable` because the two mutable fields are only ever
/// touched under `lock`, and `fd` is immutable after init. Writes themselves are
/// serialized by `queue`, so no two writes interleave on the descriptor.
public final class RecordWriter: @unchecked Sendable {
    public static let maximumPendingFrames = 2

    private let fd: Int32
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var pendingFrames = 0
    private var closed = false

    public init(fileDescriptor: Int32, label: String) {
        self.fd = fileDescriptor
        self.queue = DispatchQueue(label: label, qos: .userInitiated)
    }

    /// Sends a record that must not be lost.
    public func send(_ record: Record) {
        let bytes = record.encoded()
        queue.async { [weak self] in self?.writeAll(bytes) }
    }

    /// Sends a capture frame, or drops it when the reader is behind.
    /// Returns whether it was queued, so the caller can count drops.
    @discardableResult
    public func sendFrame(_ record: Record) -> Bool {
        lock.lock()
        if closed || pendingFrames >= Self.maximumPendingFrames {
            lock.unlock()
            return false
        }
        pendingFrames += 1
        lock.unlock()
        let bytes = record.encoded()
        queue.async { [weak self] in
            guard let self else { return }
            self.writeAll(bytes)
            self.lock.lock()
            self.pendingFrames -= 1
            self.lock.unlock()
        }
        return true
    }

    /// Blocks until everything already queued has reached the descriptor.
    ///
    /// Writes are asynchronous, so exiting without this truncates the reply to
    /// `shutdown` — the server sees the socket close instead of an `ok` and
    /// reports a crash for an orderly exit.
    public func flush() {
        queue.sync {}
    }

    /// Stops accepting frames. In-flight replies still drain.
    public func close() {
        lock.lock()
        closed = true
        lock.unlock()
    }

    private func writeAll(_ data: Data) {
        var offset = 0
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            while offset < raw.count {
                let written = write(fd, base.advanced(by: offset), raw.count - offset)
                if written > 0 {
                    offset += written
                    continue
                }
                if written < 0 && (errno == EINTR || errno == EAGAIN) { continue }
                // The peer is gone. Dropping the rest is correct: the supervisor
                // notices the disconnect and restarts us.
                close()
                return
            }
        }
    }
}

/// The writer of whichever connection is current, reachable from the capture
/// queue without a hop to the main actor.
///
/// A frame at 12fps per display would otherwise pay a main-actor round trip
/// each, which is latency spent on nothing: `RecordWriter` is already safe to
/// call from any thread.
///
/// SAFETY: `@unchecked Sendable` because `writer` is only read or written
/// under `lock`.
public final class WriterBox: @unchecked Sendable {
    private let lock = NSLock()
    private var writer: RecordWriter?

    public init() {}

    public func set(_ writer: RecordWriter?) {
        lock.lock()
        self.writer = writer
        lock.unlock()
    }

    public func current() -> RecordWriter? {
        lock.lock()
        defer { lock.unlock() }
        return writer
    }
}

/// A live duplex to whoever is driving the helper.
public final class Connection: @unchecked Sendable {
    public let writer: RecordWriter
    /// Nil in stdio mode, where the descriptors are inherited rather than owned.
    let readFd: Int32
    let ownsDescriptors: Bool
    private var source: DispatchSourceRead?
    private var framer = LineFramer()

    init(readFd: Int32, writeFd: Int32, label: String, ownsDescriptors: Bool) {
        self.readFd = readFd
        self.ownsDescriptors = ownsDescriptors
        self.writer = RecordWriter(fileDescriptor: writeFd, label: label)
    }

    /// Starts pumping lines to `onLine` on the main queue. `onEnd` fires once,
    /// when the peer closes or the stream fails.
    func start(
        queue: DispatchQueue,
        onLine: @escaping @Sendable (Data) -> Void,
        onEnd: @escaping @Sendable () -> Void
    ) {
        _ = fcntl(readFd, F_SETFL, fcntl(readFd, F_GETFL, 0) | O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: readFd, queue: queue)
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            while true {
                let count = buffer.withUnsafeMutableBytes { read(self.readFd, $0.baseAddress, $0.count) }
                if count > 0 {
                    let chunk = Data(buffer[0..<count])
                    do {
                        for line in try self.framer.feed(chunk) { onLine(line) }
                    } catch {
                        self.writer.send(.error(id: nil, code: .invalidInput, message: "\(error)"))
                        onEnd()
                        return
                    }
                    continue
                }
                if count == 0 {
                    onEnd()
                    return
                }
                if errno == EAGAIN || errno == EWOULDBLOCK { return }
                if errno == EINTR { continue }
                onEnd()
                return
            }
        }
        source.resume()
        self.source = source
    }

    func stop() {
        source?.cancel()
        source = nil
        writer.close()
        if ownsDescriptors {
            Darwin.close(readFd)
        }
    }
}

/// Listens on a Unix domain socket for exactly one driver at a time.
///
/// The socket, not a TCP port, because this process can move the user's real
/// cursor: a filesystem path with mode 0600 cannot be reached from off the
/// machine at all, and the token check makes a second local process with
/// filesystem access still have to be told the secret.
public final class UnixSocketServer: @unchecked Sendable {
    private let path: String
    private let queue: DispatchQueue
    private var listenFd: Int32 = -1
    private var acceptSource: DispatchSourceRead?

    public init(path: String, queue: DispatchQueue) {
        self.path = path
        self.queue = queue
    }

    /// Binds and listens. Throws with a reason the server can print.
    public func listen() throws {
        // 104 bytes including the terminator, and there is no error until the
        // bind fails with a truncated path, so it is checked up front.
        let pathBytes = Array(path.utf8)
        guard pathBytes.count < 104 else {
            throw HelperError(.invalidInput, "socket path is too long for a Unix domain socket: \(path)")
        }
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw HelperError(.backendUnavailable, "socket() failed: \(String(cString: strerror(errno)))")
        }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            guard let base = destination.baseAddress else { return }
            base.copyMemory(from: pathBytes, byteCount: pathBytes.count)
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        guard bound == 0 else {
            Darwin.close(fd)
            throw HelperError(.backendUnavailable, "bind(\(path)) failed: \(String(cString: strerror(errno)))")
        }
        chmod(path, 0o600)
        guard Darwin.listen(fd, 1) == 0 else {
            Darwin.close(fd)
            throw HelperError(.backendUnavailable, "listen() failed: \(String(cString: strerror(errno)))")
        }
        listenFd = fd
    }

    /// Accepts connections, one at a time. A second client while one is
    /// connected is closed immediately rather than silently queued behind it.
    public func accept(onConnection: @escaping @Sendable (Connection) -> Void) {
        let source = DispatchSource.makeReadSource(fileDescriptor: listenFd, queue: queue)
        source.setEventHandler { [weak self] in
            guard let self, self.listenFd >= 0 else { return }
            let clientFd = Darwin.accept(self.listenFd, nil, nil)
            guard clientFd >= 0 else { return }
            onConnection(
                Connection(
                    readFd: clientFd, writeFd: clientFd,
                    label: "codes.t3.openbot.helper.socket", ownsDescriptors: true))
        }
        source.resume()
        acceptSource = source
    }

    public func shutdown() {
        acceptSource?.cancel()
        acceptSource = nil
        if listenFd >= 0 {
            Darwin.close(listenFd)
            listenFd = -1
        }
        unlink(path)
    }
}

/// The inherited stdin/stdout pair, used by `--stdio`.
public func makeStdioConnection() -> Connection {
    Connection(readFd: 0, writeFd: 1, label: "codes.t3.openbot.helper.stdio", ownsDescriptors: false)
}

/// Diagnostics go to stderr, never stdout: stdout is the record stream.
public func helperLog(_ message: String) {
    FileHandle.standardError.write(Data("[t3-computer-helper] \(message)\n".utf8))
}
