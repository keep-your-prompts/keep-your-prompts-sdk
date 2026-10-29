#if os(Linux) && compiler(<6.0)
@preconcurrency import Foundation  // corelibs Foundation before 6.0 does not mark URL/URLSession Sendable
#else
import Foundation
#endif
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif
import XCTest
@testable import KeepYourPrompts

let testKey = "kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f"

/// `<repo>/conformance`, found from this file's location.
let conformanceDir: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // KeepYourPromptsTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // swift
    .deletingLastPathComponent()  // repo
    .appendingPathComponent("conformance")

func fixture(_ name: String) -> URL { conformanceDir.appendingPathComponent("fixtures").appendingPathComponent(name) }

func tempDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("kyp-test-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

func copyTree(_ from: URL, _ to: URL) {
    let fm = FileManager.default
    try! fm.createDirectory(at: to, withIntermediateDirectories: true)
    for name in try! fm.contentsOfDirectory(atPath: from.path) {
        let src = from.appendingPathComponent(name), dst = to.appendingPathComponent(name)
        var isDir: ObjCBool = false
        _ = fm.fileExists(atPath: src.path, isDirectory: &isDir)
        if isDir.boolValue {
            copyTree(src, dst)
        } else {
            try? fm.removeItem(at: dst)
            try! fm.copyItem(at: src, to: dst)
        }
    }
}

/// A folder served by a fake, initialised from a fixture.
final class Served: @unchecked Sendable {
    let path: URL
    init(_ fixtureName: String) {
        path = tempDir()
        copyTree(fixture(fixtureName), path)
    }
    deinit { try? FileManager.default.removeItem(at: path) }

    /// Deploy like the server does: blobs first, then the manifest by rename.
    func deploy(_ fixtureName: String) {
        copyTree(fixture(fixtureName).appendingPathComponent("blobs"), path.appendingPathComponent("blobs"))
        let data = try! Data(contentsOf: fixture(fixtureName).appendingPathComponent("envs/demo/prod.json"))
        try! data.write(to: path.appendingPathComponent("envs/demo/prod.json"), options: .atomic)
    }
}

struct Route: Sendable {
    let name: String
    let prefix: String
    let dir: URL
}

func standardRoutes(_ cdn: URL, _ origin: URL, _ git: URL) -> [Route] {
    [
        Route(name: "cdn", prefix: "/v1/d/\(testKey)", dir: cdn),
        Route(name: "origin", prefix: "/v1/delivery/\(testKey)", dir: origin),
        Route(name: "git", prefix: "/acme/prompts/main/.kyp", dir: git),
    ]
}

struct RouteStats: Sendable {
    var ok = 0, notModified = 0, notFound = 0, unavailable = 0
    var auth: String?
}

protocol FakeCDN: AnyObject, Sendable {
    var kind: String { get }
    var base: String { get }
    func stop()
}

extension FakeCDN {
    func control(_ path: String) -> Data {
        let sem = DispatchSemaphore(value: 0)
        let box = TestBox(Data())
        var req = URLRequest(url: URL(string: base + path)!)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { d, _, _ in
            box.set(d ?? Data())
            sem.signal()
        }.resume()
        sem.wait()
        return box.get()
    }
    func down(_ route: String) { _ = control("/__down/\(route)") }
    func up(_ route: String) { _ = control("/__up/\(route)") }
    func stats(_ route: String) -> RouteStats {
        let obj = try! JSONSerialization.jsonObject(with: control("/__stats")) as! [String: Any]
        let r = obj[route] as? [String: Any] ?? [:]
        func n(_ k: String) -> Int { (r[k] as? NSNumber)?.intValue ?? (r[k] as? Int) ?? 0 }
        return RouteStats(ok: n("200"), notModified: n("304"), notFound: n("404"), unavailable: n("503"),
                          auth: r["auth"] as? String)
    }
}

#if canImport(FoundationNetworking) && compiler(<6.0)
@preconcurrency import FoundationNetworking
#elseif canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Thread-safe box for test bookkeeping.
final class TestBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ v: T) { value = v }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
    func update(_ f: (inout T) -> Void) { lock.lock(); f(&value); lock.unlock() }
}

// MARK: - conformance/fake_cdn.py

final class PyFake: FakeCDN, @unchecked Sendable {
    let kind = "fake_cdn.py"
    let base: String
    private let process: Process

    init?(python: String, routes: [Route]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        p.arguments = [conformanceDir.appendingPathComponent("fake_cdn.py").path]
            + routes.flatMap { ["--route", "\($0.name):\($0.prefix):\($0.dir.path)"] }
        let out = Pipe()
        p.standardOutput = out
        do { try p.run() } catch { return nil }
        var line = Data()
        while !line.contains(UInt8(ascii: "\n")) {
            let d = out.fileHandleForReading.availableData
            if d.isEmpty { break }
            line.append(d)
        }
        let text = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("PORT "), let port = Int(text.dropFirst(5)) else {
            p.terminate()
            return nil
        }
        process = p
        base = "http://127.0.0.1:\(port)"
    }

    func stop() {
        // SIGKILL: a child spawned from a dispatch thread inherits its blocked SIGTERM.
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            process.waitUntilExit()
        }
    }
    deinit { stop() }
}

func findPython() -> String? {
    for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/usr/local/bin").split(separator: ":") {
        let p = "\(dir)/python3"
        if FileManager.default.isExecutableFile(atPath: p) { return p }
    }
    return nil
}

/// Runs `body` against the in-process fake, and against fake_cdn.py when python3 exists.
func withFakes(_ routes: () -> [Route], _ body: (FakeCDN) async throws -> Void) async throws {
    let fake = InProcessFake(routes: routes())
    defer { fake.stop() }
    try await body(fake)
    fake.stop()
    if let py = findPython() {
        guard let p = PyFake(python: py, routes: routes()) else { return XCTFail("fake_cdn.py did not start") }
        defer { p.stop() }
        try await body(p)
    } else {
        print("python3 not found: skipping the fake_cdn.py run")
    }
}

func quiet(_ configure: (inout Options) -> Void = { _ in }) -> Options {
    var o = Options(app: "demo", env: "prod")
    o.logLevel = nil
    o.pollInterval = 3600
    o.bundleResourceURL = nil
    configure(&o)
    return o
}

func httpOptions(_ fake: FakeCDN, _ configure: (inout Options) -> Void = { _ in }) -> Options {
    quiet { o in
        o.deliveryKey = testKey
        o.cdnBase = fake.base + "/v1/d"
        o.originBase = fake.base + "/v1/delivery"
        o.maxBackoff = 0.001
        configure(&o)
    }
}

func eventually(timeout: TimeInterval = 10, _ cond: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if cond() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return cond()
}
