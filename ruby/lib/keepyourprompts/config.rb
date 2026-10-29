# frozen_string_literal: true

module KeepYourPrompts
  # Client configuration. Only app is required.
  #
  #   KeepYourPrompts::Config.new(app: "support-bot", delivery_key: ENV["KYP_DELIVERY_KEY"])
  class Config
    DEFAULT_CDN = "https://cdn.keepyourprompts.com/v1/d"
    DEFAULT_ORIGIN = "https://api.keepyourprompts.com/v1/delivery"
    LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, off: 4 }.freeze

    DEFAULTS = {
      app: nil, env: "prod", delivery_key: nil, workspace: nil,
      snapshot_dir: nil, cache_dir: nil, git_mirror: nil, git_token: nil,
      cdn_url: DEFAULT_CDN, origin_url: DEFAULT_ORIGIN,
      mirrors: nil,             # Array<Mirror>: replaces snapshot/CDN/origin/git (the disk cache still applies)
      poll_interval: 30.0,      # seconds, +-10% jitter
      connect_timeout: 2.0, request_timeout: 5.0, startup_timeout: 3.0, max_backoff: 300.0,
      start_empty: false,       # start with no prompts instead of raising Unavailable
      poller: true,             # false: no background thread, call #refresh yourself
      user_agent: "kyp-ruby/#{VERSION}",
      logger: nil,              # anything with #debug/#info/#warn/#error (Logger, Rails.logger); default $stderr
      log_level: :warn
    }.freeze

    ENV_VARS = {
      "KYP_APP" => :app, "KYP_ENV" => :env, "KYP_DELIVERY_KEY" => :delivery_key, "KYP_WORKSPACE" => :workspace,
      "KYP_SNAPSHOT_DIR" => :snapshot_dir, "KYP_CACHE_DIR" => :cache_dir, "KYP_GIT_MIRROR" => :git_mirror,
      "KYP_GIT_TOKEN" => :git_token, "KYP_CDN_URL" => :cdn_url, "KYP_ORIGIN_URL" => :origin_url,
      "KYP_POLL_INTERVAL" => :poll_interval, "KYP_LOG" => :log_level
    }.freeze

    attr_reader(*DEFAULTS.keys)

    # KYP_APP, KYP_ENV, KYP_DELIVERY_KEY, KYP_WORKSPACE, KYP_SNAPSHOT_DIR, KYP_CACHE_DIR, KYP_GIT_MIRROR,
    # KYP_GIT_TOKEN, KYP_CDN_URL, KYP_ORIGIN_URL, KYP_POLL_INTERVAL (seconds), KYP_LOG; keyword
    # arguments win over the environment.
    def self.from_env(env = ENV, **overrides)
      from_env = ENV_VARS.each_with_object({}) do |(var, key), h|
        value = env[var]
        h[key] = value unless value.nil? || value.empty?
      end
      new(**from_env, **overrides.compact)
    end

    def initialize(**opts)
      unknown = opts.keys - DEFAULTS.keys
      raise ArgumentError, "unknown option#{"s" if unknown.size > 1}: #{unknown.join(", ")}" unless unknown.empty?

      DEFAULTS.merge(opts.reject { |_, v| v.nil? || v == "" }).each { |k, v| instance_variable_set(:"@#{k}", v) }
      normalize!
      validate!
      freeze
    end

    def to_h = DEFAULTS.keys.to_h { |k| [k, public_send(k)] }

    private

    def normalize!
      %i[poll_interval connect_timeout request_timeout startup_timeout max_backoff].each do |k|
        instance_variable_set(:"@#{k}", Float(public_send(k)))
      rescue ArgumentError, TypeError
        raise Error, "kyp: #{k} must be a number of seconds"
      end
      %i[app env delivery_key workspace snapshot_dir cache_dir git_mirror git_token].each do |k|
        v = public_send(k)
        instance_variable_set(:"@#{k}", v.to_s.freeze) unless v.nil?
      end
      @log_level = @log_level.to_s.to_sym
      @start_empty = truthy?(@start_empty)
      @poller = truthy?(@poller)
      @mirrors = @mirrors&.map { |m| m.is_a?(Mirror) ? m : Mirror.new(**m.transform_keys(&:to_sym)) }&.freeze
    end

    def validate!
      unless Manifest.slug?(app)
        raise Error, %(kyp: app must be a slug like "support-bot" (got #{app.inspect}); set KYP_APP)
      end
      raise Error, %(kyp: env must be a slug like "prod" (got #{env.inspect})) unless Manifest.slug?(env)
      raise Error, "kyp: log_level must be one of #{LOG_LEVELS.keys.join(", ")}" unless LOG_LEVELS.key?(log_level)
      raise Error, "kyp: timeouts must be positive" unless connect_timeout.positive? && request_timeout.positive?
      raise Error, "kyp: intervals must not be negative" if [poll_interval, startup_timeout,
                                                             max_backoff].any?(&:negative?)
    end

    def truthy?(value) = [true, "true", "1", "yes", "on"].include?(value.is_a?(String) ? value.downcase : value)
  end
end
