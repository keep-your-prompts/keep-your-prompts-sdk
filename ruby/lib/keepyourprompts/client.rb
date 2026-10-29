# frozen_string_literal: true

require "digest"
require "fileutils"
require "securerandom"

module KeepYourPrompts
  # Reads deployed prompts from memory and keeps them fresh with a background thread.
  #
  #   prompts = KeepYourPrompts::Client.from_env       # KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
  #   prompts.render("triage", company: "Acme")
  #
  # Reads (get, render, prompt) never do I/O and take no lock: the state is a frozen
  # object that the refresher replaces in one assignment.
  class Client # rubocop:disable Metrics/ClassLength
    # Frozen snapshot of everything reads need.
    State = Struct.new(:manifest, :raw, :prompts, :by_sha, keyword_init: true)
    Health = Struct.new(:etag, :failures, :retry_at, :last_error, :last_ok, keyword_init: true)
    private_constant :State, :Health

    @registry = ObjectSpace::WeakMap.new
    @registry_lock = Mutex.new

    class << self
      def from_env(env = ENV, **overrides) = new(Config.from_env(env, **overrides))

      # Called in the child after fork (Process._fork hook): restart pollers, drop sockets.
      def after_fork!
        clients = @registry_lock.synchronize { @registry.keys }
        clients.each(&:after_fork!)
      end

      def register(client)
        @registry_lock.synchronize { @registry[client] = true }
      end
    end

    attr_reader :config

    # Accepts a Config or the same keyword arguments.
    def initialize(config = nil, **opts)
      @config = config || Config.new(**opts)
      @callbacks = [].freeze
      @state = nil
      @source = ""
      @last_error = ""
      @last_success = nil
      @started_at = Time.now
      @stop = false
      init_runtime
      build_mirrors
      load_local
      local = !@state.nil?
      startup_from_network unless local || @mirrors.none? { |_, kind| kind == :http }
      fail_startup unless @state
      # Started from a local copy (or empty): revalidate right away, like the other SDKs.
      start_poller(immediate: local || @state.nil?)
      self.class.register(self)
    end

    # Raw template. Raises NotFound.
    def get(name) = find(name).text

    def try_get(name) = lookup(name)&.text
    def include?(name) = !lookup(name).nil?
    alias key? include?

    # Name, version, sha256, variables and text. Raises NotFound.
    def prompt(name) = find(name)

    # Raises NotFound or MissingVariable. on_missing: :error (default), :keep or :empty.
    def render(name, vars = nil, on_missing: :error, **kwargs)
      Template.render(find(name).text, vars ? vars.merge(kwargs) : kwargs, on_missing: on_missing)
    end

    def names = @state ? @state.prompts.keys : []
    def revision = @state ? @state.manifest.revision : 0

    # Called with an Update on the refresher thread after a new revision is swapped in.
    def on_update(&block)
      raise ArgumentError, "on_update needs a block" unless block

      @callbacks = (@callbacks + [block]).freeze
      self
    end

    # Revalidate now across mirrors, ignoring backoff. Returns true when a mirror answered.
    def refresh
      ensure_poller
      answered, update = @refresh_lock.synchronize { round(ignore_backoff: true) }
      deliver(update)
      answered
    end
    alias refresh_now refresh

    def status
      ensure_poller
      st = @state
      since = @last_success || @started_at
      Status.new(
        ready: !st.nil?, source: @source, revision: revision,
        workspace: st ? st.manifest.workspace : "", deployed_at: st ? st.manifest.deployed_at : "",
        prompt_count: st ? st.prompts.size : 0, last_success: @last_success, last_error: @last_error,
        stale_for: [Time.now - since, 0.0].max, mirrors: mirror_statuses
      ).freeze
    end

    # Stop the background refresher. Reads keep working.
    def close
      @stop = true
      @wake_lock.synchronize { @wake.broadcast }
      t = @poller
      t.join(@config.request_timeout + 1) if t && t != Thread.current
      @poller = nil
      @http.close
      nil
    end

    def closed? = @stop

    def after_fork!
      init_runtime # mutexes and sockets belong to the parent
      @poller = nil
      start_poller unless @stop
    end

    def inspect = "#<#{self.class.name} #{@config.app}/#{@config.env} revision=#{revision} source=#{@source}>"

    private

    def init_runtime
      @pid = Process.pid
      @refresh_lock = Mutex.new
      @wake_lock = Mutex.new
      @wake = ConditionVariable.new
      @http = HTTP.new(connect_timeout: @config.connect_timeout, request_timeout: @config.request_timeout,
                       user_agent: @config.user_agent)
    end

    def lookup(name)
      st = @state
      st && st.prompts[name]
    end

    def find(name)
      st = @state
      prompt = st && st.prompts[name]
      return prompt if prompt

      raise NotFound.new(name, st ? "#{what} revision #{st.manifest.revision}" : "nothing loaded for #{what}")
    end

    def what = "#{@config.app}/#{@config.env}"

    # --- mirrors ----------------------------------------------------------------------

    def build_mirrors
      @mirrors = []
      @cache_idx = nil
      (@config.mirrors || default_mirrors).each do |m|
        add_cache if @cache_idx.nil? && @config.cache_dir && m.http?
        @mirrors << [m, m.http? ? :http : :file]
      end
      add_cache if @cache_idx.nil? && @config.cache_dir
      @mirrors.freeze
      @health = @mirrors.map { Health.new(etag: "", failures: 0, retry_at: 0.0, last_error: "", last_ok: nil) }
      polled = @mirrors.each_index.select { |i| @mirrors[i][1] == :http }
      # No network mirror: poll the folders, so a snapshot kept current by a sidecar is picked up live.
      polled = @mirrors.each_index.select { |i| @mirrors[i][1] == :file } if polled.empty?
      @polled = polled.freeze
      @cache_root = nil
    end

    def default_mirrors
      c = @config
      key = c.delivery_key
      [
        (Mirror.file(c.snapshot_dir, name: "snapshot") if c.snapshot_dir),
        (Mirror.http("#{c.cdn_url.chomp("/")}/#{key}", name: "cdn") if key),
        (Mirror.http("#{c.origin_url.chomp("/")}/#{key}", name: "origin") if key),
        (Mirror.http(c.git_mirror, name: "git", token: c.git_token) if c.git_mirror)
      ].compact
    end

    def add_cache
      @cache_idx = @mirrors.size
      @mirrors << [Mirror.new(name: "disk-cache", url: @config.cache_dir, token: nil), :cache]
    end

    def manifest_path = "envs/#{@config.app}/#{@config.env}.json"

    def fetch(idx, rel, etag = nil)
      mirror, kind = @mirrors[idx]
      case kind
      when :cache then @cache_root ? read_file(File.join(@cache_root, rel)) : [:not_found, nil, nil, "empty"]
      when :file then read_file(File.join(mirror.path, rel))
      else fetch_http(mirror, rel, etag)
      end
    end

    def read_file(path)
      return [:not_found, nil, nil, "no such file"] unless File.file?(path)

      [:ok, File.binread(path), "", nil]
    rescue SystemCallError => e
      [:failed, nil, nil, "cannot read #{File.basename(path)}: #{e.class.name.split("::").last}"]
    end

    def fetch_http(mirror, rel, etag)
      r = @http.get("#{mirror.url.chomp("/")}/#{rel}", etag: etag, token: mirror.token)
      case r.status
      when 200 then [:ok, r.body, r.etag, nil]
      when 304 then [:not_modified, nil, r.etag.empty? ? etag : r.etag, nil]
      when 404 then [:not_found, nil, nil, "HTTP 404"]
      else [:failed, nil, nil, "HTTP #{r.status}"]
      end
    rescue HTTP::Failure => e
      [:failed, nil, nil, redact(e.message)]
    end

    # --- loading ----------------------------------------------------------------------

    # Returns [outcome, new_state, etag, error, missing].
    def try_mirror(idx, cur, use_etag:)
      etag = use_etag && cur ? @health[idx].etag : nil
      kind, body, new_etag, err = fetch(idx, manifest_path, etag)
      return [:unchanged, nil, new_etag, nil, false] if kind == :not_modified
      unless kind == :ok
        return [:failed, nil, nil, kind == :not_found ? "manifest not found (#{err})" : err,
                kind == :not_found]
      end

      man = parse_manifest(body)
      return [:failed, nil, nil, man, false] if man.is_a?(String)

      held = cur&.manifest&.revision
      if held && man.revision < held
        return [:stale, nil, nil, "stale manifest ignored (revision #{man.revision} < held #{held})", false]
      end
      return [:unchanged, nil, new_etag, nil, false] if held && man.revision == held

      state, err = build(idx, man, body, cur)
      state ? [:updated, state, new_etag, nil, false] : [:failed, nil, nil, err, false]
    end

    # A Manifest, or the error message.
    def parse_manifest(body)
      Manifest.parse(body.dup.force_encoding(Encoding::UTF_8), app: @config.app, env: @config.env)
    rescue ProtocolError => e
      "bad manifest: #{e.message}"
    end

    def build(idx, man, raw, cur)
      prompts = {}
      by_sha = {}
      man.prompts.each do |name, mp|
        text = cur&.by_sha&.[](mp[:sha256]) || by_sha[mp[:sha256]]
        unless text
          text, err = resolve_blob(idx, mp[:sha256])
          return [nil, err] unless text
        end
        by_sha[mp[:sha256]] = text
        vars = mp[:variables].empty? ? Template.variables(text).freeze : mp[:variables]
        prompts[name] = Prompt.new(name: name, version: mp[:version], sha256: mp[:sha256], variables: vars,
                                   text: text).freeze
      end
      [State.new(manifest: man, raw: raw.b.freeze, prompts: prompts.freeze, by_sha: by_sha.freeze).freeze, nil]
    end

    # A blob may come from any mirror: disk cache first, then the mirror that served the
    # manifest, then the others. Every copy is verified with SHA-256.
    def resolve_blob(idx, sha)
      errors = []
      [@cache_idx, idx, *@mirrors.each_index].compact.uniq.each do |i|
        next if i != idx && @mirrors[i][1] == :http && in_backoff?(i)

        kind, body, _, err = fetch(i, "blobs/#{sha}")
        unless kind == :ok
          errors << "#{@mirrors[i][0].name}: #{err}" if i == idx
          next
        end
        if Digest::SHA256.hexdigest(body) != sha
          msg = "blob #{sha[0, 12]} failed sha256 verification"
          log(:warn, "#{@mirrors[i][0].name}: #{msg} (discarded)")
          errors << "#{@mirrors[i][0].name}: #{msg}"
          next
        end
        return [body.force_encoding(Encoding::UTF_8).freeze, nil]
      end
      [nil, "blob #{sha[0, 12]} unavailable#{" (#{errors.join("; ")})" unless errors.empty?}"]
    end

    # Start-up step 1: local mirrors only. The highest revision wins; ties go to the earlier mirror.
    def load_local
      locate_cache
      best = nil
      best_idx = nil
      @mirrors.each_index do |i|
        next if @mirrors[i][1] == :http

        outcome, state, _, err, missing = try_mirror(i, best, use_etag: false)
        if outcome == :updated
          best = state
          best_idx = i
        elsif outcome == :failed && !missing
          @health[i].last_error = err
          @last_error = "#{@mirrors[i][0].name}: #{err}"
          log(:warn, @last_error)
        end
      end
      return unless best

      install(best, best_idx)
      write_cache(best) unless best_idx == @cache_idx
    end

    # Start-up step 2: nothing local, so block on the network up to startup_timeout.
    def startup_from_network
      deadline = monotonic + @config.startup_timeout
      delay = 0.1
      loop do
        @refresh_lock.synchronize { round(ignore_backoff: true, deadline: deadline) }
        break if @state || monotonic + delay >= deadline

        sleep delay
        delay = [delay * 2, 1.0].min
      end
    end

    def fail_startup
      err = @last_error.empty? ? "no snapshot or disk cache found and no remote mirror configured" : @last_error
      unless @config.start_empty
        raise Unavailable,
              "kyp: could not load #{what} within #{@config.startup_timeout}s: #{err}"
      end

      log(:warn, "starting empty, will keep trying: #{err}")
    end

    # One refresh round over the polled mirrors, in order. Caller holds @refresh_lock.
    # Returns [answered, update_or_nil].
    def round(ignore_backoff:, deadline: nil)
      locate_cache
      cur = @state
      errors = []
      skipped = []
      result = nil
      @polled.each_with_index do |i, n|
        break if @stop || (n.positive? && deadline && monotonic >= deadline)
        next skipped << i if !ignore_backoff && in_backoff?(i)
        break if (result = apply_attempt(i, cur, errors))
      end
      # Everything we tried failed: give the mirrors in backoff a chance too.
      skipped.each { |i| break if (result = apply_attempt(i, cur, errors)) } unless result || @stop
      finish_round(!result.nil?, errors)
      [!result.nil?, result&.first]
    end

    # Asks mirror i; returns [update_or_nil] when it answered, nil when it did not.
    def apply_attempt(idx, cur, errors)
      name = @mirrors[idx][0].name
      outcome, state, etag, err = try_mirror(idx, cur, use_etag: true)
      case outcome
      when :updated
        @health[idx].etag = etag.to_s
        update = install(state, idx)
        write_cache(state)
        record_ok(idx)
        [update]
      when :unchanged
        @health[idx].etag = etag.to_s if etag && !etag.empty?
        record_ok(idx)
        @source = name if cur
        [nil]
      else
        errors << "#{name}: #{err}"
        outcome == :stale ? @health[idx].last_error = err : record_fail(idx, err)
        nil
      end
    end

    def finish_round(answered, errors)
      @last_success = Time.now if answered
      @last_error = !answered && errors.empty? ? "all mirrors backing off" : errors.join("; ")
      log(:warn, "refresh failed, serving what is held: #{@last_error}") unless answered || @stop
    end

    def install(state, idx)
      old = @state
      before = old ? old.prompts : {}
      changed = state.prompts.keys.reject { |n| before[n]&.sha256 == state.prompts[n].sha256 }
      changed += before.keys - state.prompts.keys
      @state = state # the one atomic publish readers see
      @source = @mirrors[idx][0].name
      return nil unless old

      log(:info, "#{what}: revision #{old.manifest.revision} -> #{state.manifest.revision} from #{@source}")
      Update.new(old_revision: old.manifest.revision, new_revision: state.manifest.revision, source: @source,
                 changed: changed.sort.freeze).freeze
    end

    def deliver(update)
      return unless update

      @callbacks.each do |cb|
        cb.call(update)
      rescue StandardError => e
        log(:error, "on_update callback raised: #{e.class}: #{e.message}")
      end
    end

    def in_backoff?(idx) = @health[idx].retry_at > monotonic

    def record_ok(idx)
      h = @health[idx]
      log(:info, "#{@mirrors[idx][0].name} is answering again") if h.failures.positive?
      h.failures = 0
      h.retry_at = 0.0
      h.last_error = ""
      h.last_ok = Time.now
    end

    def record_fail(idx, err)
      h = @health[idx]
      h.last_error = err
      h.failures += 1
      # Skip the mirror for 0, 1, 3, 7, ... poll intervals, capped at max_backoff.
      wait = [@config.poll_interval * ((1 << [h.failures - 1, 20].min) - 1), @config.max_backoff].min
      h.retry_at = monotonic + (wait * rand(0.9..1.1))
      log(h.failures == 1 ? :warn : :debug, "#{@mirrors[idx][0].name}: #{err}")
    end

    def mirror_statuses
      @mirrors.each_with_index.map do |(m, kind), i|
        h = @health[i]
        MirrorStatus.new(name: m.name, url: redact(kind == :cache ? @config.cache_dir : m.url),
                         consecutive_failures: h.failures, last_error: h.last_error, last_success: h.last_ok).freeze
      end
    end

    # --- poller -----------------------------------------------------------------------

    def start_poller(immediate: false)
      return if !@config.poller || @stop

      @poller = Thread.new { run_poller(immediate) }
      @poller.name = "keepyourprompts-poller" if @poller.respond_to?(:name=)
      @poller.report_on_exception = false
    end

    # Lazy fork check, for runtimes that fork without going through Process._fork.
    def ensure_poller
      return if @pid == Process.pid

      after_fork!
    end

    def run_poller(immediate)
      first = immediate
      until @stop
        unless first
          wait = @config.poll_interval * rand(0.9..1.1)
          @wake_lock.synchronize { @wake.wait(@wake_lock, wait) unless @stop }
        end
        break if @stop

        first = false
        begin
          _, update = @refresh_lock.synchronize { round(ignore_backoff: false) }
          deliver(update)
        rescue StandardError => e
          log(:error, "refresh error: #{e.class}: #{e.message}")
        end
      end
    end

    # --- disk cache: <cache_dir>/<workspace>/<app>/<env>/ in the protocol layout -------

    def cache_root_for(workspace) = File.join(@config.cache_dir, workspace, @config.app, @config.env)

    def locate_cache
      return if @cache_idx.nil? || @cache_root
      return @cache_root = cache_root_for(@config.workspace) if @config.workspace

      best = -1
      Dir.glob(File.join("*", @config.app, @config.env, manifest_path), base: @config.cache_dir).each do |rel|
        m = parse_manifest(File.binread(File.join(@config.cache_dir, rel)))
        next if m.is_a?(String)

        if m.revision > best
          best = m.revision
          @cache_root = cache_root_for(m.workspace)
        end
      rescue SystemCallError
        next
      end
    end

    def write_cache(state)
      return unless @cache_idx

      root = cache_root_for(state.manifest.workspace)
      state.prompts.each_value do |p|
        blob = File.join(root, "blobs", p.sha256)
        atomic_write(blob, p.text) unless File.file?(blob)
      end
      path = File.join(root, manifest_path)
      if File.file?(path)
        existing = File.binread(path)
        return @cache_root = root if existing == state.raw
        return if newer_on_disk?(existing, state)
      end
      atomic_write(path, state.raw)
      @cache_root = root
    rescue SystemCallError, IOError => e
      log(:warn, "disk cache write failed: #{e.message}")
    end

    def newer_on_disk?(existing, state)
      Manifest.parse(existing.dup.force_encoding(Encoding::UTF_8), app: @config.app, env: @config.env)
              .revision > state.manifest.revision
    rescue ProtocolError
      false
    end

    # Temp file, fsync, rename: readers see the old file or the new one, never half.
    def atomic_write(path, data)
      FileUtils.mkdir_p(File.dirname(path))
      tmp = "#{path}.#{Process.pid}.#{SecureRandom.hex(4)}.tmp"
      File.open(tmp, File::WRONLY | File::CREAT | File::EXCL | File::BINARY) do |f|
        f.write(data)
        f.flush
        f.fsync
      end
      File.rename(tmp, path)
    ensure
      FileUtils.rm_f(tmp) if tmp && File.exist?(tmp)
    end

    # --- misc -------------------------------------------------------------------------

    def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    def redact(text)
      key = @config.delivery_key
      return text.to_s if key.nil? || key.size < 8

      text.to_s.gsub(key, "#{key[0, 9]}...")
    end

    def log(level, message)
      return if Config::LOG_LEVELS[level] < Config::LOG_LEVELS[@config.log_level]

      message = redact(message)
      if @config.logger
        @config.logger.public_send(level, "[kyp] #{message}")
      else
        warn "[kyp] #{level}: #{message}"
      end
    rescue StandardError
      nil
    end
  end
end
