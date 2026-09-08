// swift-tools-version: 6.0
import PackageDescription

// The helper is a bundled `.app`, not a bare executable: TCC records Screen
// Recording and Accessibility against a bundle identifier plus a code
// signature, and `swift build` alone produces neither. `scripts/bundle.sh`
// assembles what the server actually launches.
let package = Package(
    name: "T3ComputerHelper",
    platforms: [.macOS(.v14)],
    targets: [
        // Private CoreGraphics classes for virtual displays, declared in
        // Objective-C because they have no public headers to import.
        .target(
            name: "T3VirtualDisplay",
            publicHeadersPath: "include",
            linkerSettings: [.linkedFramework("CoreGraphics"), .linkedFramework("AppKit")]
        ),
        // Everything the helper does. Separate from the executable so the pure
        // parts (key table, coordinate and wheel mapping, record framing) are
        // reachable from tests.
        .target(
            name: "T3ComputerHelperCore",
            dependencies: ["T3VirtualDisplay"],
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("ImageIO"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
            ]
        ),
        .executableTarget(name: "T3ComputerHelper", dependencies: ["T3ComputerHelperCore"]),
        .testTarget(name: "T3ComputerHelperCoreTests", dependencies: ["T3ComputerHelperCore"]),
    ]
)
