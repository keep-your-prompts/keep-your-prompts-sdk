# frozen_string_literal: true

$LOAD_PATH.unshift File.expand_path("../lib", __dir__)
require "keepyourprompts"
require "minitest/autorun"
require "fileutils"
require "json"
require "net/http"
require "tmpdir"

module KYPTest
  CONFORMANCE = ENV.fetch("KYP_CONFORMANCE_DIR", File.expand_path("../../conformance", __dir__))

  def self.fixture(name) = File.join(CONFORMANCE, "fixtures", name)
  def self.cases = JSON.parse(File.read(File.join(CONFORMANCE, "cases.json"), encoding: "UTF-8"))

  # Deploy like the server does: blobs first, then the manifest by rename.
  def self.deploy(fixture_name, dest)
    src = fixture(fixture_name)
    FileUtils.mkdir_p([File.join(dest, "blobs"), File.join(dest, "envs", "demo")])
    Dir[File.join(src, "blobs", "*")].each { |b| FileUtils.cp(b, File.join(dest, "blobs")) }
    manifest = File.join(dest, "envs", "demo", "prod.json")
    FileUtils.cp(File.join(src, "envs", "demo", "prod.json"), "#{manifest}.new")
    File.rename("#{manifest}.new", manifest)
  end

  # Runs conformance/fake_cdn.py (Python 3, standard library only).
  class FakeCdn
    attr_reader :port

    def self.python
      %w[python3 python].find { |bin| system("command -v #{bin} >/dev/null 2>&1") }
    end

    def initialize(routes)
      args = routes.flat_map { |name, (prefix, dir)| ["--route", "#{name}:#{prefix}:#{dir}"] }
      @io = IO.popen([self.class.python, File.join(CONFORMANCE, "fake_cdn.py"), *args, { err: File::NULL }])
      line = @io.gets
      raise "fake_cdn.py did not start" unless line =~ /PORT (\d+)/

      @port = Regexp.last_match(1).to_i
    end

    def base = "http://127.0.0.1:#{port}"
    def down(route) = ctl("/__down/#{route}")
    def up(route) = ctl("/__up/#{route}")
    def stat(route, key) = JSON.parse(ctl("/__stats")).dig(route, key)

    def stop
      Process.kill("TERM", @io.pid)
      @io.close
    rescue Errno::ESRCH, IOError
      nil
    end

    private

    def ctl(path) = Net::HTTP.get(URI("#{base}#{path}"))
  end

  # Shared setup: a temp dir, a fake CDN serving copies of v12 under cdn/origin/git routes.
  module Network
    KEY = "kypd_test"

    def setup
      super
      @tmp = Dir.mktmpdir("kyp-rb-")
      @clients = []
    end

    def teardown
      @clients.each(&:close)
      @cdn&.stop
      FileUtils.rm_rf(@tmp)
      super
    end

    def cdn
      @cdn ||= begin
        skip "python3 is not installed: HTTP tests need conformance/fake_cdn.py" unless FakeCdn.python
        %w[cdn origin git].each { |r| KYPTest.deploy("v12", File.join(@tmp, r)) }
        FakeCdn.new("cdn" => ["/v1/d/#{KEY}", File.join(@tmp, "cdn")],
                    "origin" => ["/v1/delivery/#{KEY}", File.join(@tmp, "origin")],
                    "git" => ["/acme/prompts/main/.kyp", File.join(@tmp, "git")])
      end
    end

    def network_client(**opts)
      track KeepYourPrompts::Client.new(
        app: "demo", delivery_key: KEY, cdn_url: "#{cdn.base}/v1/d", origin_url: "#{cdn.base}/v1/delivery",
        git_mirror: "#{cdn.base}/acme/prompts/main/.kyp", git_token: "ghtok",
        poll_interval: 60, max_backoff: 0.5, log_level: :off, **opts
      )
    end

    def track(client)
      @clients << client
      client
    end

    def eventually?(timeout = 5)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
      until yield
        return false if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

        sleep 0.02
      end
      true
    end
  end
end
