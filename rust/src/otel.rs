//! OpenTelemetry for Keep Your Prompts (`protocol/tracing.md`), feature `otel`.
//!
//! ```no_run
//! # fn demo() -> kyp::Result<()> {
//! use kyp::otel::{Annotate, Instrumentation, OtelOptions};
//!
//! let otel = Instrumentation::new(OtelOptions::default()); // global tracer and meter providers
//! let prompts = kyp::Client::builder().app("support-bot").observer(otel.clone()).build()?;
//! otel.attach(&prompts); // kyp.staleness / kyp.revision gauges, annotate by name
//!
//! let r = prompts.render_with_meta("triage", &[("company", "Acme")])?;
//! otel.annotate(&r, &Annotate::default())?; // kyp.* + gen_ai.prompt.* on the active span
//! # Ok(()) }
//! ```
//!
//! Only this module depends on the `opentelemetry` crate (API only, no SDK).
//!
//! **Privacy:** with `capture_content` (or `KYP_OTEL_CAPTURE_CONTENT=true`), `annotate` also records
//! the template and the variable values, which often hold personal data. Off by default.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use opentelemetry::global::{self, BoxedTracer};
use opentelemetry::metrics::{Counter, Histogram, Meter, MeterProvider};
use opentelemetry::trace::{Span as _, SpanKind, Status, TraceContextExt, Tracer, TracerProvider};
use opentelemetry::{Context, InstrumentationScope, KeyValue};

use crate::engine::Engine;
use crate::fetch::Transport;
use crate::telemetry::{
    AttrValue, Observer, ObserverId, PromptMeta, RefreshRecord, RefreshResult, RefreshTrigger, RenderError, Rendered,
};
use crate::{Error, Result, Status as KypStatus};

/// Instrumentation scope (tracer and meter name), the same in every SDK.
pub const SCOPE: &str = "keepyourprompts";

/// Advice for `kyp.refresh.duration` (seconds).
pub const REFRESH_BUCKETS: [f64; 11] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];

/// Options of an [`Instrumentation`].
#[derive(Debug, Clone)]
pub struct OtelOptions {
    /// Record templates and variable values on annotated spans. `None`: `KYP_OTEL_CAPTURE_CONTENT`,
    /// else off. **Privacy:** variable values often hold personal data.
    pub capture_content: Option<bool>,
    /// Also set `gen_ai.prompt.name` / `gen_ai.prompt.version` (default `true`).
    pub gen_ai_attributes: bool,
    /// Also set the OpenInference aliases `prompt.vendor`, `prompt.id`, `llm.prompt_template.*`
    /// (default `false`).
    pub open_inference: bool,
    /// Also export `kyp.refresh` spans for rounds that only confirmed what is held (default `false`).
    pub trace_all_refreshes: bool,
}

impl Default for OtelOptions {
    fn default() -> Self {
        OtelOptions {
            capture_content: None,
            gen_ai_attributes: true,
            open_inference: false,
            trace_all_refreshes: false,
        }
    }
}

/// Per-call options of [`Instrumentation::annotate`] and [`annotate`].
#[derive(Debug, Clone, Default)]
pub struct Annotate<'a> {
    /// Annotate the span of this context instead of the active one.
    pub context: Option<&'a Context>,
    /// Template variables; recorded only with content capture on.
    pub variables: &'a [(&'a str, &'a str)],
    /// Override the content-capture setting for this call.
    pub capture_content: Option<bool>,
    /// [`annotate`] only: the raw template, recorded as `kyp.prompt.template` with content capture on.
    pub template: Option<&'a str>,
    /// [`annotate`] only: set `gen_ai.prompt.*` (default `true`).
    pub gen_ai_attributes: Option<bool>,
    /// [`annotate`] only: set the OpenInference aliases (default `false`).
    pub open_inference: Option<bool>,
}

/// A prompt to annotate with: a name, a [`PromptMeta`] or a [`Rendered`].
#[derive(Debug, Clone, Copy)]
pub enum PromptRef<'a> {
    /// A prompt name, resolved by the attached client.
    Name(&'a str),
    /// Metadata from `meta`.
    Meta(&'a PromptMeta),
}

impl<'a> From<&'a str> for PromptRef<'a> {
    fn from(n: &'a str) -> Self {
        PromptRef::Name(n)
    }
}
impl<'a> From<&'a PromptMeta> for PromptRef<'a> {
    fn from(m: &'a PromptMeta) -> Self {
        PromptRef::Meta(m)
    }
}
impl<'a> From<&'a Rendered> for PromptRef<'a> {
    fn from(r: &'a Rendered) -> Self {
        PromptRef::Meta(&r.meta)
    }
}

fn env_capture() -> bool {
    std::env::var("KYP_OTEL_CAPTURE_CONTENT")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

fn kv(k: &'static str, v: &AttrValue) -> KeyValue {
    match v {
        AttrValue::Str(s) => KeyValue::new(k, s.clone()),
        AttrValue::Int(i) => KeyValue::new(k, *i),
    }
}

fn json_escape(s: &str) -> String {
    serde_json::Value::String(s.to_owned()).to_string()
}

#[allow(clippy::too_many_arguments)]
fn apply(
    meta: &PromptMeta,
    cx: Option<&Context>,
    capture: bool,
    template: Option<&str>,
    variables: &[(&str, &str)],
    gen_ai: bool,
    open_inference: bool,
) {
    let build = || {
        let mut a: Vec<KeyValue> = meta.attributes(gen_ai).iter().map(|(k, v)| kv(k, v)).collect();
        if open_inference {
            a.push(KeyValue::new("prompt.vendor", "keepyourprompts"));
            a.push(KeyValue::new("prompt.id", format!("{}/{}/{}", meta.app, meta.env, meta.name)));
            a.push(KeyValue::new("llm.prompt_template.version", meta.version.to_string()));
        }
        if capture {
            if let Some(t) = template {
                a.push(KeyValue::new("kyp.prompt.template", t.to_owned()));
                if open_inference {
                    a.push(KeyValue::new("llm.prompt_template.template", t.to_owned()));
                }
            }
            if !variables.is_empty() {
                for (k, v) in variables {
                    a.push(KeyValue::new(format!("gen_ai.prompt.variable.{k}"), (*v).to_owned()));
                }
                if open_inference {
                    let body: Vec<String> =
                        variables.iter().map(|(k, v)| format!("{}:{}", json_escape(k), json_escape(v))).collect();
                    a.push(KeyValue::new("llm.prompt_template.variables", format!("{{{}}}", body.join(","))));
                }
            }
        }
        a
    };
    let run = |cx: &Context| {
        let span = cx.span();
        if span.is_recording() {
            span.set_attributes(build());
        }
    };
    match cx {
        Some(cx) => run(cx),
        None => Context::map_current(|cx| run(cx)),
    }
}

/// Annotates a span (default: the active one) with a prompt's metadata, without a client.
/// `kyp.prompt.template` needs [`Annotate::template`]. Never fails; a span that is not
/// recording is left alone. Returns the metadata.
pub fn annotate(meta: &PromptMeta, opts: &Annotate<'_>) -> PromptMeta {
    let capture = opts.capture_content.unwrap_or_else(env_capture);
    apply(
        meta,
        opts.context,
        capture,
        opts.template,
        opts.variables,
        opts.gen_ai_attributes.unwrap_or(true),
        opts.open_inference.unwrap_or(false),
    );
    meta.clone()
}

/// What an [`Instrumentation`] needs from a client (blocking or async).
trait Handle: Send + Sync {
    fn meta(&self, name: &str) -> Result<PromptMeta>;
    fn template(&self, name: &str, sha256: &str) -> Option<String>;
    fn status(&self) -> KypStatus;
    fn app_env(&self) -> (String, String);
    fn remove_observer(&self, id: ObserverId);
}

impl<T: Transport + Send + Sync + 'static> Handle for Engine<T> {
    fn meta(&self, name: &str) -> Result<PromptMeta> {
        let g = self.state();
        match (*g).as_ref().and_then(|s| s.prompts.get(name).map(|p| (s, p))) {
            Some((s, p)) => Ok(self.meta_of(p, s)),
            None => Err(Error::NotFound { name: name.to_owned() }),
        }
    }
    fn template(&self, name: &str, sha256: &str) -> Option<String> {
        let g = self.state();
        let p = (*g).as_ref()?.prompts.get(name)?;
        (p.sha256 == sha256).then(|| p.text.to_string())
    }
    fn status(&self) -> KypStatus {
        Engine::status(self)
    }
    fn app_env(&self) -> (String, String) {
        (self.cfg.app.clone(), self.cfg.env.clone())
    }
    fn remove_observer(&self, id: ObserverId) {
        Engine::remove_observer(self, id);
    }
}

/// The attached client and our subscription to it (none when given via `Builder::observer`).
type Attached = (Weak<dyn Handle>, Option<ObserverId>);

struct Metrics {
    duration: Histogram<f64>,
    fallbacks: Counter<u64>,
    mismatches: Counter<u64>,
    render_errors: Counter<u64>,
    meter: Meter,
}

/// Records `kyp.refresh` spans and `kyp.*` metrics for a client, and annotates LLM spans.
/// An [`Observer`]: pass it to [`Builder::observer`](crate::Builder::observer) so the start-up
/// round is traced too, then [`attach`](Self::attach) the client.
pub struct Instrumentation {
    tracer: BoxedTracer,
    metrics: Metrics,
    capture: bool,
    opts: OtelOptions,
    stopped: Arc<AtomicBool>,
    attached: Mutex<Option<Attached>>,
}

impl std::fmt::Debug for Instrumentation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Instrumentation").field("opts", &self.opts).finish_non_exhaustive()
    }
}

fn scope() -> InstrumentationScope {
    InstrumentationScope::builder(SCOPE).with_version(crate::VERSION).build()
}

impl Instrumentation {
    /// With the global tracer and meter providers.
    pub fn new(opts: OtelOptions) -> Arc<Instrumentation> {
        let tracer = BoxedTracer::new(Box::new(global::tracer_provider().tracer_with_scope(scope())));
        Self::build(tracer, global::meter_provider().meter_with_scope(scope()), opts)
    }

    /// With explicit providers (for example an SDK provider that is not installed globally).
    pub fn with_providers<P, T, S, M>(
        tracer_provider: &P,
        meter_provider: &M,
        opts: OtelOptions,
    ) -> Arc<Instrumentation>
    where
        P: TracerProvider<Tracer = T>,
        T: Tracer<Span = S> + Send + Sync + 'static,
        S: opentelemetry::trace::Span + Send + Sync + 'static,
        M: MeterProvider + ?Sized,
    {
        let tracer = BoxedTracer::new(Box::new(tracer_provider.tracer_with_scope(scope())));
        Self::build(tracer, meter_provider.meter_with_scope(scope()), opts)
    }

    fn build(tracer: BoxedTracer, meter: Meter, opts: OtelOptions) -> Arc<Instrumentation> {
        let metrics = Metrics {
            duration: meter
                .f64_histogram("kyp.refresh.duration")
                .with_unit("s")
                .with_description("Wall time of each prompt refresh round.")
                .with_boundaries(REFRESH_BUCKETS.to_vec())
                .build(),
            fallbacks: meter
                .u64_counter("kyp.fallbacks")
                .with_unit("{fallback}")
                .with_description("Mirror failures that made a refresh move on to the next mirror.")
                .build(),
            mismatches: meter
                .u64_counter("kyp.hash_mismatches")
                .with_unit("{blob}")
                .with_description("Prompt bodies discarded because their SHA-256 did not match.")
                .build(),
            render_errors: meter
                .u64_counter("kyp.render.errors")
                .with_unit("{error}")
                .with_description("render failures: unknown prompt or missing variable.")
                .build(),
            meter,
        };
        Arc::new(Instrumentation {
            tracer,
            metrics,
            capture: opts.capture_content.unwrap_or_else(env_capture),
            opts,
            stopped: Arc::new(AtomicBool::new(false)),
            attached: Mutex::new(None),
        })
    }

    /// Binds to a blocking client: observes it (unless it was given this instrumentation with
    /// `Builder::observer`), registers the `kyp.staleness` and `kyp.revision` gauges and lets
    /// [`annotate`](Self::annotate) resolve prompt names.
    pub fn attach(self: &Arc<Self>, client: &crate::Client) {
        let engine = client.engine.clone();
        self.attach_handle(engine.clone(), |o| engine.add_observer_unless_present(o));
    }

    /// [`attach`](Self::attach) for an [`AsyncClient`](crate::AsyncClient).
    #[cfg(feature = "tokio")]
    pub fn attach_async(self: &Arc<Self>, client: &crate::AsyncClient) {
        let engine = client.engine.clone();
        self.attach_handle(engine.clone(), |o| engine.add_observer_unless_present(o));
    }

    fn attach_handle<H: Handle + 'static>(
        self: &Arc<Self>,
        handle: Arc<H>,
        subscribe: impl FnOnce(Arc<dyn Observer>) -> Option<ObserverId>,
    ) {
        let id = subscribe(self.clone());
        let dyn_handle: Arc<dyn Handle> = handle;
        let weak = Arc::downgrade(&dyn_handle);
        let (app, env) = dyn_handle.app_env();
        let status = vec![KeyValue::new("kyp.app", app), KeyValue::new("kyp.env", env)];
        *crate::engine::lock(&self.attached) = Some((weak.clone(), id));
        let (w1, s1, a1) = (weak.clone(), self.stopped.clone(), status.clone());
        let _ = self
            .metrics
            .meter
            .f64_observable_gauge("kyp.staleness")
            .with_unit("s")
            .with_description("Seconds since a mirror last confirmed the prompts held.")
            .with_callback(move |o| {
                if s1.load(Ordering::Relaxed) {
                    return;
                }
                if let Some(h) = w1.upgrade() {
                    o.observe(h.status().stale_for.as_secs_f64(), &a1);
                }
            })
            .build();
        let (w2, s2, a2) = (weak, self.stopped.clone(), status);
        let _ = self
            .metrics
            .meter
            .i64_observable_gauge("kyp.revision")
            .with_unit("{revision}")
            .with_description("Manifest revision held (0 when nothing is loaded).")
            .with_callback(move |o| {
                if s2.load(Ordering::Relaxed) {
                    return;
                }
                if let Some(h) = w2.upgrade() {
                    o.observe(h.status().revision, &a2);
                }
            })
            .build();
    }

    /// Annotates a span (default: the active one) with the prompt used: a name, a
    /// [`PromptMeta`] or a [`Rendered`]. Returns the metadata. Fails only for an unknown name
    /// (or a name without an attached client); telemetry itself never fails.
    pub fn annotate<'a>(&self, prompt: impl Into<PromptRef<'a>>, opts: &Annotate<'_>) -> Result<PromptMeta> {
        let handle = crate::engine::lock(&self.attached).as_ref().and_then(|(w, _)| w.upgrade());
        let meta = match prompt.into() {
            PromptRef::Meta(m) => m.clone(),
            PromptRef::Name(n) => match &handle {
                Some(h) => h.meta(n)?,
                None => return Err(Error::Config("annotate(name) needs an attached client".into())),
            },
        };
        let capture = opts.capture_content.unwrap_or(self.capture);
        let template = if capture { handle.as_ref().and_then(|h| h.template(&meta.name, &meta.sha256)) } else { None };
        apply(
            &meta,
            opts.context,
            capture,
            template.as_deref(),
            opts.variables,
            self.opts.gen_ai_attributes,
            self.opts.open_inference,
        );
        Ok(meta)
    }

    /// Stops recording spans and metrics (the gauges stop reporting) and unsubscribes.
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some((w, Some(id))) = crate::engine::lock(&self.attached).take() {
            if let Some(h) = w.upgrade() {
                h.remove_observer(id);
            }
        }
    }

    fn record_metrics(&self, rec: &RefreshRecord) {
        let base = [KeyValue::new("kyp.app", rec.app.clone()), KeyValue::new("kyp.env", rec.env.clone())];
        let mut attrs = base.to_vec();
        attrs.push(KeyValue::new("kyp.refresh.trigger", rec.trigger.as_str()));
        attrs.push(KeyValue::new("kyp.refresh.result", rec.result.as_str()));
        if !rec.source.is_empty() {
            attrs.push(KeyValue::new("kyp.source", rec.source.clone()));
        }
        self.metrics.duration.record(rec.duration.as_secs_f64(), &attrs);
        for e in &rec.events {
            let get = |k: &'static str| KeyValue::new(k, e.attr(k).map(|v| v.to_string()).unwrap_or_default());
            match e.name {
                "kyp.fallback" => {
                    let mut a = base.to_vec();
                    a.extend([get("kyp.source"), get("kyp.mirror"), get("error.type")]);
                    self.metrics.fallbacks.add(1, &a);
                }
                "kyp.hash_mismatch" => {
                    let mut a = base.to_vec();
                    a.extend([get("kyp.source"), get("kyp.mirror")]);
                    self.metrics.mismatches.add(1, &a);
                }
                _ => {}
            }
        }
    }

    fn record_span(&self, rec: &RefreshRecord) {
        let mut attrs = vec![
            KeyValue::new("kyp.app", rec.app.clone()),
            KeyValue::new("kyp.env", rec.env.clone()),
            KeyValue::new("kyp.refresh.trigger", rec.trigger.as_str()),
            KeyValue::new("kyp.refresh.result", rec.result.as_str()),
        ];
        if rec.revision > 0 {
            attrs.push(KeyValue::new("kyp.revision", rec.revision));
        }
        if !rec.workspace.is_empty() {
            attrs.push(KeyValue::new("kyp.workspace", rec.workspace.clone()));
        }
        if !rec.source.is_empty() {
            attrs.push(KeyValue::new("kyp.source", rec.source.clone()));
            attrs.push(KeyValue::new("kyp.mirror", rec.mirror.clone()));
        }
        let failed = rec.result == RefreshResult::Failed;
        if failed {
            let t = if rec.error_type.is_empty() { "_OTHER".to_owned() } else { rec.error_type.clone() };
            attrs.push(KeyValue::new("error.type", t));
        }
        // A manual refresh is a child of the caller's active span; start-up and polls are roots.
        let parent = if rec.trigger == RefreshTrigger::Manual { Context::current() } else { Context::new() };
        let mut span = self
            .tracer
            .span_builder("kyp.refresh")
            .with_kind(SpanKind::Internal)
            .with_start_time(rec.start_time)
            .with_attributes(attrs)
            .start_with_context(&self.tracer, &parent);
        for e in &rec.events {
            let a: Vec<KeyValue> = e.attributes.iter().map(|(k, v)| kv(k, v)).collect();
            span.add_event_with_timestamp(e.name, e.time, a);
        }
        if failed {
            let msg: String = rec.error.chars().take(500).collect();
            span.set_status(Status::error(msg));
        }
        span.end_with_timestamp(rec.start_time + rec.duration.max(Duration::ZERO));
    }
}

impl Observer for Instrumentation {
    fn on_refresh(&self, rec: &RefreshRecord) {
        if self.stopped.load(Ordering::Relaxed) {
            return;
        }
        self.record_metrics(rec);
        if rec.result == RefreshResult::NotModified && rec.events.is_empty() && !self.opts.trace_all_refreshes {
            return;
        }
        self.record_span(rec);
    }

    fn on_render_error(&self, e: &RenderError) {
        if self.stopped.load(Ordering::Relaxed) {
            return;
        }
        self.metrics.render_errors.add(
            1,
            &[
                KeyValue::new("kyp.app", e.app.clone()),
                KeyValue::new("kyp.env", e.env.clone()),
                KeyValue::new("kyp.prompt.name", e.name.clone()),
                KeyValue::new("error.type", e.error_type),
            ],
        );
    }
}

/// `Instrumentation::new(opts)` attached to `client` (the start-up round has already happened
/// and is not traced; use [`Builder::observer`](crate::Builder::observer) for that).
pub fn instrument(client: &crate::Client, opts: OtelOptions) -> Arc<Instrumentation> {
    let i = Instrumentation::new(opts);
    i.attach(client);
    i
}
