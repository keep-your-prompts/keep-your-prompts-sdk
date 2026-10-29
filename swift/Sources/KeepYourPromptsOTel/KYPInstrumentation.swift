import Foundation
import KeepYourPrompts
import OpenTelemetryApi

/// OpenTelemetry for Keep Your Prompts (protocol/tracing.md): `kyp.refresh` spans with events,
/// `kyp.*` metrics and `annotate`, on the OpenTelemetry Swift API (`OpenTelemetryApi`).
///
/// ```swift
/// import KeepYourPrompts
/// import KeepYourPromptsOTel
///
/// let otel = KYPInstrumentation()                       // the registered tracer/meter providers
/// var options = Options.fromEnvironment()
/// options.observers = [otel]                            // so the start-up round is traced too
/// let prompts = try await KeepYourPrompts(options)
/// otel.attach(prompts)                                  // kyp.staleness / kyp.revision gauges
///
/// let r = try prompts.renderWithMeta("triage", ["company": "Acme"])
/// otel.annotate(r)                                      // kyp.* + gen_ai.prompt.* on the active span
/// ```
///
/// **Privacy:** with `captureContent` (or `KYP_OTEL_CAPTURE_CONTENT=true`) `annotate` also records
/// the template and the variable values, which often hold personal data. Off by default.
public final class KYPInstrumentation: TelemetryObserver, @unchecked Sendable {
    /// Instrumentation scope (tracer and meter name), the same in every SDK.
    public static let scope = "keepyourprompts"
    /// Advice for `kyp.refresh.duration` (seconds).
    public static let refreshBuckets: [Double] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

    public struct Settings: Sendable {
        /// Record templates and variable values on annotated spans. `nil`: `KYP_OTEL_CAPTURE_CONTENT`, else off.
        public var captureContent: Bool?
        /// Also set `gen_ai.prompt.name` / `gen_ai.prompt.version` (default `true`).
        public var genAIAttributes = true
        /// Also set `prompt.vendor`, `prompt.id`, `llm.prompt_template.*` (default `false`).
        public var openInference = false
        /// Also export `kyp.refresh` spans for rounds that only confirmed what is held (default `false`).
        public var traceAllRefreshes = false

        public init(captureContent: Bool? = nil, genAIAttributes: Bool = true, openInference: Bool = false,
                    traceAllRefreshes: Bool = false) {
            self.captureContent = captureContent
            self.genAIAttributes = genAIAttributes
            self.openInference = openInference
            self.traceAllRefreshes = traceAllRefreshes
        }
    }

    private let tracer: any Tracer
    private let settings: Settings
    private let capture: Bool
    private let lock = NSLock()
    private var instruments: Instruments
    private weak var client: KeepYourPrompts?
    private var token: ObserverToken?
    private var stopped = false

    /// With the registered providers (`OpenTelemetry.instance`) unless given.
    public init(tracerProvider: (any TracerProvider)? = nil, meterProvider: (any MeterProvider)? = nil,
                settings: Settings = Settings()) {
        let tp = tracerProvider ?? OpenTelemetry.instance.tracerProvider
        tracer = tp.get(instrumentationName: Self.scope, instrumentationVersion: keepYourPromptsVersion)
        self.settings = settings
        capture = settings.captureContent ?? Telemetry.envCaptureContent
        let mp: any MeterProvider = meterProvider ?? OpenTelemetry.instance.meterProvider
        instruments = makeInstruments(mp)
    }

    /// Binds to a client: observes it (unless this instrumentation is in its `observers` option),
    /// registers the `kyp.staleness` and `kyp.revision` gauges and lets `annotate` resolve names.
    /// Holds the client weakly.
    public func attach(_ client: KeepYourPrompts, observe: Bool = false) {
        let attrs: [String: OpenTelemetryApi.AttributeValue] = ["kyp.app": .string(client.app), "kyp.env": .string(client.env)]
        lock.lock()
        self.client = client
        if observe { token = client.addObserver(self) }
        instruments.addGauges(
            staleness: { [weak self, weak client] in
                guard let self, !self.isStopped, let client else { return nil }
                return client.status().staleFor
            },
            revision: { [weak self, weak client] in
                guard let self, !self.isStopped, let client else { return nil }
                return client.revision
            },
            attributes: attrs)
        lock.unlock()
    }

    /// `KYPInstrumentation(...)` attached to (and observing) `client`. The start-up round has
    /// already happened and is not traced; pass the instrumentation in `Options.observers` for that.
    public static func instrument(_ client: KeepYourPrompts, tracerProvider: (any TracerProvider)? = nil,
                                  meterProvider: (any MeterProvider)? = nil,
                                  settings: Settings = Settings()) -> KYPInstrumentation {
        let i = KYPInstrumentation(tracerProvider: tracerProvider, meterProvider: meterProvider, settings: settings)
        i.attach(client, observe: true)
        return i
    }

    /// Stops recording spans and metrics (gauges stop reporting) and unsubscribes.
    public func shutdown() {
        lock.lock()
        stopped = true
        let (c, t) = (client, token)
        token = nil
        lock.unlock()
        if let c, let t { c.removeObserver(t) }
    }

    private var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    // MARK: annotate

    /// Annotates a span (default: the active one) with the prompt `name` of the attached client.
    /// Throws ``KYPError/notFound(_:)`` for an unknown name; nothing else.
    @discardableResult
    public func annotate(_ name: String, span: (any Span)? = nil, variables: [String: String] = [:],
                         captureContent: Bool? = nil) throws -> PromptMeta {
        lock.lock()
        let c = client
        lock.unlock()
        guard let c else { throw KYPError.invalidConfiguration("annotate(name) needs an attached client") }
        let meta = try c.meta(name)
        let cap = captureContent ?? capture
        var template: String?
        if cap, let p = c.prompt(name), p.sha256 == meta.sha256 { template = p.text }
        Self.apply(meta, span: span, capture: cap, template: template, variables: variables,
                   genAI: settings.genAIAttributes, openInference: settings.openInference)
        return meta
    }

    /// Annotates with metadata from `meta` / `renderWithMeta`.
    @discardableResult
    public func annotate(_ meta: PromptMeta, span: (any Span)? = nil, variables: [String: String] = [:],
                         captureContent: Bool? = nil) -> PromptMeta {
        Self.apply(meta, span: span, capture: captureContent ?? capture, template: nil, variables: variables,
                   genAI: settings.genAIAttributes, openInference: settings.openInference)
        return meta
    }

    /// Annotates with the result of `renderWithMeta`.
    @discardableResult
    public func annotate(_ rendered: Rendered, span: (any Span)? = nil, variables: [String: String] = [:],
                         captureContent: Bool? = nil) -> PromptMeta {
        annotate(rendered.meta, span: span, variables: variables, captureContent: captureContent)
    }

    /// Annotates a span (default: the active one) without a client. `template` is recorded as
    /// `kyp.prompt.template` only with content capture on. Never throws; a span that is not
    /// recording is left alone.
    @discardableResult
    public static func annotate(_ meta: PromptMeta, span: (any Span)? = nil, variables: [String: String] = [:],
                                captureContent: Bool? = nil, template: String? = nil, genAIAttributes: Bool = true,
                                openInference: Bool = false) -> PromptMeta {
        apply(meta, span: span, capture: captureContent ?? Telemetry.envCaptureContent, template: template,
              variables: variables, genAI: genAIAttributes, openInference: openInference)
        return meta
    }

    private static func apply(_ meta: PromptMeta, span: (any Span)?, capture: Bool, template: String?,
                              variables: [String: String], genAI: Bool, openInference: Bool) {
        guard let span = span ?? OpenTelemetry.instance.contextProvider.activeSpan, span.isRecording else { return }
        var a = convert(meta.attributes(genAI: genAI))
        if openInference {
            a["prompt.vendor"] = .string("keepyourprompts")
            a["prompt.id"] = .string("\(meta.app)/\(meta.env)/\(meta.name)")
            a["llm.prompt_template.version"] = .string(String(meta.version))
        }
        if capture {
            if let template {
                a["kyp.prompt.template"] = .string(template)
                if openInference { a["llm.prompt_template.template"] = .string(template) }
            }
            for (k, v) in variables { a["gen_ai.prompt.variable.\(k)"] = .string(v) }
            if openInference, !variables.isEmpty,
               let json = try? JSONSerialization.data(withJSONObject: variables, options: [.sortedKeys]) {
                a["llm.prompt_template.variables"] = .string(String(decoding: json, as: UTF8.self))
            }
        }
        span.setAttributes(a)
    }

    // MARK: TelemetryObserver

    public func onRefresh(_ rec: RefreshRecord) {
        if isStopped { return }
        recordMetrics(rec)
        if rec.result == .notModified && rec.events.isEmpty && !settings.traceAllRefreshes { return }
        recordSpan(rec)
    }

    public func onRenderError(_ e: RenderError) {
        if isStopped { return }
        lock.lock()
        defer { lock.unlock() }
        instruments.renderErrors.add(value: 1, attributes: [
            "kyp.app": .string(e.app), "kyp.env": .string(e.env), "kyp.prompt.name": .string(e.name),
            "error.type": .string(e.errorType),
        ])
    }

    private func recordMetrics(_ rec: RefreshRecord) {
        let base: [String: OpenTelemetryApi.AttributeValue] = ["kyp.app": .string(rec.app), "kyp.env": .string(rec.env)]
        var attrs = base
        attrs["kyp.refresh.trigger"] = .string(rec.trigger.rawValue)
        attrs["kyp.refresh.result"] = .string(rec.result.rawValue)
        if !rec.source.isEmpty { attrs["kyp.source"] = .string(rec.source) }
        lock.lock()
        defer { lock.unlock() }
        instruments.duration.record(value: rec.duration, attributes: attrs)
        for e in rec.events {
            func s(_ k: String, _ d: String = "") -> OpenTelemetryApi.AttributeValue { .string(e.attributes[k]?.description ?? d) }
            if e.name == "kyp.fallback" {
                instruments.fallbacks.add(value: 1, attributes: base.merging([
                    "kyp.source": s("kyp.source"), "kyp.mirror": s("kyp.mirror"), "error.type": s("error.type", "_OTHER"),
                ]) { $1 })
            } else if e.name == "kyp.hash_mismatch" {
                instruments.mismatches.add(value: 1, attributes: base.merging([
                    "kyp.source": s("kyp.source"), "kyp.mirror": s("kyp.mirror"),
                ]) { $1 })
            }
        }
    }

    private func recordSpan(_ rec: RefreshRecord) {
        let b = tracer.spanBuilder(spanName: "kyp.refresh").setSpanKind(spanKind: .internal).setStartTime(time: rec.startTime)
        // A manual refresh is a child of the caller's active span; start-up and polls are roots.
        if rec.trigger == .manual, let parent = OpenTelemetry.instance.contextProvider.activeSpan {
            b.setParent(parent)
        } else {
            b.setNoParent()
        }
        var attrs: [String: OpenTelemetryApi.AttributeValue] = [
            "kyp.app": .string(rec.app), "kyp.env": .string(rec.env),
            "kyp.refresh.trigger": .string(rec.trigger.rawValue), "kyp.refresh.result": .string(rec.result.rawValue),
        ]
        if rec.revision > 0 { attrs["kyp.revision"] = .int(rec.revision) }
        if !rec.workspace.isEmpty { attrs["kyp.workspace"] = .string(rec.workspace) }
        if !rec.source.isEmpty {
            attrs["kyp.source"] = .string(rec.source)
            attrs["kyp.mirror"] = .string(rec.mirror)
        }
        if rec.result == .failed { attrs["error.type"] = .string(rec.errorType.isEmpty ? "_OTHER" : rec.errorType) }
        for (k, v) in attrs { b.setAttribute(key: k, value: v) }
        let span = b.startSpan()
        for e in rec.events { span.addEvent(name: e.name, attributes: Self.convert(e.attributes), timestamp: e.time) }
        if rec.result == .failed { span.status = .error(description: String(rec.error.prefix(500))) }
        span.end(time: rec.startTime.addingTimeInterval(rec.duration))
    }

    private static func convert(_ a: [String: TelemetryValue]) -> [String: OpenTelemetryApi.AttributeValue] {
        a.mapValues { v in
            switch v {
            case .string(let s): return .string(s)
            case .int(let i): return .int(i)
            }
        }
    }
}

// MARK: - instruments (the metrics API uses associated types: open the existentials generically)

final class Instruments {
    var duration: any DoubleHistogram
    var fallbacks: any LongCounter
    var mismatches: any LongCounter
    var renderErrors: any LongCounter
    let addGauges: (_ staleness: @escaping () -> Double?, _ revision: @escaping () -> Int?,
                    _ attributes: [String: OpenTelemetryApi.AttributeValue]) -> Void

    init<M: Meter>(meter: M) {
        duration = meter.histogramBuilder(name: "kyp.refresh.duration")
            .setExplicitBucketBoundariesAdvice(KYPInstrumentation.refreshBuckets).build()
        fallbacks = meter.counterBuilder(name: "kyp.fallbacks").build()
        mismatches = meter.counterBuilder(name: "kyp.hash_mismatches").build()
        renderErrors = meter.counterBuilder(name: "kyp.render.errors").build()
        // The observable gauges stay registered while this closure (and so `keep`) lives.
        var keep: [Any] = []
        addGauges = { staleness, revision, attributes in
            keep.append(meter.gaugeBuilder(name: "kyp.staleness").buildWithCallback { m in
                if let v = staleness() { m.record(value: v, attributes: attributes) }
            })
            // A double gauge: the Swift SDK (opentelemetry-swift-core 2.x) records observable long
            // gauges as doubles and then reports 0.
            keep.append(meter.gaugeBuilder(name: "kyp.revision").buildWithCallback { m in
                if let v = revision() { m.record(value: Double(v), attributes: attributes) }
            })
        }
    }

    func addGauges(staleness: @escaping () -> Double?, revision: @escaping () -> Int?,
                   attributes: [String: OpenTelemetryApi.AttributeValue]) {
        addGauges(staleness, revision, attributes)
    }
}

private func makeInstruments<P: MeterProvider>(_ provider: P) -> Instruments {
    let meter = provider.meterBuilder(name: KYPInstrumentation.scope)
        .setInstrumentationVersion(instrumentationVersion: keepYourPromptsVersion).build()
    return Instruments(meter: meter)
}
