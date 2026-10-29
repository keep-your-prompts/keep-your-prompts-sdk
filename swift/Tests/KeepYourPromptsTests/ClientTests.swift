import Foundation
import XCTest
@testable import KeepYourPrompts

final class ClientTests: XCTestCase {
    func testBundledSnapshotFromBundleModule() async throws {
        var o = quiet()
        o.useBundle(Bundle.module)
        let c = try await KeepYourPrompts(o)
        XCTAssertEqual(c.status().source, "embedded")
        XCTAssertEqual(c.revision, 12)
        XCTAssertEqual(c.prompt("greeting")?.version, 4)
        // A newer snapshot folder wins; the bundled one is the floor.
        o.snapshotDirectory = fixture("v13")
        let c2 = try await KeepYourPrompts(o)
        XCTAssertEqual(c2.status().source, "snapshot")
        XCTAssertEqual(c2.revision, 13)
        // The convenience initialiser takes a bundle directly.
        let c3 = try await KeepYourPrompts(app: "demo", bundle: .module)
        XCTAssertEqual(c3.revision, 12)
        c3.close()
    }

    func testFromEnvironment() async throws {
        let o = Options.fromEnvironment([
            "KYP_APP": "demo", "KYP_ENV": "prod", "KYP_SNAPSHOT_DIR": fixture("v12").path,
            "KYP_POLL_INTERVAL": "0.5", "KYP_LOG": "off", "KYP_DELIVERY_KEY": "", "KYP_CDN_URL": "https://cdn.example",
        ])
        XCTAssertEqual(o.pollInterval, 0.5)
        XCTAssertNil(o.logLevel)
        XCTAssertNil(o.deliveryKey)
        XCTAssertEqual(o.cdnBase, "https://cdn.example")
        let c = try await KeepYourPrompts(o)
        XCTAssertEqual(c.revision, 12)
        XCTAssertEqual(c.status().source, "snapshot")
    }

    func testInvalidOptions() async {
        for o in [quiet { $0.app = "" }, quiet { $0.app = "Bad App" }, quiet { $0.env = "-x" },
                  quiet { $0.deliveryKey = "kypd_a/b"; $0.snapshotDirectory = fixture("v12") }] {
            do {
                _ = try await KeepYourPrompts(o)
                XCTFail("expected invalidConfiguration")
            } catch let e as KYPError {
                guard case .invalidConfiguration = e else { return XCTFail("\(e)") }
            } catch { XCTFail("\(error)") }
        }
        do {
            _ = try await KeepYourPrompts(quiet())
            XCTFail("expected unavailable")
        } catch let e as KYPError {
            guard case .unavailable = e else { return XCTFail("\(e)") }
        } catch { XCTFail("\(error)") }
    }

    func testBackgroundPollerHotReloadsAndStopsWhenReleased() async throws {
        let served = Served("v12")
        let fake = InProcessFake(routes: standardRoutes(served.path, served.path, served.path))
        defer { fake.stop() }
        let updates = TestBox(0)
        var c: KeepYourPrompts? = try await KeepYourPrompts(httpOptions(fake) { o in
            o.pollInterval = 0.1
            o.onUpdate = { _ in updates.update { $0 += 1 } }
        })
        let polled = await eventually { fake.stats("cdn").notModified >= 2 }
        XCTAssertTrue(polled, "polls revalidate")
        served.deploy("v13")
        let reloaded = await eventually { c?.revision == 13 }
        XCTAssertTrue(reloaded)
        let fired = await eventually { updates.get() == 1 }
        XCTAssertTrue(fired)
        let alive: () -> Bool = { [weak c] in c != nil }
        c = nil
        XCTAssertFalse(alive(), "the poller must not retain the client")
        try await Task.sleep(nanoseconds: 150_000_000)
        let a = fake.stats("cdn")
        try await Task.sleep(nanoseconds: 400_000_000)
        let b = fake.stats("cdn")
        XCTAssertEqual(a.ok + a.notModified, b.ok + b.notModified, "no polls after release")
    }

    func testStartupTimeoutOrStartEmpty() async throws {
        let served = Served("v12")
        let fake = InProcessFake(routes: standardRoutes(served.path, served.path, served.path))
        defer { fake.stop() }
        fake.down("cdn")
        fake.down("origin")
        let start = Date()
        do {
            _ = try await KeepYourPrompts(httpOptions(fake) { $0.startupTimeout = 0.4 })
            XCTFail("expected unavailable")
        } catch let e as KYPError {
            guard case .unavailable(let m) = e else { return XCTFail("\(e)") }
            XCTAssertFalse(m.contains(testKey), "key redacted: \(m)")
        }
        let took = Date().timeIntervalSince(start)
        XCTAssertGreaterThanOrEqual(took, 0.3)
        XCTAssertLessThan(took, 2)

        let c = try await KeepYourPrompts(httpOptions(fake) { o in
            o.startupTimeout = 0.2
            o.startEmpty = true
            o.pollInterval = 0.1
        })
        XCTAssertFalse(c.status().ready)
        XCTAssertNil(c.get("greeting"))
        fake.up("origin")
        let loaded = await eventually { c.get("greeting") != nil }
        XCTAssertTrue(loaded)
        XCTAssertEqual(c.status().source, "origin")
    }

    func testTamperedCDNBlobIsTakenFromTheNextMirror() async throws {
        let bad = Served("v12"), good = Served("v12")
        try Data("evil".utf8).write(to: bad.path.appendingPathComponent(
            "blobs/5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"))
        let fake = InProcessFake(routes: standardRoutes(bad.path, good.path, good.path))
        defer { fake.stop() }
        let c = try await KeepYourPrompts(httpOptions(fake))
        XCTAssertEqual(c.status().source, "cdn")
        XCTAssertEqual(c.get("greeting"), "Hello {{name}}, welcome to {{ company }}.")
    }

    func testFileMirrorsArePolledWithoutNetwork() async throws {
        let snap = Served("v12")
        let c = try await KeepYourPrompts(quiet { $0.snapshotDirectory = snap.path })
        snap.deploy("v13")
        let ok = await c.refresh()
        XCTAssertTrue(ok)
        XCTAssertEqual(c.revision, 13)
    }

    func testPullSnapshot() async throws {
        let served = Served("v12")
        let fake = InProcessFake(routes: standardRoutes(served.path, served.path, served.path))
        defer { fake.stop() }
        let out = tempDir()
        defer { try? FileManager.default.removeItem(at: out) }
        let info = try await pullSnapshot(httpOptions(fake), to: out)
        XCTAssertEqual(info, SnapshotInfo(workspace: "acme", revision: 12, promptCount: 4, blobsWritten: 4, source: "cdn"))
        let offline = try await KeepYourPrompts(quiet { $0.snapshotDirectory = out })
        XCTAssertEqual(offline.revision, 12)
    }

    func testPromptMetadataAndRenderModes() async throws {
        let c = try await KeepYourPrompts(quiet { $0.snapshotDirectory = fixture("v12") })
        let p = try XCTUnwrap(c.prompt("greeting"))
        XCTAssertEqual(p.variables, ["name", "company"])
        XCTAssertEqual(p.sha256, sha256Hex(Data(p.text.utf8)))
        XCTAssertEqual(try p.render(["name": "A", "company": "B"]), "Hello A, welcome to B.")
        XCTAssertEqual(try c.render("greeting", ["name": "A"], onMissing: .keep), "Hello A, welcome to {{ company }}.")
        XCTAssertEqual(try c.render("greeting", ["name": "A"], onMissing: .empty), "Hello A, welcome to .")
        XCTAssertTrue(c.contains("agents/reviewer"))
        XCTAssertFalse(c.contains("agents"))
    }

    func testTemplateEdgeCases() throws {
        XCTAssertEqual(try renderTemplate("{{", [:]), "{{")
        XCTAssertEqual(try renderTemplate("{{a", [:]), "{{a")
        XCTAssertEqual(try renderTemplate("{{{a}}", ["a": "x"]), "{{{a}}")
        XCTAssertEqual(try renderTemplate("a}}b", [:]), "a}}b")
        XCTAssertEqual(try renderTemplate("{{\ta\t}}", ["a": "x"]), "x")
        XCTAssertThrowsError(try renderTemplate("{{b}}{{a}}{{b}}", [:])) {
            XCTAssertEqual($0 as? KYPError, .missingVariables(["b", "a"]))
        }
        // Values are inserted verbatim, never rendered again.
        for _ in 0..<200 {
            let v = String((0..<Int.random(in: 0..<12)).map { _ in "{}ab é日".randomElement()! })
            XCTAssertEqual(try renderTemplate("<{{ x }}>", ["x": v]), "<\(v)>")
        }
    }

    /// Timing (not pass/fail): ns per get() and render() from memory.
    func testTimingGetAndRender() async throws {
        let c = try await KeepYourPrompts(quiet { $0.snapshotDirectory = fixture("v12") })
        let n = 200_000
        var t = Date()
        var sink = 0
        for _ in 0..<n { sink &+= c.get("greeting")?.utf8.count ?? 0 }
        let getNs = Date().timeIntervalSince(t) * 1e9 / Double(n)
        t = Date()
        for _ in 0..<n { sink &+= try c.render("greeting", ["name": "Ana", "company": "Acme"]).utf8.count }
        let renderNs = Date().timeIntervalSince(t) * 1e9 / Double(n)
        print(String(format: "timing: get %.1f ns/op, render %.1f ns/op (sink %d)", getNs, renderNs, sink))
        XCTAssertLessThan(getNs, 100_000)
    }
}
