import Foundation

/// How the helper was asked to run.
public struct Options: Sendable, Equatable {
    public enum Mode: Sendable, Equatable {
        /// NDJSON on stdin, records on stdout. A diagnostic mode: a helper
        /// spawned as a child of the server inherits the server's TCC
        /// responsible process, so its permission grants are attributed to
        /// whatever started the server rather than to the helper.
        case stdio
        /// A Unix domain socket the server connects to after launching the
        /// bundle through Launch Services. This is the product path.
        case socket(path: String, token: String, readyFile: String?)
    }

    public var mode: Mode = .stdio
    public var exitOnDisconnect = false
    public var showsHelp = false

    public static let usage = """
        T3ComputerHelper — screen view and control for one macOS login session.

        USAGE
          T3ComputerHelper --stdio
          T3ComputerHelper --socket <path> --token <hex> [--ready-file <path>] [--exit-on-disconnect]

        OPTIONS
          --stdio                NDJSON commands on stdin, records on stdout, logs on stderr.
          --socket <path>        Listen on a Unix domain socket (mode 0600).
          --token <hex>          Shared secret; the first line on a socket must be
                                 {"type":"auth","token":"<hex>"}.
          --ready-file <path>    Write {"event":"ready","pid":N,"socket":"..."} once listening.
          --exit-on-disconnect   Exit when the connected driver goes away.
          --help                 Print this and exit.

        The helper reports Screen Recording and Accessibility state; it only ever
        prompts for them in response to a `request-permissions` command.
        """

    /// Parses argv. Fails only on a flag whose value is missing or unusable,
    /// so a typo is a message rather than a silent default.
    public static func parse(_ raw: [String]) throws -> Options {
        var options = Options()
        var socketPath: String?
        var token: String?
        var readyFile: String?
        var index = 0
        while index < raw.count {
            let flag = raw[index]
            func value() throws -> String {
                guard index + 1 < raw.count else {
                    throw HelperError(.invalidInput, "\(flag) needs a value")
                }
                index += 1
                return raw[index]
            }
            switch flag {
            case "--stdio": options.mode = .stdio
            case "--socket": socketPath = try value()
            case "--token": token = try value()
            case "--ready-file": readyFile = try value()
            case "--exit-on-disconnect": options.exitOnDisconnect = true
            case "--help", "-h": options.showsHelp = true
            default:
                throw HelperError(.invalidInput, "unknown option '\(flag)'")
            }
            index += 1
        }
        if let socketPath {
            guard let token, !token.isEmpty else {
                throw HelperError(
                    .invalidInput,
                    "--socket needs --token: an unauthenticated socket would let any local"
                        + " process move this user's cursor")
            }
            options.mode = .socket(path: socketPath, token: token, readyFile: readyFile)
        }
        return options
    }
}
