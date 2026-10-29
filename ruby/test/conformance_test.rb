# frozen_string_literal: true

require "test_helper"

# The 12 required behaviours of conformance/README.md, against the shared fixtures.
class ConformanceTest < Minitest::Test
  include KYPTest::Network

  GREETING_V4 = "Hello {{name}}, welcome to {{ company }}."
  GREETING_V5 = File.read(File.join(KYPTest.fixture("v13"), "blobs",
                                    "a413e0e86cf132f04fbac888b900733641d384cd0e9b42fd0042cf6942701cf2"))

  # 1. Render
  def test_render_cases
    KYPTest.cases["render"].each do |c|
      mode = c["lenient"] ? :keep : :error
      if c["error"]
        err = assert_raises(KeepYourPrompts::MissingVariable) do
          KeepYourPrompts::Template.render(c["template"], c["vars"], on_missing: mode)
        end
        assert_equal "missing_variable", c["error"]
        assert_equal [c["variable"]], err.names
      else
        assert_equal c["out"], KeepYourPrompts::Template.render(c["template"], c["vars"], on_missing: mode), c.inspect
      end
    end
  end

  # 2. Variables
  def test_variables_cases
    KYPTest.cases["variables"].each do |c|
      assert_equal c["out"], KeepYourPrompts::Template.variables(c["template"])
    end
  end

  # 3. Manifest
  def test_manifest_cases
    KYPTest.cases["manifest"].each do |c|
      file = c["file"] && File.join(KYPTest::CONFORMANCE, c["file"])
      json = file ? File.read(file, encoding: "UTF-8") : JSON.generate(c["json"])
      unless c["valid"]
        assert_raises(KeepYourPrompts::ProtocolError, c["why"]) { KeepYourPrompts::Manifest.parse(json, app: "demo", env: "prod") }
        next
      end
      m = KeepYourPrompts::Manifest.parse(json, app: "demo", env: "prod")
      assert_equal c["prompts"], m.prompts.keys if c["prompts"]

      m.prompts.each_value { |p| assert_kind_of Array, p[:variables] }
    end
  end

  # 4. Hash check
  def test_tampered_blob_is_rejected
    only_tampered = track KeepYourPrompts::Client.new(app: "demo", snapshot_dir: KYPTest.fixture("tampered-v14"),
                                                      start_empty: true, startup_timeout: 0, log_level: :off)

    refute_predicate only_tampered.status, :ready?
    assert_match(/sha256/, only_tampered.status.last_error)

    c = network_client

    assert_equal 12, c.revision
    %w[cdn origin git].each { |r| KYPTest.deploy("tampered-v14", File.join(@tmp, r)) }

    refute c.refresh
    assert_equal 12, c.revision
    assert_equal GREETING_V4, c.get("greeting")
    assert_match(/failed sha256 verification/, c.status.last_error)
  end

  # 5. Start from local
  def test_starts_from_snapshot_without_network
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    c = track KeepYourPrompts::Client.new(app: "demo", snapshot_dir: KYPTest.fixture("v12"), log_level: :off)

    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 0.5
    p = c.prompt("greeting")

    assert_equal 4, p.version
    assert_equal %w[name company], p.variables
    assert_equal "Hello Ana, welcome to Acme.", c.render("greeting", name: "Ana", company: "Acme")
    assert_equal "You are a support agent for Acme. Literal {{braces}} stay.", c.render("triage", company: "Acme")
    assert_equal "Review the diff.", c.get("agents/reviewer")
    assert_equal "", c.get("empty")
    assert_equal "snapshot", c.status.source
    assert_equal ["agents/reviewer", "empty", "greeting", "triage"], c.names
  end

  # 6. Mirror order and fallback
  def test_mirror_order_and_fallback
    c = network_client

    assert_equal "cdn", c.status.source
    assert_equal 0, cdn.stat("origin", "200")

    cdn.down("cdn")

    assert c.refresh
    assert_equal "origin", c.status.source
    assert_includes c.status.last_error, "cdn: HTTP 503"

    cdn.down("origin")

    assert c.refresh
    assert_equal "git", c.status.source
    assert_equal "Bearer ghtok", cdn.stat("git", "auth")
    assert_equal GREETING_V4, c.get("greeting")

    fresh = network_client

    assert_equal "git", fresh.status.source

    cdn.up("cdn")
    cdn.up("origin")

    assert c.refresh
    assert_equal "cdn", c.status.source
    assert_equal "", c.status.last_error
  end

  # 7. Revalidation
  def test_revalidation_sends_if_none_match_and_304_changes_nothing
    c = network_client
    updates = 0
    c.on_update { updates += 1 }

    assert c.refresh
    assert c.refresh
    assert_equal 2, cdn.stat("cdn", "304")
    assert_equal 1, cdn.stat("cdn", "200") - 4, "one manifest 200 (plus 4 blobs) at start-up only"
    assert_equal 12, c.revision
    assert_equal 0, updates
  end

  # 8. Hot update
  def test_hot_update_without_restart_fires_callback_once
    c = network_client(poll_interval: 0.1)
    updates = Queue.new
    c.on_update { |u| updates << u }

    assert_equal 4, c.prompt("greeting").version
    KYPTest.deploy("v13", File.join(@tmp, "cdn"))

    assert(eventually? { c.revision == 13 })
    assert_equal 5, c.prompt("greeting").version
    assert_equal GREETING_V5, c.get("greeting")
    assert(eventually? { cdn.stat("cdn", "304") >= 2 }, "keeps polling")
    assert_equal 1, updates.size
    u = updates.pop

    assert_equal [12, 13, "cdn", ["greeting"]], [u.old_revision, u.new_revision, u.source, u.changed]
  end

  # 9. Stale mirror
  def test_stale_mirror_never_replaces_newer_revision
    c = network_client
    %w[cdn origin git].each do |r|
      FileUtils.rm_rf(File.join(@tmp, r))
      KYPTest.deploy("v11-stale", File.join(@tmp, r))
    end
    c.refresh

    assert_equal 12, c.revision
    assert_equal 4, c.prompt("greeting").version
    assert_includes c.status.last_error, "stale manifest ignored (revision 11 < held 12)"
  end

  # 10. Failures never evict
  def test_failures_never_evict
    c = network_client
    %w[cdn origin git].each { |r| cdn.down(r) }

    refute c.refresh
    sleep 0.05

    assert_equal GREETING_V4, c.get("greeting")
    st = c.status

    assert_predicate st, :ready?
    %w[cdn origin git].each { |r| assert_includes st.last_error, "#{r}: HTTP 503" }
    assert_operator st.stale_for, :>, 0.04
    refute_nil st.last_success
    assert_equal 1, st.mirrors.find { |m| m.name == "cdn" }.consecutive_failures
  end

  # 11. Disk cache
  def test_restarts_from_disk_cache_without_network
    cache = File.join(@tmp, "cache")
    c = network_client(cache_dir: cache)

    assert_equal 12, c.revision
    assert_path_exists File.join(cache, "acme/demo/prod/envs/demo/prod.json")
    blob = "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"

    assert_path_exists File.join(cache, "acme/demo/prod/blobs", blob)
    c.close
    cdn.stop

    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    restarted = track KeepYourPrompts::Client.new(app: "demo", delivery_key: KEY, cdn_url: "http://127.0.0.1:9/v1/d",
                                                  origin_url: "http://127.0.0.1:9/v1/delivery", cache_dir: cache,
                                                  poller: false, log_level: :off)

    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 0.5
    assert_equal GREETING_V4, restarted.get("greeting")
    assert_equal "disk-cache", restarted.status.source
  end

  # 12. Read path: no I/O, many threads at once (while the poller swaps state underneath).
  def test_read_path_no_io_and_thread_safe
    quiet = network_client(poller: false)
    no_io = Object.new
    no_io.define_singleton_method(:get) { |*| raise "I/O on read path" }
    no_io.define_singleton_method(:close) { nil }
    quiet.instance_variable_set(:@http, no_io)
    10_000.times { quiet.get("greeting") && quiet.render("triage", company: "Acme") && quiet.prompt("agents/reviewer") }

    c = network_client(poll_interval: 0.02)
    errors = Queue.new
    stop = false
    readers = Array.new(8) do
      Thread.new do
        until stop
          text = c.get("greeting")
          errors << text unless [GREETING_V4, GREETING_V5].include?(text)
          c.render("greeting", name: "a", company: "b")
          Thread.pass # let the poller (and the test) get the GVL now and then
        end
      rescue StandardError => e
        errors << e
      end
    end
    KYPTest.deploy("v13", File.join(@tmp, "cdn"))

    assert(eventually? { c.revision == 13 })
    sleep 0.1
    stop = true
    readers.each(&:join)

    assert_empty errors
  end
end
