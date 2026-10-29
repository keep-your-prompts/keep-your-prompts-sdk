# frozen_string_literal: true

# OpenTelemetry for Keep Your Prompts (protocol/tracing.md). Optional: the gem itself never loads
# this file and has no dependency on OpenTelemetry. Require it explicitly, with opentelemetry-api
# (and opentelemetry-metrics-api for metrics) in your bundle:
#
#   require "keepyourprompts/otel"
#   otel = KeepYourPrompts::OTel.instrument(prompts)   # kyp.refresh spans + kyp.* metrics
#   otel.annotate("triage")                            # kyp.* + gen_ai.prompt.* on the current span
require "json"
require "keepyourprompts"

begin
  require "opentelemetry"
rescue LoadError
  raise LoadError, 'keepyourprompts/otel needs the opentelemetry-api gem: add gem "opentelemetry-api" ' \
                   '(or "opentelemetry-sdk") to your Gemfile'
end

begin
  require "opentelemetry-metrics-api"
rescue LoadError
  nil # metrics are optional: spans and annotate work without them
end

module KeepYourPrompts
  # OpenTelemetry add-on: kyp.refresh spans, kyp.* metrics and the annotate helper.
  module OTel
    # Instrumentation scope (tracer and meter name), the same in every SDK.
    SCOPE = "keepyourprompts"
    # Advice for kyp.refresh.duration (seconds).
    REFRESH_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10].freeze

    module_function

    # Annotate a span (default: the current one) with a prompt's metadata, without a client.
    # prompt is a PromptMeta or a Rendered. template and variables are recorded only with content
    # capture on (capture_content: true or KYP_OTEL_CAPTURE_CONTENT=true). Returns the PromptMeta.
    # Never raises for telemetry reasons.
    def annotate(prompt, span: nil, variables: nil, capture_content: nil, template: nil, # rubocop:disable Metrics/ParameterLists
                 gen_ai_attributes: true, open_inference: false)
      meta = prompt.is_a?(Rendered) ? prompt.meta : prompt
      apply(meta, span || OpenTelemetry::Trace.current_span,
            capture: capture_content.nil? ? env_capture? : capture_content, template: template,
            variables: variables, gen_ai: gen_ai_attributes, open_inference: open_inference)
      meta
    end

    # Record kyp.refresh spans and kyp.* metrics for a client, and annotate LLM spans.
    #
    # Options: tracer_provider:, meter_provider: (default: the global ones), capture_content:
    # (default false, or KYP_OTEL_CAPTURE_CONTENT), gen_ai_attributes: (default true),
    # open_inference: (default false), trace_all_refreshes: (default false).
    #
    # PRIVACY: capture_content records prompt templates and variable values, which often hold
    # personal data, on the spans you annotate. See the README before turning it on.
    #
    # Without a client, returns an Instrumentation to pass as the client's observer: option, so the
    # start-up round is traced too; call #attach(client) once the client exists.
    #
    #   otel = KeepYourPrompts::OTel.instrument
    #   prompts = KeepYourPrompts::Client.from_env(observer: otel)
    #   otel.attach(prompts)
    def instrument(client = nil, **options)
      i = Instrumentation.new(**options)
      client ? i.attach(client) : i
    end

    def env_capture?
      %w[1 true yes on].include?(ENV.fetch("KYP_OTEL_CAPTURE_CONTENT", "").strip.downcase)
    end

    # @api private
    def apply(meta, span, capture:, template:, variables:, gen_ai:, open_inference:) # rubocop:disable Metrics
      return unless span&.recording?

      a = meta.attributes(gen_ai: gen_ai)
      if open_inference
        a["prompt.vendor"] = "keepyourprompts"
        a["prompt.id"] = "#{meta.app}/#{meta.env}/#{meta.name}"
        a["llm.prompt_template.version"] = meta.version.to_s
      end
      if capture
        unless template.nil?
          a["kyp.prompt.template"] = template
          a["llm.prompt_template.template"] = template if open_inference
        end
        if variables
          vars = variables.to_h { |k, v| [k.to_s, v.is_a?(String) ? v : stringify(v)] }
          vars.each { |k, v| a["gen_ai.prompt.variable.#{k}"] = v }
          a["llm.prompt_template.variables"] = JSON.generate(vars) if open_inference
        end
      end
      span.add_attributes(a)
    rescue StandardError
      nil # telemetry never breaks the app
    end

    # @api private
    def stringify(value)
      case value
      when nil then ""
      when Hash, Array then JSON.generate(value)
      else value.to_s
      end
    rescue StandardError
      value.to_s
    end

    # What OTel.instrument returns.
    class Instrumentation # rubocop:disable Metrics/ClassLength
      attr_reader :client

      def initialize(tracer_provider: nil, meter_provider: nil, capture_content: nil, # rubocop:disable Metrics/ParameterLists
                     gen_ai_attributes: true, open_inference: false, trace_all_refreshes: false)
        @client = nil
        @capture = capture_content.nil? ? OTel.env_capture? : capture_content
        @gen_ai = gen_ai_attributes
        @open_inference = open_inference
        @trace_all = trace_all_refreshes
        @tracer = (tracer_provider || OpenTelemetry.tracer_provider).tracer(SCOPE, KeepYourPrompts::VERSION)
        setup_metrics(meter_provider)
      end

      # Bind to a client: observe it (unless it already has this as its observer: option),
      # register the kyp.staleness and kyp.revision gauges, and let #annotate take prompt names.
      def attach(client)
        raise KeepYourPrompts::Error, "kyp: this instrumentation is already attached to a client" if @client

        @client = client
        @unsubscribe = client.add_observer(self) unless client.config.observer.equal?(self)
        setup_gauges
        self
      end

      # Annotate a span (default: the current one) with the prompt used: a name, PromptMeta or
      # Rendered. Returns the PromptMeta. An unknown name raises NotFound like Client#meta.
      def annotate(prompt, span: nil, variables: nil, capture_content: nil)
        meta = case prompt
               when String
                 raise KeepYourPrompts::Error, "kyp: annotate(name) needs instrument(client)" unless @client

                 @client.meta(prompt)
               when Rendered then prompt.meta
               else prompt
               end
        capture = capture_content.nil? ? @capture : capture_content
        OTel.apply(meta, span || OpenTelemetry::Trace.current_span,
                   capture: capture, template: capture ? template_of(meta) : nil, variables: variables,
                   gen_ai: @gen_ai, open_inference: @open_inference)
        meta
      end

      # Stop recording spans and metrics for this client.
      def shutdown
        @unsubscribe&.call
        @unsubscribe = nil
        @stopped = true
        @gauges&.each do |g, cb|
          g.unregister(cb) if g.respond_to?(:unregister)
        end
        nil
      end

      # Observer hook (called by the client).
      def on_refresh(rec)
        return if @stopped

        record_metrics(rec)
        return if rec.result == "not_modified" && rec.events.empty? && !@trace_all

        record_span(rec)
      rescue StandardError
        nil
      end

      # Observer hook (called by the client).
      def on_render_error(info)
        return if @stopped

        @render_errors&.add(1, attributes: base(info).merge("kyp.prompt.name" => info.name,
                                                            "error.type" => info.error_type))
      rescue StandardError
        nil
      end

      private

      # Only the template of the very body the metadata names.
      def template_of(meta)
        held = @client&.try_get(meta.name) && @client.prompt(meta.name)
        held.text if held && held.sha256 == meta.sha256
      rescue KeepYourPrompts::Error
        nil
      end

      def base(rec) = { "kyp.app" => rec.app, "kyp.env" => rec.env }

      def setup_metrics(meter_provider)
        provider = meter_provider || (OpenTelemetry.respond_to?(:meter_provider) ? OpenTelemetry.meter_provider : nil)
        return unless provider

        @meter = meter = provider.meter(SCOPE, version: KeepYourPrompts::VERSION)
        @duration = meter.create_histogram(
          "kyp.refresh.duration", unit: "s", description: "Wall time of each prompt refresh round.",
                                  advisory: { explicit_bucket_boundaries: REFRESH_BUCKETS }
        )
        @fallbacks = meter.create_counter(
          "kyp.fallbacks", unit: "{fallback}", description: "Mirror failures that made a refresh move on."
        )
        @mismatches = meter.create_counter(
          "kyp.hash_mismatches", unit: "{blob}", description: "Prompt bodies discarded for a bad SHA-256."
        )
        @render_errors = meter.create_counter(
          "kyp.render.errors", unit: "{error}", description: "render failures: unknown prompt or missing variable."
        )
      end

      def setup_gauges
        return unless @meter

        meter = @meter
        attrs = { "kyp.app" => @client.config.app, "kyp.env" => @client.config.env }
        staleness = -> { @client.status.stale_for.to_f }
        revision = -> { @client.revision }
        # Created without a callback and registered after, so a second instrumentation on the
        # same meter adds its callback instead of being ignored. The Ruby metrics SDK reports one
        # attribute set per observable instrument: instrument one client per meter provider.
        g1 = meter.create_observable_gauge("kyp.staleness", unit: "s",
                                                            description: "Seconds since a mirror last confirmed " \
                                                                         "the prompts held.")
        g2 = meter.create_observable_gauge("kyp.revision", unit: "{revision}",
                                                           description: "Manifest revision held (0 when nothing).")
        @gauges = [[g1, staleness], [g2, revision]]
        @gauges.each do |g, cb|
          g.add_attributes(attrs) if g.respond_to?(:add_attributes)
          g.register_callback(cb) if g.respond_to?(:register_callback)
        end
      end

      def record_metrics(rec)
        return unless @duration

        b = base(rec)
        attrs = b.merge("kyp.refresh.trigger" => rec.trigger, "kyp.refresh.result" => rec.result)
        attrs["kyp.source"] = rec.source unless rec.source.empty?
        @duration.record(rec.duration, attributes: attrs)
        rec.events.each do |e|
          case e.name
          when "kyp.fallback"
            @fallbacks.add(1, attributes: b.merge(e.attributes.slice("kyp.source", "kyp.mirror", "error.type")))
          when "kyp.hash_mismatch"
            @mismatches.add(1, attributes: b.merge(e.attributes.slice("kyp.source", "kyp.mirror")))
          end
        end
      end

      def record_span(rec) # rubocop:disable Metrics/AbcSize
        attrs = base(rec).merge("kyp.refresh.trigger" => rec.trigger, "kyp.refresh.result" => rec.result)
        attrs["kyp.revision"] = rec.revision if rec.revision.positive?
        attrs["kyp.workspace"] = rec.workspace unless rec.workspace.empty?
        unless rec.source.empty?
          attrs["kyp.source"] = rec.source
          attrs["kyp.mirror"] = rec.mirror
        end
        attrs["error.type"] = rec.error_type.empty? ? "_OTHER" : rec.error_type if rec.result == "failed"
        # A manual refresh is a child of the caller's span; start-up and polls are roots.
        parent = rec.trigger == "manual" ? OpenTelemetry::Context.current : OpenTelemetry::Context.empty
        span = @tracer.start_span("kyp.refresh", with_parent: parent, attributes: attrs, kind: :internal,
                                                 start_timestamp: rec.start_time)
        rec.events.each { |e| span.add_event(e.name, attributes: e.attributes, timestamp: e.time) }
        span.status = OpenTelemetry::Trace::Status.error(rec.error[0, 500]) if rec.result == "failed"
        span.finish(end_timestamp: rec.start_time + rec.duration)
      end
    end
  end
end
