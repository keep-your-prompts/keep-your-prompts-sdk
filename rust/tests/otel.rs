//! The `otel` feature against the OpenTelemetry SDK's in-memory exporters (protocol/tracing.md,
//! conformance checklist).
#![cfg(all(feature = "otel", feature = "blocking"))]

mod common;

use std::sync::Arc;

use common::*;
use kyp::otel::{Annotate, Instrumentation, OtelOptions};
use kyp::Mirror;
use opentelemetry::trace::{SpanId, SpanKind, Status, TraceContextExt, Tracer, TracerProvider as _};
use opentelemetry::{Context, KeyValue, Value};
use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData};
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};

struct Otel {
    spans: InMemorySpanExporter,
    tracer_provider: SdkTracerProvider,
    metrics: InMemoryMetricExporter,
    meter_provider: SdkMeterProvider,
}

impl Otel {
    fn new() -> Otel {
        let spans = InMemorySpanExporter::default();
        let tracer_provider = SdkTracerProvider::builder().with_simple_exporter(spans.clone()).build();
        let metrics = InMemoryMetricExporter::default();
        let meter_provider =
            SdkMeterProvider::builder().with_reader(PeriodicReader::builder(metrics.clone()).build()).build();
        Otel { spans, tracer_provider, metrics, meter_provider }
    }

    fn spans(&self, name: &str) -> Vec<SpanData> {
        self.spans.get_finished_spans().unwrap().into_iter().filter(|s| s.name == name).collect()
    }

    /// (attributes, value or count) per data point of the latest export of `name`.
    fn points(&self, name: &str) -> Vec<(Vec<(String, String)>, f64)> {
        self.meter_provider.force_flush().unwrap();
        let all = self.metrics.get_finished_metrics().unwrap();
        let rm = all.last().unwrap();
        let attrs = |it: &mut dyn Iterator<Item = &KeyValue>| {
            let mut v: Vec<(String, String)> = it.map(|kv| (kv.key.to_string(), kv.value.to_string())).collect();
            v.sort();
            v
        };
        for sm in rm.scope_metrics() {
            for m in sm.metrics() {
                if m.name() != name {
                    continue;
                }
                return match m.data() {
                    AggregatedMetrics::F64(MetricData::Histogram(h)) => {
                        h.data_points().map(|p| (attrs(&mut p.attributes()), p.count() as f64)).collect()
                    }
                    AggregatedMetrics::F64(MetricData::Gauge(g)) => {
                        g.data_points().map(|p| (attrs(&mut p.attributes()), p.value())).collect()
                    }
                    AggregatedMetrics::I64(MetricData::Gauge(g)) => {
                        g.data_points().map(|p| (attrs(&mut p.attributes()), p.value() as f64)).collect()
                    }
                    AggregatedMetrics::U64(MetricData::Sum(s)) => {
                        s.data_points().map(|p| (attrs(&mut p.attributes()), p.value() as f64)).collect()
                    }
                    other => panic!("unexpected data for {name}: {other:?}"),
                };
            }
        }
        panic!("no metric {name}")
    }
}

fn attr(s: &SpanData, key: &str) -> Option<Value> {
    s.attributes.iter().find(|kv| kv.key.as_str() == key).map(|kv| kv.value.clone())
}

fn sorted_attrs(kvs: &[KeyValue]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = kvs.iter().map(|kv| (kv.key.to_string(), kv.value.to_string())).collect();
    v.sort();
    v
}

fn pairs(p: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = p.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    v.sort();
    v
}

struct Setup {
    otel: Otel,
    inst: Arc<Instrumentation>,
    client: kyp::Client,
    _broken: Served,
    good: Served,
}

/// Two folder mirrors: "broken" (a manifest that is not JSON) first, then "snapshot" (v12).
fn setup(opts: OtelOptions, broken_is_good: bool) -> Setup {
    let otel = Otel::new();
    let inst = Instrumentation::with_providers(&otel.tracer_provider, &otel.meter_provider, opts);
    let broken = Served::new("v12");
    if !broken_is_good {
        std::fs::write(broken.path().join("envs/demo/prod.json"), "not json").unwrap();
    }
    let good = Served::new("v12");
    let client = quiet()
        .mirrors(vec![Mirror::file(broken.path(), "broken"), Mirror::file(good.path(), "snapshot")])
        .observer(inst.clone())
        .build()
        .unwrap();
    inst.attach(&client);
    // Folder-only clients poll their folders right after start-up: let that round happen first.
    let first_poll = || otel.points("kyp.refresh.duration").iter().map(|p| p.1).sum::<f64>() >= 2.0;
    assert!(eventually(first_poll));
    Setup { otel, inst, client, _broken: broken, good }
}

fn in_llm_span<R>(o: &Otel, f: impl FnOnce() -> R) -> (R, SpanData) {
    let tracer = o.tracer_provider.tracer("app");
    let span = tracer.start("llm.call");
    let cx = Context::current_with_span(span);
    let r = {
        let _g = cx.clone().attach();
        f()
    };
    cx.span().end();
    (r, o.spans("llm.call").pop().unwrap())
}

#[test]
fn annotate_sets_kyp_and_gen_ai_attributes_without_content() {
    let s = setup(OtelOptions::default(), false);
    let (meta, span) = in_llm_span(&s.otel, || {
        s.inst.annotate("greeting", &Annotate { variables: &[("name", "Ada")], ..Default::default() }).unwrap()
    });
    assert_eq!(meta.name, "greeting");
    assert_eq!(
        sorted_attrs(&span.attributes),
        pairs(&[
            ("kyp.prompt.name", "greeting"),
            ("kyp.prompt.version", "4"),
            ("kyp.prompt.sha256", "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"),
            ("kyp.app", "demo"),
            ("kyp.env", "prod"),
            ("kyp.revision", "12"),
            ("kyp.workspace", "acme"),
            ("kyp.source", "snapshot"),
            ("gen_ai.prompt.name", "greeting"),
            ("gen_ai.prompt.version", "4"),
        ])
    );
    assert_eq!(attr(&span, "kyp.prompt.version"), Some(Value::I64(4)));
    assert_eq!(attr(&span, "gen_ai.prompt.version"), Some(Value::from("4")));
}

#[test]
fn capture_content_and_open_inference() {
    let s = setup(OtelOptions { capture_content: Some(true), open_inference: true, ..Default::default() }, false);
    let r = s.client.render_with_meta("greeting", &[("name", "Ada"), ("company", "Acme")]).unwrap();
    let vars = [("name", "Ada"), ("company", "Acme")];
    let (_, span) = in_llm_span(&s.otel, || s.inst.annotate(&r, &Annotate { variables: &vars, ..Default::default() }));
    assert_eq!(attr(&span, "kyp.prompt.template"), Some(Value::from(s.client.get("greeting").unwrap().to_string())));
    assert_eq!(attr(&span, "gen_ai.prompt.variable.name"), Some(Value::from("Ada")));
    assert_eq!(attr(&span, "gen_ai.prompt.variable.company"), Some(Value::from("Acme")));
    assert_eq!(attr(&span, "prompt.vendor"), Some(Value::from("keepyourprompts")));
    assert_eq!(attr(&span, "prompt.id"), Some(Value::from("demo/prod/greeting")));
    assert_eq!(attr(&span, "llm.prompt_template.version"), Some(Value::from("4")));
    let v: serde_json::Value =
        serde_json::from_str(&attr(&span, "llm.prompt_template.variables").unwrap().to_string()).unwrap();
    assert_eq!(v, serde_json::json!({"name": "Ada", "company": "Acme"}));
}

#[test]
fn free_annotate_on_explicit_context() {
    let s = setup(OtelOptions::default(), false);
    let tracer = s.otel.tracer_provider.tracer("app");
    let cx = Context::new().with_span(tracer.start("explicit"));
    let meta = s.client.meta("triage").unwrap();
    kyp::otel::annotate(
        &meta,
        &Annotate {
            context: Some(&cx),
            variables: &[("company", "Acme")],
            gen_ai_attributes: Some(false),
            capture_content: Some(false),
            ..Default::default()
        },
    );
    cx.span().end();
    let span = s.otel.spans("explicit").pop().unwrap();
    assert_eq!(attr(&span, "kyp.prompt.version"), Some(Value::I64(7)));
    assert!(attr(&span, "gen_ai.prompt.name").is_none());
    assert!(!span.attributes.iter().any(|kv| kv.key.as_str().starts_with("gen_ai.prompt.variable.")));

    // No active span: a no-op; unknown names still fail.
    assert_eq!(s.inst.annotate("triage", &Annotate::default()).unwrap().version, 7);
    assert!(matches!(s.inst.annotate("nope", &Annotate::default()), Err(kyp::Error::NotFound { .. })));
}

#[test]
fn refresh_spans_and_events() {
    let s = setup(OtelOptions::default(), false);
    s.good.deploy("v13");
    let (_, llm) = in_llm_span(&s.otel, || s.client.refresh());
    s.good.deploy("tampered-v14");
    s.client.refresh();

    let all = s.otel.spans("kyp.refresh");
    // start-up (with a fallback), first poll (fallback), update, tampered.
    assert_eq!(all.len(), 4);
    let start = &all[0];
    assert_eq!(start.span_kind, SpanKind::Internal);
    assert_eq!(start.instrumentation_scope.name(), "keepyourprompts");
    assert_eq!(
        sorted_attrs(&start.attributes),
        pairs(&[
            ("kyp.app", "demo"),
            ("kyp.env", "prod"),
            ("kyp.refresh.trigger", "start"),
            ("kyp.refresh.result", "updated"),
            ("kyp.revision", "12"),
            ("kyp.workspace", "acme"),
            ("kyp.source", "snapshot"),
            ("kyp.mirror", "snapshot"),
        ])
    );
    let ev: Vec<&str> = start.events.iter().map(|e| e.name.as_ref()).collect();
    assert_eq!(ev, ["kyp.fallback", "kyp.update"]);
    assert!(start.events[0].attributes.contains(&KeyValue::new("error.type", "bad_manifest")));
    assert_eq!(start.parent_span_id, SpanId::INVALID);

    let update = &all[2];
    assert_eq!(attr(update, "kyp.refresh.trigger"), Some(Value::from("manual")));
    assert_eq!(attr(update, "kyp.revision"), Some(Value::I64(13)));
    assert_eq!(update.parent_span_id, llm.span_context.span_id());
    assert_eq!(
        sorted_attrs(&update.events.last().unwrap().attributes),
        pairs(&[("kyp.prompts.changed", "1"), ("kyp.revision", "13"), ("kyp.revision.previous", "12")])
    );

    let bad = &all[3];
    assert!(bad.events.iter().any(|e| e.name == "kyp.hash_mismatch"));
    assert_eq!(attr(bad, "kyp.refresh.result"), Some(Value::from("failed")));
    assert_eq!(attr(bad, "error.type"), Some(Value::from("blob_unavailable")));
    assert!(matches!(bad.status, Status::Error { .. }));
    assert!(attr(bad, "kyp.source").is_none());
}

#[test]
fn refresh_metrics() {
    let s = setup(OtelOptions::default(), false);
    s.good.deploy("v13");
    s.client.refresh();
    s.good.deploy("tampered-v14");
    s.client.refresh();

    let d = s.otel.points("kyp.refresh.duration");
    assert_eq!(d.iter().map(|p| p.1).sum::<f64>(), 4.0);
    assert!(d.contains(&(
        pairs(&[
            ("kyp.app", "demo"),
            ("kyp.env", "prod"),
            ("kyp.refresh.result", "updated"),
            ("kyp.refresh.trigger", "start"),
            ("kyp.source", "snapshot"),
        ]),
        1.0
    )));
    let f = s.otel.points("kyp.fallbacks");
    assert_eq!(f.iter().map(|p| p.1).sum::<f64>(), 5.0); // broken x4 + the tampered snapshot
    assert!(f.contains(&(
        pairs(&[
            ("error.type", "bad_manifest"),
            ("kyp.app", "demo"),
            ("kyp.env", "prod"),
            ("kyp.mirror", "broken"),
            ("kyp.source", "snapshot"),
        ]),
        4.0
    )));
    assert_eq!(s.otel.points("kyp.hash_mismatches").iter().map(|p| p.1).sum::<f64>(), 1.0);
    assert_eq!(s.otel.points("kyp.revision"), [(pairs(&[("kyp.app", "demo"), ("kyp.env", "prod")]), 13.0)]);
    let st = s.otel.points("kyp.staleness");
    assert_eq!(st.len(), 1);
    assert!(st[0].1 >= 0.0);
}

#[test]
fn uneventful_rounds_are_not_traced_unless_asked() {
    let s = setup(OtelOptions::default(), true);
    s.client.refresh();
    // Only the start-up round: the poll and the manual refresh confirmed what is held.
    assert_eq!(s.otel.spans("kyp.refresh").len(), 1);
    assert_eq!(s.otel.points("kyp.refresh.duration").iter().map(|p| p.1).sum::<f64>(), 3.0);

    let s = setup(OtelOptions { trace_all_refreshes: true, ..Default::default() }, true);
    s.client.refresh();
    let triggers: Vec<String> =
        s.otel.spans("kyp.refresh").iter().map(|sp| attr(sp, "kyp.refresh.trigger").unwrap().to_string()).collect();
    assert_eq!(triggers, ["start", "poll", "manual"]);
}

#[test]
fn render_errors_metric_and_shutdown() {
    let s = setup(OtelOptions::default(), false);
    assert!(s.client.render("greeting", &[("name", "Ada")]).is_err());
    assert!(s.client.render("nope", &[("a", "b")]).is_err());
    let mut e: Vec<Vec<(String, String)>> = s.otel.points("kyp.render.errors").into_iter().map(|p| p.0).collect();
    e.sort();
    assert_eq!(
        e,
        [
            pairs(&[
                ("error.type", "missing_variable"),
                ("kyp.app", "demo"),
                ("kyp.env", "prod"),
                ("kyp.prompt.name", "greeting")
            ]),
            pairs(&[
                ("error.type", "not_found"),
                ("kyp.app", "demo"),
                ("kyp.env", "prod"),
                ("kyp.prompt.name", "nope")
            ]),
        ]
    );
    s.inst.shutdown();
    let before = s.otel.spans("kyp.refresh").len();
    s.good.deploy("v13");
    s.client.refresh();
    assert_eq!(s.otel.spans("kyp.refresh").len(), before);
}

#[cfg(feature = "tokio")]
#[tokio::test(flavor = "multi_thread")]
async fn async_client_start_and_manual_refresh() {
    let otel = Otel::new();
    let inst = Instrumentation::with_providers(&otel.tracer_provider, &otel.meter_provider, OtelOptions::default());
    let good = Served::new("v12");
    let c = quiet()
        .mirrors(vec![Mirror::file(good.path(), "snapshot")])
        .observer(inst.clone())
        .build_async()
        .await
        .unwrap();
    inst.attach_async(&c);
    good.deploy("v13");
    assert!(c.refresh().await);
    assert_eq!(inst.annotate("greeting", &Annotate::default()).unwrap().version, 5);
    let results: Vec<String> =
        otel.spans("kyp.refresh").iter().map(|s| attr(s, "kyp.refresh.result").unwrap().to_string()).collect();
    // Start-up, then the update (seen by the first poll or by the manual refresh, whichever ran first).
    assert_eq!(results.iter().filter(|r| *r == "updated").count(), 2);
    assert_eq!(otel.points("kyp.revision")[0].1, 13.0);
}
