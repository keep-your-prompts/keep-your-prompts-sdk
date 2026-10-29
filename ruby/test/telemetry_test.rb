# frozen_string_literal: true

require "test_helper"

# Prompt metadata and the observer hook (protocol/tracing.md), without OpenTelemetry.
class TelemetryTest < Minitest::Test
  # Records what the client reports.
  class Recorder
    attr_reader :refreshes, :render_errors

    def initialize
      @refreshes = []
      @render_errors = []
    end

    def on_refresh(record) = @refreshes << record
    def on_render_error(info) = @render_errors << info
  end

  # Two folder mirrors: "broken" (a manifest that is not JSON) first, then "snapshot" (v12).
  def setup
    @tmp = Dir.mktmpdir("kyp-rb-tel-")
    @broken = File.join(@tmp, "broken")
    FileUtils.mkdir_p(File.join(@broken, "envs", "demo"))
    File.write(File.join(@broken, "envs", "demo", "prod.json"), "not json")
    @good = File.join(@tmp, "good")
    KYPTest.deploy("v12", @good)
    @rec = Recorder.new
    @client = KeepYourPrompts::Client.new(
      app: "demo", log_level: :off, poller: false, observer: @rec,
      mirrors: [KeepYourPrompts::Mirror.file(@broken, name: "broken"), KeepYourPrompts::Mirror.file(@good)]
    )
  end

  def teardown
    @client.close
    FileUtils.rm_rf(@tmp)
  end

  def test_meta_and_render_with_meta
    m = @client.meta("greeting")

    sha = "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"

    assert_equal ["greeting", 4, sha, "demo", "prod", "acme", 12, "snapshot"],
                 [m.name, m.version, m.sha256, m.app, m.env, m.workspace, m.revision, m.source]
    assert_predicate m, :frozen?

    r = @client.render_with_meta("greeting", name: "Ada", company: "Acme")

    assert_equal @client.render("greeting", name: "Ada", company: "Acme"), r.text
    assert_equal m, r.meta
    assert_raises(KeepYourPrompts::NotFound) { @client.meta("nope") }
  end

  def test_attributes_and_metadata_maps
    m = @client.meta("triage")
    attrs = m.attributes

    assert_equal %w[kyp.prompt.name kyp.prompt.version kyp.prompt.sha256 kyp.app kyp.env kyp.revision kyp.workspace
                    kyp.source gen_ai.prompt.name gen_ai.prompt.version].sort, attrs.keys.sort
    assert_equal 7, attrs["kyp.prompt.version"]
    assert_equal "7", attrs["gen_ai.prompt.version"]
    assert_equal "triage", attrs["gen_ai.prompt.name"]
    refute_includes m.attributes(gen_ai: false).keys, "gen_ai.prompt.name"

    flat = %w[kyp_prompt_name kyp_prompt_version kyp_prompt_sha256 kyp_app kyp_env kyp_revision kyp_workspace
              kyp_source]

    assert_equal flat.sort, m.trace_metadata.keys.sort
    assert_equal m.trace_metadata, m.langfuse_metadata
    assert_equal m.trace_metadata, m.langsmith_metadata
    assert_equal 12, m.trace_metadata["kyp_revision"]

    bare = KeepYourPrompts::PromptMeta.new(name: "a", version: 1, sha256: "x", app: "b", env: "c", workspace: "",
                                           revision: 0, source: "")

    refute_includes bare.attributes.keys, "kyp.workspace"
    refute_includes bare.trace_metadata.keys, "kyp_source"
  end

  def test_start_round_with_fallback_and_update
    assert_equal 1, @rec.refreshes.size
    r = @rec.refreshes.first

    assert_equal %w[start updated snapshot snapshot 12 0 acme], [r.trigger, r.result, r.mirror, r.source,
                                                                 r.revision.to_s, r.previous_revision.to_s, r.workspace]
    assert_equal %w[kyp.fallback kyp.update], r.events.map(&:name)
    fb = r.events.first.attributes

    assert_equal %w[broken snapshot bad_manifest], fb.values_at("kyp.mirror", "kyp.source", "error.type")
    assert_equal({ "kyp.revision.previous" => 0, "kyp.revision" => 12, "kyp.prompts.changed" => 4 },
                 r.events.last.attributes)
    assert_kind_of Time, r.start_time
    assert_operator r.duration, :>=, 0
  end

  def test_update_not_modified_and_hash_mismatch
    KYPTest.deploy("v13", @good)

    assert @client.refresh
    r = @rec.refreshes.last

    assert_equal %w[manual updated], [r.trigger, r.result]
    assert_equal 1, r.events.last.attributes["kyp.prompts.changed"]
    assert_equal 12, r.previous_revision

    @client.refresh

    assert_equal "not_modified", @rec.refreshes.last.result

    FileUtils.rm_rf(@good)
    KYPTest.deploy("tampered-v14", @good)

    refute @client.refresh
    r = @rec.refreshes.last

    assert_equal "failed", r.result
    assert_equal "", r.source
    assert_includes r.events.map(&:name), "kyp.hash_mismatch"
    hm = r.events.find { |e| e.name == "kyp.hash_mismatch" }.attributes

    assert_equal %w[snapshot snapshot fcadfa6b70f5b153be065e4f32dc011328b1aff4749fb3b748bba68a60c0838e],
                 hm.values_at("kyp.mirror", "kyp.source", "kyp.blob.sha256")
    assert_equal "blob_unavailable", r.error_type
    assert_equal 13, @client.revision
  end

  def test_render_errors_and_observer_isolation
    assert_raises(KeepYourPrompts::MissingVariable) { @client.render("greeting", name: "Ada") }
    assert_raises(KeepYourPrompts::NotFound) { @client.render_with_meta("nope") }

    assert_equal([%w[greeting missing_variable], %w[nope not_found]],
                 @rec.render_errors.map { |e| [e.name, e.error_type] })

    boom = Object.new
    def boom.on_refresh(_) = raise("boom")
    unsubscribe = @client.add_observer(boom)

    assert @client.refresh
    unsubscribe.call
    extra = Recorder.new
    unsub = @client.add_observer(extra)
    @client.refresh
    unsub.call
    @client.refresh

    assert_equal 1, extra.refreshes.size
  end

  def test_normalize_and_classify
    t = KeepYourPrompts::Telemetry

    assert_equal %w[cache cdn custom snapshot embedded cache],
                 [t.normalize_source("disk-cache", :cache), t.normalize_source("cdn", :http),
                  t.normalize_source("eu", :http), t.normalize_source("local", :file),
                  t.normalize_source("x", :embedded), t.normalize_source("y", :cache)]
    messages = ["HTTP 503", "manifest not found (HTTP 404)", "ReadTimeout: Net::ReadTimeout",
                "ECONNREFUSED: Connection refused", "stale manifest ignored", "weird"]

    assert_equal(%w[http_503 not_found timeout network stale _OTHER], messages.map { |m| t.classify_error(m) })
  end
end
