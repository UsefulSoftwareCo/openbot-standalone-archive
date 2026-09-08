import AppKit
import Foundation
import T3ComputerHelperCore

/// T3 Code's macOS computer helper.
///
/// It sees and drives the host's shared login session: one pointer, one
/// frontmost app, shared by the human at the machine and by the agents. A
/// managed display it creates is another screen on that same session, never a
/// private desktop.
///
/// It ships as a `.app` because TCC records Screen Recording and Accessibility
/// against a bundle identifier and a code signature, and a bare SwiftPM
/// executable has neither.

let options: Options
do {
    options = try Options.parse(Array(CommandLine.arguments.dropFirst()))
} catch let error as HelperError {
    FileHandle.standardError.write(Data("\(error.message)\n\n\(Options.usage)\n".utf8))
    exit(2)
}

if options.showsHelp {
    print(Options.usage)
    exit(0)
}

// An accessory app has a main run loop and no Dock tile. The run loop is not
// optional: CGVirtualDisplay, ScreenCaptureKit and Accessibility all need one.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)

let runtime = HelperRuntime(options: options)
do {
    try MainActor.assumeIsolated { try runtime.start() }
} catch let error as HelperError {
    FileHandle.standardError.write(Data("helper failed to start: \(error.message)\n".utf8))
    exit(1)
} catch {
    FileHandle.standardError.write(Data("helper failed to start: \(error)\n".utf8))
    exit(1)
}

application.run()
