package com.keepyourprompts.otel;

import com.keepyourprompts.KeepYourPrompts;
import com.keepyourprompts.Prompt;
import com.keepyourprompts.PromptMeta;
import com.keepyourprompts.Rendered;
import com.keepyourprompts.Telemetry;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.Meter;
import io.opentelemetry.api.metrics.ObservableDoubleGauge;
import io.opentelemetry.api.metrics.ObservableLongGauge;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * OpenTelemetry for Keep Your Prompts (protocol/tracing.md): {@code kyp.refresh} spans with {@code kyp.fallback},
 * {@code kyp.hash_mismatch} and {@code kyp.update} events, the {@code kyp.*} metrics, and {@link #annotate} to put
 * {@code kyp.*} and {@code gen_ai.prompt.*} attributes on your LLM span.
 *
 * <pre>{@code
 * KypOpenTelemetry otel = KypOpenTelemetry.instrument(prompts);
 * Rendered r = prompts.renderWithMeta("triage", Map.of("company", "Acme"));
 * otel.annotate(r);   // on Span.current()
 * }</pre>
 *
 * <p>Needs {@code io.opentelemetry:opentelemetry-api} on the class path (an optional dependency of the SDK: add it
 * yourself). Nothing else in the SDK loads this package.
 */
public final class KypOpenTelemetry implements Telemetry.Observer, AutoCloseable {
  /** Instrumentation scope (tracer and meter name), the same in every SDK. */
  public static final String SCOPE = "keepyourprompts";

  /** Histogram buckets of {@code kyp.refresh.duration}, in seconds. */
  public static final List<Double> REFRESH_BUCKETS =
      List.of(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0);

  /** Options for {@link #builder()}. */
  public static final class Builder {
    private OpenTelemetry openTelemetry;
    private Boolean captureContent;
    private boolean genAiAttributes = true;
    private boolean openInference;
    private boolean traceAllRefreshes;

    private Builder() {}

    /** Default: {@link GlobalOpenTelemetry#get()}. */
    public Builder openTelemetry(OpenTelemetry v) {
      openTelemetry = Objects.requireNonNull(v);
      return this;
    }

    /**
     * Record prompt templates and variable values on annotated spans. Default {@code false}, or
     * {@code KYP_OTEL_CAPTURE_CONTENT=true}. PRIVACY: variable values often hold personal data; they reach every
     * backend your traces go to.
     */
    public Builder captureContent(boolean v) {
      captureContent = v;
      return this;
    }

    /** Also set {@code gen_ai.prompt.name} / {@code gen_ai.prompt.version} (default {@code true}). */
    public Builder genAiAttributes(boolean v) {
      genAiAttributes = v;
      return this;
    }

    /** Also set {@code prompt.vendor}, {@code prompt.id}, {@code llm.prompt_template.version} (default {@code false}). */
    public Builder openInference(boolean v) {
      openInference = v;
      return this;
    }

    /** Also export spans for uneventful {@code not_modified} rounds (default {@code false}). */
    public Builder traceAllRefreshes(boolean v) {
      traceAllRefreshes = v;
      return this;
    }

    /**
     * Creates the instrumentation without a client: pass it to {@code KeepYourPrompts.builder().observer(...)} so
     * the start-up round is recorded, then call {@link #attach}.
     */
    public KypOpenTelemetry build() {
      return new KypOpenTelemetry(this);
    }

    /** Creates the instrumentation, subscribes it to {@code client} and attaches it. */
    public KypOpenTelemetry instrument(KeepYourPrompts client) {
      KypOpenTelemetry k = build();
      k.attach(client);
      k.unsubscribe = client.addObserver(k);
      return k;
    }
  }

  public static Builder builder() {
    return new Builder();
  }

  /** {@code builder().instrument(client)} with the global OpenTelemetry. */
  public static KypOpenTelemetry instrument(KeepYourPrompts client) {
    return builder().instrument(client);
  }

  private final boolean capture;
  private final boolean genAi;
  private final boolean openInference;
  private final boolean traceAll;
  private final Tracer tracer;
  private final Meter meter;
  private final DoubleHistogram duration;
  private final LongCounter fallbacks;
  private final LongCounter mismatches;
  private final LongCounter renderErrors;
  private volatile KeepYourPrompts client;
  private volatile boolean active = true;
  private volatile Runnable unsubscribe;
  private ObservableDoubleGauge staleness;
  private ObservableLongGauge revision;

  private KypOpenTelemetry(Builder b) {
    OpenTelemetry otel = b.openTelemetry != null ? b.openTelemetry : GlobalOpenTelemetry.get();
    capture = b.captureContent != null ? b.captureContent : envCapture();
    genAi = b.genAiAttributes;
    openInference = b.openInference;
    traceAll = b.traceAllRefreshes;
    tracer = otel.getTracerProvider().tracerBuilder(SCOPE).setInstrumentationVersion(KeepYourPrompts.VERSION).build();
    meter = otel.getMeterProvider().meterBuilder(SCOPE).setInstrumentationVersion(KeepYourPrompts.VERSION).build();
    duration =
        meter
            .histogramBuilder("kyp.refresh.duration")
            .setUnit("s")
            .setDescription("Wall time of each prompt refresh round.")
            .setExplicitBucketBoundariesAdvice(REFRESH_BUCKETS)
            .build();
    fallbacks =
        meter
            .counterBuilder("kyp.fallbacks")
            .setUnit("{fallback}")
            .setDescription("Mirror failures that made a refresh move on to the next mirror.")
            .build();
    mismatches =
        meter
            .counterBuilder("kyp.hash_mismatches")
            .setUnit("{blob}")
            .setDescription("Prompt bodies discarded because their SHA-256 did not match.")
            .build();
    renderErrors =
        meter
            .counterBuilder("kyp.render.errors")
            .setUnit("{error}")
            .setDescription("render() failures: unknown prompt or missing variable.")
            .build();
  }

  private static boolean envCapture() {
    String v = System.getenv("KYP_OTEL_CAPTURE_CONTENT");
    if (v == null) return false;
    switch (v.trim().toLowerCase(Locale.ROOT)) {
      case "1":
      case "true":
      case "yes":
      case "on":
        return true;
      default:
        return false;
    }
  }

  /** Sets the client used by {@link #annotate(String)} and the gauges {@code kyp.staleness} and {@code kyp.revision}. */
  public synchronized KypOpenTelemetry attach(KeepYourPrompts c) {
    closeGauges();
    client = Objects.requireNonNull(c);
    Attributes base = base(c.app(), c.env());
    staleness =
        meter
            .gaugeBuilder("kyp.staleness")
            .setUnit("s")
            .setDescription("Seconds since a mirror last confirmed the prompts held.")
            .buildWithCallback(
                m -> {
                  if (active) m.record(c.status().staleFor().toMillis() / 1000.0, base);
                });
    revision =
        meter
            .gaugeBuilder("kyp.revision")
            .ofLongs()
            .setUnit("{revision}")
            .setDescription("Manifest revision held (0 when nothing is loaded).")
            .buildWithCallback(
                m -> {
                  if (active) m.record(c.revision(), base);
                });
    return this;
  }

  private void closeGauges() {
    if (staleness != null) staleness.close();
    if (revision != null) revision.close();
    staleness = null;
    revision = null;
  }

  /** Stops recording: unsubscribes from the client and removes the gauges. */
  @Override
  public synchronized void close() {
    active = false;
    Runnable u = unsubscribe;
    if (u != null) u.run();
    unsubscribe = null;
    closeGauges();
  }

  private static Attributes base(String app, String env) {
    return Attributes.builder().put("kyp.app", app).put("kyp.env", env).build();
  }

  private static void put(AttributesBuilder b, String k, Object v) {
    if (v instanceof Long l) b.put(k, l);
    else if (v instanceof Integer i) b.put(k, (long) i);
    else b.put(k, String.valueOf(v));
  }

  private static Attributes attrs(Map<String, Object> m) {
    AttributesBuilder b = Attributes.builder();
    m.forEach((k, v) -> put(b, k, v));
    return b.build();
  }

  // --- Telemetry.Observer ---------------------------------------------------------------------

  @Override
  public void onRenderError(Telemetry.RenderError e) {
    if (!active) return;
    renderErrors.add(
        1,
        base(e.app(), e.env()).toBuilder()
            .put("kyp.prompt.name", e.name())
            .put("error.type", e.errorType())
            .build());
  }

  @Override
  public void onRefresh(Telemetry.RefreshRecord rec) {
    if (!active) return;
    try {
      record(rec);
    } catch (RuntimeException ignored) {
      // telemetry never breaks the client
    }
  }

  private void record(Telemetry.RefreshRecord rec) {
    Attributes base = base(rec.app(), rec.env());
    AttributesBuilder m =
        base.toBuilder().put("kyp.refresh.trigger", rec.trigger()).put("kyp.refresh.result", rec.result());
    if (!rec.source().isEmpty()) m.put("kyp.source", rec.source());
    duration.record(rec.duration().toNanos() / 1e9, m.build());
    for (Telemetry.Event e : rec.events()) {
      Map<String, Object> a = e.attributes();
      if (e.name().equals("kyp.fallback")) {
        fallbacks.add(
            1,
            base.toBuilder()
                .put("kyp.source", String.valueOf(a.get("kyp.source")))
                .put("kyp.mirror", String.valueOf(a.get("kyp.mirror")))
                .put("error.type", String.valueOf(a.get("error.type")))
                .build());
      } else if (e.name().equals("kyp.hash_mismatch")) {
        mismatches.add(
            1,
            base.toBuilder()
                .put("kyp.source", String.valueOf(a.get("kyp.source")))
                .put("kyp.mirror", String.valueOf(a.get("kyp.mirror")))
                .build());
      }
    }
    if (rec.result().equals("not_modified") && rec.events().isEmpty() && !traceAll) return;
    AttributesBuilder s =
        base.toBuilder().put("kyp.refresh.trigger", rec.trigger()).put("kyp.refresh.result", rec.result());
    if (rec.revision() != 0) s.put("kyp.revision", rec.revision());
    if (!rec.workspace().isEmpty()) s.put("kyp.workspace", rec.workspace());
    if (!rec.source().isEmpty()) s.put("kyp.source", rec.source()).put("kyp.mirror", rec.mirror());
    boolean failed = rec.result().equals("failed");
    if (failed) s.put("error.type", rec.errorType().isEmpty() ? "_OTHER" : rec.errorType());
    SpanBuilder sb =
        tracer
            .spanBuilder("kyp.refresh")
            .setSpanKind(SpanKind.INTERNAL)
            .setStartTimestamp(rec.start())
            .setAllAttributes(s.build());
    // Background and start-up rounds are root spans; a manual refresh joins the caller's trace.
    if (!rec.trigger().equals("manual")) sb.setNoParent();
    Span span = sb.startSpan();
    for (Telemetry.Event e : rec.events()) span.addEvent(e.name(), attrs(e.attributes()), e.time());
    if (failed) {
      String msg = rec.error();
      span.setStatus(StatusCode.ERROR, msg.length() > 500 ? msg.substring(0, 500) : msg);
    }
    span.end(rec.start().plus(rec.duration()));
  }

  // --- annotate -------------------------------------------------------------------------------

  /** Annotates {@link Span#current()} with the body of {@code name} held now. Returns its metadata. */
  public PromptMeta annotate(String name) {
    return annotate(Span.current(), name, null);
  }

  /** Annotates {@link Span#current()} with the body a {@code renderWithMeta} call used. */
  public PromptMeta annotate(Rendered rendered) {
    return annotate(Span.current(), rendered.meta(), null);
  }

  public PromptMeta annotate(PromptMeta meta) {
    return annotate(Span.current(), meta, null);
  }

  /** {@code variables} are recorded only with content capture on. */
  public PromptMeta annotate(PromptMeta meta, Map<String, ?> variables) {
    return annotate(Span.current(), meta, variables);
  }

  /**
   * Annotates {@code span} with the body of {@code name} held now. Throws
   * {@link com.keepyourprompts.PromptNotFoundException}, never for telemetry reasons.
   */
  public PromptMeta annotate(Span span, String name, Map<String, ?> variables) {
    KeepYourPrompts c = client;
    if (c == null) throw new IllegalStateException("kyp: annotate(name) needs a client: use instrument() or attach()");
    return annotate(span, c.meta(name), variables);
  }

  /** Annotates {@code span} with {@code meta}; {@code variables} (may be null) only with content capture on. */
  public PromptMeta annotate(Span span, PromptMeta meta, Map<String, ?> variables) {
    String template = null;
    KeepYourPrompts c = client;
    if (capture && c != null && c.contains(meta.name())) {
      try {
        Prompt p = c.prompt(meta.name());
        if (p.sha256().equals(meta.sha256())) template = p.text(); // only that very body
      } catch (RuntimeException ignored) {
        // swapped meanwhile
      }
    }
    apply(span, meta, variables, template, capture, genAi, openInference);
    return meta;
  }

  /**
   * Annotates without an instrumentation (no client: pass {@code template} to record it). Content capture follows
   * {@code captureContent}.
   */
  public static PromptMeta annotateSpan(
      Span span,
      PromptMeta meta,
      Map<String, ?> variables,
      String template,
      boolean captureContent,
      boolean genAiAttributes,
      boolean openInference) {
    apply(span, meta, variables, template, captureContent, genAiAttributes, openInference);
    return meta;
  }

  private static void apply(
      Span span,
      PromptMeta meta,
      Map<String, ?> variables,
      String template,
      boolean capture,
      boolean genAi,
      boolean openInference) {
    try {
      if (span == null || !span.isRecording()) return;
      AttributesBuilder b = Attributes.builder();
      (genAi ? meta.attributes() : meta.kypAttributes()).forEach((k, v) -> put(b, k, v));
      if (openInference) {
        b.put("prompt.vendor", "keepyourprompts");
        b.put("prompt.id", meta.app() + "/" + meta.env() + "/" + meta.name());
        b.put("llm.prompt_template.version", Long.toString(meta.version()));
      }
      if (capture) {
        if (template != null) {
          b.put("kyp.prompt.template", template);
          if (openInference) b.put("llm.prompt_template.template", template);
        }
        if (variables != null && !variables.isEmpty()) {
          Map<String, String> vs = new LinkedHashMap<>();
          variables.forEach((k, v) -> vs.put(k, String.valueOf(v)));
          vs.forEach((k, v) -> b.put("gen_ai.prompt.variable." + k, v));
          if (openInference) b.put("llm.prompt_template.variables", toJson(vs));
        }
      }
      span.setAllAttributes(b.build());
    } catch (RuntimeException ignored) {
      // telemetry never breaks the app
    }
  }

  private static String toJson(Map<String, String> m) {
    StringBuilder sb = new StringBuilder("{");
    boolean first = true;
    for (Map.Entry<String, String> e : m.entrySet()) {
      if (!first) sb.append(',');
      first = false;
      quote(sb, e.getKey());
      sb.append(':');
      quote(sb, e.getValue());
    }
    return sb.append('}').toString();
  }

  private static void quote(StringBuilder sb, String s) {
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char ch = s.charAt(i);
      switch (ch) {
        case '"':
          sb.append("\\\"");
          break;
        case '\\':
          sb.append("\\\\");
          break;
        case '\n':
          sb.append("\\n");
          break;
        case '\r':
          sb.append("\\r");
          break;
        case '\t':
          sb.append("\\t");
          break;
        default:
          if (ch < 0x20) sb.append(String.format("\\u%04x", (int) ch));
          else sb.append(ch);
      }
    }
    sb.append('"');
  }
}
