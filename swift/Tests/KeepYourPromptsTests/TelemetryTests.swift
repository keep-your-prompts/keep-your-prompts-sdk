import Foundation
import XCTest
@testable import KeepYourPrompts

final class Recorder: TelemetryObserver, @unchecked Sendable {
    private let lock = NSLock()
    private var _refreshes: [RefreshRecord] = []
    private var _renderErrors: [RenderError] = []
    var refreshes: [RefreshRecord] { lock.lock(); defer { lock.unlock() }; return _refreshes }
    var renderErrors: [RenderError] { lock.lock(); defer { lock.unlock() }; return _renderErrors }
    func onRefresh(_ record: RefreshRecord) { lock.lock(); _refreshes.append(record); lock.unlock() }
    func onRenderError(_ error: RenderError) { lock.lock(); _renderErrors.append(error); lock.unlock() }
}

/// Prompt metadata and the observer hook (protocol/tracing.md), without OpenTelemetry.
final class TelemetryTests: XCTestCase {
    /// Two folder mirrors: "broken" (a manifest that is not JSON) first, then "snapshot" (v12).
    /// Folder-only clients poll their folders right after start-up: wait for that round.
    private func setup(_ rec: Recorder) async throws -> (Served, Served, KeepYourPrompts) {
        let broken = Served("v12")
        try Data("not json".utf8).write(to: broken.path.appendingPathComponent("envs/demo/prod.json"))
        let good = Served("v12")
        let c = try await KeepYourPrompts(quiet { o in
            o.mirrors = [.directory(broken.path, name: "broken"), .directory(good.path, name: "snapshot")]
            o.observers = [rec]
        })
        let polled = await eventually { rec.refreshes.count >= 2 }
        XCTAssertTrue(polled)
        return (broken, good, c)
    }

    func testMetaAndRenderWithMeta() async throws {
        let rec = Recorder()
        let (_, _, c) = try await setup(rec)
        let m = try c.meta("greeting")
        XCTAssertEqual(m, PromptMeta(name: "greeting", version: 4,
                                     sha256: "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d",
                                     app: "demo", env: "prod", workspace: "acme", revision: 12, source: "snapshot"))
        let r = try c.renderWithMeta("greeting", ["name": "Ada", "company": "Acme"])
        XCTAssertEqual(r.text, try c.render("greeting", ["name": "Ada", "company": "Acme"]))
        XCTAssertEqual(r.meta, m)
        XCTAssertThrowsError(try c.meta("nope")) { XCTAssertEqual($0 as? KYPError, .notFound("nope")) }
        c.close()
    }

    func testAttributesAndMetadataMaps() async throws {
        let rec = Recorder()
        let (_, _, c) = try await setup(rec)
        let m = try c.meta("triage")
        let a = m.attributes()
        XCTAssertEqual(Set(a.keys), ["kyp.prompt.name", "kyp.prompt.version", "kyp.prompt.sha256", "kyp.app", "kyp.env",
                                     "kyp.revision", "kyp.workspace", "kyp.source", "gen_ai.prompt.name",
                                     "gen_ai.prompt.version"])
        XCTAssertEqual(a["kyp.prompt.version"], .int(7))
        XCTAssertEqual(a["gen_ai.prompt.version"], .string("7"))
        XCTAssertNil(m.attributes(genAI: false)["gen_ai.prompt.name"])
        XCTAssertEqual(Set(m.traceMetadata().keys), ["kyp_prompt_name", "kyp_prompt_version", "kyp_prompt_sha256",
                                                     "kyp_app", "kyp_env", "kyp_revision", "kyp_workspace", "kyp_source"])
        XCTAssertEqual(m.langfuseMetadata(), m.traceMetadata())
        XCTAssertEqual(m.langsmithMetadata(), m.traceMetadata())
        let json = String(decoding: try JSONEncoder().encode(m.traceMetadata()), as: UTF8.self)
        XCTAssertTrue(json.contains("\"kyp_revision\":12"))
        let bare = PromptMeta(name: "a", version: 1, sha256: "x", app: "b", env: "c", workspace: "", revision: 0, source: "")
        XCTAssertNil(bare.attributes()["kyp.workspace"])
        XCTAssertNil(bare.traceMetadata()["kyp_source"])
        c.close()
    }

    func testStartRoundWithFallbackAndUpdate() async throws {
        let rec = Recorder()
        let (_, _, c) = try await setup(rec)
        let r = rec.refreshes[0]
        XCTAssertEqual(r.trigger, .start)
        XCTAssertEqual(r.result, .updated)
        XCTAssertEqual([r.mirror, r.source, r.workspace], ["snapshot", "snapshot", "acme"])
        XCTAssertEqual([r.revision, r.previousRevision], [12, 0])
        XCTAssertEqual(r.events.map(\.name), ["kyp.fallback", "kyp.update"])
        XCTAssertEqual(r.events[0].attributes["kyp.mirror"], .string("broken"))
        XCTAssertEqual(r.events[0].attributes["kyp.source"], .string("snapshot"))
        XCTAssertEqual(r.events[0].attributes["error.type"], .string("bad_manifest"))
        XCTAssertEqual(r.events[1].attributes, ["kyp.revision.previous": .int(0), "kyp.revision": .int(12),
                                                "kyp.prompts.changed": .int(4)])
        XCTAssertEqual(rec.refreshes[1].trigger, .poll)
        XCTAssertEqual(rec.refreshes[1].result, .notModified)
        c.close()
    }

    func testUpdateNotModifiedAndHashMismatch() async throws {
        let rec = Recorder()
        let (_, good, c) = try await setup(rec)
        good.deploy("v13")
        let ok = await c.refresh()
        XCTAssertTrue(ok)
        var r = rec.refreshes.last!
        XCTAssertEqual(r.trigger, .manual)
        XCTAssertEqual(r.result, .updated)
        XCTAssertEqual([r.previousRevision, r.revision], [12, 13])
        XCTAssertEqual(r.events.last?.attributes["kyp.prompts.changed"], .int(1))

        await c.refresh()
        XCTAssertEqual(rec.refreshes.last?.result, .notModified)

        good.deploy("tampered-v14")
        let failed = await c.refresh()
        XCTAssertFalse(failed)
        r = rec.refreshes.last!
        XCTAssertEqual(r.result, .failed)
        XCTAssertEqual(r.source, "")
        XCTAssertEqual(r.errorType, "blob_unavailable")
        let hm = r.events.filter { $0.name == "kyp.hash_mismatch" }
        XCTAssertEqual(hm.count, 1)
        XCTAssertEqual(hm.first?.attributes, [
            "kyp.mirror": .string("snapshot"), "kyp.source": .string("snapshot"),
            "kyp.blob.sha256": .string("fcadfa6b70f5b153be065e4f32dc011328b1aff4749fb3b748bba68a60c0838e"),
        ])
        XCTAssertEqual(c.revision, 13)
        c.close()
    }

    func testRenderErrorsAndObserverIsolation() async throws {
        let rec = Recorder()
        let (_, _, c) = try await setup(rec)
        XCTAssertThrowsError(try c.render("greeting", ["name": "Ada"]))
        XCTAssertThrowsError(try c.renderWithMeta("nope"))
        XCTAssertEqual(rec.renderErrors.map { [$0.name, $0.errorType] }, [["greeting", "missing_variable"], ["nope", "not_found"]])

        let extra = Recorder()
        let token = c.addObserver(extra)
        await c.refresh()
        XCTAssertTrue(c.removeObserver(token))
        XCTAssertFalse(c.removeObserver(token))
        await c.refresh()
        XCTAssertEqual(extra.refreshes.count, 1)
        c.close()
    }

    func testNormalizeAndClassify() {
        XCTAssertEqual(Telemetry.normalizeSource("disk-cache", kind: "cache"), "cache")
        XCTAssertEqual(Telemetry.normalizeSource("cdn", kind: "http"), "cdn")
        XCTAssertEqual(Telemetry.normalizeSource("eu", kind: "http"), "custom")
        XCTAssertEqual(Telemetry.normalizeSource("local", kind: "file"), "snapshot")
        XCTAssertEqual(Telemetry.normalizeSource("x", kind: "embedded"), "embedded")
        XCTAssertEqual(Telemetry.normalizeSource("", kind: "http"), "")
        let cases = [
            ("HTTP 503", "http_503"), ("manifest not found (HTTP 404)", "not_found"),
            ("manifest not found (/x not found)", "not_found"), ("The request timed out.", "timeout"),
            ("Could not connect to the server.", "network"), ("stale manifest ignored (revision 11 < held 12)", "stale"),
            ("bad manifest: not JSON", "bad_manifest"), ("weird", "_OTHER"),
        ]
        for (msg, want) in cases { XCTAssertEqual(Telemetry.classifyError(msg), want, msg) }
    }
}
