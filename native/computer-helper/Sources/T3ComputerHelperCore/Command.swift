import CoreGraphics
import Foundation

/// A mouse button as the contract names it.
public enum MouseButton: String, Sendable, CaseIterable {
    case left, right, middle
}

/// A modifier as the contract names it. `meta` is Command on macOS.
public enum InputModifier: String, Sendable, CaseIterable {
    case shift, control, alt, meta
}

/// One event from `OpenbotComputerInputEvent`, already parsed. Points are in
/// the target display's pixel space with the origin at its top-left.
public enum InputEvent: Sendable, Equatable {
    case move(point: CGPoint)
    case button(button: MouseButton, down: Bool, point: CGPoint)
    case click(button: MouseButton, count: Int, point: CGPoint, modifiers: [InputModifier])
    case scroll(point: CGPoint, deltaX: Double, deltaY: Double)
    case key(code: String, down: Bool, modifiers: [InputModifier])
    case keyPress(code: String, modifiers: [InputModifier])
    case text(String)
    case releaseAll
}

/// One event that survived parsing, or the reason it did not.
///
/// A rejection is a value rather than a thrown error because a batch keeps
/// going: one unknown key must not lose the keystrokes behind it.
public enum ParsedInputEvent: Sendable, Equatable {
    case event(InputEvent)
    case rejected(String)
}

/// A command line as it arrived, before its arguments are read.
///
/// Parsing is by hand rather than through `Codable` because every malformed
/// field has to come back to the server as `invalid_input` naming the field,
/// and `Codable`'s errors do not say that in words a user can act on.
/// Not `Sendable`: it holds the raw JSON object and never leaves the main
/// actor that read it.
public struct Command {
    public let id: Int?
    public let type: String
    private let object: [String: Any]

    public init(line: Data) throws {
        guard let parsed = try? JSONSerialization.jsonObject(with: line),
            let object = parsed as? [String: Any]
        else {
            throw HelperError(.invalidInput, "command was not a JSON object")
        }
        guard let type = object["type"] as? String else {
            throw HelperError(.invalidInput, "command has no 'type'")
        }
        self.object = object
        self.type = type
        self.id = (object["id"] as? NSNumber).map(\.intValue)
    }

    /// The id a reply must echo. Every command except `auth` carries one.
    public func requiredId() throws -> Int {
        guard let id else { throw HelperError(.invalidInput, "command '\(type)' has no 'id'") }
        return id
    }

    public func string(_ key: String) throws -> String {
        guard let value = object[key] as? String else {
            throw HelperError(.invalidInput, "'\(key)' must be a string")
        }
        return value
    }

    public func optionalString(_ key: String) -> String? {
        object[key] as? String
    }

    public func int(_ key: String) throws -> Int {
        guard let value = object[key] as? NSNumber else {
            throw HelperError(.invalidInput, "'\(key)' must be a number")
        }
        return value.intValue
    }

    public func double(_ key: String, default fallback: Double) -> Double {
        (object[key] as? NSNumber)?.doubleValue ?? fallback
    }

    public func bool(_ key: String, default fallback: Bool) -> Bool {
        (object[key] as? NSNumber)?.boolValue ?? fallback
    }

    public func strings(_ key: String) -> [String] {
        (object[key] as? [Any])?.compactMap { $0 as? String } ?? []
    }

    /// A `CGDirectDisplayID` from its decimal string form.
    public func displayId(_ key: String = "displayId") throws -> CGDirectDisplayID {
        let raw = try string(key)
        guard let value = UInt32(raw) else {
            throw HelperError(.invalidInput, "'\(key)' is not a display id: \(raw)")
        }
        return value
    }

    public func optionalDisplayId(_ key: String = "displayId") -> CGDirectDisplayID? {
        guard let raw = object[key] as? String else { return nil }
        return UInt32(raw)
    }

    /// The `events` array of an `input` command.
    ///
    /// A single bad event does not fail the batch: it is returned as a
    /// rejection so the events behind it still land, which is the difference
    /// between one dropped keystroke and a lost sentence.
    public func inputEvents() throws -> [ParsedInputEvent] {
        guard let raw = object["events"] as? [Any] else {
            throw HelperError(.invalidInput, "'events' must be an array")
        }
        return raw.map { entry in
            guard let event = entry as? [String: Any] else {
                return .rejected("event was not an object")
            }
            return Command.parseEvent(event)
        }
    }

    /// True when a batch asks for nothing but `release-all`.
    ///
    /// Such a batch names a display on the wire but does not need one: held
    /// buttons and keys belong to the connection rather than to any screen, and
    /// the batch that most needs to be honoured is the one sent about a display
    /// that has just been unplugged. Resolving the display first would fail it.
    public static func isReleaseOnly(_ events: [ParsedInputEvent]) -> Bool {
        !events.isEmpty && events.allSatisfy { $0 == .event(.releaseAll) }
    }

    static func parseEvent(_ event: [String: Any]) -> ParsedInputEvent {
        func point() -> CGPoint? {
            guard let raw = event["point"] as? [String: Any],
                let x = (raw["x"] as? NSNumber)?.doubleValue,
                let y = (raw["y"] as? NSNumber)?.doubleValue
            else { return nil }
            return CGPoint(x: x, y: y)
        }
        func modifiers() -> [InputModifier] {
            (event["modifiers"] as? [Any])?
                .compactMap { $0 as? String }
                .compactMap(InputModifier.init(rawValue:)) ?? []
        }
        func button() -> MouseButton? {
            (event["button"] as? String).flatMap(MouseButton.init(rawValue:))
        }

        switch event["type"] as? String {
        case "move":
            guard let point = point() else { return .rejected("move needs a point") }
            return .event(.move(point: point))
        case "button":
            guard let button = button() else { return .rejected("unknown mouse button") }
            guard let action = event["action"] as? String, action == "down" || action == "up" else {
                return .rejected("button action must be 'down' or 'up'")
            }
            guard let point = point() else { return .rejected("button needs a point") }
            return .event(.button(button: button, down: action == "down", point: point))
        case "click":
            guard let button = button() else { return .rejected("unknown mouse button") }
            guard let point = point() else { return .rejected("click needs a point") }
            let count = (event["count"] as? NSNumber)?.intValue ?? 1
            guard (1...3).contains(count) else { return .rejected("click count must be 1, 2 or 3") }
            return .event(.click(button: button, count: count, point: point, modifiers: modifiers()))
        case "scroll":
            guard let point = point() else { return .rejected("scroll needs a point") }
            let deltaX = (event["deltaX"] as? NSNumber)?.doubleValue ?? 0
            let deltaY = (event["deltaY"] as? NSNumber)?.doubleValue ?? 0
            return .event(.scroll(point: point, deltaX: deltaX, deltaY: deltaY))
        case "key":
            guard let code = event["key"] as? String else { return .rejected("key needs a 'key' code") }
            guard let action = event["action"] as? String, action == "down" || action == "up" else {
                return .rejected("key action must be 'down' or 'up'")
            }
            return .event(.key(code: code, down: action == "down", modifiers: modifiers()))
        case "key-press":
            guard let code = event["key"] as? String else { return .rejected("key-press needs a 'key' code") }
            return .event(.keyPress(code: code, modifiers: modifiers()))
        case "text":
            guard let text = event["text"] as? String, !text.isEmpty else {
                return .rejected("text needs a non-empty 'text'")
            }
            return .event(.text(text))
        case "release-all":
            return .event(.releaseAll)
        case let other?:
            return .rejected("unknown event type '\(other)'")
        case nil:
            return .rejected("event has no 'type'")
        }
    }
}
