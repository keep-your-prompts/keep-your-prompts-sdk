// An in-process HTTP mirror with the behaviour of conformance/fake_cdn.py: routes, strong
// ETags and 304, Cache-Control, /__down/<route>, /__up/<route> and /__stats. POSIX sockets only.
import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#elseif canImport(Darwin)
import Darwin
#endif
@testable import KeepYourPrompts

final class InProcessFake: FakeCDN, @unchecked Sendable {
    let kind = "in-process"
    let base: String
    private let routes: [Route]
    private let fd: Int32
    private let lock = NSLock()
    private var downRoutes = Set<String>()
    private var stats: [String: RouteStats] = [:]
    private var stopped = false
    private let done = DispatchSemaphore(value: 0)

    init(routes: [Route]) {
        signal(SIGPIPE, SIG_IGN)
        self.routes = routes
        for r in routes { stats[r.name] = RouteStats() }
        #if canImport(Darwin)
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        #else
        let sock = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        #endif
        var yes: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        #if canImport(Darwin)
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        #endif
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(sock, $0, size) } }
        precondition(bound == 0 && listen(sock, 128) == 0, "fake server could not listen")
        var len = size
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(sock, $0, &len) } }
        fd = sock
        base = "http://127.0.0.1:\(UInt16(bigEndian: addr.sin_port))"
        let t = Thread { [self] in acceptLoop() }
        t.start()
    }

    func stop() {
        lock.lock()
        let was = stopped
        stopped = true
        lock.unlock()
        if !was {
            done.wait()
            close(fd)
        }
    }

    deinit { stop() }

    private var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }

    private func acceptLoop() {
        while !isStopped {
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            if poll(&pfd, 1, 50) <= 0 { continue }
            let c = accept(fd, nil, nil)
            if c < 0 { continue }
            DispatchQueue.global().async { [self] in handle(c) }
        }
        done.signal()
    }

    private func handle(_ c: Int32) {
        defer { close(c) }
        var buf = [UInt8](repeating: 0, count: 8192)
        var req = Data()
        let end = Data("\r\n\r\n".utf8)
        while req.range(of: end) == nil {
            let n = read(c, &buf, buf.count)
            if n <= 0 { return }
            req.append(buf, count: n)
        }
        let head = String(decoding: req, as: UTF8.self)
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ")
        guard parts.count >= 2 else { return }
        var headers: [String: String] = [:]
        for l in lines.dropFirst() {
            guard let i = l.firstIndex(of: ":") else { continue }
            headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        let path = String(parts[1].split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        let (code, body, extra) = respond(path, headers)
        var out = "HTTP/1.1 \(code) \(code == 200 ? "OK" : code == 304 ? "Not Modified" : "Error")\r\n"
        for (k, v) in extra { out += "\(k): \(v)\r\n" }
        out += "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var data = Data(out.utf8)
        data.append(body)
        data.withUnsafeBytes { p in
            var off = 0
            while off < p.count {
                let n = write(c, p.baseAddress! + off, p.count - off)
                if n <= 0 { break }
                off += n
            }
        }
    }

    private func respond(_ path: String, _ headers: [String: String]) -> (Int, Data, [(String, String)]) {
        lock.lock()
        defer { lock.unlock() }
        if path == "/__stats" {
            var obj: [String: Any] = [:]
            for (k, s) in stats {
                obj[k] = ["200": s.ok, "304": s.notModified, "404": s.notFound, "503": s.unavailable,
                          "auth": s.auth as Any? ?? NSNull()] as [String: Any]
            }
            return (200, try! JSONSerialization.data(withJSONObject: obj), [("Content-Type", "application/json")])
        }
        for verb in ["down", "up"] where path.hasPrefix("/__\(verb)/") {
            let name = String(path.dropFirst("/__\(verb)/".count))
            if verb == "down" { downRoutes.insert(name) } else { downRoutes.remove(name) }
            return (200, Data("ok".utf8), [])
        }
        for r in routes where path.hasPrefix(r.prefix + "/") {
            let rel = String(path.dropFirst(r.prefix.count + 1))
            stats[r.name]!.auth = headers["authorization"]
            if downRoutes.contains(r.name) {
                stats[r.name]!.unavailable += 1
                return (503, Data("down".utf8), [])
            }
            let comps = rel.split(separator: "/", omittingEmptySubsequences: false)
            if comps.contains("..") || comps.contains("") || !(rel.hasPrefix("envs/") || rel.hasPrefix("blobs/")) {
                return (404, Data("not found".utf8), [])
            }
            guard let body = FileManager.default.contents(atPath: r.dir.appendingPathComponent(rel).path) else {
                stats[r.name]!.notFound += 1
                return (404, Data("not found".utf8), [])
            }
            let etag = "\"\(sha256Hex(body).prefix(32))\""
            let manifest = rel.hasPrefix("envs/")
            let h = [
                ("ETag", etag),
                ("Cache-Control", manifest ? "public, max-age=15, stale-while-revalidate=300, stale-if-error=86400"
                                           : "public, max-age=31536000, immutable"),
                ("Content-Type", manifest ? "application/json" : "text/plain; charset=utf-8"),
            ]
            if headers["if-none-match"] == etag {
                stats[r.name]!.notModified += 1
                return (304, Data(), h)
            }
            stats[r.name]!.ok += 1
            return (200, body, h)
        }
        return (404, Data("no route".utf8), [])
    }
}
