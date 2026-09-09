import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

@preconcurrency import ScreenCaptureKit

/// JPEG per frame is the deliberate choice for this wire: every browser decodes
/// it with no codec pipeline, a dropped frame costs nothing because each one is
/// independent, and there is no keyframe state to resynchronise after a
/// reconnect. Moving to a real video codec later changes the frame envelope,
/// not the protocol around it.
enum ImageCodec {
    static func jpeg(_ image: CGImage, quality: Double) -> Data? {
        let data = NSMutableData()
        guard
            let destination = CGImageDestinationCreateWithData(
                data, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(
            destination, image,
            [kCGImageDestinationLossyCompressionQuality: max(0.1, min(quality, 1.0))]
                as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}

/// Receives frames off ScreenCaptureKit's own queue.
///
/// Whoever builds one of these must keep it alive for as long as the stream
/// runs; see `CaptureSession`.
///
/// SAFETY: `@unchecked Sendable` because it holds only immutable state — a
/// `CIContext`, which is documented as thread-safe, and two `@Sendable`
/// closures.
final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let context = CIContext(options: [.useSoftwareRenderer: false])
    private let onImage: @Sendable (CGImage) -> Void
    private let onStop: @Sendable (String) -> Void

    init(
        onImage: @escaping @Sendable (CGImage) -> Void, onStop: @escaping @Sendable (String) -> Void
    ) {
        self.onImage = onImage
        self.onStop = onStop
    }

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        // The compositor marks an unchanged frame idle. Skipping those is what
        // makes an idle screen cost nothing on the wire.
        guard type == .screen, CMSampleBufferIsValid(sampleBuffer),
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let rawStatus = attachments.first?[.status] as? Int,
            SCFrameStatus(rawValue: rawStatus) == .complete,
            let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }
        onImage(cgImage)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop(error.localizedDescription)
    }
}

/// One display's live capture.
///
/// `output` is not bookkeeping. `SCStream(filter:configuration:delegate:)` and
/// `addStreamOutput(_:type:sampleHandlerQueue:)` both hold what you hand them
/// *weakly*, so the session is the only strong reference to the object that
/// receives frames. Drop it and capture silently produces nothing: the stream
/// still starts, `capture-start` still reports `capturing`, and
/// ScreenCaptureKit logs `stream output NOT found. Dropping frame` for every
/// frame until the stream stops. Releasing the session releases the stream and
/// the output together, which is exactly what `stop` wants.
final class CaptureSession {
    let stream: SCStream
    let output: CaptureOutput
    let widthPx: Int
    let heightPx: Int

    init(stream: SCStream, output: CaptureOutput, widthPx: Int, heightPx: Int) {
        self.stream = stream
        self.output = output
        self.widthPx = widthPx
        self.heightPx = heightPx
    }
}

/// Live capture, one `SCStream` per display.
///
/// Streams for several displays run at once because the product streams several
/// screens at once, but with one caveat carried over from an earlier build:
/// `SCStream` has been seen to misroute frames across *virtual* displays after
/// they connect and disconnect, serving the last-connected display regardless
/// of the id in its filter. There is no filter-side fix. What reliably avoids
/// the state is never stacking a new stream on one that has not finished
/// stopping, so `start` awaits `stop` for the same display before rebuilding.
@MainActor
public final class CaptureManager {
    private var sessions: [CGDirectDisplayID: CaptureSession] = [:]
    private var generations: [CGDirectDisplayID: Int] = [:]

    /// Called with each encoded frame. The manager never buffers: whoever takes
    /// this decides what to do when the reader is behind.
    public var onFrame: (@Sendable (CGDirectDisplayID, Int, Int, Data) -> Void)?
    /// Called when ScreenCaptureKit stops a stream on its own.
    public var onStopped: (@Sendable (CGDirectDisplayID, String) -> Void)?

    public init() {}

    public var capturedDisplayIds: [CGDirectDisplayID] { Array(sessions.keys) }

    public func start(
        display: DisplayRecord, maxWidthPx: Int, fps: Int, quality: Double
    ) async throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError(
                .permissionDenied,
                "Screen Recording permission is required to capture a display")
        }
        // Rebuilding on top of a stream that has not finished stopping is the
        // state that reproduces the cross-display misroute.
        await stop(displayId: display.id)

        let generation = (generations[display.id] ?? 0) + 1
        generations[display.id] = generation

        let content = try await shareableContent()
        guard let target = content.displays.first(where: { $0.displayID == display.id }) else {
            throw HelperError(.displayNotFound, "display \(display.id) is not shareable")
        }

        let size = InputGeometry.captureSize(
            sourceWidthPx: display.widthPx, sourceHeightPx: display.heightPx,
            maxWidthPx: maxWidthPx)
        let configuration = SCStreamConfiguration()
        configuration.width = size.width
        configuration.height = size.height
        // Defaults to false: ask for a buffer that is not the source size and
        // ScreenCaptureKit anchors the content top-left instead of scaling it,
        // so the viewer sees a cropped corner of the screen.
        configuration.scalesToFit = true
        configuration.showsCursor = true
        configuration.captureResolution = .best
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = 5
        configuration.minimumFrameInterval = CMTime(
            value: 1, timescale: CMTimeScale(max(1, min(fps, 30))))

        let displayId = display.id
        let width = size.width
        let height = size.height
        let onFrame = self.onFrame
        let onStopped = self.onStopped
        let output = CaptureOutput(
            onImage: { image in
                guard let data = ImageCodec.jpeg(image, quality: quality) else { return }
                onFrame?(displayId, width, height, data)
            },
            onStop: { message in
                onStopped?(displayId, message)
            })

        let stream = SCStream(
            filter: SCContentFilter(display: target, excludingWindows: []),
            configuration: configuration, delegate: output)
        try stream.addStreamOutput(
            output, type: .screen,
            sampleHandlerQueue: DispatchQueue(
                label: "codes.t3.openbot.helper.capture.\(displayId)", qos: .userInteractive))
        try await stream.startCapture()

        // A `capture-stop` that arrived while we were awaiting the start must
        // win, or the stop is silently undone by the stream we just built.
        // No session is built here, so `output` dies with this scope — correct,
        // because nothing should be delivered to it.
        guard generations[display.id] == generation else {
            try? await stream.stopCapture()
            return
        }
        sessions[display.id] = CaptureSession(
            stream: stream, output: output, widthPx: width, heightPx: height)
    }

    /// Tears a capture down and waits for ScreenCaptureKit to acknowledge it.
    public func stop(displayId: CGDirectDisplayID) async {
        generations[displayId] = (generations[displayId] ?? 0) + 1
        guard let session = sessions.removeValue(forKey: displayId) else { return }
        try? await session.stream.stopCapture()
    }

    public func stopAll() async {
        for id in sessions.keys { await stop(displayId: id) }
    }

    /// One still of one display.
    ///
    /// `SCScreenshotManager` rather than a polling `SCStream`, because a still
    /// is exactly what it is for; the reverse — driving live capture from
    /// repeated screenshots — is what does not work, since each shot needs an
    /// `SCShareableContent` call that enumerates every window on the system.
    public func screenshot(
        display: DisplayRecord, maxWidthPx: Int, quality: Double
    ) async throws -> (widthPx: Int, heightPx: Int, jpeg: Data) {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError(
                .permissionDenied,
                "Screen Recording permission is required to capture a display")
        }
        let content = try await shareableContent()
        guard let target = content.displays.first(where: { $0.displayID == display.id }) else {
            throw HelperError(.displayNotFound, "display \(display.id) is not shareable")
        }
        let size = InputGeometry.captureSize(
            sourceWidthPx: display.widthPx, sourceHeightPx: display.heightPx,
            maxWidthPx: maxWidthPx)
        let configuration = SCStreamConfiguration()
        configuration.width = size.width
        configuration.height = size.height
        configuration.scalesToFit = true
        configuration.showsCursor = true
        configuration.captureResolution = .best
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(display: target, excludingWindows: []),
            configuration: configuration)
        guard let jpeg = ImageCodec.jpeg(image, quality: quality) else {
            throw HelperError(.captureFailed, "the screenshot could not be encoded as JPEG")
        }
        return (image.width, image.height, jpeg)
    }

    private func shareableContent() async throws -> SCShareableContent {
        do {
            return try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
        } catch {
            throw HelperError(
                .permissionDenied,
                "ScreenCaptureKit refused to list shareable content: \(error.localizedDescription)")
        }
    }
}
