#if os(Linux) && compiler(<6.0)
@preconcurrency import Foundation  // corelibs Foundation before 6.0 does not mark URL/URLSession Sendable
#else
import Foundation
#endif

/// Client options. Only `app` (and `env`, default `"prod"`) are required.
public struct Options: Sendable {
    /// App slug (`KYP_APP`).
    public var app: String
    /// Environment slug, default `prod` (`KYP_ENV`).
    public var env: String
    /// `kypd_...`: enables the CDN and origin mirrors (`KYP_DELIVERY_KEY`). Keep it server-side or
    /// in your app's configuration; it only grants read access to deployed prompts.
    public var deliveryKey: String?
    /// Lets the disk cache be found without scanning `cacheDirectory` (`KYP_WORKSPACE`).
    public var workspace: String?
    /// A snapshot folder on disk (`KYP_SNAPSHOT_DIR`).
    public var snapshotDirectory: URL?
    /// Disk cache written by the SDK (`KYP_CACHE_DIR`). See ``Options/defaultCacheDirectory``.
    public var cacheDirectory: URL?
    /// Resource folder of the bundle that ships a snapshot (default `Bundle.main.resourceURL`).
    /// Set with ``Options/useBundle(_:subdirectory:)``; `nil` disables the bundled snapshot.
    public var bundleResourceURL: URL?
    /// Folder inside the bundle holding the snapshot layout (default `KeepYourPrompts`).
    public var bundleSubdirectory: String
    /// Your git repo's `.kyp` folder, e.g. `https://raw.githubusercontent.com/acme/prompts/main/.kyp` (`KYP_GIT_MIRROR`).
    public var gitMirror: String?
    /// Read-only token sent to the git mirror as `Authorization: Bearer` (`KYP_GIT_TOKEN`).
    public var gitToken: String?
    /// CDN base (`KYP_CDN_URL`).
    public var cdnBase: String
    /// Origin base (`KYP_ORIGIN_URL`).
    public var originBase: String
    /// Replaces the snapshot/CDN/origin/git mirrors with an explicit ordered list.
    public var mirrors: [Mirror]?
    /// Appended after the defaults.
    public var extraMirrors: [Mirror]
    /// Seconds between revalidations (default 30, ±10% jitter, minimum 0.1) (`KYP_POLL_INTERVAL`).
    public var pollInterval: TimeInterval
    public var connectTimeout: TimeInterval
    public var requestTimeout: TimeInterval
    /// How long start-up waits on the network when nothing local exists (default 3 s).
    public var startupTimeout: TimeInterval
    /// Cap for the per-mirror backoff (default 300 s).
    public var maxBackoff: TimeInterval
    /// Start with no prompts instead of throwing ``KYPError/unavailable(_:)``.
    public var startEmpty: Bool
    public var userAgent: String
    /// Called after a new revision was swapped in (also delivered on ``KeepYourPrompts/updates``).
    public var onUpdate: (@Sendable (Update) -> Void)?
    /// Log sink; default: standard error, `[kyp] warn: ...`.
    public var logger: (@Sendable (LogLevel, String) -> Void)?
    /// Minimum level logged; `nil` turns logging off (`KYP_LOG`).
    public var logLevel: LogLevel?
    /// Delivery telemetry hooks (protocol/tracing.md), registered before start-up so the start-up
    /// round is reported too. `KeepYourPromptsOTel` provides one.
    public var observers: [any TelemetryObserver] = []

    public init(app: String, env: String = "prod", deliveryKey: String? = nil) {
        self.app = app
        self.env = env
        self.deliveryKey = deliveryKey
        bundleResourceURL = Bundle.main.resourceURL
        bundleSubdirectory = "KeepYourPrompts"
        cdnBase = "https://cdn.keepyourprompts.com/v1/d"
        originBase = "https://api.keepyourprompts.com/v1/delivery"
        extraMirrors = []
        pollInterval = 30
        connectTimeout = 2
        requestTimeout = 5
        startupTimeout = 3
        maxBackoff = 300
        startEmpty = false
        userAgent = "kyp-swift/\(keepYourPromptsVersion)"
        logLevel = .warn
    }

    /// Ship the snapshot in `bundle` (e.g. `Bundle.main` for an app, `Bundle.module` for a package).
    public mutating func useBundle(_ bundle: Bundle?, subdirectory: String = "KeepYourPrompts") {
        bundleResourceURL = bundle?.resourceURL
        bundleSubdirectory = subdirectory
    }

    /// `<Caches>/KeepYourPrompts`: a good `cacheDirectory` for apps (the system may purge it;
    /// the bundled snapshot still covers that case).
    public static var defaultCacheDirectory: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("KeepYourPrompts", isDirectory: true)
    }

    /// `KYP_APP`, `KYP_ENV`, `KYP_DELIVERY_KEY`, `KYP_WORKSPACE`, `KYP_SNAPSHOT_DIR`, `KYP_CACHE_DIR`,
    /// `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN`, `KYP_CDN_URL`, `KYP_ORIGIN_URL`, `KYP_POLL_INTERVAL` (seconds)
    /// and `KYP_LOG` (`debug|info|warn|error|off`).
    public static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Options {
        func v(_ k: String) -> String? {
            guard let s = environment[k], !s.isEmpty else { return nil }
            return s
        }
        var o = Options(app: v("KYP_APP") ?? "", env: v("KYP_ENV") ?? "prod", deliveryKey: v("KYP_DELIVERY_KEY"))
        o.workspace = v("KYP_WORKSPACE")
        if let d = v("KYP_SNAPSHOT_DIR") { o.snapshotDirectory = URL(fileURLWithPath: d, isDirectory: true) }
        if let d = v("KYP_CACHE_DIR") { o.cacheDirectory = URL(fileURLWithPath: d, isDirectory: true) }
        o.gitMirror = v("KYP_GIT_MIRROR")
        o.gitToken = v("KYP_GIT_TOKEN")
        if let s = v("KYP_CDN_URL") { o.cdnBase = s }
        if let s = v("KYP_ORIGIN_URL") { o.originBase = s }
        if let s = v("KYP_POLL_INTERVAL"), let secs = Double(s), secs > 0 { o.pollInterval = secs }
        switch v("KYP_LOG") {
        case "off": o.logLevel = nil
        case "debug": o.logLevel = .debug
        case "info": o.logLevel = .info
        case "error": o.logLevel = .error
        default: break
        }
        return o
    }
}

/// Keep Your Prompts client: reads deployed prompts from memory and keeps them fresh.
///
/// ```swift
/// let prompts = try await KeepYourPrompts(app: "support-bot", env: "prod", deliveryKey: key)
/// let text = try prompts.render("triage", ["company": "Acme"])
/// ```
///
/// Reads (`get`, `render`, `prompt`) never do I/O and are safe from any thread or task; a
/// background task revalidates the manifest every `pollInterval` and stops when the client is
/// deallocated or ``close()`` is called.
public final class KeepYourPrompts: Sendable {
    let engine: Engine
    private let poller = Locked<Task<Void, Never>?>(nil)

    /// Loads prompts, then refreshes in the background.
    ///
    /// Local mirrors (bundled snapshot, snapshot folder, disk cache) are read first; if any holds the
    /// manifest this returns at once. Otherwise it waits on the network for up to `startupTimeout`.
    public init(_ options: Options) async throws {
        let engine = try Engine(options)
        self.engine = engine
        await engine.loadLocal()
        engine.deliverRecords()
        let loadedLocally = engine.current != nil
        if !loadedLocally {
            if engine.polled.isEmpty {
                guard options.startEmpty else {
                    throw KYPError.unavailable(
                        "no prompts for \(engine.what): no snapshot or disk cache found and no remote mirror configured "
                            + "(set KYP_DELIVERY_KEY, KYP_SNAPSHOT_DIR or bundle a snapshot)")
                }
                engine.log(.warn, "starting empty: no mirror for \(engine.what)")
            } else {
                try await Self.startupFromNetwork(engine)
            }
        }
        if !engine.polled.isEmpty {
            let immediate = loadedLocally || engine.current == nil
            let task = Task.detached(priority: .utility) { [engine] in
                await Self.run(engine, immediate: immediate)
            }
            poller.withLock { $0 = task }
        }
    }

    /// `try await KeepYourPrompts(app: "support-bot", deliveryKey: key)`.
    public convenience init(
        app: String,
        env: String = "prod",
        deliveryKey: String? = nil,
        cacheDirectory: URL? = nil,
        bundle: Bundle? = .main,
        onUpdate: (@Sendable (Update) -> Void)? = nil
    ) async throws {
        var o = Options(app: app, env: env, deliveryKey: deliveryKey)
        o.cacheDirectory = cacheDirectory
        o.useBundle(bundle)
        o.onUpdate = onUpdate
        try await self.init(o)
    }

    /// `KeepYourPrompts(Options.fromEnvironment())`, with optional adjustments.
    public static func fromEnvironment(_ configure: (inout Options) -> Void = { _ in }) async throws -> KeepYourPrompts {
        var o = Options.fromEnvironment()
        configure(&o)
        return try await KeepYourPrompts(o)
    }

    deinit {
        engine.stopped.withLock { $0 = true }
        poller.current?.cancel()
        engine.finishSubscribers()
    }

    // MARK: reads (memory only)

    /// Raw template of `name`, or `nil` if it is not deployed.
    @inline(__always)
    public func get(_ name: String) -> String? {
        engine.current?.prompts[name]?.text
    }

    /// Whether `name` is in the current revision.
    public func contains(_ name: String) -> Bool {
        engine.current?.prompts[name] != nil
    }

    /// Name, version, sha256, variables and text of `name`.
    public func prompt(_ name: String) -> Prompt? {
        engine.current?.prompts[name]
    }

    /// Renders `name`. Throws ``KYPError/notFound(_:)`` or ``KYPError/missingVariables(_:)``.
    public func render(_ name: String, _ vars: [String: String] = [:], onMissing: OnMissing = .error) throws -> String {
        do {
            guard let p = engine.current?.prompts[name] else { throw KYPError.notFound(name) }
            return try renderTemplate(p.text, vars, onMissing: onMissing)
        } catch {
            engine.renderFailed(name, error)
            throw error
        }
    }

    /// Which deployed body `name` is: name, version, sha256, app, env, workspace, revision and the
    /// mirror kind that served it (protocol/tracing.md). Memory only. Throws ``KYPError/notFound(_:)``.
    public func meta(_ name: String) throws -> PromptMeta {
        guard let s = engine.current, let p = s.prompts[name] else { throw KYPError.notFound(name) }
        return engine.meta(p, s)
    }

    /// ``render(_:_:onMissing:)`` plus the metadata of the exact body rendered.
    public func renderWithMeta(_ name: String, _ vars: [String: String] = [:], onMissing: OnMissing = .error) throws -> Rendered {
        do {
            guard let s = engine.current, let p = s.prompts[name] else { throw KYPError.notFound(name) }
            return Rendered(text: try renderTemplate(p.text, vars, onMissing: onMissing), meta: engine.meta(p, s))
        } catch {
            engine.renderFailed(name, error)
            throw error
        }
    }

    /// Subscribes to delivery telemetry (refresh rounds, render errors).
    @discardableResult
    public func addObserver(_ observer: any TelemetryObserver) -> ObserverToken { engine.addObserver(observer) }

    /// Unsubscribes. Returns whether the observer was subscribed.
    @discardableResult
    public func removeObserver(_ token: ObserverToken) -> Bool { engine.removeObserver(token) }

    /// App slug the client is configured with.
    public var app: String { engine.options.app }

    /// Environment slug the client is configured with.
    public var env: String { engine.options.env }

    /// Prompt names in the current revision, sorted.
    public var names: [String] { engine.current?.names ?? [] }

    /// Current revision, 0 when nothing is loaded.
    public var revision: Int { engine.current?.manifest.revision ?? 0 }

    /// Health, for logs and metrics.
    public func status() -> Status { engine.status() }

    /// Every swap to a new revision from now on. Each access returns a new stream; it finishes when the
    /// client is deallocated or closed.
    public var updates: AsyncStream<Update> { engine.subscribe() }

    // MARK: refresh

    /// Revalidates now across mirrors (ignoring backoff). Returns `true` if a mirror answered.
    @discardableResult
    public func refresh() async -> Bool {
        if engine.polled.isEmpty || engine.stopped.current { return false }
        let engine = self.engine
        let ok = await engine.gate.run { await engine.round(ignoreBackoff: true, deadline: nil, trigger: .manual) }
        engine.deliverUpdates()
        return ok
    }

    /// Stops the background refresher. Reads keep working. Called on deinit.
    public func close() {
        engine.stopped.withLock { $0 = true }
        poller.withLock { t in
            t?.cancel()
            t = nil
        }
        engine.finishSubscribers()
    }

    // MARK: internals

    private static func startupFromNetwork(_ engine: Engine) async throws {
        let deadline = Date().addingTimeInterval(engine.options.startupTimeout)
        var delay: TimeInterval = 0.1
        while engine.current == nil {
            _ = await engine.gate.run { await engine.round(ignoreBackoff: true, deadline: deadline, trigger: .start) }
            if engine.current != nil || Date().addingTimeInterval(delay) >= deadline { break }
            try? await Task.sleep(nanoseconds: UInt64(delay * 1e9))
            delay = min(delay * 2, 1)
        }
        engine.clearPending()  // the first load is not an "update"
        engine.deliverRecords()
        if engine.current != nil { return }
        let err = engine.lastError
        guard engine.options.startEmpty else {
            throw KYPError.unavailable(
                "could not load \(engine.what) within \(Int(engine.options.startupTimeout * 1000)) ms: \(err)")
        }
        engine.log(.warn, "starting empty, will keep trying: \(err)")
    }

    private static func run(_ engine: Engine, immediate: Bool) async {
        var first = immediate
        while !Task.isCancelled && !engine.stopped.current {
            if !first {
                let wait = engine.options.pollInterval * Double.random(in: 0.9...1.1)
                try? await Task.sleep(nanoseconds: UInt64(wait * 1e9))
                if Task.isCancelled || engine.stopped.current { return }
            }
            first = false
            _ = await engine.gate.run { await engine.round(ignoreBackoff: false, deadline: nil, trigger: .poll) }
            engine.deliverUpdates()
        }
    }
}

// MARK: - Snapshots

/// What ``pullSnapshot(_:to:)`` wrote.
public struct SnapshotInfo: Sendable, Equatable {
    public let workspace: String
    public let revision: Int
    public let promptCount: Int
    public let blobsWritten: Int
    public let source: String
}

/// Pulls the deployed manifest and its blobs from the network mirrors in `options` and writes the
/// layout to `directory`: a complete offline mirror to bundle with your app.
@discardableResult
public func pullSnapshot(_ options: Options, to directory: URL) async throws -> SnapshotInfo {
    let engine = try Engine(options, forSnapshot: true)
    let (st, source) = try await engine.pull()
    var written = 0
    for p in st.prompts.values {
        let blob = directory.appendingPathComponent("blobs").appendingPathComponent(p.sha256)
        if let existing = try? Data(contentsOf: blob), existing == Data(p.text.utf8) { continue }
        try atomicWrite(Data(p.text.utf8), to: blob)
        written += 1
    }
    try atomicWrite(st.raw, to: directory.appendingPathComponent(engine.manifestPath))
    return SnapshotInfo(workspace: st.manifest.workspace, revision: st.manifest.revision,
                        promptCount: st.prompts.count, blobsWritten: written, source: source)
}
