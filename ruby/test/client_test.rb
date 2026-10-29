# frozen_string_literal: true

require "test_helper"
require "logger"
require "stringio"

class ClientTest < Minitest::Test
  include KYPTest::Network

  LONG_KEY = "kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f"

  def test_config_from_env_and_validation
    env = { "KYP_APP" => "support-bot", "KYP_ENV" => "staging", "KYP_DELIVERY_KEY" => "kypd_x",
            "KYP_POLL_INTERVAL" => "12.5", "KYP_LOG" => "off", "KYP_CACHE_DIR" => "" }
    c = KeepYourPrompts::Config.from_env(env, env: "prod")

    assert_equal ["support-bot", "prod", "kypd_x", 12.5, :off, nil],
                 [c.app, c.env, c.delivery_key, c.poll_interval, c.log_level, c.cache_dir]
    assert_predicate c, :frozen?
    [{ app: "" }, { app: "Bad" }, { app: "a", env: "x y" }, { app: "a", log_level: :loud },
     { app: "a", poll_interval: "soon" }, { app: "a", request_timeout: 0 }].each do |bad|
      assert_raises(KeepYourPrompts::Error, bad.inspect) { KeepYourPrompts::Config.new(**bad) }
    end
    assert_raises(ArgumentError) { KeepYourPrompts::Config.new(app: "a", nope: 1) }
  end

  def test_not_found_and_nothing_configured
    c = track KeepYourPrompts::Client.new(app: "demo", snapshot_dir: KYPTest.fixture("v12"), log_level: :off)
    err = assert_raises(KeepYourPrompts::NotFound) { c.get("nope") }
    assert_equal "nope", err.name
    assert_equal 'prompt not found: "nope" (demo/prod revision 12)', err.message
    assert_nil c.try_get("nope")
    assert_includes c, "agents/reviewer"

    err = assert_raises(KeepYourPrompts::Unavailable) { KeepYourPrompts::Client.new(app: "demo", log_level: :off) }
    assert_match(/no snapshot or disk cache found/, err.message)
  end

  def test_startup_timeout_and_redaction
    opts = { app: "demo", delivery_key: LONG_KEY, cdn_url: "http://127.0.0.1:9/v1/d",
             origin_url: "http://127.0.0.1:9/v1/delivery", startup_timeout: 0.3, log_level: :off }
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    err = assert_raises(KeepYourPrompts::Unavailable) { KeepYourPrompts::Client.new(**opts) }
    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 2
    refute_includes err.message, LONG_KEY

    c = track KeepYourPrompts::Client.new(**opts, start_empty: true, poller: false)
    st = c.status

    refute_predicate st, :ready?
    st.mirrors.each { |m| refute_includes m.url, LONG_KEY }
    assert_includes st.mirrors.first.url, "kypd_Ab3d..."
    refute_includes c.inspect, LONG_KEY
  end

  def test_start_empty_then_recovers_in_background
    cdn.down("cdn")
    cdn.down("origin")
    cdn.down("git")
    c = network_client(start_empty: true, startup_timeout: 0.2, poll_interval: 0.05)

    refute_predicate c.status, :ready?
    assert_nil c.try_get("greeting")
    cdn.up("origin")

    assert(eventually? { c.try_get("greeting") })
    assert_equal "origin", c.status.source
  end

  def test_failing_mirror_backs_off
    c = network_client(poller: false, poll_interval: 0.1, max_backoff: 10)
    cdn.down("cdn")
    4.times do
      c.send(:round, ignore_backoff: false)
      sleep 0.13
    end
    # Failures 1, 2, 3 were tried (0 and 1 poll intervals of backoff); the 4th round skipped the CDN.
    assert_equal 3, cdn.stat("cdn", "503")
    assert_equal "origin", c.status.source
    cdn.up("cdn")

    assert c.refresh, "refresh ignores backoff"
    assert_equal "cdn", c.status.source
    assert_equal 0, c.status.mirrors.first.consecutive_failures
  end

  def test_snapshot_folder_is_polled_without_network_mirror
    snap = File.join(@tmp, "snap")
    KYPTest.deploy("v12", snap)
    c = track KeepYourPrompts::Client.new(app: "demo", snapshot_dir: snap, poller: false, log_level: :off)
    updates = []
    c.on_update { |u| updates << u.new_revision }
    KYPTest.deploy("v13", snap)

    assert c.refresh
    assert_equal 13, c.revision
    assert_equal [13], updates
  end

  def test_callback_errors_are_logged_not_raised
    out = StringIO.new
    c = network_client(poller: false, logger: Logger.new(out), log_level: :error)
    c.on_update { raise "boom" }
    KYPTest.deploy("v13", File.join(@tmp, "cdn"))

    assert c.refresh
    assert_equal 13, c.revision
    assert_match(/on_update callback raised: RuntimeError: boom/, out.string)
  end

  def test_fork_restarts_poller_in_child
    skip "fork is not available" unless Process.respond_to?(:fork)

    c = network_client(poll_interval: 0.05)

    assert_equal 12, c.revision
    reader, writer = IO.pipe
    pid = fork do
      reader.close
      poller = c.instance_variable_get(:@poller)
      KYPTest.deploy("v13", File.join(@tmp, "cdn"))
      updated = eventually?(5) { c.revision == 13 }
      writer.write(JSON.generate(alive: poller&.alive? || false, updated: updated))
      writer.close
      exit!(0)
    end
    writer.close
    result = JSON.parse(reader.read)
    Process.wait(pid)

    assert result["alive"], "poller re-spawned after fork"
    assert result["updated"], "child picked up the deploy"
  end

  def test_lazy_pid_check_restarts_poller
    c = network_client(poll_interval: 0.05)
    c.instance_variable_set(:@pid, -1) # as if forked without Process._fork
    c.status

    assert_equal Process.pid, c.instance_variable_get(:@pid)
    assert_predicate c.instance_variable_get(:@poller), :alive?
  end

  def test_close_stops_poller_and_reads_keep_working
    c = network_client(poll_interval: 0.05)
    poller = c.instance_variable_get(:@poller)
    c.close

    refute_predicate poller, :alive?
    assert_predicate c, :closed?
    assert_equal 12, c.revision
  end

  def test_module_level_client
    KeepYourPrompts.configure(app: "demo", snapshot_dir: KYPTest.fixture("v12"), log_level: :off)
    first = KeepYourPrompts.client

    assert_same first, KeepYourPrompts.client
    assert_equal "Hello A, welcome to B.", KeepYourPrompts.render("greeting", name: "A", company: "B")
    KeepYourPrompts.configure(app: "demo", snapshot_dir: KYPTest.fixture("v13"), log_level: :off)

    assert_predicate first, :closed?
    assert_equal 13, KeepYourPrompts.client.revision
  ensure
    KeepYourPrompts.configure
  end
end
