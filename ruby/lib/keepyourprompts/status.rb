# frozen_string_literal: true

module KeepYourPrompts
  # One copy of a workspace in the protocol layout (envs/<app>/<env>.json, blobs/<sha256>).
  # url: a directory, file:///dir or http(s)://host/base. token: sent as Authorization: Bearer.
  Mirror = Struct.new(:name, :url, :token, keyword_init: true) do
    def self.file(dir, name: "snapshot") = new(name: name, url: dir.to_s, token: nil)
    def self.http(base_url, name:, token: nil) = new(name: name, url: base_url, token: token)

    def http? = url.match?(%r{\Ahttps?://}i)
    def path = url.start_with?("file://") ? URI.decode_www_form_component(url.delete_prefix("file://")) : url
  end

  # Passed to on_update callbacks after a new revision was swapped in.
  Update = Struct.new(:old_revision, :new_revision, :source, :changed, keyword_init: true)

  # Per-mirror health in Status#mirrors. url has the delivery key redacted.
  MirrorStatus = Struct.new(:name, :url, :consecutive_failures, :last_error, :last_success, keyword_init: true)

  # Health of the client, for logs, metrics and health checks.
  #   ready        a manifest is loaded
  #   source       mirror that served or last confirmed the state: snapshot, disk-cache, cdn, origin, git
  #   last_success last time a polled mirror confirmed the manifest (200 or 304), a Time or nil
  #   last_error   failures in the latest round, e.g. "cdn: HTTP 503"; empty when the first mirror answered
  #   stale_for    seconds since last_success (since start-up if never). Alert on this.
  Status = Struct.new(:ready, :source, :revision, :workspace, :deployed_at, :prompt_count,
                      :last_success, :last_error, :stale_for, :mirrors, keyword_init: true) do
    alias_method :ready?, :ready

    def to_h
      super.merge(mirrors: mirrors.map(&:to_h))
    end
  end
end
