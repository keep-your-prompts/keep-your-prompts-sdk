import Foundation
import KeepYourPrompts
import KeepYourPromptsOTel
import OpenTelemetryApi
import OpenTelemetrySdk
import XCTest

// The OpenTelemetry add-on against the OpenTelemetry Swift SDK with in-memory exporters
// (protocol/tracing.md, conformance checklist).

final class MemorySpanExporter: SpanExporter, @unchecked Sendable {
    private let lock = NSLock()
    private var _spans: [SpanData] = []
    var spans: [SpanData] { lock.lock(); defer { lock.unlock() }; return _spans }
    /// Finished spans named `n` (the SimpleSpanProcessor exports on a queue: flush it first).
    func named(_ n: String) -> [SpanData] {
        provider?.forceFlush()
        return spans.filter { $0.name == n }
    }
    var provider: TracerProviderSdk?
    func export(spans: [SpanData], explicitTimeout: TimeInterval?) -> SpanExporterResultCode {
        lock.lock(); _spans += spans; lock.unlock()
        return .success
    }
    func flush(explicitTimeout: TimeInterval?) -> SpanExporterResultCode { .success }
    func shutdown(explicitTimeout: TimeInterval?) {}
}

final class MemoryMetricExporter: MetricExporter, @unchecked Sendable {
    private let lock = NSLock()
    private var latest: [MetricData] = []
    func export(metrics: [MetricData]) -> ExportResult {
        lock.lock(); latest = metrics; lock.unlock()
        return .success
    }
    func flush() -> ExportResult { .success }
    func shutdown() -> ExportResult { .success }
    func getAggregationTemporality(for instrument: InstrumentType) -> AggregationTemporality { .cumulative }
    func metric(_ name: String) -> MetricData? { lock.lock(); defer { lock.unlock() }; return latest.first { $0.name == name } }
}

private let conformance = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("conformance")

private func copyFixture(_ name: String, to dir: URL) {
    let src = conformance.appendingPathComponent("fixtures").appendingPathComponent(name)
    let fm = FileManager.default
    try? fm.createDirectory(at: dir.appendingPathComponent("blobs"), withIntermediateDirectories: true)
    try? fm.createDirectory(at: dir.appendingPathComponent("envs/demo"), withIntermediateDirectories: true)
    for b in (try? fm.contentsOfDirectory(atPath: src.appendingPathComponent("blobs").path)) ?? [] {
        let dst = dir.appendingPathComponent("blobs").appendingPathComponent(b)
        try? fm.removeItem(at: dst)
        try! fm.copyItem(at: src.appendingPathComponent("blobs").appendingPathComponent(b), to: dst)
    }
    let m = try! Data(contentsOf: src.appendingPathComponent("envs/demo/prod.json"))
    try! m.write(to: dir.appendingPathComponent("envs/demo/prod.json"), options: .atomic)
}

private func value(_ p: PointData) -> Double {
    if let l = p as? LongPointData { return Double(l.value) }
    if let d = p as? DoublePointData { return d.value }
    if let h = p as? HistogramPointData { return Double(h.count) }
    return .nan
}

final class KYPInstrumentationTests: XCTestCase {
    var spans: MemorySpanExporter!
    var tracerProvider: TracerProviderSdk!
    var metrics: MemoryMetricExporter!
    var meterProvider: MeterProviderSdk!
    var dirs: [URL] = []

    override func setUp() { resetProviders() }

    private func resetProviders() {
        spans = MemorySpanExporter()
        tracerProvider = TracerProviderSdk()
        tracerProvider.addSpanProcessor(SimpleSpanProcessor(spanExporter: spans))
        spans.provider = tracerProvider
        metrics = MemoryMetricExporter()
        meterProvider = MeterProviderSdk.builder()
            .registerMetricReader(reader: PeriodicMetricReaderBuilder(exporter: metrics).setInterval(timeInterval: 3600).build())
            // The SDK only aggregates instruments that a view selects.
            .registerView(selector: InstrumentSelectorBuilder().build(), view: View.builder().build())
            .build()
    }

    override func tearDown() {
        for d in dirs { try? FileManager.default.removeItem(at: d) }
    }

    private func tempDir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("kyp-otel-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        dirs.append(d)
        return d
    }

    /// (attributes, value) per data point of `name` after a flush.
    private func points(_ name: String) -> [([String: String], Double)] {
        _ = meterProvider.forceFlush()
        guard let m = metrics.metric(name) else { return [] }
        return m.data.points.map { p in (p.attributes.mapValues { $0.description }, value(p)) }
    }

    private func total(_ name: String) -> Double { points(name).reduce(0) { $0 + $1.1 } }

    struct Setup {
        let otel: KYPInstrumentation
        let client: KeepYourPrompts
        let good: URL
    }

    /// Two folder mirrors: "broken" (a manifest that is not JSON) first, then "snapshot" (v12).
    private func setup(_ settings: KYPInstrumentation.Settings = .init(captureContent: false),
                       brokenIsGood: Bool = false) async throws -> Setup {
        let broken = tempDir(), good = tempDir()
        copyFixture("v12", to: broken)
        if !brokenIsGood { try Data("not json".utf8).write(to: broken.appendingPathComponent("envs/demo/prod.json")) }
        copyFixture("v12", to: good)
        let otel = KYPInstrumentation(tracerProvider: tracerProvider, meterProvider: meterProvider, settings: settings)
        var o = Options(app: "demo")
        o.logLevel = nil
        o.pollInterval = 3600
        o.bundleResourceURL = nil
        o.mirrors = [.directory(broken, name: "broken"), .directory(good, name: "snapshot")]
        o.observers = [otel]
        let client = try await KeepYourPrompts(o)
        otel.attach(client)
        // Folder-only clients poll their folders right after start-up: let that round happen.
        let end = Date().addingTimeInterval(10)
        while total("kyp.refresh.duration") < 2 && Date() < end { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(total("kyp.refresh.duration"), 2)
        return Setup(otel: otel, client: client, good: good)
    }

    private func inLLMSpan<T>(_ body: () throws -> T) rethrows -> (T, SpanData) {
        let span = tracerProvider.get(instrumentationName: "app").spanBuilder(spanName: "llm.call").startSpan()
        let r = try OpenTelemetry.instance.contextProvider.withActiveSpan(span) { try body() }
        span.end()
        return (r, spans.named("llm.call").last!)
    }

    func testAnnotateSetsKypAndGenAIAttributesWithoutContent() async throws {
        let s = try await setup()
        let (meta, span) = try inLLMSpan { try s.otel.annotate("greeting", variables: ["name": "Ada"]) }
        XCTAssertEqual(meta.name, "greeting")
        XCTAssertEqual(span.attributes, [
            "kyp.prompt.name": .string("greeting"), "kyp.prompt.version": .int(4),
            "kyp.prompt.sha256": .string("5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"),
            "kyp.app": .string("demo"), "kyp.env": .string("prod"), "kyp.revision": .int(12),
            "kyp.workspace": .string("acme"), "kyp.source": .string("snapshot"),
            "gen_ai.prompt.name": .string("greeting"), "gen_ai.prompt.version": .string("4"),
        ])
        s.client.close()
    }

    func testCaptureContentAndOpenInference() async throws {
        let s = try await setup(.init(captureContent: true, openInference: true))
        let vars = ["name": "Ada", "company": "Acme"]
        let (_, span) = try inLLMSpan { try s.otel.annotate("greeting", variables: vars) }
        XCTAssertEqual(span.attributes["kyp.prompt.template"], .string(s.client.get("greeting")!))
        XCTAssertEqual(span.attributes["gen_ai.prompt.variable.name"], .string("Ada"))
        XCTAssertEqual(span.attributes["gen_ai.prompt.variable.company"], .string("Acme"))
        XCTAssertEqual(span.attributes["prompt.vendor"], .string("keepyourprompts"))
        XCTAssertEqual(span.attributes["prompt.id"], .string("demo/prod/greeting"))
        XCTAssertEqual(span.attributes["llm.prompt_template.version"], .string("4"))
        XCTAssertEqual(span.attributes["llm.prompt_template.variables"], .string(#"{"company":"Acme","name":"Ada"}"#))
        s.client.close()
    }

    func testStaticAnnotateExplicitSpanAndNoOp() async throws {
        let s = try await setup()
        let span = tracerProvider.get(instrumentationName: "app").spanBuilder(spanName: "explicit").startSpan()
        KYPInstrumentation.annotate(try s.client.meta("triage"), span: span, variables: ["company": "Acme"],
                                    captureContent: false, genAIAttributes: false)
        span.end()
        let a = spans.named("explicit")[0].attributes
        XCTAssertEqual(a["kyp.prompt.version"], .int(7))
        XCTAssertNil(a["gen_ai.prompt.name"])
        XCTAssertFalse(a.keys.contains { $0.hasPrefix("gen_ai.prompt.variable.") })
        // No active span: a no-op; unknown names still throw.
        XCTAssertEqual(try s.otel.annotate("triage").version, 7)
        XCTAssertThrowsError(try s.otel.annotate("nope"))
        s.client.close()
    }

    func testRefreshSpansAndEvents() async throws {
        let s = try await setup()
        copyFixture("v13", to: s.good)
        let llm = tracerProvider.get(instrumentationName: "app").spanBuilder(spanName: "llm.call").startSpan()
        _ = await OpenTelemetry.instance.contextProvider.withActiveSpan(llm) { await s.client.refresh() }
        llm.end()
        copyFixture("tampered-v14", to: s.good)
        await s.client.refresh()

        let all = spans.named("kyp.refresh")
        XCTAssertEqual(all.count, 4)  // start-up, first poll (a fallback), update, tampered
        let start = all[0]
        XCTAssertEqual(start.kind, .internal)
        XCTAssertEqual(start.instrumentationScope.name, "keepyourprompts")
        XCTAssertEqual(start.attributes, [
            "kyp.app": .string("demo"), "kyp.env": .string("prod"), "kyp.refresh.trigger": .string("start"),
            "kyp.refresh.result": .string("updated"), "kyp.revision": .int(12), "kyp.workspace": .string("acme"),
            "kyp.source": .string("snapshot"), "kyp.mirror": .string("snapshot"),
        ])
        XCTAssertEqual(start.events.map(\.name), ["kyp.fallback", "kyp.update"])
        XCTAssertEqual(start.events[0].attributes["error.type"], .string("bad_manifest"))
        XCTAssertNil(start.parentSpanId)

        let update = all[2]
        XCTAssertEqual(update.attributes["kyp.refresh.trigger"], .string("manual"))
        XCTAssertEqual(update.attributes["kyp.revision"], .int(13))
        #if !canImport(os.activity)
            // Task-local context (Linux): the caller's active span follows the `await`. Apple's
            // default os.activity context manager does not reliably do so across suspension points.
            XCTAssertEqual(update.parentSpanId, llm.context.spanId)
        #endif
        XCTAssertEqual(update.events.last?.attributes, [
            "kyp.revision.previous": .int(12), "kyp.revision": .int(13), "kyp.prompts.changed": .int(1),
        ])

        let bad = all[3]
        XCTAssertTrue(bad.events.contains { $0.name == "kyp.hash_mismatch" })
        XCTAssertEqual(bad.attributes["kyp.refresh.result"], .string("failed"))
        XCTAssertEqual(bad.attributes["error.type"], .string("blob_unavailable"))
        XCTAssertNil(bad.attributes["kyp.source"])
        if case .error = bad.status {} else { XCTFail("status \(bad.status)") }
        XCTAssertGreaterThanOrEqual(start.endTime, start.startTime)
        s.client.close()
    }

    func testRefreshMetricsAndGauges() async throws {
        let s = try await setup()
        copyFixture("v13", to: s.good)
        await s.client.refresh()
        copyFixture("tampered-v14", to: s.good)
        await s.client.refresh()

        XCTAssertEqual(total("kyp.refresh.duration"), 4)
        XCTAssertTrue(points("kyp.refresh.duration").contains { p in
            p.0 == ["kyp.app": "demo", "kyp.env": "prod", "kyp.refresh.trigger": "start",
                    "kyp.refresh.result": "updated", "kyp.source": "snapshot"] && p.1 == 1
        })
        XCTAssertEqual(total("kyp.fallbacks"), 5)  // broken x4 + the tampered snapshot
        XCTAssertTrue(points("kyp.fallbacks").contains { p in
            p.0 == ["kyp.app": "demo", "kyp.env": "prod", "kyp.source": "snapshot", "kyp.mirror": "broken",
                    "error.type": "bad_manifest"] && p.1 == 4
        })
        XCTAssertEqual(total("kyp.hash_mismatches"), 1)
        let rev = points("kyp.revision")
        XCTAssertEqual(rev.count, 1)
        XCTAssertEqual(rev.first?.1, 13)
        XCTAssertEqual(rev.first?.0, ["kyp.app": "demo", "kyp.env": "prod"])
        XCTAssertGreaterThanOrEqual(points("kyp.staleness").first?.1 ?? -1, 0)

        XCTAssertThrowsError(try s.client.render("greeting", ["name": "Ada"]))
        XCTAssertThrowsError(try s.client.render("nope"))
        let errs = points("kyp.render.errors").map { [$0.0["kyp.prompt.name"] ?? "", $0.0["error.type"] ?? ""] }
        XCTAssertEqual(Set(errs), [["greeting", "missing_variable"], ["nope", "not_found"]])
        s.client.close()
    }

    func testUneventfulRoundsAreNotTracedUnlessAsked() async throws {
        let s = try await setup(brokenIsGood: true)
        await s.client.refresh()
        XCTAssertEqual(spans.named("kyp.refresh").count, 1)  // the start-up round only
        XCTAssertEqual(total("kyp.refresh.duration"), 3)
        s.client.close()
        s.otel.shutdown()

        resetProviders()
        let t = try await setup(.init(captureContent: false, traceAllRefreshes: true), brokenIsGood: true)
        await t.client.refresh()
        XCTAssertEqual(spans.named("kyp.refresh").map { $0.attributes["kyp.refresh.trigger"]?.description },
                       ["start", "poll", "manual"])
        t.client.close()
    }
}
