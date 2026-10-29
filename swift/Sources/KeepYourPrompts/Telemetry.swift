import Foundation

// Prompt metadata, metadata maps and the observer hook (protocol/tracing.md). No dependency on
// OpenTelemetry: the KeepYourPromptsOTel product builds on these.

/// An attribute value: the SDK's attributes are strings or integers.
public enum TelemetryValue: Sendable, Hashable, Codable, CustomStringConvertible {
    case string(String)
    case int(Int)

    public var description: String {
        switch self {
        case .string(let s): return s
        case .int(let i): return String(i)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let i = try? c.decode(Int.self) { self = .int(i) } else { self = .string(try c.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .int(let i): try c.encode(i)
        }
    }
}

/// Which deployed body a call used. Read from memory with ``KeepYourPrompts/meta(_:)`` or
/// ``KeepYourPrompts/renderWithMeta(_:_:onMissing:)``. Never holds prompt content.
public struct PromptMeta: Sendable, Hashable, Codable {
    public let name: String
    public let version: Int
    /// 64 lowercase hex: the body actually used.
    public let sha256: String
    public let app: String
    public let env: String
    /// `workspace` from the manifest.
    public let workspace: String
    public let revision: Int
    /// Normalised mirror kind: `embedded`, `snapshot`, `cache`, `cdn`, `origin`, `git` or `custom`
    /// (empty before anything is loaded).
    public let source: String

    public init(name: String, version: Int, sha256: String, app: String, env: String, workspace: String,
                revision: Int, source: String) {
        self.name = name
        self.version = version
        self.sha256 = sha256
        self.app = app
        self.env = env
        self.workspace = workspace
        self.revision = revision
        self.source = source
    }

    /// Span attributes: `kyp.*` plus `gen_ai.prompt.name` / `gen_ai.prompt.version` (a string)
    /// unless `genAI` is false. `kyp.workspace` and `kyp.source` are left out when empty.
    public func attributes(genAI: Bool = true) -> [String: TelemetryValue] {
        var a: [String: TelemetryValue] = [
            "kyp.prompt.name": .string(name),
            "kyp.prompt.version": .int(version),
            "kyp.prompt.sha256": .string(sha256),
            "kyp.app": .string(app),
            "kyp.env": .string(env),
            "kyp.revision": .int(revision),
        ]
        if !workspace.isEmpty { a["kyp.workspace"] = .string(workspace) }
        if !source.isEmpty { a["kyp.source"] = .string(source) }
        if genAI {
            a["gen_ai.prompt.name"] = .string(name)
            a["gen_ai.prompt.version"] = .string(String(version))
        }
        return a
    }

    /// Flat `kyp_*` keys (dots replaced by underscores) for any tool's free-form metadata.
    public func traceMetadata() -> [String: TelemetryValue] {
        Dictionary(uniqueKeysWithValues: attributes(genAI: false).map { ($0.key.replacingOccurrences(of: ".", with: "_"), $0.value) })
    }

    /// The same map, for the metadata of a Langfuse observation.
    public func langfuseMetadata() -> [String: TelemetryValue] { traceMetadata() }

    /// The same map, for LangSmith run metadata.
    public func langsmithMetadata() -> [String: TelemetryValue] { traceMetadata() }
}

/// What ``KeepYourPrompts/renderWithMeta(_:_:onMissing:)`` returns.
public struct Rendered: Sendable, Hashable {
    /// The rendered prompt.
    public let text: String
    /// The metadata of the exact body rendered.
    public let meta: PromptMeta
}

/// What started a refresh round (`kyp.refresh.trigger`).
public enum RefreshTrigger: String, Sendable {
    case start, poll, manual
}

/// How a refresh round ended (`kyp.refresh.result`).
public enum RefreshResult: String, Sendable {
    case updated
    case notModified = "not_modified"
    case failed
}

/// A span event of a refresh round: `kyp.fallback`, `kyp.hash_mismatch` or `kyp.update`.
public struct TelemetryEvent: Sendable, Equatable {
    public let name: String
    public let time: Date
    public let attributes: [String: TelemetryValue]
}

/// One refresh round, passed to ``TelemetryObserver/onRefresh(_:)``.
public struct RefreshRecord: Sendable, Equatable {
    public let app: String
    public let env: String
    public let trigger: RefreshTrigger
    public let result: RefreshResult
    /// Wall clock at the start.
    public let startTime: Date
    /// Seconds.
    public let duration: TimeInterval
    /// Configured name of the mirror that answered (empty when failed).
    public let mirror: String
    /// Its normalised kind (empty when failed).
    public let source: String
    /// Revision held after the round (0 when nothing).
    public let revision: Int
    /// Revision held before it.
    public let previousRevision: Int
    public let workspace: String
    /// When failed: a short message, delivery key redacted.
    public let error: String
    /// When failed: the low-cardinality `error.type`.
    public let errorType: String
    public let events: [TelemetryEvent]
}

/// A failed `render` / `renderWithMeta`, passed to ``TelemetryObserver/onRenderError(_:)``.
public struct RenderError: Sendable, Equatable {
    public let app: String
    public let env: String
    public let name: String
    /// `not_found` or `missing_variable`.
    public let errorType: String
}

/// Receives delivery telemetry. Both methods default to doing nothing. Called outside the
/// client's locks.
public protocol TelemetryObserver: Sendable {
    func onRefresh(_ record: RefreshRecord)
    func onRenderError(_ error: RenderError)
}

public extension TelemetryObserver {
    func onRefresh(_ record: RefreshRecord) {}
    func onRenderError(_ error: RenderError) {}
}

/// Identifies an observer added with ``KeepYourPrompts/addObserver(_:)``.
public struct ObserverToken: Sendable, Hashable {
    let id: UUID
}

/// Telemetry helpers shared with the OpenTelemetry add-on.
public enum Telemetry {
    /// A mirror's configured name and kind (`embedded`, `file`, `cache`, `http`) to `kyp.source`.
    public static func normalizeSource(_ name: String, kind: String) -> String {
        if name.isEmpty { return "" }
        if name == "disk-cache" || name == "cache" { return "cache" }
        if ["embedded", "snapshot", "cdn", "origin", "git"].contains(name) { return name }
        switch kind {
        case "embedded": return "embedded"
        case "cache": return "cache"
        case "file": return "snapshot"
        default: return "custom"
        }
    }

    /// A failure message to a low-cardinality `error.type`.
    public static func classifyError(_ message: String) -> String {
        let m = message.lowercased()
        var status = ""
        if let r = m.range(of: "http ") {
            let digits = m[r.upperBound...].prefix { $0.isASCII && $0.isNumber }
            if digits.count == 3 { status = String(digits) }
        }
        if m.contains("blob ") && m.contains(" unavailable") { return "blob_unavailable" }
        if m.contains("sha256 verification") || m.contains("hash mismatch") { return "hash_mismatch" }
        if m.contains("stale manifest") { return "stale" }
        if m.contains("bad manifest") || m.contains("invalid manifest") { return "bad_manifest" }
        if status == "404" || status == "410" || m.contains("not found") || m.contains("no such file") {
            return "not_found"
        }
        if !status.isEmpty { return "http_\(status)" }
        if m.contains("timed out") || m.contains("timeout") || m.contains("deadline") { return "timeout" }
        for w in ["connect", "refused", "reset", "resolve", "unreachable", "network", "socket", "ssl", "tls", "offline"]
        where m.contains(w) {
            return "network"
        }
        return "_OTHER"
    }

    /// `KYP_OTEL_CAPTURE_CONTENT` is `1`, `true`, `yes` or `on`.
    public static var envCaptureContent: Bool {
        let v = ProcessInfo.processInfo.environment["KYP_OTEL_CAPTURE_CONTENT"]?.lowercased() ?? ""
        return ["1", "true", "yes", "on"].contains(v.trimmingCharacters(in: .whitespaces))
    }
}
