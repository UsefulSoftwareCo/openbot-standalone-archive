import Foundation

/// The helper's side of the wire.
///
/// One JSON object per line. When a record carries binary data it declares
/// `payloadBytes` and exactly that many raw bytes follow the newline, so the
/// reader never has to scan a JPEG for a delimiter. Commands never carry a
/// payload, so the inbound direction is plain NDJSON.
public let helperProtocolVersion = 1

/// A failure the server can act on. The codes are exactly the literals of
/// `OpenbotComputerError.code` in `packages/contracts/src/openbotComputer.ts`;
/// keeping them identical is what lets the server pass a helper failure
/// straight through instead of guessing at a translation.
public struct HelperError: Error, Sendable {
    public enum Code: String, Sendable {
        case unsupported
        case captureFailed = "capture_failed"
        case permissionDenied = "permission_denied"
        case displayNotFound = "display_not_found"
        case windowNotFound = "window_not_found"
        case notControlling = "not_controlling"
        case setupRequired = "setup_required"
        case backendUnavailable = "backend_unavailable"
        case invalidInput = "invalid_input"
    }

    public let code: Code
    public let message: String

    public init(_ code: Code, _ message: String) {
        self.code = code
        self.message = message
    }
}

public struct PermissionsRecord: Sendable, Equatable {
    /// `unknown` is never reported today: both gates answer synchronously. It
    /// exists so a future gate the helper cannot preflight has an honest value.
    public enum State: String, Sendable { case granted, denied, unknown }

    public let screenCapture: State
    public let accessibility: State

    public init(screenCapture: State, accessibility: State) {
        self.screenCapture = screenCapture
        self.accessibility = accessibility
    }

    var json: [String: Any] {
        ["screenCapture": screenCapture.rawValue, "accessibility": accessibility.rawValue]
    }
}

public struct DisplayRecord: Sendable, Equatable {
    public enum Kind: String, Sendable {
        case physical
        case managedVirtual = "managed-virtual"
    }

    public let id: UInt32
    public let name: String
    public let kind: Kind
    /// Pixels, which is the space every coordinate on this wire is stated in.
    public let widthPx: Int
    public let heightPx: Int
    /// Pixels per point, so the helper can convert a client point back into the
    /// point space CoreGraphics posts events in.
    public let scale: Double
    public let main: Bool

    public init(
        id: UInt32, name: String, kind: Kind, widthPx: Int, heightPx: Int, scale: Double, main: Bool
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.scale = scale
        self.main = main
    }

    var json: [String: Any] {
        [
            "id": String(id),
            "name": name,
            "kind": kind.rawValue,
            "widthPx": widthPx,
            "heightPx": heightPx,
            "scale": scale,
            "main": main,
            "managed": kind == .managedVirtual,
        ]
    }
}

public struct WindowRecord: Sendable, Equatable {
    public let id: String
    public let displayId: UInt32?
    public let title: String
    public let app: String
    public let pid: Int32?
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
    public let focused: Bool
    public let minimized: Bool

    public init(
        id: String, displayId: UInt32?, title: String, app: String, pid: Int32?,
        x: Double, y: Double, width: Double, height: Double, focused: Bool, minimized: Bool
    ) {
        self.id = id
        self.displayId = displayId
        self.title = title
        self.app = app
        self.pid = pid
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.focused = focused
        self.minimized = minimized
    }

    var json: [String: Any] {
        [
            "id": id,
            "displayId": displayId.map { String($0) } ?? NSNull(),
            "title": title,
            "app": app,
            "pid": pid.map { Int($0) } ?? NSNull(),
            "x": x, "y": y, "width": width, "height": height,
            "focused": focused,
            "minimized": minimized,
        ]
    }
}

public struct InputRejection: Sendable, Equatable {
    public let index: Int
    public let reason: String

    public init(index: Int, reason: String) {
        self.index = index
        self.reason = reason
    }
}

/// Everything the helper can say. `id` is present exactly when the record
/// answers a command; a frame with no `id` is an unsolicited capture frame and
/// a frame with one is the reply to a `screenshot`.
public enum Record: Sendable {
    case authOk
    case hello(id: Int, pid: Int32, bundleId: String?, permissions: PermissionsRecord, displays: [DisplayRecord])
    case displays(id: Int, displays: [DisplayRecord])
    case windows(id: Int, windows: [WindowRecord])
    case ok(id: Int)
    case display(id: Int, display: DisplayRecord)
    case launched(id: Int, pid: Int32?)
    case permissions(id: Int, permissions: PermissionsRecord)
    case inputResult(id: Int, delivered: Int, rejected: [InputRejection])
    case frame(id: Int?, displayId: UInt32, widthPx: Int, heightPx: Int, capturedAtMs: Double, payload: Data)
    case event(name: String)
    case error(id: Int?, code: HelperError.Code, message: String)

    /// The bytes that follow this record's JSON line, or nil when it has none.
    var payload: Data? {
        if case let .frame(_, _, _, _, _, payload) = self { return payload }
        return nil
    }

    var json: [String: Any] {
        switch self {
        case .authOk:
            return ["type": "auth-ok", "protocolVersion": helperProtocolVersion]
        case let .hello(id, pid, bundleId, permissions, displays):
            return [
                "id": id, "type": "hello", "protocolVersion": helperProtocolVersion,
                "pid": Int(pid), "bundleId": bundleId ?? NSNull(),
                "permissions": permissions.json, "displays": displays.map(\.json),
            ]
        case let .displays(id, displays):
            return ["id": id, "type": "displays", "displays": displays.map(\.json)]
        case let .windows(id, windows):
            return ["id": id, "type": "windows", "windows": windows.map(\.json)]
        case let .ok(id):
            return ["id": id, "type": "ok"]
        case let .display(id, display):
            return ["id": id, "type": "display", "display": display.json]
        case let .launched(id, pid):
            return ["id": id, "type": "launched", "pid": pid.map { Int($0) } ?? NSNull()]
        case let .permissions(id, permissions):
            return ["id": id, "type": "permissions", "permissions": permissions.json]
        case let .inputResult(id, delivered, rejected):
            return [
                "id": id, "type": "input-result", "delivered": delivered,
                "rejected": rejected.map { ["index": $0.index, "reason": $0.reason] },
            ]
        case let .frame(id, displayId, widthPx, heightPx, capturedAtMs, payload):
            var object: [String: Any] = [
                "type": "frame", "displayId": String(displayId),
                "widthPx": widthPx, "heightPx": heightPx,
                "capturedAtMs": capturedAtMs, "payloadBytes": payload.count,
            ]
            if let id { object["id"] = id }
            return object
        case let .event(name):
            return ["type": "event", "event": name]
        case let .error(id, code, message):
            var object: [String: Any] = ["type": "error", "code": code.rawValue, "message": message]
            if let id { object["id"] = id }
            return object
        }
    }

    /// The framed bytes for this record: one JSON line, then its payload.
    ///
    /// `JSONSerialization` can only fail on values it cannot represent, and
    /// every value above is a string, number, bool, null, array or dictionary
    /// of those. A failure here would be a defect, so it degrades to an error
    /// record rather than taking the process down.
    public func encoded() -> Data {
        var line: Data
        do {
            line = try JSONSerialization.data(withJSONObject: json, options: [])
        } catch {
            line = Data(#"{"type":"error","code":"backend_unavailable","message":"record could not be encoded"}"#.utf8)
        }
        line.append(0x0A)
        if let payload { line.append(payload) }
        return line
    }
}
