import Foundation

/// Which half of a keystroke a `TextDeliveryJob` is posting.
public enum TextKeyPhase: Sendable, Equatable {
    case down
    case up
}

/// Types one `text` event grapheme by grapheme, pacing itself with awaits
/// rather than blocking waits.
///
/// The pacing is measured, not guessed: at 6ms a receiving app silently
/// swallowed roughly half of a typed string, because events posted to the HID
/// tap are delivered asynchronously and a target that cannot keep up drops them
/// with no error anywhere. 15ms types about 33 characters a second and arrives
/// complete. The contract allows 4096 characters in one event, which at that
/// rate is two minutes — so the wait has to be an await. Blocking the main run
/// loop for two minutes stalls the disconnect cleanup, the permission poll,
/// `release-all` and every other command behind it.
///
/// Awaiting also makes the gap a cancellation point, which is what turns a
/// runaway sentence into something `release-all` can stop.
///
/// `post` is injected so the pacing and the cancellation behaviour are testable
/// without an event tap, and without typing into whatever the developer running
/// the tests has focused.
@MainActor
public struct TextDeliveryJob {
    /// How a run ended, and how many graphemes actually reached the tap.
    public enum Outcome: Sendable, Equatable {
        case completed(typed: Int)
        case cancelled(typed: Int)
    }

    private let graphemes: [String]
    private let gap: Duration
    private let post: (String, TextKeyPhase) -> Void
    private let pause: (Duration) async throws -> Void

    /// - Parameters:
    ///   - pause: how the job waits out one gap. It must throw when the wait is
    ///     cancelled. The default sleeps, which is the production behaviour;
    ///     tests substitute it to drive cancellation without a clock.
    ///   - post: posts one half of one keystroke.
    public init(
        text: String,
        gap: Duration = .milliseconds(15),
        pause: ((Duration) async throws -> Void)? = nil,
        post: @escaping (String, TextKeyPhase) -> Void
    ) {
        // Graphemes, not scalars, so an emoji or a combining accent arrives
        // whole rather than as its pieces.
        self.graphemes = text.map { String($0) }
        self.gap = gap
        self.post = post
        self.pause = pause ?? { try await Task.sleep(for: $0) }
    }

    /// Types the text, stopping at the first cancellation.
    ///
    /// A keystroke is atomic: once its key-down is out, the matching key-up is
    /// posted even when the wait between the two was cancelled, so cancelling
    /// never leaves a key down on the shared desktop.
    public func run() async -> Outcome {
        var typed = 0
        for grapheme in graphemes {
            if Task.isCancelled { return .cancelled(typed: typed) }
            post(grapheme, .down)
            let cancelledMidKeystroke = await !waited()
            post(grapheme, .up)
            typed += 1
            if cancelledMidKeystroke { return .cancelled(typed: typed) }
            if typed < graphemes.count, await !waited() { return .cancelled(typed: typed) }
        }
        return .completed(typed: typed)
    }

    /// True when the gap elapsed, false when the wait was cancelled.
    private func waited() async -> Bool {
        do {
            try await pause(gap)
            return !Task.isCancelled
        } catch {
            return false
        }
    }
}

/// A serial queue of input batches that can be cancelled as a group.
///
/// Input does not run on the service's command chain. One batch can legitimately
/// take minutes — typing is paced — and everything behind it on that chain,
/// `capture-stop` and `windows` and the disconnect cleanup included, would wait
/// that out. Input gets its own queue instead: two batches still run in the
/// order they arrived, and the rest of the protocol stays responsive.
///
/// `cancelAll` is what makes `release-all` prompt. It cancels the batch in
/// flight along with everything queued behind it, so the release lands in
/// milliseconds rather than after the sentence someone else is still typing.
@MainActor
public final class InputJobQueue {
    /// The task the next job waits on, which is what preserves arrival order.
    private var tail: Task<Void, Never>?
    /// Everything queued or in flight, so cancellation can reach all of it. A
    /// job removes its own entry when it ends.
    private var live: [Int: Task<Void, Never>] = [:]
    private var nextJobId = 0

    public init() {}

    /// Appends a batch. Jobs run one at a time, in enqueue order.
    ///
    /// A job is expected to answer its own request, cancelled or not: the
    /// driver is waiting on a reply with that command's id either way.
    public func enqueue(_ job: @escaping @MainActor @Sendable () async -> Void) {
        let previous = tail
        let id = nextJobId
        nextJobId += 1
        let task = Task { @MainActor [weak self] in
            // A cancelled predecessor finishes almost at once, so ordering
            // costs nothing once the queue has been cancelled.
            await previous?.value
            await job()
            self?.live[id] = nil
        }
        tail = task
        live[id] = task
    }

    /// Cancels every queued and in-flight batch.
    ///
    /// Each job still runs to its own end so it can report what it did; the
    /// events it never reached come back as rejections rather than vanishing.
    public func cancelAll() {
        for task in live.values { task.cancel() }
        live.removeAll()
    }

    /// Waits for the queue to drain.
    ///
    /// Used on the shutdown path so a cancelled batch's reply reaches the
    /// writer before it is flushed. Cancel first: this is not a place to wait
    /// out a batch that is still typing.
    public func settle() async {
        await tail?.value
    }
}
