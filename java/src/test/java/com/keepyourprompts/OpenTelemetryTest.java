package com.keepyourprompts;

import static com.keepyourprompts.TestSupport.deploy;
import static com.keepyourprompts.TestSupport.fixture;
import static com.keepyourprompts.TestSupport.quiet;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.keepyourprompts.otel.KypOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.metrics.SdkMeterProvider;
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.EventData;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** protocol/tracing.md conformance checklist, with in-memory OpenTelemetry exporters. */
class OpenTelemetryTest {
  static final String KEY = "kypd_test";
  static final String GREETING_SHA = "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d";

  @TempDir Path tmp;
  Path cdnDir;
  Path originDir;
  FakeCdn server;
  InMemorySpanExporter spans;
  InMemoryMetricReader metrics;
  OpenTelemetrySdk otel;
  final List<AutoCloseable> closers = new ArrayList<>();

  @BeforeEach
  void setUp() throws Exception {
    cdnDir = tmp.resolve("cdn");
    originDir = tmp.resolve("origin");
    deploy("v12", cdnDir);
    deploy("v12", originDir);
    server =
        JvmFakeCdn.factory()
            .start(Map.of("cdn", Map.entry("/v1/d/" + KEY, cdnDir), "origin", Map.entry("/v1/delivery/" + KEY, originDir)));
    spans = InMemorySpanExporter.create();
    metrics = InMemoryMetricReader.create();
    otel =
        OpenTelemetrySdk.builder()
            .setTracerProvider(SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(spans)).build())
            .setMeterProvider(SdkMeterProvider.builder().registerMetricReader(metrics).build())
            .build();
  }

  @AfterEach
  void tearDown() throws Exception {
    for (int i = closers.size() - 1; i >= 0; i--) closers.get(i).close();
    server.close();
    otel.close();
  }

  <T extends AutoCloseable> T track(T c) {
    closers.add(c);
    return c;
  }

  KeepYourPrompts.Builder net() {
    return quiet()
        .deliveryKey(KEY)
        .cdnBase(server.base() + "/v1/d")
        .originBase(server.base() + "/v1/delivery")
        .pollInterval(Duration.ofHours(1));
  }

  KeepYourPrompts local() {
    return track(quiet().snapshotDir(fixture("v12")).build());
  }

  List<SpanData> named(String name) {
    return spans.getFinishedSpanItems().stream().filter(s -> s.getName().equals(name)).collect(Collectors.toList());
  }

  Map<String, MetricData> collect() {
    Map<String, MetricData> out = new HashMap<>();
    for (MetricData m : metrics.collectAllMetrics()) {
      assertEquals("keepyourprompts", m.getInstrumentationScopeInfo().getName());
      out.put(m.getName(), m);
    }
    return out;
  }

  static Map<String, Object> asMap(Attributes a) {
    Map<String, Object> m = new LinkedHashMap<>();
    a.forEach((k, v) -> m.put(k.getKey(), v));
    return m;
  }

  static Map<String, Object> expected() {
    Map<String, Object> m = new HashMap<>();
    m.put("kyp.prompt.name", "greeting");
    m.put("kyp.prompt.version", 4L);
    m.put("kyp.prompt.sha256", GREETING_SHA);
    m.put("kyp.app", "demo");
    m.put("kyp.env", "prod");
    m.put("kyp.revision", 12L);
    m.put("kyp.workspace", "acme");
    m.put("kyp.source", "snapshot");
    m.put("gen_ai.prompt.name", "greeting");
    m.put("gen_ai.prompt.version", "4");
    return m;
  }

  @Test
  void metaAndRenderWithMeta() {
    KeepYourPrompts c = local();
    PromptMeta m = c.meta("greeting");
    assertEquals(expected(), new HashMap<>(m.attributes()));
    Rendered r = c.renderWithMeta("greeting", Map.of("name", "Ada", "company", "Acme"));
    assertEquals("Hello Ada, welcome to Acme.", r.text());
    assertEquals(m, r.meta());
    Map<String, Object> flat = new HashMap<>();
    expected().forEach((k, v) -> {
      if (!k.startsWith("gen_ai")) flat.put(k.replace('.', '_'), v);
    });
    assertEquals(flat, new HashMap<>(m.traceMetadata()));
    assertEquals(flat, new HashMap<>(m.langfuseMetadata()));
    assertEquals(flat, new HashMap<>(m.langsmithMetadata()));
    assertThrows(PromptNotFoundException.class, () -> c.meta("nope"));
  }

  @Test
  void annotateCurrentSpanWithoutContent() {
    KeepYourPrompts c = local();
    KypOpenTelemetry k = track(KypOpenTelemetry.builder().openTelemetry(otel).captureContent(false).instrument(c));
    Span span = otel.getTracer("app").spanBuilder("llm.call").startSpan();
    try (Scope ignored = span.makeCurrent()) {
      assertEquals(4, k.annotate(c.renderWithMeta("greeting", Map.of("name", "a", "company", "b"))).version());
    } finally {
      span.end();
    }
    assertEquals(expected(), asMap(named("llm.call").get(0).getAttributes()));
  }

  @Test
  void captureContentAndOpenInference() {
    KeepYourPrompts c = local();
    KypOpenTelemetry k =
        track(KypOpenTelemetry.builder().openTelemetry(otel).captureContent(true).openInference(true).instrument(c));
    Span span = otel.getTracer("app").spanBuilder("llm.call").startSpan();
    Map<String, String> vars = new LinkedHashMap<>();
    vars.put("name", "Ada");
    vars.put("company", "Acme");
    k.annotate(span, "greeting", vars);
    span.end();
    Map<String, Object> a = asMap(named("llm.call").get(0).getAttributes());
    assertEquals("Hello {{name}}, welcome to {{ company }}.", a.get("kyp.prompt.template"));
    assertEquals("Ada", a.get("gen_ai.prompt.variable.name"));
    assertEquals("Acme", a.get("gen_ai.prompt.variable.company"));
    assertEquals("keepyourprompts", a.get("prompt.vendor"));
    assertEquals("demo/prod/greeting", a.get("prompt.id"));
    assertEquals("4", a.get("llm.prompt_template.version"));
    assertEquals("{\"name\":\"Ada\",\"company\":\"Acme\"}", a.get("llm.prompt_template.variables"));

    Span s2 = otel.getTracer("app").spanBuilder("explicit").startSpan();
    KypOpenTelemetry.annotateSpan(s2, c.meta("triage"), vars, null, false, false, false);
    s2.end();
    Map<String, Object> b = asMap(named("explicit").get(0).getAttributes());
    assertEquals(7L, b.get("kyp.prompt.version"));
    assertNull(b.get("gen_ai.prompt.name"));
    assertNull(b.get("gen_ai.prompt.variable.company"));
  }

  @Test
  void refreshSpansEventsAndMetrics() {
    KypOpenTelemetry k = KypOpenTelemetry.builder().openTelemetry(otel).build();
    KeepYourPrompts c = track(net().observer(k).build()); // sees the start-up round
    track(k.attach(c));
    List<SpanData> start = named("kyp.refresh");
    assertEquals(1, start.size());
    assertEquals("start", start.get(0).getAttributes().get(AttributeKey.stringKey("kyp.refresh.trigger")));
    assertEquals("kyp.update", start.get(0).getEvents().get(0).getName());
    assertFalse(start.get(0).getParentSpanContext().isValid());

    // CDN down: a manual refresh under a parent span, with a fallback event.
    server.down("cdn");
    Span parent = otel.getTracer("app").spanBuilder("parent").startSpan();
    try (Scope ignored = parent.makeCurrent()) {
      assertTrue(c.refresh());
    } finally {
      parent.end();
    }
    SpanData manual = named("kyp.refresh").get(1);
    Map<String, Object> a = asMap(manual.getAttributes());
    assertEquals("manual", a.get("kyp.refresh.trigger"));
    assertEquals("not_modified", a.get("kyp.refresh.result"));
    assertEquals("origin", a.get("kyp.source"));
    assertEquals(12L, a.get("kyp.revision"));
    assertEquals("acme", a.get("kyp.workspace"));
    assertEquals(parent.getSpanContext().getSpanId(), manual.getParentSpanId());
    assertEquals(1, manual.getEvents().size());
    EventData fb = manual.getEvents().get(0);
    assertEquals("kyp.fallback", fb.getName());
    assertEquals("http_503", fb.getAttributes().get(AttributeKey.stringKey("error.type")));
    assertEquals("origin", c.meta("greeting").source());

    // Tampered CDN, v13 on the origin: hash mismatch, fallback, update.
    server.up("cdn");
    deploy("tampered-v14", cdnDir);
    deploy("v13", originDir);
    assertTrue(c.refresh());
    assertEquals(13, c.revision());
    SpanData upd = named("kyp.refresh").get(2);
    assertEquals(
        List.of("kyp.hash_mismatch", "kyp.fallback", "kyp.update"),
        upd.getEvents().stream().map(EventData::getName).collect(Collectors.toList()));
    assertEquals("blob_unavailable", upd.getEvents().get(1).getAttributes().get(AttributeKey.stringKey("error.type")));
    assertEquals(12L, upd.getEvents().get(2).getAttributes().get(AttributeKey.longKey("kyp.revision.previous")));

    // Everything down: an error span.
    server.down("cdn");
    server.down("origin");
    assertFalse(c.refresh());
    SpanData failed = named("kyp.refresh").get(3);
    assertEquals(StatusCode.ERROR, failed.getStatus().getStatusCode());
    assertEquals("http_503", failed.getAttributes().get(AttributeKey.stringKey("error.type")));
    assertNull(failed.getAttributes().get(AttributeKey.stringKey("kyp.source")));

    // Render errors.
    assertThrows(MissingVariableException.class, () -> c.render("greeting", Map.of("name", "x")));
    assertThrows(PromptNotFoundException.class, () -> c.renderWithMeta("nope", Map.of()));

    Map<String, MetricData> m = collect();
    Map<String, Long> fallbacks = sums(m.get("kyp.fallbacks"), "error.type", "kyp.source");
    assertEquals(Map.of("http_503/cdn", 2L, "blob_unavailable/cdn", 1L, "http_503/origin", 1L), fallbacks);
    assertEquals(Map.of("cdn", 1L), sums(m.get("kyp.hash_mismatches"), "kyp.source"));
    assertEquals(
        Map.of("missing_variable/greeting", 1L, "not_found/nope", 1L),
        sums(m.get("kyp.render.errors"), "error.type", "kyp.prompt.name"));
    long rounds = m.get("kyp.refresh.duration").getHistogramData().getPoints().stream().mapToLong(p -> p.getCount()).sum();
    assertEquals(4, rounds);
    assertEquals(13L, m.get("kyp.revision").getLongGaugeData().getPoints().iterator().next().getValue());
    assertTrue(m.get("kyp.staleness").getDoubleGaugeData().getPoints().iterator().next().getValue() >= 0);
  }

  @Test
  void uneventfulRoundsAreNotTracedByDefault() {
    for (boolean all : new boolean[] {false, true}) {
      spans.reset();
      KeepYourPrompts c = track(net().build());
      track(KypOpenTelemetry.builder().openTelemetry(otel).traceAllRefreshes(all).instrument(c));
      assertTrue(c.refresh());
      assertEquals(all ? 1 : 0, named("kyp.refresh").size());
    }
  }

  @Test
  void throwingObserverIsHarmless() {
    KeepYourPrompts c =
        track(
            quiet()
                .snapshotDir(fixture("v12"))
                .observer(
                    new Telemetry.Observer() {
                      @Override
                      public void onRefresh(Telemetry.RefreshRecord r) {
                        throw new IllegalStateException("boom");
                      }

                      @Override
                      public void onRenderError(Telemetry.RenderError e) {
                        throw new IllegalStateException("boom");
                      }
                    })
                .build());
    assertThrows(MissingVariableException.class, () -> c.render("greeting", Map.of()));
    assertTrue(c.get("triage").contains("support agent"));
  }

  static Map<String, Long> sums(MetricData m, String... keys) {
    Map<String, Long> out = new HashMap<>();
    for (LongPointData p : m.getLongSumData().getPoints()) {
      List<String> parts = new ArrayList<>();
      for (String k : keys) parts.add(p.getAttributes().get(AttributeKey.stringKey(k)));
      out.merge(String.join("/", parts), p.getValue(), Long::sum);
    }
    return out;
  }
}
