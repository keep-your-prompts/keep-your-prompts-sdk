# frozen_string_literal: true

require "test_helper"

begin
  require "opentelemetry/sdk"
  require "opentelemetry-metrics-sdk"
  require "keepyourprompts/otel"
  KYP_OTEL_AVAILABLE = true
rescue LoadError
  KYP_OTEL_AVAILABLE = false
end

# The optional OpenTelemetry add-on, against the SDK's in-memory exporters (protocol/tracing.md,
# conformance checklist).
class OTelTest < Minitest::Test
  def setup
    skip "opentelemetry-sdk / opentelemetry-metrics-sdk not installed" unless KYP_OTEL_AVAILABLE
    @spans = OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new
    @tracer_provider = OpenTelemetry::SDK::Trace::TracerProvider.new
    @tracer_provider.add_span_processor(OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(@spans))
    @metrics = OpenTelemetry::SDK::Metrics::Export::InMemoryMetricPullExporter.new
    @meter_provider = OpenTelemetry::SDK::Metrics::MeterProvider.new
    @meter_provider.add_metric_reader(@metrics)
    @app_tracer = @tracer_provider.tracer("app")

    @tmp = Dir.mktmpdir("kyp-rb-otel-")
    @broken = File.join(@tmp, "broken")
    FileUtils.mkdir_p(File.join(@broken, "envs", "demo"))
    File.write(File.join(@broken, "envs", "demo", "prod.json"), "not json")
    @good = File.join(@tmp, "good")
    KYPTest.deploy("v12", @good)
  end

  def teardown
    @otel&.shutdown
    @client&.close
    FileUtils.rm_rf(@tmp) if @tmp
  end

  def start(**otel_options)
    @otel = KeepYourPrompts::OTel.instrument(tracer_provider: @tracer_provider, meter_provider: @meter_provider,
                                             **otel_options)
    @client = KeepYourPrompts::Client.new(
      app: "demo", log_level: :off, poller: false, observer: @otel,
      mirrors: [KeepYourPrompts::Mirror.file(@broken, name: "broken"), KeepYourPrompts::Mirror.file(@good)]
    )
    @otel.attach(@client)
  end

  def in_llm_span(&)
    span = @app_tracer.start_span("llm.call")
    OpenTelemetry::Trace.with_span(span, &)
  ensure
    span.finish
  end

  def llm_span = @spans.finished_spans.find { |s| s.name == "llm.call" }
  def refresh_spans = @spans.finished_spans.select { |s| s.name == "kyp.refresh" }

  def metric(name)
    @metrics.pull
    @metrics.metric_snapshots.reverse.find { |m| m.name == name }
  end

  def test_annotate_sets_kyp_and_gen_ai_attributes_without_content
    start
    meta = nil
    in_llm_span { meta = @otel.annotate("greeting", variables: { "name" => "Ada" }) }
    a = llm_span.attributes

    assert_equal "greeting", meta.name
    assert_equal({ "kyp.prompt.name" => "greeting", "kyp.prompt.version" => 4,
                   "kyp.prompt.sha256" => "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d",
                   "kyp.app" => "demo", "kyp.env" => "prod", "kyp.revision" => 12, "kyp.workspace" => "acme",
                   "kyp.source" => "snapshot", "gen_ai.prompt.name" => "greeting", "gen_ai.prompt.version" => "4" }, a)
  end

  def test_capture_content_and_open_inference
    start(capture_content: true, open_inference: true)
    rendered = @client.render_with_meta("greeting", name: "Ada", company: "Acme")
    in_llm_span { @otel.annotate(rendered, variables: { name: "Ada", company: "Acme" }) }
    a = llm_span.attributes

    assert_equal @client.get("greeting"), a["kyp.prompt.template"]
    assert_equal %w[Ada Acme], a.values_at("gen_ai.prompt.variable.name", "gen_ai.prompt.variable.company")
    assert_equal %w[keepyourprompts demo/prod/greeting 4],
                 a.values_at("prompt.vendor", "prompt.id", "llm.prompt_template.version")
    assert_equal({ "name" => "Ada", "company" => "Acme" }, JSON.parse(a["llm.prompt_template.variables"]))
  end

  def test_free_annotate_explicit_span_and_env_capture
    start(gen_ai_attributes: false)
    span = @app_tracer.start_span("explicit")
    KeepYourPrompts::OTel.annotate(@client.meta("triage"), span: span, gen_ai_attributes: false,
                                                           variables: { "company" => "Acme" })
    span.finish
    a = @spans.finished_spans.find { |s| s.name == "explicit" }.attributes

    assert_equal 7, a["kyp.prompt.version"]
    refute_includes a.keys, "gen_ai.prompt.name"
    refute(a.keys.any? { |k| k.start_with?("gen_ai.prompt.variable.") })

    ENV["KYP_OTEL_CAPTURE_CONTENT"] = "true"
    span = @app_tracer.start_span("env")
    KeepYourPrompts::OTel.annotate(@client.meta("triage"), span: span, variables: { "company" => "Acme" })
    span.finish

    assert_equal "Acme", @spans.finished_spans.last.attributes["gen_ai.prompt.variable.company"]
  ensure
    ENV.delete("KYP_OTEL_CAPTURE_CONTENT")
  end

  def test_annotate_is_a_no_op_without_a_recording_span
    start
    meta = @otel.annotate("triage") # no active span: the invalid span is not recording

    assert_equal 7, meta.version
    assert_raises(KeepYourPrompts::NotFound) { @otel.annotate("nope") }
  end

  # Start-up (a failing first mirror, then an update), a hot update, then a tampered blob.
  def run_scenario
    start
    KYPTest.deploy("v13", @good)
    in_llm_span { @client.refresh }
    FileUtils.rm_rf(@good)
    KYPTest.deploy("tampered-v14", @good)
    @client.refresh
  end

  def test_refresh_spans_and_events
    run_scenario
    first = refresh_spans.first

    assert_equal "kyp.refresh", first.name
    assert_equal :internal, first.kind
    assert_equal({ "kyp.app" => "demo", "kyp.env" => "prod", "kyp.refresh.trigger" => "start",
                   "kyp.refresh.result" => "updated", "kyp.revision" => 12, "kyp.workspace" => "acme",
                   "kyp.source" => "snapshot", "kyp.mirror" => "snapshot" }, first.attributes)
    assert_equal %w[kyp.fallback kyp.update], first.events.map(&:name)
    assert_equal "bad_manifest", first.events.first.attributes["error.type"]

    # Update: a manual refresh is a child of the caller's span.
    upd = refresh_spans[1]

    assert_equal %w[manual updated 13], upd.attributes.values_at("kyp.refresh.trigger", "kyp.refresh.result",
                                                                 "kyp.revision").map(&:to_s)
    assert_equal llm_span.span_id, upd.parent_span_id
    assert_equal({ "kyp.revision.previous" => 12, "kyp.revision" => 13, "kyp.prompts.changed" => 1 },
                 upd.events.last.attributes)

    # Tampered blob: hash mismatch, failed round with ERROR status.
    bad = refresh_spans[2]

    assert_includes bad.events.map(&:name), "kyp.hash_mismatch"
    assert_equal %w[failed blob_unavailable], bad.attributes.values_at("kyp.refresh.result", "error.type")
    assert_equal OpenTelemetry::Trace::Status::ERROR, bad.status.code
    refute_includes bad.attributes.keys, "kyp.source"
  end

  def test_refresh_metrics
    run_scenario
    duration = metric("kyp.refresh.duration")

    assert_equal "s", duration.unit
    assert_equal 3, duration.data_points.sum(&:count)
    assert_equal(%w[start updated snapshot],
                 duration.data_points.first.attributes.values_at("kyp.refresh.trigger", "kyp.refresh.result",
                                                                 "kyp.source"))
    fallbacks = metric("kyp.fallbacks").data_points

    assert_equal 4, fallbacks.sum(&:value) # broken x3 + the tampered snapshot
    assert_equal %w[demo prod snapshot broken bad_manifest],
                 fallbacks.first.attributes.values_at("kyp.app", "kyp.env", "kyp.source", "kyp.mirror", "error.type")
    assert_equal 1, metric("kyp.hash_mismatches").data_points.sum(&:value)
    assert_equal 13, metric("kyp.revision").data_points.first.value
    assert_operator metric("kyp.staleness").data_points.first.value, :>=, 0
    assert_equal({ "kyp.app" => "demo", "kyp.env" => "prod" }, metric("kyp.staleness").data_points.first.attributes)
  end

  def test_uneventful_rounds_are_not_traced_unless_asked
    File.write(File.join(@broken, "envs", "demo", "prod.json"), File.read(File.join(@good, "envs", "demo",
                                                                                    "prod.json")))
    FileUtils.cp_r(File.join(@good, "blobs"), @broken)
    start
    @client.refresh

    assert_equal 1, refresh_spans.size # the start-up round only
    assert_equal 2, metric("kyp.refresh.duration").data_points.sum(&:count)

    @otel.shutdown
    @client.close
    @spans.reset
    start(trace_all_refreshes: true)
    @client.refresh

    assert_equal(%w[start manual], refresh_spans.map { |s| s.attributes["kyp.refresh.trigger"] })
    assert_equal "not_modified", refresh_spans.last.attributes["kyp.refresh.result"]
  end

  def test_render_errors_metric
    start
    assert_raises(KeepYourPrompts::MissingVariable) { @client.render("greeting", name: "Ada") }
    assert_raises(KeepYourPrompts::NotFound) { @client.render("nope") }
    points = metric("kyp.render.errors").data_points.map { |p| p.attributes.values_at("kyp.prompt.name", "error.type") }

    assert_equal [%w[greeting missing_variable], %w[nope not_found]], points.sort
  end
end
