#if os(Linux) && compiler(<6.0)
@preconcurrency import Foundation  // corelibs Foundation before 6.0 does not mark URL/URLSession Sendable
#else
import Foundation
#endif

/// Immutable once published.
final class State: Sendable {
    let manifest: Manifest
    let raw: Data
    let prompts: [String: Prompt]
    let names: [String]

    init(manifest: Manifest, raw: Data, prompts: [String: Prompt]) {
        self.manifest = manifest
        self.raw = raw
        self.prompts = prompts
        self.names = prompts.keys.sorted()
    }

    func text(sha: String) -> String? {
        prompts.values.first { $0.sha256 == sha }?.text
    }
}

enum MirrorKind: Sendable { case embedded, file, cache, http }

struct MirrorRuntime: Sendable {
    var etag = ""
    var failures = 0
    var retryAt: Date?
    var lastError = ""
    var lastOK: Date?
}

final class MirrorEntry: Sendable {
    let config: Mirror
    let kind: MirrorKind
    let shownURL: String
    let rt = Locked(MirrorRuntime())

    init(config: Mirror, kind: MirrorKind, shownURL: String) {
        self.config = config
        self.kind = kind
        self.shownURL = shownURL
    }
}

struct StatusInner: Sendable {
    let started = Date()
    var lastSuccess: Date?
    var lastError = ""
    var source = ""
}

enum Outcome: Sendable {
    case updated(State, etag: String)
    case unchanged(etag: String)
    case stale(String)
    case failed(String, missing: Bool)
}

func redact(_ s: String, key: String?) -> String {
    guard let key, key.count >= 10 else { return s }
    return s.replacingOccurrences(of: key, with: String(key.prefix(9)) + "...")
}

/// Mirrors, refresh rounds, the disk cache and the swapped state.
final class Engine: Sendable {
    let options: Options
    let mirrors: [MirrorEntry]
    let polled: [Int]
    let cacheIndex: Int?
    let http: HTTPClient?
    let gate = AsyncMutex()
    let stopped = Locked(false)

    private let cacheRoot = Locked<URL?>(nil)
    private let state = Locked<State?>(nil)
    private let statusInfo = Locked(StatusInner())
    private let pending = Locked<[Update]>([])
    private let subscribers = Locked<[UUID: AsyncStream<Update>.Continuation]>([:])

    var manifestPath: String { "envs/\(options.app)/\(options.env).json" }
    var what: String { "\(options.app)/\(options.env)" }

    init(_ o: Options, forSnapshot: Bool = false) throws {
        var o = o
        guard !o.app.isEmpty else { throw KYPError.invalidConfiguration("app is not set (Options.app or KYP_APP)") }
        guard isSlug(o.app) else {
            throw KYPError.invalidConfiguration("app \"\(o.app)\" is not a slug ([a-z0-9][a-z0-9-]{0,62})")
        }
        guard isSlug(o.env) else {
            throw KYPError.invalidConfiguration("env \"\(o.env)\" is not a slug ([a-z0-9][a-z0-9-]{0,62})")
        }
        if let k = o.deliveryKey,
           !k.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x5F || $0 == 0x2D }) {
            throw KYPError.invalidConfiguration("the delivery key contains an invalid character")
        }
        if o.deliveryKey?.isEmpty == true { o.deliveryKey = nil }
        o.pollInterval = max(o.pollInterval, 0.1)
        if forSnapshot {
            o.bundleResourceURL = nil
            o.cacheDirectory = nil
        }

        var rest: [Mirror]
        if let m = o.mirrors {
            rest = m
        } else {
            rest = []
            if let d = o.snapshotDirectory { rest.append(.directory(d, name: "snapshot")) }
            if let k = o.deliveryKey {
                rest.append(.http(joinURL(o.cdnBase, k), name: "cdn"))
                rest.append(.http(joinURL(o.originBase, k), name: "origin"))
            }
            if let g = o.gitMirror, !g.isEmpty { rest.append(.http(g, name: "git", bearerToken: o.gitToken)) }
        }
        rest += o.extraMirrors

        var list: [MirrorEntry] = []
        func add(_ m: Mirror, _ k: MirrorKind) {
            list.append(MirrorEntry(config: m, kind: k, shownURL: redact(m.url, key: o.deliveryKey)))
        }
        // The snapshot bundled with the app (folder reference in Bundle.main or a package's Bundle.module).
        if let res = o.bundleResourceURL {
            let dir = res.appendingPathComponent(o.bundleSubdirectory, isDirectory: true)
            let manifest = dir.appendingPathComponent("envs/\(o.app)/\(o.env).json")
            if FileManager.default.fileExists(atPath: manifest.path) { add(.directory(dir, name: "embedded"), .embedded) }
        }
        var cacheIndex: Int?
        for m in rest {
            let isHTTP = m.url.hasPrefix("http://") || m.url.hasPrefix("https://")
            if cacheIndex == nil, isHTTP, let d = o.cacheDirectory {
                cacheIndex = list.count
                add(.directory(d, name: "disk-cache"), .cache)
            }
            add(m, isHTTP ? .http : .file)
        }
        if cacheIndex == nil, let d = o.cacheDirectory {
            cacheIndex = list.count
            add(.directory(d, name: "disk-cache"), .cache)
        }
        var polled = list.indices.filter { list[$0].kind == .http }
        if polled.isEmpty {
            // No network mirrors: poll the file mirrors (a folder kept fresh by a sidecar or git pull).
            polled = list.indices.filter { list[$0].kind == .file }
            http = nil
        } else {
            http = HTTPClient(connectTimeout: o.connectTimeout, requestTimeout: o.requestTimeout, userAgent: o.userAgent)
        }
        self.mirrors = list
        self.polled = polled
        self.cacheIndex = cacheIndex
        self.options = o
        if let k = o.deliveryKey, !k.hasPrefix("kypd_") {
            log(.warn, "delivery key does not start with kypd_; check KYP_DELIVERY_KEY")
        }
    }

    func log(_ level: LogLevel, _ msg: @autoclosure () -> String) {
        guard let threshold = options.logLevel, level >= threshold else { return }
        let m = redact(msg(), key: options.deliveryKey)
        if let l = options.logger {
            l(level, m)
        } else {
            FileHandle.standardError.write(Data("[kyp] \(level.label): \(m)\n".utf8))
        }
    }

    // MARK: read path

    @inline(__always) var current: State? { state.current }

    func status() -> Status {
        let s = state.current
        let st = statusInfo.current
        return Status(
            ready: s != nil,
            source: st.source,
            revision: s?.manifest.revision ?? 0,
            workspace: s?.manifest.workspace ?? "",
            deployedAt: s?.manifest.deployedAt ?? "",
            promptCount: s?.prompts.count ?? 0,
            lastSuccess: st.lastSuccess,
            lastError: st.lastError,
            staleFor: max(0, Date().timeIntervalSince(st.lastSuccess ?? st.started)),
            mirrors: mirrors.map { m in
                let rt = m.rt.current
                return MirrorStatus(name: m.config.name, url: m.shownURL, consecutiveFailures: rt.failures,
                                    lastError: rt.lastError, lastSuccess: rt.lastOK)
            }
        )
    }

    var lastError: String { statusInfo.current.lastError }

    // MARK: updates

    func subscribe() -> AsyncStream<Update> {
        AsyncStream { continuation in
            let id = UUID()
            subscribers.withLock { $0[id] = continuation }
            continuation.onTermination = { [weak self] _ in
                _ = self?.subscribers.withLock { $0.removeValue(forKey: id) }
            }
        }
    }

    func finishSubscribers() {
        let subs = subscribers.withLock { s -> [AsyncStream<Update>.Continuation] in
            defer { s.removeAll() }
            return Array(s.values)
        }
        subs.forEach { $0.finish() }
    }

    func deliverUpdates() {
        let todo = pending.withLock { p -> [Update] in
            defer { p.removeAll() }
            return p
        }
        guard !todo.isEmpty else { return }
        let subs = subscribers.withLock { Array($0.values) }
        for u in todo {
            options.onUpdate?(u)
            subs.forEach { $0.yield(u) }
        }
    }

    func clearPending() { pending.withLock { $0.removeAll() } }

    // MARK: mirror access

    private func fetchLocal(_ mi: Int, _ rel: String) -> Fetched {
        let m = mirrors[mi]
        switch m.kind {
        case .embedded, .file: return readFile(fileURL(m.config.url).appendingPathComponent(rel))
        case .cache:
            guard let root = cacheRoot.current else { return .notFound("empty") }
            return readFile(root.appendingPathComponent(rel))
        case .http: return .failed("not a local mirror")
        }
    }

    private func fetch(_ mi: Int, _ rel: String, etag: String, deadline: Date?) async -> Fetched {
        let m = mirrors[mi]
        var r: Fetched
        if m.kind != .http {
            r = fetchLocal(mi, rel)
        } else if let http {
            var timeout = options.requestTimeout
            if let d = deadline {
                let left = d.timeIntervalSinceNow
                if left <= 0 { return .failed("start-up timeout") }
                timeout = min(timeout, left)
            }
            r = await http.get(joinURL(m.config.url, rel), etag: etag, bearer: m.config.bearerToken, timeout: timeout)
        } else {
            r = .failed("no HTTP client")
        }
        switch r {
        case .failed(let e): r = .failed(redact(e, key: options.deliveryKey))
        case .notFound(let e): r = .notFound(redact(e, key: options.deliveryKey))
        default: break
        }
        return r
    }

    private func inBackoff(_ mi: Int) -> Bool {
        guard let t = mirrors[mi].rt.current.retryAt else { return false }
        return t > Date()
    }

    private func recordOK(_ mi: Int, etag: String) {
        let recovered = mirrors[mi].rt.withLock { rt -> Bool in
            let r = rt.failures > 0
            rt.failures = 0
            rt.retryAt = nil
            rt.lastError = ""
            rt.lastOK = Date()
            rt.etag = etag
            return r
        }
        if recovered { log(.info, "\(mirrors[mi].config.name) is answering again") }
    }

    private func recordFail(_ mi: Int, _ err: String, count: Bool) {
        let poll = options.pollInterval, cap = options.maxBackoff
        let failures = mirrors[mi].rt.withLock { rt -> Int in
            rt.lastError = err
            guard count else { return 0 }
            rt.failures += 1
            // Skip the mirror for 0, 1, 3, 7, ... poll intervals, capped at maxBackoff.
            let mult = Double((1 << min(rt.failures - 1, 20)) - 1)
            rt.retryAt = Date().addingTimeInterval(min(poll * mult, cap) * Double.random(in: 0.9...1.1))
            return rt.failures
        }
        log(failures == 1 ? .warn : .debug, "\(mirrors[mi].config.name): \(err)")
    }

    // MARK: loading

    private func resolveBlob(_ mi: Int, _ sha: String, deadline: Date?, localOnly: Bool) async -> Result<String, KYPError> {
        var order: [Int] = []
        if let c = cacheIndex { order.append(c) }
        order.append(mi)
        order += mirrors.indices
        var seen = Set<Int>()
        var errors: [String] = []
        let short = String(sha.prefix(12))
        for i in order where seen.insert(i).inserted {
            if stopped.current { break }
            let isHTTP = mirrors[i].kind == .http
            if isHTTP && (localOnly || (i != mi && inBackoff(i))) { continue }
            let body: Data
            switch await fetch(i, "blobs/\(sha)", etag: "", deadline: deadline) {
            case .ok(let d, _): body = d
            case .failed(let e), .notFound(let e):
                if i == mi { errors.append("\(mirrors[i].config.name): \(e)") }
                continue
            case .notModified: continue
            }
            guard sha256Hex(body) == sha else {
                let msg = "blob \(short) failed sha256 verification"
                log(.warn, "\(mirrors[i].config.name): \(msg) (discarded)")
                errors.append("\(mirrors[i].config.name): \(msg)")
                continue
            }
            guard let text = String(data: body, encoding: .utf8) else {
                errors.append("\(mirrors[i].config.name): blob \(short) is not UTF-8")
                continue
            }
            return .success(text)
        }
        return .failure(.protocolError(errors.isEmpty ? "blob \(short) unavailable"
                                                      : "blob \(short) unavailable (\(errors.joined(separator: "; ")))"))
    }

    private func build(_ mi: Int, _ man: Manifest, _ raw: Data, cur: State?, deadline: Date?, localOnly: Bool) async -> Result<State, KYPError> {
        var fetched: [String: String] = [:]
        var prompts: [String: Prompt] = [:]
        for name in man.names {
            let mp = man.prompts[name]!
            let text: String
            if let t = cur?.text(sha: mp.sha256) ?? fetched[mp.sha256] {
                text = t
            } else {
                switch await resolveBlob(mi, mp.sha256, deadline: deadline, localOnly: localOnly) {
                case .success(let t):
                    fetched[mp.sha256] = t
                    text = t
                case .failure(let e): return .failure(e)
                }
            }
            let vars = mp.variables.isEmpty ? templateVariables(in: text) : mp.variables
            prompts[name] = Prompt(name: name, version: mp.version, sha256: mp.sha256, variables: vars, text: text)
        }
        return .success(State(manifest: man, raw: raw, prompts: prompts))
    }

    private func tryMirror(_ mi: Int, cur: State?, useETag: Bool, deadline: Date?, localOnly: Bool) async -> Outcome {
        let etag = (useETag && cur != nil) ? mirrors[mi].rt.current.etag : ""
        let body: Data, newETag: String
        switch await fetch(mi, manifestPath, etag: etag, deadline: deadline) {
        case .notModified(let e): return .unchanged(etag: e)
        case .ok(let d, let e): (body, newETag) = (d, e)
        case .notFound(let e): return .failed("manifest not found (\(e))", missing: true)
        case .failed(let e): return .failed(e, missing: false)
        }
        let man: Manifest
        do {
            man = try Manifest.parse(body, app: options.app, env: options.env)
        } catch let e as KYPError {
            if case .protocolError(let m) = e { return .failed("bad manifest: \(m)", missing: false) }
            return .failed("bad manifest: \(e)", missing: false)
        } catch {
            return .failed("bad manifest: \(error)", missing: false)
        }
        if let c = cur {
            if man.revision < c.manifest.revision {
                return .stale("stale manifest ignored (revision \(man.revision) < held \(c.manifest.revision))")
            }
            if man.revision == c.manifest.revision { return .unchanged(etag: newETag) }
        }
        switch await build(mi, man, body, cur: cur, deadline: deadline, localOnly: localOnly) {
        case .success(let st): return .updated(st, etag: newETag)
        case .failure(let e):
            if case .protocolError(let m) = e { return .failed(m, missing: false) }
            return .failed("\(e)", missing: false)
        }
    }

    /// Publishes `st` unless an equal or newer revision is already held.
    @discardableResult
    private func install(_ st: State, _ mi: Int, notify: Bool) -> Bool {
        let name = mirrors[mi].config.name
        let old: State?? = state.withLock { s -> State?? in
            if let cur = s, cur.manifest.revision >= st.manifest.revision { return .none }
            let old = s
            s = st
            return .some(old)
        }
        guard case .some(let previous) = old else { return false }
        statusInfo.withLock { $0.source = name }
        log(.info, "loaded \(what) revision \(st.manifest.revision) (\(st.prompts.count) prompts) from \(name)")
        if notify {
            var changed = st.names.filter { n in previous?.prompts[n]?.sha256 != st.prompts[n]?.sha256 }
            if let p = previous { changed += p.names.filter { st.prompts[$0] == nil } }
            let u = Update(oldRevision: previous?.manifest.revision ?? 0, newRevision: st.manifest.revision,
                           source: name, changed: changed)
            pending.withLock { $0.append(u) }
        }
        return true
    }

    /// Start-up step 1: local mirrors only; the highest revision wins, ties go to the earlier mirror.
    func loadLocal() async {
        locateCache()
        var best: (State, Int)?
        for mi in mirrors.indices where mirrors[mi].kind != .http {
            switch await tryMirror(mi, cur: best?.0, useETag: false, deadline: nil, localOnly: true) {
            case .updated(let st, _): best = (st, mi)
            case .failed(let err, let missing) where !missing: recordFail(mi, err, count: false)
            default: break
            }
        }
        if let (st, mi) = best {
            install(st, mi, notify: false)
            if mi != cacheIndex { writeCache(st) }
        }
    }

    /// One refresh round over the polled mirrors, in order. Returns true if a mirror answered.
    func round(ignoreBackoff: Bool, deadline: Date?) async -> Bool {
        let cur = state.current
        var errs: [String] = []
        var skipped: [Int] = []
        var answered = false
        for mi in polled {
            if stopped.current { break }
            if !ignoreBackoff && inBackoff(mi) {
                skipped.append(mi)
                continue
            }
            if await attempt(mi, cur: cur, deadline: deadline, errs: &errs) {
                answered = true
                break
            }
        }
        // Everything tried failed: give the mirrors in backoff a chance too.
        if !answered {
            for mi in skipped {
                if stopped.current { break }
                if await attempt(mi, cur: cur, deadline: deadline, errs: &errs) {
                    answered = true
                    break
                }
            }
        }
        let joined = errs.joined(separator: "; ")
        statusInfo.withLock { s in
            if answered { s.lastSuccess = Date() }
            s.lastError = (!answered && joined.isEmpty) ? "all mirrors backing off" : joined
        }
        if !answered && !stopped.current { log(.warn, "refresh failed, serving what is held: \(joined)") }
        return answered
    }

    private func attempt(_ mi: Int, cur: State?, deadline: Date?, errs: inout [String]) async -> Bool {
        let name = mirrors[mi].config.name
        switch await tryMirror(mi, cur: cur, useETag: true, deadline: deadline, localOnly: false) {
        case .updated(let st, let etag):
            recordOK(mi, etag: etag)
            if install(st, mi, notify: true) { writeCache(st) }
            return true
        case .unchanged(let etag):
            recordOK(mi, etag: etag)
            if cur != nil { statusInfo.withLock { $0.source = name } }
            return true
        case .stale(let err):
            errs.append("\(name): \(err)")
            recordFail(mi, err, count: false)
            return false
        case .failed(let err, _):
            errs.append("\(name): \(err)")
            recordFail(mi, err, count: true)
            return false
        }
    }

    // MARK: disk cache

    private func cacheRoot(for workspace: String) -> URL? {
        options.cacheDirectory?.appendingPathComponent(workspace).appendingPathComponent(options.app)
            .appendingPathComponent(options.env)
    }

    /// Finds `<cacheDirectory>/<workspace>/<app>/<env>` holding the highest revision.
    private func locateCache() {
        guard cacheIndex != nil, cacheRoot.current == nil, let dir = options.cacheDirectory else { return }
        if let w = options.workspace, !w.isEmpty {
            cacheRoot.withLock { $0 = cacheRoot(for: w) }
            return
        }
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        var best: (Int, URL)?
        for e in entries {
            let root = dir.appendingPathComponent(e).appendingPathComponent(options.app).appendingPathComponent(options.env)
            guard case .ok(let body, _) = readFile(root.appendingPathComponent(manifestPath)),
                  let m = try? Manifest.parse(body, app: options.app, env: options.env) else { continue }
            if best == nil || m.revision > best!.0 { best = (m.revision, root) }
        }
        let found = best?.1
        cacheRoot.withLock { $0 = found }
    }

    private func writeCache(_ st: State) {
        guard cacheIndex != nil, let root = cacheRoot(for: st.manifest.workspace) else { return }
        do {
            for p in st.prompts.values {
                let blob = root.appendingPathComponent("blobs").appendingPathComponent(p.sha256)
                if !FileManager.default.fileExists(atPath: blob.path) { try atomicWrite(Data(p.text.utf8), to: blob) }
            }
            let mpath = root.appendingPathComponent(manifestPath)
            if case .ok(let body, _) = readFile(mpath) {
                if body == st.raw {
                    cacheRoot.withLock { $0 = root }
                    return
                }
                if let m = try? Manifest.parse(body, app: options.app, env: options.env), m.revision > st.manifest.revision {
                    return
                }
            }
            try atomicWrite(st.raw, to: mpath)
            cacheRoot.withLock { $0 = root }
        } catch {
            log(.warn, "disk cache write failed: \(error.localizedDescription)")
        }
    }

    /// For `pullSnapshot`: the first polled mirror that delivers a complete state.
    func pull() async throws -> (State, String) {
        var errors: [String] = []
        for mi in polled {
            switch await tryMirror(mi, cur: nil, useETag: false, deadline: nil, localOnly: false) {
            case .updated(let st, _): return (st, mirrors[mi].config.name)
            case .failed(let e, _), .stale(let e): errors.append("\(mirrors[mi].config.name): \(e)")
            case .unchanged: break
            }
        }
        if polled.isEmpty { errors.append("no remote mirror configured (set a delivery key or a mirror)") }
        throw KYPError.unavailable("could not pull \(what): \(errors.joined(separator: "; "))")
    }
}
