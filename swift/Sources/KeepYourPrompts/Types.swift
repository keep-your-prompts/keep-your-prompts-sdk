import Foundation

/// SDK version.
public let keepYourPromptsVersion = "0.1.0"

/// Everything the SDK throws.
public enum KYPError: Error, Sendable, Equatable, CustomStringConvertible {
    /// `render`/`prompt` for a name that is not in the deployed manifest.
    case notFound(String)
    /// `render` was called without a value for one or more `{{variables}}` (every missing name).
    case missingVariables([String])
    /// No mirror could deliver a manifest during start-up.
    case unavailable(String)
    /// A mirror returned something that does not follow the protocol.
    case protocolError(String)
    /// Invalid options (app/env not a slug, bad delivery key, ...).
    case invalidConfiguration(String)

    public var description: String {
        switch self {
        case .notFound(let n): return "prompt not found: \"\(n)\""
        case .missingVariables(let names):
            return "missing template variable\(names.count == 1 ? "" : "s"): \(names.joined(separator: ", "))"
        case .unavailable(let m): return "prompts unavailable: \(m)"
        case .protocolError(let m): return "protocol error: \(m)"
        case .invalidConfiguration(let m): return "invalid configuration: \(m)"
        }
    }
}

/// A deployed prompt.
public struct Prompt: Sendable, Equatable {
    /// Name in the manifest (may contain `/`).
    public let name: String
    public let version: Int
    /// Lowercase hex SHA-256 of `text`.
    public let sha256: String
    /// Declared variables (extracted from the text when the manifest lists none).
    public let variables: [String]
    /// The raw template.
    public let text: String

    /// Renders this prompt.
    public func render(_ vars: [String: String] = [:], onMissing: OnMissing = .error) throws -> String {
        try renderTemplate(text, vars, onMissing: onMissing)
    }
}

/// One copy of a workspace (layout `envs/<app>/<env>.json` + `blobs/<sha256>`).
public struct Mirror: Sendable, Equatable {
    /// Shown in `status()` and logs, e.g. `"cdn"`.
    public var name: String
    /// `https://host/base`, `file:///dir` or a plain path.
    public var url: String
    /// Sent as `Authorization: Bearer` (git mirror, origin).
    public var bearerToken: String?

    public init(name: String, url: String, bearerToken: String? = nil) {
        self.name = name
        self.url = url
        self.bearerToken = bearerToken
    }

    /// A snapshot folder.
    public static func directory(_ url: URL, name: String = "snapshot") -> Mirror {
        Mirror(name: name, url: url.path)
    }

    /// An HTTP(S) mirror.
    public static func http(_ baseURL: String, name: String, bearerToken: String? = nil) -> Mirror {
        Mirror(name: name, url: baseURL, bearerToken: bearerToken)
    }
}

/// Log severity.
public enum LogLevel: Int, Sendable, Comparable {
    case debug, info, warn, error
    public static func < (a: LogLevel, b: LogLevel) -> Bool { a.rawValue < b.rawValue }
    var label: String { ["debug", "info", "warn", "error"][rawValue] }
}

/// Delivered after a new revision was swapped in.
public struct Update: Sendable, Equatable {
    /// 0 if nothing was loaded before.
    public let oldRevision: Int
    public let newRevision: Int
    /// Mirror that delivered it.
    public let source: String
    /// Prompts added, removed or with a new body.
    public let changed: [String]
}

/// Per-mirror health.
public struct MirrorStatus: Sendable, Equatable {
    public let name: String
    /// URL with the delivery key redacted.
    public let url: String
    public let consecutiveFailures: Int
    public let lastError: String
    public let lastSuccess: Date?
}

/// Health of a client, for logs and metrics.
public struct Status: Sendable, Equatable {
    /// A manifest is loaded.
    public let ready: Bool
    /// Mirror that served or last confirmed the current state: `embedded`, `snapshot`, `disk-cache`, `cdn`, `origin`, `git`.
    public let source: String
    public let revision: Int
    public let workspace: String
    public let deployedAt: String
    public let promptCount: Int
    /// Last time a polled mirror confirmed the manifest (200 or 304).
    public let lastSuccess: Date?
    /// Failures in the latest refresh round; empty when the first mirror answered.
    public let lastError: String
    /// Seconds since `lastSuccess` (since start-up if never). Alert on this.
    public let staleFor: TimeInterval
    public let mirrors: [MirrorStatus]
}
