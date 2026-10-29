# frozen_string_literal: true

module KeepYourPrompts
  # Reads config/keepyourprompts.yml (per-environment, ERB allowed) and
  # config.keepyourprompts, on top of the KYP_* variables. The client itself is built
  # lazily on first use of KeepYourPrompts.client, so Puma/Unicorn workers create it
  # after forking.
  class Railtie < ::Rails::Railtie
    config.keepyourprompts = ActiveSupport::OrderedOptions.new

    initializer "keepyourprompts.configure" do |app|
      opts = app.root.join("config", "keepyourprompts.yml").exist? ? app.config_for(:keepyourprompts).to_h : {}
      opts = opts.merge(app.config.keepyourprompts.to_h).transform_keys(&:to_sym)
      opts[:cache_dir] ||= app.root.join("tmp", "cache", "keepyourprompts").to_s if ENV["KYP_CACHE_DIR"].to_s.empty?
      opts[:logger] ||= Rails.logger
      KeepYourPrompts.configure(**opts)
    end
  end
end
