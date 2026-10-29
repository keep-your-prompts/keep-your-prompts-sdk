# frozen_string_literal: true

module KeepYourPrompts
  # Which deployed body a call used: the prompt metadata of protocol/tracing.md. Read from memory
  # (Client#meta, Client#render_with_meta); no dependency on OpenTelemetry or any vendor SDK.
  #
  #   meta = prompts.meta("triage")
  #   span.add_attributes(meta.attributes)                    # kyp.* + gen_ai.prompt.*
  #   Langfuse.update_current_generation(metadata: meta.langfuse_metadata)
  PromptMeta = Struct.new(:name, :version, :sha256, :app, :env, :workspace, :revision, :source,
                          keyword_init: true) do
    # Span attributes: kyp.* plus gen_ai.prompt.name / gen_ai.prompt.version (a string), unless
    # gen_ai: false. kyp.workspace and kyp.source are left out when empty. No content, ever.
    def attributes(gen_ai: true)
      a = {
        "kyp.prompt.name" => name, "kyp.prompt.version" => version, "kyp.prompt.sha256" => sha256,
        "kyp.app" => app, "kyp.env" => env, "kyp.revision" => revision
      }
      a["kyp.workspace"] = workspace unless workspace.to_s.empty?
      a["kyp.source"] = source unless source.to_s.empty?
      if gen_ai
        a["gen_ai.prompt.name"] = name
        a["gen_ai.prompt.version"] = version.to_s
      end
      a
    end

    # Flat kyp_* keys (dots replaced by underscores) for any tool's free-form metadata.
    def trace_metadata = attributes(gen_ai: false).transform_keys { |k| k.tr(".", "_") }

    # The same map, for Langfuse (metadata: of an observation).
    def langfuse_metadata = trace_metadata

    # The same map, for LangSmith (traceable metadata:).
    def langsmith_metadata = trace_metadata
  end

  # What Client#render_with_meta returns: the rendered text and the metadata of the body used.
  Rendered = Struct.new(:text, :meta, keyword_init: true) do
    def to_s = text
  end

  # Delivery telemetry types and helpers (protocol/tracing.md, "SDK architecture").
  module Telemetry
    SOURCES = %w[embedded snapshot cache cdn origin git].freeze

    # A span event recorded during a refresh round: kyp.fallback, kyp.hash_mismatch or kyp.update.
    # time is a wall-clock Time.
    Event = Struct.new(:name, :time, :attributes, keyword_init: true)

    # Passed to an observer's on_refresh after each refresh round.
    #   trigger: "start" | "poll" | "manual"; result: "updated" | "not_modified" | "failed"
    #   start_time: Time (wall clock); duration: seconds (Float)
    #   mirror/source: the mirror that answered ("" when failed)
    #   error/error_type: when failed (delivery key redacted)
    RefreshRecord = Struct.new(:app, :env, :trigger, :result, :start_time, :duration, :mirror, :source,
                               :revision, :previous_revision, :workspace, :error, :error_type, :events,
                               keyword_init: true)

    # Passed to an observer's on_render_error. error_type: "not_found" or "missing_variable".
    RenderError = Struct.new(:app, :env, :name, :error_type, keyword_init: true)

    module_function

    # A mirror's configured name and kind (:http, :file, :cache, :embedded) to kyp.source.
    def normalize_source(name, kind)
      return "" if name.nil? || name.empty?
      return "cache" if name == "disk-cache"
      return name if SOURCES.include?(name)

      case kind
      when :embedded then "embedded"
      when :cache then "cache"
      when :file then "snapshot"
      else "custom"
      end
    end

    # A failure message to a low-cardinality error.type.
    def classify_error(message)
      m = message.to_s.downcase
      return "blob_unavailable" if m.match?(/blob \S+ unavailable/)
      return "hash_mismatch" if m.include?("sha256 verification") || m.include?("hash mismatch")
      return "stale" if m.include?("stale manifest")
      return "bad_manifest" if m.include?("bad manifest") || m.include?("invalid manifest")
      return "not_found" if m.match?(/http (404|410)\b/) || m.include?("not found") || m.include?("no such file")

      if (http = m.match(/http (\d{3})\b/))
        return "http_#{http[1]}"
      end
      return "timeout" if m.match?(/timed out|timeout|deadline/)
      return "network" if m.match?(/econn|refused|reset|unreachable|resolve|getaddrinfo|network|socket|connection/)

      "_OTHER"
    end
  end
end
