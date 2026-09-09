import CoreGraphics
import Foundation
import Testing

@preconcurrency import ScreenCaptureKit

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

@Suite("capture session lifetime")
struct CaptureSessionTests {
    /// The regression this guards: `SCStream` keeps its delegate and its
    /// stream output weakly, so a `CaptureOutput` that only the caller's local
    /// scope holds is deallocated the moment `start` returns, and every frame
    /// is dropped with `stream output NOT found` while the stream still
    /// reports itself as capturing. Constructing the stream needs no
    /// permission — only `startCapture`, which this never calls, does.
    @Test("a capture session keeps its stream output alive")
    func sessionRetainsOutput() {
        weak var probe: CaptureOutput?
        var session: CaptureSession?
        do {
            let output = CaptureOutput(onImage: { _ in }, onStop: { _ in })
            probe = output
            let stream = SCStream(
                filter: SCContentFilter(), configuration: SCStreamConfiguration(),
                delegate: output)
            try? stream.addStreamOutput(
                output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "test.capture"))
            session = CaptureSession(
                stream: stream, output: output, widthPx: 640, heightPx: 480)
        }
        #expect(probe != nil)
        #expect(session?.output === probe)

        session = nil
        #expect(probe == nil)
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

/// The flags a synthesised event carries.
///
/// This is the whole reason text can go missing while the batch reports every
/// event delivered. A `CGEvent` made from a `.combinedSessionState` source
/// starts life with that session's modifier flags, so any event posted without
/// assigning `flags` types Command-something instead of a character. The
/// helper's policy is that only the keys it is itself holding may colour an
/// event, and it is pure arithmetic, so it is tested here rather than by
/// posting into whatever the developer has focused.
@Suite("modifier flag policy")
struct ModifierFlagTests {
    private static let shiftLeft: CGKeyCode = 56
    private static let shiftRight: CGKeyCode = 60
    private static let commandLeft: CGKeyCode = 55
    private static let keyA: CGKeyCode = 0

    /// The case the live failure was in: nothing is held, so a keystroke must
    /// carry an empty mask, not whatever the session state believes.
    @Test("holding nothing is an empty mask, not an inherited one")
    func nothingHeld() {
        #expect(Keymap.heldFlags(for: []).rawValue == 0)
        #expect(Keymap.heldFlags(for: [Self.keyA]).rawValue == 0)
    }

    @Test("a text keystroke carries exactly the held modifiers")
    func textFlagsAreTheHeldModifiers() {
        #expect(Keymap.heldFlags(for: [Self.commandLeft]) == .maskCommand)
        #expect(
            Keymap.heldFlags(for: [Self.commandLeft, Self.shiftLeft, Self.keyA])
                == CGEventFlags([.maskCommand, .maskShift]))
    }

    /// `key-press KeyA meta` puts Command on that key event only. It never
    /// enters the held set, so the text event behind it in the batch is typed
    /// with no modifier at all.
    @Test("a key-press modifier rides its own event and holds nothing after it")
    func keyPressModifierDoesNotLinger() {
        let held: Set<CGKeyCode> = []
        #expect(
            Keymap.keyEventFlags(for: Self.keyA, down: true, held: held, extra: .maskCommand)
                == .maskCommand)
        #expect(
            Keymap.keyEventFlags(for: Self.keyA, down: false, held: held, extra: .maskCommand)
                == .maskCommand)
        #expect(Keymap.heldFlags(for: held).rawValue == 0)
    }

    @Test("a modifier's own down carries its flag")
    func modifierDown() {
        #expect(
            Keymap.keyEventFlags(for: Self.commandLeft, down: true, held: []) == .maskCommand)
    }

    /// The controller records the release after it posts it, so the held set
    /// still lists the key on its own up event. The up must clear the flag
    /// anyway, or every app downstream keeps treating Command as down.
    @Test("a modifier's own up clears its flag even while the held set still lists it")
    func modifierUpClearsItsOwnFlag() {
        #expect(
            Keymap.keyEventFlags(for: Self.commandLeft, down: false, held: [Self.commandLeft])
                .rawValue == 0)
        // An explicit modifiers list on the up event does not resurrect it.
        #expect(
            Keymap.keyEventFlags(
                for: Self.commandLeft, down: false, held: [Self.commandLeft], extra: .maskCommand
            ).rawValue == 0)
    }

    @Test("releasing one Shift keeps the flag while its twin is down")
    func twinModifierStaysHeld() {
        #expect(
            Keymap.keyEventFlags(
                for: Self.shiftLeft, down: false, held: [Self.shiftLeft, Self.shiftRight])
                == .maskShift)
    }

    @Test("an ordinary key-up still carries the modifiers that are held")
    func ordinaryKeyUpKeepsHeldModifiers() {
        #expect(
            Keymap.keyEventFlags(for: Self.keyA, down: false, held: [Self.commandLeft])
                == .maskCommand)
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

    /// The unplug case: cleanup for a display that is gone has to be
    /// recognisable without resolving that display, or the release fails
    /// exactly when it matters.
    @Test("a release-all-only batch is recognised without a display")
    func releaseOnlyNeedsNoDisplay() throws {
        let json = #"{"id":2,"type":"input","events":[{"type":"release-all"}]}"#
        let command = try Command(line: Data(json.utf8))
        let events = try command.inputEvents()

        #expect(Command.isReleaseOnly(events))
        // The batch parses and is classified even though there is no display to
        // name, let alone to find.
        #expect(throws: HelperError.self) { _ = try command.displayId() }
    }

    @Test("a batch with anything else in it is not release-only")
    func mixedIsNotReleaseOnly() throws {
        let json = """
            {"id":3,"type":"input","displayId":"9","events":[
              {"type":"release-all"},{"type":"move","point":{"x":1,"y":1}}
            ]}
            """
        let events = try Command(line: Data(json.utf8)).inputEvents()
        #expect(!Command.isReleaseOnly(events))
        #expect(!Command.isReleaseOnly([]))
        #expect(Command.isReleaseOnly([.event(.releaseAll), .event(.releaseAll)]))
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

/// Records what a `TextDeliveryJob` posted, without an event tap in sight.
@MainActor
final class TypingRecorder {
    private(set) var downs: [String] = []
    private(set) var ups: [String] = []
    private(set) var waits = 0

    func record(_ grapheme: String, _ phase: TextKeyPhase) {
        if phase == .down { downs.append(grapheme) } else { ups.append(grapheme) }
    }

    func countWait() -> Int {
        waits += 1
        return waits
    }
}

@MainActor
final class TypingTaskBox {
    var task: Task<TextDeliveryJob.Outcome, Never>?
}

@Suite("text delivery")
@MainActor
struct TextDeliveryTests {
    @Test("a whole string types every grapheme once, down then up")
    func typesEverything() async {
        let recorder = TypingRecorder()
        let job = TextDeliveryJob(text: "héllo👋", gap: .zero) { grapheme, phase in
            recorder.record(grapheme, phase)
        }

        let outcome = await job.run()

        // The emoji is one grapheme, not two scalars.
        #expect(outcome == .completed(typed: 6))
        #expect(recorder.downs == ["h", "é", "l", "l", "o", "👋"])
        #expect(recorder.ups == recorder.downs)
    }

    /// The reason the job exists: a cancel has to stop the typing where it is
    /// and say how far it got, so the driver learns what landed.
    @Test("a job cancelled mid-string reports the partial count and stops")
    func partialCount() async {
        let recorder = TypingRecorder()
        let job = TextDeliveryJob(
            text: "abcdef",
            pause: { _ in
                // Two waits per keystroke, so the fifth is the gap after the
                // third key-down.
                if recorder.countWait() >= 5 { throw CancellationError() }
            },
            post: { grapheme, phase in recorder.record(grapheme, phase) })

        let outcome = await job.run()

        #expect(outcome == .cancelled(typed: 3))
        #expect(recorder.downs == ["a", "b", "c"])
        // The key-up of the keystroke the cancel interrupted still goes out, or
        // that key stays down on the shared desktop.
        #expect(recorder.ups == ["a", "b", "c"])
    }

    @Test("cancelling the surrounding task stops the typing")
    func cancellingTheTask() async {
        let recorder = TypingRecorder()
        let box = TypingTaskBox()
        let job = TextDeliveryJob(text: "abcdefgh", gap: .milliseconds(1)) { grapheme, phase in
            recorder.record(grapheme, phase)
            if phase == .up, recorder.ups.count == 2 { box.task?.cancel() }
        }

        let task = Task { @MainActor in await job.run() }
        box.task = task
        let outcome = await task.value

        #expect(outcome == .cancelled(typed: 2))
        #expect(recorder.downs == ["a", "b"])
    }
}

/// The batch shape a driver sends about a display that has gone away.
///
/// Nothing here posts input: the controller under test holds nothing, so
/// `releaseAll` has no button and no key to let go of.
@Suite("release without a display")
@MainActor
struct ReleaseWithoutDisplayTests {
    @Test("a release-only batch is delivered in full with nothing to resolve")
    func releaseOnly() {
        let result = InputController().releaseWithoutDisplay(
            events: [.event(.releaseAll), .event(.releaseAll)], reason: "no display 7 is attached")

        #expect(result.delivered == 2)
        #expect(result.rejected.isEmpty)
    }

    /// A mixed batch still releases; only the events that genuinely needed the
    /// screen are refused, and as rejections rather than a failed command.
    @Test("the events that needed the display are rejected, the release is not")
    func mixedBatch() {
        let result = InputController().releaseWithoutDisplay(
            events: [
                .event(.releaseAll),
                .event(.move(point: CGPoint(x: 1, y: 1))),
                .rejected("unknown event type 'nope'"),
                .event(.text("hello")),
            ],
            reason: "no display 7 is attached")

        #expect(result.delivered == 1)
        #expect(result.rejected.map(\.index) == [1, 2, 3])
        #expect(result.rejected[0].reason == "no display 7 is attached")
        // A parse rejection keeps its own reason instead of being relabelled.
        #expect(result.rejected[1].reason == "unknown event type 'nope'")
        #expect(result.rejected[2].reason == "no display 7 is attached")
    }
}

/// A log of what jobs ran, in the order they ran.
@MainActor
final class JobLog {
    private(set) var entries: [String] = []
    func append(_ entry: String) { entries.append(entry) }
}

@Suite("input job queue")
@MainActor
struct InputJobQueueTests {
    /// Two batches from one driver are a click and the keystroke that depends
    /// on it; leaving the command chain must not reorder them.
    @Test("batches run in the order they were enqueued")
    func preservesOrder() async {
        let queue = InputJobQueue()
        let log = JobLog()

        queue.enqueue {
            // Suspends, so a queue that did not chain would let the next batch
            // overtake this one here.
            await Task.yield()
            log.append("first")
        }
        queue.enqueue { log.append("second") }
        await queue.settle()

        #expect(log.entries == ["first", "second"])
    }

    /// What `release-all` relies on: the batch in flight stops, and the batch
    /// behind it never types anything.
    @Test("cancelling the queue stops the running batch and the queued one")
    func cancelsInFlightAndQueued() async {
        let queue = InputJobQueue()
        let log = JobLog()

        queue.enqueue {
            while !Task.isCancelled { await Task.yield() }
            log.append("first stopped")
        }
        queue.enqueue { log.append(Task.isCancelled ? "second cancelled" : "second typed") }
        // Let the first batch start before cancelling, so this covers the
        // in-flight case and not only the queued one.
        await Task.yield()
        queue.cancelAll()
        await queue.settle()

        #expect(log.entries == ["first stopped", "second cancelled"])
    }

    /// A cancelled batch still answers its request; a driver waiting on that id
    /// would otherwise sit there until its own timeout.
    @Test("a cancelled batch still runs to its own end")
    func cancelledBatchStillReplies() async {
        let queue = InputJobQueue()
        let log = JobLog()

        queue.enqueue { log.append("replied") }
        queue.cancelAll()
        await queue.settle()

        #expect(log.entries == ["replied"])
    }
}

// ---------------------------------------------------------------------------
// Keyboard focus
// ---------------------------------------------------------------------------

/// A chat's screen: a managed display, off to the side of the main one.
private let chatDisplay = DisplayRecord(
    id: 37, name: "Chat A", kind: .managedVirtual, widthPx: 1280, heightPx: 800, scale: 1,
    main: false)
/// The screen the developer is looking at, to the left of it.
private let mainDisplay = DisplayRecord(
    id: 1, name: "Built-in", kind: .physical, widthPx: 1512, heightPx: 982, scale: 1, main: true)
/// Where those displays sit in the global point space.
private let chatBounds = CGRect(x: 1512, y: 0, width: 1280, height: 800)
private let mainBounds = CGRect(x: 0, y: 0, width: 1512, height: 982)
private let fixtureDisplays = [mainDisplay, chatDisplay]
private func fixtureBounds(_ id: CGDirectDisplayID) -> CGRect {
    switch id {
    case chatDisplay.id: return chatBounds
    case mainDisplay.id: return mainBounds
    default: return .null
    }
}
private let fixtureScreens = fixtureDisplays.map {
    DisplayAttribution.Screen(id: $0.id, bounds: fixtureBounds($0.id))
}

/// A window on the chat's screen, and one on the laptop's own screen.
private let windowOnChatScreen = CGRect(x: 1572, y: 60, width: 800, height: 600)
private let windowOnOwnScreen = CGRect(x: 100, y: 100, width: 800, height: 600)
/// Dragged across the boundary: 800 points of it on the main screen, one on the
/// chat's.
private let windowMostlyOnOwnScreen = CGRect(x: 712, y: 100, width: 801, height: 600)
/// The mirror image: one point on the main screen, 799 on the chat's.
private let windowMostlyOnChatScreen = CGRect(x: 1511, y: 100, width: 800, height: 600)
/// Exactly half on each, which no rule can attribute.
private let windowSplitEvenly = CGRect(x: 1412, y: 100, width: 200, height: 600)

/// A guard that reads focus from a script instead of from Accessibility.
@MainActor
private func guardWith(
    trusted: Bool = true, frames: [CGRect?]
) -> (guard: FocusGuard, reads: () -> Int) {
    let reader = FrameReader(frames: frames)
    return (
        FocusGuard(
            isTrusted: { trusted },
            focusedWindowFrame: { reader.next() },
            displayIds: { fixtureDisplays.map(\.id) },
            boundsOfDisplay: fixtureBounds),
        { reader.reads }
    )
}

/// Answers a scripted sequence of focused-window frames, repeating the last one
/// forever so a caller may read as often as it likes.
@MainActor
private final class FrameReader {
    private let frames: [CGRect?]
    private(set) var reads = 0

    init(frames: [CGRect?]) { self.frames = frames }

    func next() -> CGRect? {
        defer { reads += 1 }
        return frames[min(reads, frames.count - 1)]
    }
}

@Suite("display attribution")
struct DisplayAttributionTests {
    @Test("a window wholly on one screen belongs to it")
    func wholly() {
        #expect(DisplayAttribution.owner(of: windowOnChatScreen, among: fixtureScreens) == 37)
        #expect(DisplayAttribution.owner(of: windowOnOwnScreen, among: fixtureScreens) == 1)
    }

    /// The regression: a window one point over the boundary is not "on" the
    /// screen it barely touches, whoever is asking.
    @Test("a straddling window belongs to the screen holding most of it")
    func straddling() {
        #expect(DisplayAttribution.owner(of: windowMostlyOnOwnScreen, among: fixtureScreens) == 1)
        #expect(DisplayAttribution.owner(of: windowMostlyOnChatScreen, among: fixtureScreens) == 37)
    }

    /// Nothing to break the tie with, so there is no owner rather than an
    /// arbitrary one that depends on the order the window server listed the
    /// screens in.
    @Test("a window split evenly belongs to neither")
    func tie() {
        #expect(DisplayAttribution.owner(of: windowSplitEvenly, among: fixtureScreens) == nil)
    }

    /// Touching edges are not an overlap: a window flush against the left edge
    /// of a display is entirely on the one before it.
    @Test("no overlap and a zero-area touch have no owner")
    func noOverlap() {
        #expect(
            DisplayAttribution.owner(
                of: CGRect(x: 712, y: 0, width: 800, height: 600), among: [fixtureScreens[1]])
                == nil)
        #expect(DisplayAttribution.owner(of: .null, among: fixtureScreens) == nil)
        #expect(DisplayAttribution.owner(of: windowOnChatScreen, among: []) == nil)
        #expect(
            DisplayAttribution.owner(
                of: windowOnChatScreen, among: [.init(id: 9, bounds: .null)]) == nil)
    }

    /// What `place` is checked with: a frame that could not be read is not
    /// evidence that the window arrived.
    @Test("an unreadable frame is not owned by anything")
    func unreadableFrame() {
        #expect(!DisplayAttribution.isOwned(nil, by: 37, among: fixtureScreens))
        #expect(DisplayAttribution.isOwned(windowOnChatScreen, by: 37, among: fixtureScreens))
        #expect(!DisplayAttribution.isOwned(windowMostlyOnOwnScreen, by: 37, among: fixtureScreens))
        #expect(!DisplayAttribution.isOwned(windowSplitEvenly, by: 37, among: fixtureScreens))
    }
}

/// The two consumers of attribution, asked the same questions.
///
/// They disagreed before: the guard accepted any positive overlap while the
/// window list attributed a window to the screen holding most of it, so a
/// window listed as being on the user's own screen was typed into as if it were
/// on the chat's.
@Suite("attribution agrees across its consumers")
@MainActor
struct AttributionAgreementTests {
    @Test("the window list and the focus guard attribute the same frames alike")
    func agree() {
        let fixtures: [CGRect] = [
            windowOnChatScreen, windowOnOwnScreen, windowMostlyOnChatScreen,
            windowMostlyOnOwnScreen, windowSplitEvenly,
            CGRect(x: 2000, y: 700, width: 400, height: 400),
            CGRect(x: 5000, y: 5000, width: 100, height: 100),
        ]

        for frame in fixtures {
            let listed = WindowInspector.bestDisplay(
                for: frame, among: fixtureDisplays, bounds: fixtureBounds)
            let (focus, _) = guardWith(frames: [frame])
            let typeable = focus.rejectionReason(display: chatDisplay) == nil

            #expect(
                typeable == (listed?.id == chatDisplay.id),
                "disagreed about \(frame): listed on \(String(describing: listed?.id))")
        }
    }
}

@Suite("focus guard")
@MainActor
struct FocusGuardTests {
    @Test("focus on the display permits typing")
    func onDisplay() {
        let (focus, _) = guardWith(frames: [windowOnChatScreen])
        #expect(focus.rejectionReason(display: chatDisplay) == nil)
    }

    @Test("focus on another screen names that reason")
    func offDisplay() {
        let (focus, _) = guardWith(frames: [windowOnOwnScreen])
        #expect(focus.rejectionReason(display: chatDisplay) == "keyboard focus is on another screen")
    }

    /// Nothing frontmost, a frontmost app with no focused window, or an app
    /// whose only window is its main one rather than its focused one: none of
    /// them is an excuse to type into whatever is there.
    @Test("no readable focused window is refused, and says so in its own words")
    func noWindow() {
        let (focus, _) = guardWith(frames: [nil])
        #expect(focus.rejectionReason(display: chatDisplay) == "no window has keyboard focus")
    }

    /// The straddling cases, through the guard rather than through attribution
    /// directly: this is the decision that used to let a window one point over
    /// the edge collect the chat's typing.
    @Test("a window mostly on the user's own screen is refused")
    func mostlyElsewhere() {
        let (focus, _) = guardWith(frames: [windowMostlyOnOwnScreen])
        #expect(focus.rejectionReason(display: chatDisplay) == FocusGuard.elsewhereReason)
    }

    @Test("a window mostly on the chat's screen is accepted")
    func mostlyHere() {
        let (focus, _) = guardWith(frames: [windowMostlyOnChatScreen])
        #expect(focus.rejectionReason(display: chatDisplay) == nil)
    }

    @Test("a window split evenly between two screens is refused")
    func splitEvenly() {
        let (focus, _) = guardWith(frames: [windowSplitEvenly])
        #expect(focus.rejectionReason(display: chatDisplay) == FocusGuard.elsewhereReason)
    }

    /// Without Accessibility the question cannot be answered at all, and the
    /// message has to tell the user what to do about it.
    @Test("without Accessibility typing is refused with a message about the grant")
    func untrusted() {
        let (focus, reads) = guardWith(trusted: false, frames: [windowOnChatScreen])
        #expect(
            focus.rejectionReason(display: chatDisplay)
                == "Accessibility is required to confirm where typing would land")
        // The window is never even read: there is no way to read it.
        #expect(reads() == 0)
    }
}

/// Batches sent for a chat's screen while focus is somewhere else.
///
/// Nothing here posts input. Every keyboard event is refused before it reaches
/// the tap, the pointer event names a point off its display, and the
/// controller holds nothing for `release-all` to let go of — so running these
/// does not move the cursor or type into whatever the developer has open.
@Suite("keyboard focus guard")
@MainActor
struct KeyboardFocusGuardTests {
    /// The case root measured on a real Mac: text sent for chat A while chat
    /// B's window is focused used to arrive in B.
    @Test("keyboard events are refused when focus is on another screen")
    func refusesKeyboard() async {
        let (focus, _) = guardWith(frames: [windowOnOwnScreen])
        let controller = InputController(focus: focus)

        let result = await controller.deliver(
            events: [
                .event(.key(code: "KeyA", down: true, modifiers: [])),
                .event(.keyPress(code: "Enter", modifiers: [])),
                .event(.text("hello")),
                .event(.click(button: .left, count: 1, point: .zero, modifiers: [.meta])),
            ],
            display: chatDisplay)

        #expect(result.delivered == 0)
        #expect(result.rejected.map(\.index) == [0, 1, 2, 3])
        #expect(result.rejected.allSatisfy { $0.reason == FocusGuard.elsewhereReason })
    }

    /// Pointer events carry their own target, so the keyboard's problem is not
    /// theirs: this one is judged by its coordinates, and the `release-all`
    /// behind it still runs.
    @Test("a pointer event and a release are judged on their own terms")
    func pointerUnaffected() async {
        let (focus, _) = guardWith(frames: [windowOnOwnScreen])
        let controller = InputController(focus: focus)

        let result = await controller.deliver(
            events: [
                .event(.text("hello")),
                .event(.move(point: CGPoint(x: 9000, y: 9000))),
                .event(.releaseAll),
            ],
            display: chatDisplay)

        #expect(result.delivered == 1)
        #expect(result.rejected[0].reason == FocusGuard.elsewhereReason)
        #expect(result.rejected[1].reason.contains("outside display 37"))
    }

    /// Refusing a key-up would leave held down whatever its key-down pressed,
    /// on the desktop the human is sitting at. It is judged like any other
    /// event instead — here, by the key table.
    @Test("a key-up is not refused for focus")
    func keyUpIsNotGated() async {
        let (focus, _) = guardWith(frames: [windowOnOwnScreen])
        let controller = InputController(focus: focus)

        let result = await controller.deliver(
            events: [.event(.key(code: "KeyÅ", down: false, modifiers: []))],
            display: chatDisplay)

        #expect(result.rejected.count == 1)
        #expect(result.rejected[0].reason.contains("unknown key code"))
    }

    /// Once focus has been found elsewhere the rest of the batch is refused on
    /// that finding rather than racing the next read: a batch must not type
    /// half a password into another window because focus flickered back.
    @Test("the first refusal latches for the rest of the batch")
    func latches() async {
        let (focus, reads) = guardWith(frames: [windowOnOwnScreen, windowOnChatScreen])
        let controller = InputController(focus: focus)

        let result = await controller.deliver(
            events: [
                .event(.keyPress(code: "KeyA", modifiers: [])),
                .event(.keyPress(code: "KeyB", modifiers: [])),
                .event(.keyPress(code: "KeyC", modifiers: [])),
            ],
            display: chatDisplay)

        #expect(result.delivered == 0)
        #expect(result.rejected.count == 3)
        #expect(reads() == 1)
    }

    @Test("without Accessibility keyboard events say which grant is missing")
    func untrustedBatch() async {
        let (focus, _) = guardWith(trusted: false, frames: [windowOnChatScreen])
        let controller = InputController(focus: focus)

        let result = await controller.deliver(
            events: [.event(.text("hello"))], display: chatDisplay)

        #expect(result.rejected[0].reason == FocusGuard.untrustedReason)
    }
}

/// Typing while the human clicks away mid-sentence.
///
/// Driven through `TextDeliveryJob` with the same `FocusGuard` production
/// uses, and with the posting injected: a real `InputController` text delivery
/// would type this string into whatever the developer running the tests has
/// focused.
@Suite("typing follows focus nowhere")
@MainActor
struct TypingFocusTests {
    @Test("focus moving mid-string stops the typing and reports how far it got")
    func stopsMidString() async {
        let recorder = TypingRecorder()
        let (focus, _) = guardWith(
            frames: [
                windowOnChatScreen, windowOnChatScreen, windowOnChatScreen, windowOnOwnScreen,
            ])
        let job = TextDeliveryJob(
            text: "abcdef", gap: .zero,
            blocked: { focus.rejectionReason(display: chatDisplay) },
            post: { grapheme, phase in recorder.record(grapheme, phase) })

        let outcome = await job.run()

        #expect(outcome == .stopped(reason: FocusGuard.elsewhereReason, typed: 3))
        #expect(recorder.downs == ["a", "b", "c"])
        #expect(recorder.ups == ["a", "b", "c"])
    }

    @Test("focus that stays put types the whole string")
    func staysPut() async {
        let recorder = TypingRecorder()
        let (focus, _) = guardWith(frames: [windowOnChatScreen])
        let job = TextDeliveryJob(
            text: "abc", gap: .zero,
            blocked: { focus.rejectionReason(display: chatDisplay) },
            post: { grapheme, phase in recorder.record(grapheme, phase) })

        #expect(await job.run() == .completed(typed: 3))
        #expect(recorder.downs == ["a", "b", "c"])
    }
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/// A bundle that resolves but is never started.
@MainActor
private func makeProbeBundle() throws -> String {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("t3-launch-tests-\(UUID().uuidString)")
        .appendingPathComponent("Probe.app")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.path
}

@Suite("launch preflight")
@MainActor
struct LaunchPreflightTests {
    /// The bug: the helper launched first and checked Accessibility afterwards,
    /// so without the grant the app opened on the user's own screen and there
    /// was nothing left to do about it.
    @Test("a launch onto a display without Accessibility throws before spawning")
    func preflightsBeforeSpawning() async throws {
        let app = try makeProbeBundle()
        var spawned = false

        do {
            _ = try await AppLauncher.launch(
                app: app, arguments: [], display: chatDisplay, isTrusted: { false },
                spawn: { _, _ in
                    spawned = true
                    return 4242
                })
            Issue.record("expected the launch to be refused")
        } catch let error as HelperError {
            #expect(error.code == .permissionDenied)
            #expect(error.message.contains("would open on your own screen"))
        }

        #expect(!spawned)
    }

    /// No display, no placement claim: a launch onto the shared desktop is not
    /// a launch that failed to place anything.
    @Test("a launch with no display reports no placement either way")
    func noDisplayNoClaim() async throws {
        let app = try makeProbeBundle()

        let outcome = try await AppLauncher.launch(
            app: app, arguments: [], display: nil, isTrusted: { false },
            spawn: { _, _ in 4242 })

        #expect(outcome.pid == 4242)
        #expect(outcome.placedWindows == nil)
        #expect(outcome.placed == nil)
    }

    @Test("an app that resolves to nothing is invalid input, not a permission problem")
    func unresolvable() async {
        await #expect(throws: HelperError.self) {
            _ = try await AppLauncher.launch(
                app: "/nonexistent/Nope.app", arguments: [], display: chatDisplay,
                isTrusted: { true }, spawn: { _, _ in 1 })
        }
    }

    @Test("placement is reported honestly")
    func outcomeShape() {
        #expect(AppLauncher.Outcome(pid: 1, placedWindows: 0).placed == false)
        #expect(AppLauncher.Outcome(pid: 1, placedWindows: 2).placed == true)
    }
}

/// Which windows a launch may move.
///
/// The bug this guards: `launch` enumerated every window of the pid it got
/// back, and an app that ignores `createsNewApplicationInstance` hands back the
/// process the user is already working in — so their open windows were dragged
/// onto a chat's screen and counted as the launch's own.
@Suite("launch window ownership")
@MainActor
struct LaunchWindowOwnershipTests {
    @Test("every window of a process the launch created is the launch's own")
    func freshProcess() {
        #expect(AppLauncher.newWindowIds([11, 12], openBeforeLaunch: nil) == [11, 12])
        // Even one Accessibility could not name: there is nobody else's window
        // in a process that did not exist a moment ago.
        #expect(AppLauncher.newWindowIds([0], openBeforeLaunch: nil) == [0])
        #expect(AppLauncher.newWindowIds([], openBeforeLaunch: nil).isEmpty)
    }

    @Test("a reused process keeps the windows it already had")
    func reusedProcess() {
        #expect(AppLauncher.newWindowIds([11, 12, 13], openBeforeLaunch: [11, 12]) == [13])
        #expect(AppLauncher.newWindowIds([11, 12], openBeforeLaunch: [11, 12]).isEmpty)
    }

    /// An unnameable window in a reused process cannot be told from one that
    /// was already open, and the safe direction is to leave it alone: a
    /// placement not made is reported, a window moved out from under the user
    /// is not undoable.
    @Test("a window Accessibility cannot name is left alone in a reused process")
    func unnameableInReusedProcess() {
        #expect(AppLauncher.newWindowIds([0, 13], openBeforeLaunch: [11]) == [13])
        #expect(AppLauncher.newWindowIds([0], openBeforeLaunch: []).isEmpty)
    }
}

/// The check `WindowInspector.place` makes after it moves a window.
///
/// `AXUIElementSetAttributeValue` reports only that the app took the message.
/// The frame is read back and attributed, by the same rule the window list and
/// the focus guard use, and only that decides whether a window is counted as
/// placed.
@Suite("placement is verified, not assumed")
struct PlacementCheckTests {
    @Test("a window that arrived counts, one that did not does not")
    func verifies() {
        #expect(
            DisplayAttribution.isOwned(
                CGRect(x: 1572, y: 60, width: 1160, height: 680), by: chatDisplay.id,
                among: fixtureScreens))
        // The app accepted the move and put the window back on the main screen.
        #expect(!DisplayAttribution.isOwned(windowOnOwnScreen, by: chatDisplay.id, among: fixtureScreens))
        // The app clamped the move to a minimum size and only a sliver crossed.
        #expect(
            !DisplayAttribution.isOwned(
                windowMostlyOnOwnScreen, by: chatDisplay.id, among: fixtureScreens))
        // The frame could not be read back at all.
        #expect(!DisplayAttribution.isOwned(nil, by: chatDisplay.id, among: fixtureScreens))
    }
}

@Suite("launched record")
struct LaunchedRecordTests {
    @Test("a placement is reported with its count")
    func placement() throws {
        let bytes = Record.launched(id: 4, pid: 4242, placedWindows: 2).encoded()
        let object = try #require(
            try JSONSerialization.jsonObject(with: bytes.dropLast()) as? [String: Any])
        #expect(object["pid"] as? Int == 4242)
        #expect(object["placedWindows"] as? Int == 2)
        #expect(object["placed"] as? Bool == true)
    }

    /// The case the server turns into a warning: the app started, and its
    /// window is on whatever screen the app chose.
    @Test("no window placed is reported as such, not as success")
    func nothingPlaced() throws {
        let bytes = Record.launched(id: 4, pid: 4242, placedWindows: 0).encoded()
        let object = try #require(
            try JSONSerialization.jsonObject(with: bytes.dropLast()) as? [String: Any])
        #expect(object["placedWindows"] as? Int == 0)
        #expect(object["placed"] as? Bool == false)
    }

    /// A launch that named no display asked for no placement, so it claims
    /// neither success nor failure at it.
    @Test("a launch with no display omits the placement fields")
    func omitted() throws {
        let bytes = Record.launched(id: 4, pid: nil, placedWindows: nil).encoded()
        let object = try #require(
            try JSONSerialization.jsonObject(with: bytes.dropLast()) as? [String: Any])
        #expect(object["pid"] is NSNull)
        #expect(object["placedWindows"] == nil)
        #expect(object["placed"] == nil)
    }
}
