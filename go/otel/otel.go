// Package kypotel is OpenTelemetry for the Keep Your Prompts Go SDK
// (protocol/tracing.md in the SDK repository).
//
//	ins, err := kypotel.Instrument(prompts) // kyp.refresh spans + kyp.* metrics
//	...
//	ctx, span := tracer.Start(ctx, "chat triage")
//	r, _ := prompts.RenderWithMeta("triage", kyp.Vars{"company": "Acme"})
//	ins.AnnotateMeta(ctx, r.Meta) // kyp.* + gen_ai.prompt.* on the span in ctx
//
// It is a separate module so the SDK itself keeps zero dependencies.
package kypotel

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	kyp "github.com/keep-your-prompts/keep-your-prompts-sdk/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// Scope is the instrumentation scope (tracer and meter name), the same in every SDK.
const Scope = "keepyourprompts"

// RefreshBuckets are the histogram buckets of kyp.refresh.duration, in seconds.
var RefreshBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

type config struct {
	tp             trace.TracerProvider
	mp             metric.MeterProvider
	capture        bool
	noGenAI        bool
	openInference  bool
	traceAll       bool
	captureFromEnv bool
}

// Option configures New and Instrument.
type Option func(*config)

// WithTracerProvider sets the tracer provider (default: otel.GetTracerProvider()).
func WithTracerProvider(tp trace.TracerProvider) Option { return func(c *config) { c.tp = tp } }

// WithMeterProvider sets the meter provider (default: otel.GetMeterProvider()).
func WithMeterProvider(mp metric.MeterProvider) Option { return func(c *config) { c.mp = mp } }

// WithCaptureContent records prompt templates and variable values on annotated
// spans. Off by default (or KYP_OTEL_CAPTURE_CONTENT=true). PRIVACY: variable
// values often hold personal data; they reach every backend your traces go to.
func WithCaptureContent(on bool) Option {
	return func(c *config) { c.capture, c.captureFromEnv = on, false }
}

// WithoutGenAIAttributes stops Annotate from setting gen_ai.prompt.name and gen_ai.prompt.version.
func WithoutGenAIAttributes() Option { return func(c *config) { c.noGenAI = true } }

// WithOpenInference also sets prompt.vendor, prompt.id and llm.prompt_template.version (Arize Phoenix).
func WithOpenInference() Option { return func(c *config) { c.openInference = true } }

// WithTraceAllRefreshes also exports kyp.refresh spans for uneventful not_modified rounds.
func WithTraceAllRefreshes() Option { return func(c *config) { c.traceAll = true } }

func envCapture() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("KYP_OTEL_CAPTURE_CONTENT"))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// Instrumentation records kyp.refresh spans and kyp.* metrics (it is a
// kyp.Observer) and annotates LLM spans. Create it with Instrument, or with
// New plus kyp.WithObserver and Attach to see the start-up round too.
type Instrumentation struct {
	cfg    config
	tracer trace.Tracer

	duration     metric.Float64Histogram
	fallbacks    metric.Int64Counter
	mismatches   metric.Int64Counter
	renderErrors metric.Int64Counter
	staleness    metric.Float64ObservableGauge
	revision     metric.Int64ObservableGauge
	meter        metric.Meter

	mu     sync.Mutex
	client *kyp.Client
	reg    metric.Registration
	remove func()
	active atomic.Bool
}

// New creates the instruments. Pass it to kyp.New with kyp.WithObserver, then
// call Attach with the client.
func New(opts ...Option) (*Instrumentation, error) {
	cfg := config{captureFromEnv: true}
	for _, o := range opts {
		o(&cfg)
	}
	if cfg.captureFromEnv {
		cfg.capture = envCapture()
	}
	if cfg.tp == nil {
		cfg.tp = otel.GetTracerProvider()
	}
	if cfg.mp == nil {
		cfg.mp = otel.GetMeterProvider()
	}
	i := &Instrumentation{cfg: cfg}
	i.active.Store(true)
	i.tracer = cfg.tp.Tracer(Scope, trace.WithInstrumentationVersion(kyp.Version))
	m := cfg.mp.Meter(Scope, metric.WithInstrumentationVersion(kyp.Version))
	i.meter = m
	var err error
	if i.duration, err = m.Float64Histogram("kyp.refresh.duration", metric.WithUnit("s"),
		metric.WithDescription("Wall time of each prompt refresh round."),
		metric.WithExplicitBucketBoundaries(RefreshBuckets...)); err != nil {
		return nil, err
	}
	if i.fallbacks, err = m.Int64Counter("kyp.fallbacks", metric.WithUnit("{fallback}"),
		metric.WithDescription("Mirror failures that made a refresh move on to the next mirror.")); err != nil {
		return nil, err
	}
	if i.mismatches, err = m.Int64Counter("kyp.hash_mismatches", metric.WithUnit("{blob}"),
		metric.WithDescription("Prompt bodies discarded because their SHA-256 did not match.")); err != nil {
		return nil, err
	}
	if i.renderErrors, err = m.Int64Counter("kyp.render.errors", metric.WithUnit("{error}"),
		metric.WithDescription("Render failures: unknown prompt or missing variable.")); err != nil {
		return nil, err
	}
	if i.staleness, err = m.Float64ObservableGauge("kyp.staleness", metric.WithUnit("s"),
		metric.WithDescription("Seconds since a mirror last confirmed the prompts held.")); err != nil {
		return nil, err
	}
	if i.revision, err = m.Int64ObservableGauge("kyp.revision", metric.WithUnit("{revision}"),
		metric.WithDescription("Manifest revision held (0 when nothing is loaded).")); err != nil {
		return nil, err
	}
	return i, nil
}

// Instrument creates an Instrumentation, subscribes it to c and attaches it.
func Instrument(c *kyp.Client, opts ...Option) (*Instrumentation, error) {
	i, err := New(opts...)
	if err != nil {
		return nil, err
	}
	if err := i.Attach(c); err != nil {
		return nil, err
	}
	rm := c.AddObserver(i)
	i.mu.Lock()
	i.remove = rm
	i.mu.Unlock()
	return i, nil
}

// Attach sets the client used by Annotate and the observable gauges
// (kyp.staleness, kyp.revision). It does not subscribe to c: use Instrument,
// or kyp.WithObserver before kyp.New.
func (i *Instrumentation) Attach(c *kyp.Client) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.reg != nil {
		_ = i.reg.Unregister()
	}
	i.client = c
	reg, err := i.meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		s := c.Status()
		attrs := metric.WithAttributes(i.base(c)...)
		o.ObserveFloat64(i.staleness, s.StaleFor.Seconds(), attrs)
		o.ObserveInt64(i.revision, s.Revision, attrs)
		return nil
	}, i.staleness, i.revision)
	if err != nil {
		return err
	}
	i.reg = reg
	return nil
}

func (i *Instrumentation) base(c *kyp.Client) []attribute.KeyValue {
	app, env := c.App(), c.Env()
	return []attribute.KeyValue{attribute.String("kyp.app", app), attribute.String("kyp.env", env)}
}

// Shutdown stops recording: it unsubscribes from the client and unregisters the gauges.
func (i *Instrumentation) Shutdown() {
	i.active.Store(false)
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.remove != nil {
		i.remove()
		i.remove = nil
	}
	if i.reg != nil {
		_ = i.reg.Unregister()
		i.reg = nil
	}
}

// --- kyp.Observer ---------------------------------------------------------------

func attrs(m map[string]any) []attribute.KeyValue {
	out := make([]attribute.KeyValue, 0, len(m))
	for k, v := range m {
		switch x := v.(type) {
		case string:
			out = append(out, attribute.String(k, x))
		case int64:
			out = append(out, attribute.Int64(k, x))
		case int:
			out = append(out, attribute.Int(k, x))
		default:
			out = append(out, attribute.String(k, fmt.Sprint(x)))
		}
	}
	return out
}

// OnRenderError implements kyp.Observer.
func (i *Instrumentation) OnRenderError(e kyp.RenderError) {
	if !i.active.Load() {
		return
	}
	i.renderErrors.Add(context.Background(), 1, metric.WithAttributes(
		attribute.String("kyp.app", e.App), attribute.String("kyp.env", e.Env),
		attribute.String("kyp.prompt.name", e.Name), attribute.String("error.type", e.ErrorType)))
}

// OnRefresh implements kyp.Observer.
func (i *Instrumentation) OnRefresh(rec kyp.RefreshRecord) {
	if !i.active.Load() {
		return
	}
	ctx := context.Background()
	base := []attribute.KeyValue{attribute.String("kyp.app", rec.App), attribute.String("kyp.env", rec.Env)}
	mattrs := append(append([]attribute.KeyValue{}, base...),
		attribute.String("kyp.refresh.trigger", rec.Trigger), attribute.String("kyp.refresh.result", rec.Result))
	if rec.Source != "" {
		mattrs = append(mattrs, attribute.String("kyp.source", rec.Source))
	}
	i.duration.Record(ctx, rec.Duration.Seconds(), metric.WithAttributes(mattrs...))
	for _, e := range rec.Events {
		str := func(k string) string { s, _ := e.Attributes[k].(string); return s }
		switch e.Name {
		case "kyp.fallback":
			i.fallbacks.Add(ctx, 1, metric.WithAttributes(append(append([]attribute.KeyValue{}, base...),
				attribute.String("kyp.source", str("kyp.source")), attribute.String("kyp.mirror", str("kyp.mirror")),
				attribute.String("error.type", str("error.type")))...))
		case "kyp.hash_mismatch":
			i.mismatches.Add(ctx, 1, metric.WithAttributes(append(append([]attribute.KeyValue{}, base...),
				attribute.String("kyp.source", str("kyp.source")), attribute.String("kyp.mirror", str("kyp.mirror")))...))
		}
	}
	if rec.Result == kyp.ResultNotModified && len(rec.Events) == 0 && !i.cfg.traceAll {
		return
	}
	sattrs := append(append([]attribute.KeyValue{}, base...),
		attribute.String("kyp.refresh.trigger", rec.Trigger), attribute.String("kyp.refresh.result", rec.Result))
	if rec.Revision != 0 {
		sattrs = append(sattrs, attribute.Int64("kyp.revision", rec.Revision))
	}
	if rec.Workspace != "" {
		sattrs = append(sattrs, attribute.String("kyp.workspace", rec.Workspace))
	}
	if rec.Source != "" {
		sattrs = append(sattrs, attribute.String("kyp.source", rec.Source), attribute.String("kyp.mirror", rec.Mirror))
	}
	if rec.Result == kyp.ResultFailed {
		et := rec.ErrorType
		if et == "" {
			et = "_OTHER"
		}
		sattrs = append(sattrs, attribute.String("error.type", et))
	}
	opts := []trace.SpanStartOption{trace.WithSpanKind(trace.SpanKindInternal), trace.WithTimestamp(rec.Start), trace.WithAttributes(sattrs...)}
	parent := context.Background()
	if rec.Trigger == kyp.TriggerManual && rec.Ctx != nil {
		parent = rec.Ctx
	} else {
		opts = append(opts, trace.WithNewRoot())
	}
	_, span := i.tracer.Start(parent, "kyp.refresh", opts...)
	for _, e := range rec.Events {
		span.AddEvent(e.Name, trace.WithTimestamp(e.Time), trace.WithAttributes(attrs(e.Attributes)...))
	}
	if rec.Result == kyp.ResultFailed {
		msg := rec.Error
		if len(msg) > 500 {
			msg = msg[:500]
		}
		span.SetStatus(codes.Error, msg)
	}
	span.End(trace.WithTimestamp(rec.Start.Add(rec.Duration)))
}

// --- annotate ----------------------------------------------------------------------

type annotateConfig struct {
	span     trace.Span
	vars     kyp.Vars
	capture  *bool
	template *string
	noGenAI  bool
	oi       bool
}

// AnnotateOption configures Annotate, AnnotateMeta and the free function AnnotateSpan.
type AnnotateOption func(*annotateConfig)

// OnSpan annotates span instead of the span in ctx.
func OnSpan(s trace.Span) AnnotateOption { return func(c *annotateConfig) { c.span = s } }

// WithVariables passes the template variables; recorded only with content capture on.
func WithVariables(v kyp.Vars) AnnotateOption { return func(c *annotateConfig) { c.vars = v } }

// CaptureContent overrides the content-capture setting for one call.
func CaptureContent(on bool) AnnotateOption { return func(c *annotateConfig) { c.capture = &on } }

// WithTemplate gives AnnotateSpan the raw template (recorded only with content capture on).
func WithTemplate(t string) AnnotateOption { return func(c *annotateConfig) { c.template = &t } }

// Annotate sets kyp.* and gen_ai.prompt.* for the body of name held now on the
// span in ctx (or OnSpan). It returns the metadata, or a *kyp.NotFoundError.
func (i *Instrumentation) Annotate(ctx context.Context, name string, opts ...AnnotateOption) (kyp.PromptMeta, error) {
	i.mu.Lock()
	c := i.client
	i.mu.Unlock()
	if c == nil {
		return kyp.PromptMeta{}, fmt.Errorf("kypotel: Annotate needs a client: use Instrument or Attach")
	}
	m, err := c.Meta(name)
	if err != nil {
		return m, err
	}
	return i.AnnotateMeta(ctx, m, opts...), nil
}

// AnnotateMeta sets kyp.* and gen_ai.prompt.* from m (from Client.Meta or
// RenderWithMeta) on the span in ctx (or OnSpan).
func (i *Instrumentation) AnnotateMeta(ctx context.Context, m kyp.PromptMeta, opts ...AnnotateOption) kyp.PromptMeta {
	ac := annotateConfig{noGenAI: i.cfg.noGenAI, oi: i.cfg.openInference}
	for _, o := range opts {
		o(&ac)
	}
	capture := i.cfg.capture
	if ac.capture != nil {
		capture = *ac.capture
	}
	if capture && ac.template == nil {
		i.mu.Lock()
		c := i.client
		i.mu.Unlock()
		if c != nil {
			if p, err := c.Prompt(m.Name); err == nil && p.SHA256 == m.SHA256 { // only that very body
				ac.template = &p.Text
			}
		}
	}
	apply(ctx, m, ac, capture)
	return m
}

// AnnotateSpan annotates without an Instrumentation (no client: pass
// WithTemplate to record the template). Content capture follows
// KYP_OTEL_CAPTURE_CONTENT unless CaptureContent is given.
func AnnotateSpan(ctx context.Context, m kyp.PromptMeta, opts ...AnnotateOption) kyp.PromptMeta {
	var ac annotateConfig
	for _, o := range opts {
		o(&ac)
	}
	capture := envCapture()
	if ac.capture != nil {
		capture = *ac.capture
	}
	apply(ctx, m, ac, capture)
	return m
}

// AnnotateSpanOptions turns off gen_ai.prompt.* or turns on OpenInference for AnnotateSpan.
func AnnotateSpanOptions(genAI, openInference bool) AnnotateOption {
	return func(c *annotateConfig) { c.noGenAI, c.oi = !genAI, openInference }
}

func apply(ctx context.Context, m kyp.PromptMeta, ac annotateConfig, capture bool) {
	defer func() { _ = recover() }() // telemetry never breaks the app
	span := ac.span
	if span == nil {
		span = trace.SpanFromContext(ctx)
	}
	if !span.IsRecording() {
		return
	}
	var a map[string]any
	if ac.noGenAI {
		a = m.KypAttributes()
	} else {
		a = m.Attributes()
	}
	kv := attrs(a)
	if ac.oi {
		kv = append(kv,
			attribute.String("prompt.vendor", "keepyourprompts"),
			attribute.String("prompt.id", m.App+"/"+m.Env+"/"+m.Name),
			attribute.String("llm.prompt_template.version", fmt.Sprint(m.Version)))
	}
	if capture {
		if ac.template != nil {
			kv = append(kv, attribute.String("kyp.prompt.template", *ac.template))
			if ac.oi {
				kv = append(kv, attribute.String("llm.prompt_template.template", *ac.template))
			}
		}
		if len(ac.vars) > 0 {
			vs := map[string]string{}
			for k, v := range ac.vars {
				vs[k] = v
				kv = append(kv, attribute.String("gen_ai.prompt.variable."+k, v))
			}
			if ac.oi {
				if b, err := json.Marshal(vs); err == nil {
					kv = append(kv, attribute.String("llm.prompt_template.variables", string(b)))
				}
			}
		}
	}
	span.SetAttributes(kv...)
}
