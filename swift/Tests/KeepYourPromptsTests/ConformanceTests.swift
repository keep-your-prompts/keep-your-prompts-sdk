// The 12 required behaviours of conformance/README.md, with the shared fixtures. Network
// behaviours run against the in-process fake and against fake_cdn.py when python3 exists.
import Foundation
import XCTest
@testable import KeepYourPrompts

final class ConformanceTests: XCTestCase {
    private func cases() throws -> [String: Any] {
        let data = try Data(contentsOf: conformanceDir.appendingPathComponent("cases.json"))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    // 1. Render
    func test01RenderCases() throws {
        let list = try cases()["render"] as! [[String: Any]]
        XCTAssertFalse(list.isEmpty)
        for c in list {
            let tmpl = c["template"] as! String
            let vars = c["vars"] as? [String: String] ?? [:]
            let lenient = (c["lenient"] as? Bool) ?? false
            if let out = c["out"] as? String {
                XCTAssertEqual(try renderTemplate(tmpl, vars, onMissing: lenient ? .keep : .error), out, "\(c)")
            } else {
                XCTAssertEqual(c["error"] as? String, "missing_variable")
                XCTAssertThrowsError(try renderTemplate(tmpl, vars)) { e in
                    XCTAssertEqual(e as? KYPError, .missingVariables([c["variable"] as! String]))
                }
            }
        }
    }

    // 2. Variables
    func test02VariablesCases() throws {
        for c in try cases()["variables"] as! [[String: Any]] {
            XCTAssertEqual(templateVariables(in: c["template"] as! String), c["out"] as! [String])
        }
    }

    // 3. Manifest
    func test03ManifestCases() throws {
        for c in try cases()["manifest"] as! [[String: Any]] {
            let data: Data
            if let f = c["file"] as? String {
                data = try Data(contentsOf: conformanceDir.appendingPathComponent(f))
            } else {
                data = try JSONSerialization.data(withJSONObject: c["json"]!)
            }
            let valid = c["valid"] as! Bool
            let parsed = try? Manifest.parse(data, app: "demo", env: "prod")
            XCTAssertEqual(parsed != nil, valid, "\(c)")
            if let m = parsed {
                if let names = c["prompts"] as? [String] { XCTAssertEqual(m.names, names) }
                if c["json"] != nil { XCTAssertEqual(m.prompts["p"]?.variables, []) }
            }
        }
        let v12 = try Data(contentsOf: fixture("v12").appendingPathComponent("envs/demo/prod.json"))
        XCTAssertThrowsError(try Manifest.parse(v12, app: "demo", env: "staging"))
    }

    // 4. Hash check
    func test04HashCheck() async throws {
        for c in try cases()["sha256"] as! [[String: Any]] {
            XCTAssertEqual(sha256Hex(Data((c["in"] as! String).utf8)), c["out"] as! String)
        }
        do {
            _ = try await KeepYourPrompts(quiet { $0.snapshotDirectory = fixture("tampered-v14"); $0.startupTimeout = 0.2 })
            XCTFail("a tampered snapshot must be refused")
        } catch let e as KYPError {
            guard case .unavailable = e else { return XCTFail("\(e)") }
        }
        try await withFakes({ [Route(name: "cdn", prefix: "/v1/d/\(testKey)", dir: fixture("tampered-v14"))] }) { fake in
            let c = try await KeepYourPrompts(httpOptions(fake) { $0.snapshotDirectory = fixture("v12") })
            let answered = await c.refresh()
            XCTAssertFalse(answered, fake.kind)
            XCTAssertEqual(c.revision, 12)
            XCTAssertEqual(c.prompt("greeting")?.version, 4)
            XCTAssertTrue(c.status().lastError.contains("failed sha256 verification"), c.status().lastError)
        }
    }

    // 5. Start from local
    func test05StartFromLocalWithoutNetwork() async throws {
        let start = Date()
        let c = try await KeepYourPrompts(quiet { o in
            o.snapshotDirectory = fixture("v12")
            o.deliveryKey = testKey
            o.cdnBase = "http://127.0.0.1:9/v1/d"  // nothing listens
            o.originBase = "http://127.0.0.1:9/v1/delivery"
        })
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.5)
        XCTAssertEqual(c.prompt("greeting")?.version, 4)
        XCTAssertEqual(c.get("greeting"), "Hello {{name}}, welcome to {{ company }}.")
        XCTAssertEqual(try c.render("greeting", ["name": "Ana", "company": "Acme"]), "Hello Ana, welcome to Acme.")
        XCTAssertEqual(try c.render("triage", ["company": "Acme"]),
                       "You are a support agent for Acme. Literal {{braces}} stay.")
        XCTAssertEqual(c.get("agents/reviewer"), "Review the diff.")
        XCTAssertEqual(c.get("empty"), "")
        XCTAssertEqual(c.status().source, "snapshot")
        XCTAssertEqual(c.names, ["agents/reviewer", "empty", "greeting", "triage"])
        XCTAssertThrowsError(try c.render("nope")) { XCTAssertEqual($0 as? KYPError, .notFound("nope")) }
        XCTAssertThrowsError(try c.render("greeting", ["name": "x"])) {
            XCTAssertEqual($0 as? KYPError, .missingVariables(["company"]))
        }
    }

    // 6. Mirror order and fallback
    func test06MirrorOrderAndFallback() async throws {
        let served = Served("v12")
        try await withFakes({ standardRoutes(served.path, served.path, served.path) }) { fake in
            let opts = httpOptions(fake) { o in
                o.gitMirror = fake.base + "/acme/prompts/main/.kyp"
                o.gitToken = "github_pat_test"
            }
            var c: KeepYourPrompts? = try await KeepYourPrompts(opts)
            XCTAssertEqual(c?.status().source, "cdn", fake.kind)
            XCTAssertGreaterThanOrEqual(fake.stats("cdn").ok, 1)
            XCTAssertEqual(fake.stats("origin").ok, 0)
            XCTAssertEqual(fake.stats("git").ok, 0)
            XCTAssertEqual(c?.status().mirrors.map(\.name), ["cdn", "origin", "git"])
            for m in c!.status().mirrors { XCTAssertFalse(m.url.contains(testKey), "key must be redacted") }
            c = nil

            fake.down("cdn")
            c = try await KeepYourPrompts(opts)
            XCTAssertEqual(c?.status().source, "origin")
            XCTAssertEqual(c?.prompt("greeting")?.version, 4)
            XCTAssertTrue(c!.status().lastError.contains("cdn: HTTP 503"), c!.status().lastError)
            c = nil

            fake.down("origin")
            c = try await KeepYourPrompts(opts)
            XCTAssertEqual(c?.status().source, "git")
            XCTAssertEqual(c?.prompt("greeting")?.version, 4)
            XCTAssertEqual(fake.stats("git").auth, "Bearer github_pat_test")
            c = nil

            fake.up("cdn")
            fake.up("origin")
            c = try await KeepYourPrompts(opts)
            XCTAssertEqual(c?.status().source, "cdn")
        }
    }

    // 7. Revalidation
    func test07RevalidationWithETag() async throws {
        let served = Served("v12")
        try await withFakes({ standardRoutes(served.path, served.path, served.path) }) { fake in
            let updates = TestBox(0)
            let c = try await KeepYourPrompts(httpOptions(fake) { $0.onUpdate = { _ in updates.update { $0 += 1 } } })
            let before = fake.stats("cdn")
            XCTAssertEqual(before.notModified, 0)
            let answered = await c.refresh()
            XCTAssertTrue(answered)
            let after = fake.stats("cdn")
            XCTAssertEqual(after.notModified, 1, "\(fake.kind): the second poll must send If-None-Match")
            XCTAssertEqual(after.ok, before.ok)
            XCTAssertEqual(c.revision, 12)
            XCTAssertEqual(updates.get(), 0)
            XCTAssertNotNil(c.status().lastSuccess)
            XCTAssertEqual(c.status().lastError, "")
        }
    }

    // 8. Hot update
    func test08HotUpdateFiresCallbackOnce() async throws {
        func run(_ fake: FakeCDN, _ served: Served) async throws {
            let seen = TestBox<[Update]>([])
            let c = try await KeepYourPrompts(httpOptions(fake) { $0.onUpdate = { u in seen.update { $0.append(u) } } })
            let stream = c.updates
            XCTAssertEqual(c.prompt("greeting")?.version, 4)
            served.deploy("v13")
            var ok = await c.refresh()
            XCTAssertTrue(ok)
            XCTAssertEqual(c.revision, 13)
            XCTAssertEqual(c.prompt("greeting")?.version, 5)
            XCTAssertEqual(c.get("greeting"), "Hi {{name}}! {{company}} is glad you are here.")
            ok = await c.refresh()  // a 304 afterwards fires nothing
            XCTAssertTrue(ok)
            let s = seen.get()
            XCTAssertEqual(s.count, 1, "\(fake.kind): \(s)")
            XCTAssertEqual(s.first, Update(oldRevision: 12, newRevision: 13, source: "cdn", changed: ["greeting"]))
            var it = stream.makeAsyncIterator()
            let streamed = await it.next()
            XCTAssertEqual(streamed?.newRevision, 13)
        }
        let served = Served("v12")
        let fake = InProcessFake(routes: standardRoutes(served.path, served.path, served.path))
        try await run(fake, served)
        fake.stop()
        if let py = findPython() {
            let served = Served("v12")
            let p = try XCTUnwrap(PyFake(python: py, routes: standardRoutes(served.path, served.path, served.path)))
            try await run(p, served)
            p.stop()
        }
    }

    // 9. Stale mirror
    func test09StaleMirrorNeverReplacesNewer() async throws {
        try await withFakes({ [Route(name: "cdn", prefix: "/v1/d/\(testKey)", dir: fixture("v11-stale"))] }) { fake in
            let c = try await KeepYourPrompts(httpOptions(fake) { $0.snapshotDirectory = fixture("v12") })
            let answered = await c.refresh()
            XCTAssertFalse(answered)
            XCTAssertEqual(c.revision, 12)
            XCTAssertEqual(c.prompt("greeting")?.version, 4)
            XCTAssertTrue(c.status().lastError.contains("stale manifest ignored"), c.status().lastError)
        }
        let c = try await KeepYourPrompts(quiet {
            $0.mirrors = [.directory(fixture("v11-stale"), name: "old"), .directory(fixture("v12"), name: "new")]
        })
        XCTAssertEqual(c.revision, 12)
        XCTAssertEqual(c.status().source, "new")
    }

    // 10. Failures never evict
    func test10FailuresNeverEvict() async throws {
        let served = Served("v12")
        try await withFakes({ standardRoutes(served.path, served.path, served.path) }) { fake in
            let c = try await KeepYourPrompts(httpOptions(fake))
            let confirmed = try XCTUnwrap(c.status().lastSuccess)
            fake.down("cdn")
            fake.down("origin")
            try await Task.sleep(nanoseconds: 30_000_000)
            let answered = await c.refresh()
            XCTAssertFalse(answered)
            XCTAssertEqual(c.get("greeting"), "Hello {{name}}, welcome to {{ company }}.")
            let st = c.status()
            XCTAssertTrue(st.ready)
            XCTAssertEqual(st.revision, 12)
            XCTAssertTrue(st.lastError.contains("cdn: HTTP 503"), st.lastError)
            XCTAssertTrue(st.lastError.contains("origin: HTTP 503"), st.lastError)
            XCTAssertEqual(st.lastSuccess, confirmed)
            XCTAssertGreaterThanOrEqual(st.staleFor, 0.03)
            XCTAssertGreaterThanOrEqual(st.mirrors[0].consecutiveFailures, 1)
            fake.up("cdn")
            fake.up("origin")
        }
    }

    // 11. Disk cache
    func test11DiskCacheRestartWithoutNetwork() async throws {
        let served = Served("v12")
        try await withFakes({ standardRoutes(served.path, served.path, served.path) }) { fake in
            let cache = tempDir()
            defer { try? FileManager.default.removeItem(at: cache) }
            var c: KeepYourPrompts? = try await KeepYourPrompts(httpOptions(fake) { $0.cacheDirectory = cache })
            XCTAssertEqual(c?.status().source, "cdn")
            c = nil
            let cached = cache.appendingPathComponent("acme/demo/prod/envs/demo/prod.json")
            XCTAssertTrue(FileManager.default.fileExists(atPath: cached.path))

            let start = Date()
            let c2 = try await KeepYourPrompts(quiet { $0.cacheDirectory = cache })
            XCTAssertLessThan(Date().timeIntervalSince(start), 0.5)
            XCTAssertEqual(c2.status().source, "disk-cache")
            XCTAssertEqual(c2.prompt("greeting")?.version, 4)

            fake.down("cdn")
            fake.down("origin")
            let c3 = try await KeepYourPrompts(httpOptions(fake) { $0.cacheDirectory = cache })
            XCTAssertEqual(c3.status().source, "disk-cache")
            XCTAssertEqual(c3.revision, 12)
            fake.up("cdn")
            fake.up("origin")
        }
    }

    // 12. Read path
    func test12ReadPathNoIOAndThreadSafe() async throws {
        let snap = Served("v12")
        let c0 = try await KeepYourPrompts(quiet { $0.snapshotDirectory = snap.path })
        try FileManager.default.removeItem(at: snap.path)  // no I/O on reads
        XCTAssertEqual(c0.prompt("greeting")?.version, 4)

        let served = Served("v12")
        let fake = InProcessFake(routes: standardRoutes(served.path, served.path, served.path))
        defer { fake.stop() }
        let c = try await KeepYourPrompts(httpOptions(fake))
        let stop = TestBox(false)
        let reads = TestBox(0)
        let readers = (0..<8).map { _ in
            Thread {
                var n = 0
                while !stop.get() {
                    guard let g = c.get("greeting") else { return XCTFail("evicted") }
                    XCTAssertTrue(g.hasPrefix("Hello") || g.hasPrefix("Hi"))
                    if (try? c.render("triage", ["company": "A"])) == nil { XCTFail("render failed") }
                    n += 1
                }
                reads.update { $0 += n }
            }
        }
        readers.forEach { $0.start() }
        let m12 = try String(contentsOf: fixture("v12").appendingPathComponent("envs/demo/prod.json"), encoding: .utf8)
        let m13 = try String(contentsOf: fixture("v13").appendingPathComponent("envs/demo/prod.json"), encoding: .utf8)
        served.deploy("v13")
        for rev in 13..<33 {
            let body = (rev % 2 == 0 ? m12 : m13)
                .replacingOccurrences(of: "\"revision\": 12", with: "\"revision\": \(rev)")
                .replacingOccurrences(of: "\"revision\": 13", with: "\"revision\": \(rev)")
            try Data(body.utf8).write(to: served.path.appendingPathComponent("envs/demo/prod.json"), options: .atomic)
            let ok = await c.refresh()
            XCTAssertTrue(ok)
            XCTAssertEqual(c.revision, rev)
        }
        // Concurrent tasks read too.
        await withTaskGroup(of: Int.self) { g in
            for _ in 0..<8 { g.addTask { (0..<1000).reduce(0) { n, _ in n + (c.get("greeting") == nil ? 0 : 1) } } }
            var total = 0
            for await n in g { total += n }
            XCTAssertEqual(total, 8000)
        }
        stop.set(true)
        _ = await eventually { readers.allSatisfy { $0.isFinished } }
        XCTAssertGreaterThan(reads.get(), 100)
    }
}
