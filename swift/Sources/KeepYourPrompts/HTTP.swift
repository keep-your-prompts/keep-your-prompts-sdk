#if os(Linux) && compiler(<6.0)
@preconcurrency import Foundation  // corelibs Foundation before 6.0 does not mark URL/URLSession Sendable
#else
import Foundation
#endif
#if canImport(FoundationNetworking) && compiler(<6.0)
@preconcurrency import FoundationNetworking
#elseif canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum Fetched: Sendable {
    case ok(Data, etag: String)
    case notModified(etag: String)
    case notFound(String)
    case failed(String)
}

/// URLSession without its own cache, so `If-None-Match`/`304` are ours.
final class HTTPClient: Sendable {
    private let session: URLSession
    private let userAgent: String

    init(connectTimeout: TimeInterval, requestTimeout: TimeInterval, userAgent: String) {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = max(connectTimeout, requestTimeout)
        config.timeoutIntervalForResource = requestTimeout
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        session = URLSession(configuration: config)
        self.userAgent = userAgent
    }

    deinit { session.invalidateAndCancel() }

    func get(_ urlString: String, etag: String, bearer: String?, timeout: TimeInterval) async -> Fetched {
        guard let url = URL(string: urlString) else { return .failed("invalid URL") }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        if !etag.isEmpty { req.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        if let b = bearer, !b.isEmpty { req.setValue("Bearer \(b)", forHTTPHeaderField: "Authorization") }
        let session = self.session
        return await withCheckedContinuation { (c: CheckedContinuation<Fetched, Never>) in
            let task = session.dataTask(with: req) { data, response, error in
                if let error {
                    c.resume(returning: .failed(error.localizedDescription))
                    return
                }
                guard let http = response as? HTTPURLResponse else {
                    c.resume(returning: .failed("not an HTTP response"))
                    return
                }
                var etag = ""
                for (k, v) in http.allHeaderFields {
                    if let k = k as? String, k.lowercased() == "etag", let v = v as? String { etag = v }
                }
                switch http.statusCode {
                case 200: c.resume(returning: .ok(data ?? Data(), etag: etag))
                case 304: c.resume(returning: .notModified(etag: etag))
                case 404, 410: c.resume(returning: .notFound("HTTP 404"))
                default: c.resume(returning: .failed("HTTP \(http.statusCode)"))
                }
            }
            task.resume()
        }
    }
}

// MARK: - Files

func readFile(_ url: URL) -> Fetched {
    guard FileManager.default.fileExists(atPath: url.path) else { return .notFound("\(url.path) not found") }
    do {
        return .ok(try Data(contentsOf: url), etag: "")
    } catch {
        return .failed("\(url.path): \(error.localizedDescription)")
    }
}

/// Temp file + rename (`.atomic`): readers see the old or the new file, never half of one.
func atomicWrite(_ data: Data, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
}

func joinURL(_ base: String, _ rel: String) -> String {
    base.hasSuffix("/") ? base + rel : base + "/" + rel
}

func fileURL(_ s: String) -> URL {
    if s.hasPrefix("file://"), let u = URL(string: s) { return u }
    return URL(fileURLWithPath: s)
}
