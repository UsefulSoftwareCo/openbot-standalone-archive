import CoreGraphics
import Foundation
import Testing

@testable import T3ComputerHelperCore

@Suite("wheel mapping")
struct WheelMappingTests {
    /// The whole point of the mapping: a viewer wheel-down has to scroll the
    /// Mac down, and the two platforms disagree about which direction is
    /// positive.
    @Test("a browser wheel-down scrolls the page toward its end")
    func wheelDownScrollsDown() {
        let axes = InputGeometry.wheelAxes(deltaX: 0, deltaY: 120)
        #expect(axes.wheel1 == -120)
        #expect(axes.wheel2 == 0)
    }

    @Test("a browser wheel-up scrolls the page toward its start")
    func wheelUpScrollsUp() {
        #expect(InputGeometry.wheelAxes(deltaX: 0, deltaY: -40).wheel1 == 40)
    }

    @Test("horizontal deltas invert the same way")
    func horizontal() {
        let axes = InputGeometry.wheelAxes(deltaX: 30, deltaY: 0)
        #expect(axes.wheel2 == -30)
        #expect(axes.wheel1 == 0)
    }

    /// An unclamped `Int32(...)` of a large trackpad delta traps at runtime.
    @Test("absurd deltas clamp instead of trapping")
    func clamps() {
        #expect(InputGeometry.wheelAxes(deltaX: 0, deltaY: -1e18).wheel1 == Int32.max)
        #expect(InputGeometry.wheelAxes(deltaX: 0, deltaY: 1e18).wheel1 == Int32.min)
        #expect(InputGeometry.wheelAxes(deltaX: .nan, deltaY: .infinity).wheel1 == 0)
    }
}

@Suite("coordinate mapping")
struct CoordinateTests {
    @Test("a pixel point on a retina second display lands in global points")
    func retinaSecondDisplay() {
        let point = InputGeometry.globalPoint(
            CGPoint(x: 200, y: 100), displayOrigin: CGPoint(x: 1512, y: 0), scale: 2)
        #expect(point.x == 1612)
        #expect(point.y == 50)
    }

    @Test("a scale of zero does not divide by zero")
    func degenerateScale() {
        let point = InputGeometry.globalPoint(
            CGPoint(x: 10, y: 10), displayOrigin: .zero, scale: 0)
        #expect(point.x == 10)
    }

    @Test("points outside the display are rejected, edges are not")
    func bounds() {
        #expect(InputGeometry.isInside(CGPoint(x: 0, y: 0), widthPx: 100, heightPx: 50))
        #expect(InputGeometry.isInside(CGPoint(x: 100, y: 50), widthPx: 100, heightPx: 50))
        #expect(!InputGeometry.isInside(CGPoint(x: 101, y: 10), widthPx: 100, heightPx: 50))
        #expect(!InputGeometry.isInside(CGPoint(x: -1, y: 10), widthPx: 100, heightPx: 50))
    }
}

@Suite("capture sizing")
struct CaptureSizeTests {
    @Test("downscales to the requested width, keeping the aspect ratio")
    func downscales() {
        let size = InputGeometry.captureSize(
            sourceWidthPx: 3456, sourceHeightPx: 2234, maxWidthPx: 1280)
        #expect(size.width == 1280)
        #expect(size.height == 827)
    }

    /// Enlarging costs bandwidth and shows the viewer nothing new.
    @Test("never upscales")
    func neverUpscales() {
        let size = InputGeometry.captureSize(
            sourceWidthPx: 800, sourceHeightPx: 600, maxWidthPx: 4000)
        #expect(size.width == 800)
        #expect(size.height == 600)
    }
}

@Suite("key table")
struct KeymapTests {
    @Test("W3C codes map to the macOS virtual keys for those positions")
    func knownCodes() {
        #expect(Keymap.virtualKey(for: "KeyA") == 0)
        #expect(Keymap.virtualKey(for: "KeyZ") == 6)
        #expect(Keymap.virtualKey(for: "Digit1") == 18)
        #expect(Keymap.virtualKey(for: "Digit0") == 29)
        #expect(Keymap.virtualKey(for: "Enter") == 36)
        #expect(Keymap.virtualKey(for: "Space") == 49)
        #expect(Keymap.virtualKey(for: "Escape") == 53)
        #expect(Keymap.virtualKey(for: "ArrowLeft") == 123)
        #expect(Keymap.virtualKey(for: "F20") == 90)
        #expect(Keymap.virtualKey(for: "Numpad5") == 87)
        #expect(Keymap.virtualKey(for: "MetaLeft") == 55)
        #expect(Keymap.virtualKey(for: "BracketRight") == 30)
    }

    /// Every letter and digit position must be present, or a keyboard on the
    /// other end of the wire has holes in it.
    @Test("every letter and digit position is covered")
    func coversAlphanumerics() {
        for scalar in UnicodeScalar("A").value...UnicodeScalar("Z").value {
            let code = "Key\(Character(UnicodeScalar(scalar)!))"
            #expect(Keymap.virtualKey(for: code) != nil, "missing \(code)")
        }
        for digit in 0...9 {
            #expect(Keymap.virtualKey(for: "Digit\(digit)") != nil, "missing Digit\(digit)")
        }
        for index in 1...20 {
            #expect(Keymap.virtualKey(for: "F\(index)") != nil, "missing F\(index)")
        }
    }

    @Test("an unknown code is nil rather than a wrong key")
    func unknownCode() {
        #expect(Keymap.virtualKey(for: "KeyÅ") == nil)
        #expect(Keymap.virtualKey(for: "a") == nil)
    }

    @Test("held modifier keys contribute their flags")
    func heldModifierFlags() {
        #expect(Keymap.flag(forHeldKey: 56) == .maskShift)
        #expect(Keymap.flag(forHeldKey: 60) == .maskShift)
        #expect(Keymap.flag(forHeldKey: 55) == .maskCommand)
        #expect(Keymap.flag(forHeldKey: 0) == nil)
    }
}

@Suite("record framing")
struct RecordFramingTests {
    @Test("a frame declares its payload length and the bytes follow the newline")
    func framePayload() throws {
        let payload = Data([0xFF, 0xD8, 0x0A, 0x7B, 0xFF, 0xD9])
        let bytes = Record.frame(
            id: nil, displayId: 7, widthPx: 100, heightPx: 50, capturedAtMs: 1_700_000_000_000,
            payload: payload
        ).encoded()
        let newline = try #require(bytes.firstIndex(of: 0x0A))
        let object = try #require(
            try JSONSerialization.jsonObject(with: bytes[..<newline]) as? [String: Any])
        #expect(object["type"] as? String == "frame")
        #expect(object["displayId"] as? String == "7")
        #expect(object["payloadBytes"] as? Int == payload.count)
        #expect(object["id"] == nil)
        // The payload contains a newline and a brace; a reader that scanned for
        // either instead of counting bytes would desynchronise here.
        #expect(Data(bytes[bytes.index(after: newline)...]) == payload)
    }

    @Test("a screenshot reply carries the command id")
    func screenshotCarriesId() throws {
        let bytes = Record.frame(
            id: 5, displayId: 1, widthPx: 10, heightPx: 10, capturedAtMs: 0, payload: Data([1])
        ).encoded()
        let newline = try #require(bytes.firstIndex(of: 0x0A))
        let object = try #require(
            try JSONSerialization.jsonObject(with: bytes[..<newline]) as? [String: Any])
        #expect(object["id"] as? Int == 5)
    }

    @Test("error codes are the contract's literals")
    func errorCodes() throws {
        let bytes = Record.error(id: 3, code: .permissionDenied, message: "nope").encoded()
        let object = try #require(
            try JSONSerialization.jsonObject(with: bytes.dropLast()) as? [String: Any])
        #expect(object["code"] as? String == "permission_denied")
        #expect(HelperError.Code.backendUnavailable.rawValue == "backend_unavailable")
        #expect(HelperError.Code.displayNotFound.rawValue == "display_not_found")
    }

    @Test("a window with no display reports null rather than omitting the key")
    func nullDisplayId() throws {
        let window = WindowRecord(
            id: "12:34", displayId: nil, title: "t", app: "a", pid: 12,
            x: 0, y: 0, width: 1, height: 1, focused: false, minimized: false)
        let bytes = Record.windows(id: 1, windows: [window]).encoded()
        let object = try #require(
            try JSONSerialization.jsonObject(with: bytes.dropLast()) as? [String: Any])
        let windows = try #require(object["windows"] as? [[String: Any]])
        #expect(windows[0]["displayId"] is NSNull)
    }
}

@Suite("line framing")
struct LineFramerTests {
    @Test("a command split across chunks arrives whole")
    func splitAcrossChunks() throws {
        var framer = LineFramer()
        #expect(try framer.feed(Data(#"{"id":1,"typ"#.utf8)).isEmpty)
        let lines = try framer.feed(Data("e\":\"hello\"}\n".utf8))
        #expect(lines.count == 1)
        #expect(String(decoding: lines[0], as: UTF8.self) == #"{"id":1,"type":"hello"}"#)
    }

    @Test("several commands in one chunk all arrive, blank lines are ignored")
    func manyPerChunk() throws {
        var framer = LineFramer()
        let lines = try framer.feed(Data("{\"a\":1}\n\n{\"b\":2}\n".utf8))
        #expect(lines.count == 2)
    }

    /// A peer that never sends a newline must not grow this buffer forever.
    @Test("an unterminated line past the cap is a protocol error")
    func unboundedLine() {
        var framer = LineFramer()
        let huge = Data(repeating: 0x61, count: LineFramer.maximumLineBytes + 1)
        #expect(throws: HelperError.self) { _ = try framer.feed(huge) }
    }
}

@Suite("command parsing")
struct CommandTests {
    @Test("a well-formed input batch parses every event kind")
    func parsesEvents() throws {
        let json = """
            {"id":8,"type":"input","displayId":"3","events":[
              {"type":"move","point":{"x":10,"y":20}},
              {"type":"button","button":"left","action":"down","point":{"x":10,"y":20}},
              {"type":"click","button":"right","count":2,"point":{"x":1,"y":2},"modifiers":["meta"]},
              {"type":"scroll","point":{"x":1,"y":2},"deltaX":0,"deltaY":120},
              {"type":"key","key":"KeyA","action":"down","modifiers":["shift"]},
              {"type":"key-press","key":"Enter"},
              {"type":"text","text":"hi"},
              {"type":"release-all"}
            ]}
            """
        let command = try Command(line: Data(json.utf8))
        #expect(try command.requiredId() == 8)
        #expect(try command.displayId() == 3)
        let events = try command.inputEvents()
        #expect(events.count == 8)
        #expect(events.allSatisfy { if case .event = $0 { return true } else { return false } })
        guard case let .event(.click(button, count, _, modifiers)) = events[2] else {
            Issue.record("expected a click")
            return
        }
        #expect(button == .right)
        #expect(count == 2)
        #expect(modifiers == [.meta])
    }

    /// One bad event must not lose the ones behind it.
    @Test("a bad event is rejected in place, not fatal to the batch")
    func rejectsOneEvent() throws {
        let json = """
            {"id":1,"type":"input","displayId":"1","events":[
              {"type":"nope"},{"type":"click","button":"left","count":9,"point":{"x":0,"y":0}},
              {"type":"move","point":{"x":1,"y":1}}
            ]}
            """
        let events = try Command(line: Data(json.utf8)).inputEvents()
        #expect(events.count == 3)
        if case let .rejected(reason) = events[0] { #expect(reason.contains("nope")) } else {
            Issue.record("expected a rejection")
        }
        if case .rejected = events[1] {} else { Issue.record("expected a count rejection") }
        if case .event = events[2] {} else { Issue.record("expected the third event to survive") }
    }

    @Test("a malformed command names the field")
    func malformed() {
        #expect(throws: HelperError.self) { _ = try Command(line: Data("not json".utf8)) }
        #expect(throws: HelperError.self) {
            _ = try Command(line: Data(#"{"id":1}"#.utf8))
        }
    }
}

@Suite("options")
struct OptionsTests {
    @Test("socket mode needs a token")
    func socketNeedsToken() {
        #expect(throws: HelperError.self) { _ = try Options.parse(["--socket", "/tmp/x.sock"]) }
    }

    @Test("the login-session argv the server sends parses")
    func loginSessionArgv() throws {
        let options = try Options.parse([
            "--socket", "/tmp/t3/helper.sock", "--token", "abc123",
            "--ready-file", "/tmp/t3/ready.json", "--exit-on-disconnect",
        ])
        #expect(options.exitOnDisconnect)
        guard case let .socket(path, token, readyFile) = options.mode else {
            Issue.record("expected socket mode")
            return
        }
        #expect(path == "/tmp/t3/helper.sock")
        #expect(token == "abc123")
        #expect(readyFile == "/tmp/t3/ready.json")
    }

    @Test("stdio is the default and an unknown flag is an error")
    func stdioDefault() throws {
        #expect(try Options.parse([]).mode == .stdio)
        #expect(try Options.parse(["--stdio"]).mode == .stdio)
        #expect(throws: HelperError.self) { _ = try Options.parse(["--nope"]) }
        #expect(throws: HelperError.self) { _ = try Options.parse(["--token"]) }
    }
}

@Suite("token comparison")
struct TokenTests {
    @Test("equal tokens match, different ones do not")
    func comparison() {
        #expect(constantTimeEquals("deadbeef", "deadbeef"))
        #expect(!constantTimeEquals("deadbeef", "deadbeee"))
        #expect(!constantTimeEquals("deadbeef", "deadbee"))
        #expect(!constantTimeEquals("", "x"))
    }
}
