package kypotel

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	kyp "github.com/keep-your-prompts/keep-your-prompts-sdk/go"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

const (
	key         = "kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f"
	greetingSHA = "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"
)

func fixture(name string) string { return filepath.Join("..", "..", "conformance", "fixtures", name) }

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// mirrors serves cdn and origin routes from fixture folders; either can be
// switched to another fixture or taken down (503).
type mirrors struct {
	mu   sync.Mutex
	dirs map[string]string
	down map[string]bool
	srv  *httptest.Server
}

func newMirrors(t *testing.T, cdn, origin string) *mirrors {
	m := &mirrors{dirs: map[string]string{"cdn": fixture(cdn), "origin": fixture(origin)}, down: map[string]bool{}}
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for name, prefix := range map[string]string{"cdn": "/v1/d/" + key + "/", "origin": "/v1/delivery/" + key + "/"} {
			if !strings.HasPrefix(r.URL.Path, prefix) {
				continue
			}
			m.mu.Lock()
			dir, down := m.dirs[name], m.down[name]
			m.mu.Unlock()
			if down {
				http.Error(w, "down", http.StatusServiceUnavailable)
				return
			}
			b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, prefix))))
			if errors.Is(err, fs.ErrNotExist) {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(b)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(m.srv.Close)
	return m
}

func (m *mirrors) set(name, fx string) { m.mu.Lock(); m.dirs[name] = fixture(fx); m.mu.Unlock() }
func (m *mirrors) setDown(name string, d bool) {
	m.mu.Lock()
	m.down[name] = d
	m.mu.Unlock()
}

func (m *mirrors) options() kyp.Options {
	return kyp.Options{
		App: "demo", DeliveryKey: key, CDNBase: m.srv.URL + "/v1/d", OriginBase: m.srv.URL + "/v1/delivery",
		PollInterval: time.Hour, Logger: quiet(),
	}
}

type tel struct {
	spans  *tracetest.InMemoryExporter
	tp     *sdktrace.TracerProvider
	reader *sdkmetric.ManualReader
	mp     *sdkmetric.MeterProvider
}

func newTel(t *testing.T) *tel {
	x := &tel{spans: tracetest.NewInMemoryExporter(), reader: sdkmetric.NewManualReader()}
	x.tp = sdktrace.NewTracerProvider(sdktrace.WithSyncer(x.spans))
	x.mp = sdkmetric.NewMeterProvider(sdkmetric.WithReader(x.reader))
	t.Cleanup(func() { _ = x.tp.Shutdown(context.Background()); _ = x.mp.Shutdown(context.Background()) })
	return x
}

func (x *tel) opts(extra ...Option) []Option {
	return append([]Option{WithTracerProvider(x.tp), WithMeterProvider(x.mp)}, extra...)
}

func (x *tel) named(name string) []tracetest.SpanStub {
	var out []tracetest.SpanStub
	for _, s := range x.spans.GetSpans() {
		if s.Name == name {
			out = append(out, s)
		}
	}
	return out
}

func (x *tel) metrics(t *testing.T) map[string]metricdata.Aggregation {
	var rm metricdata.ResourceMetrics
	if err := x.reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	out := map[string]metricdata.Aggregation{}
	for _, sm := range rm.ScopeMetrics {
		if sm.Scope.Name != Scope {
			t.Fatalf("scope %q", sm.Scope.Name)
		}
		for _, m := range sm.Metrics {
			out[m.Name] = m.Data
		}
	}
	return out
}

func attrMap(kvs []attribute.KeyValue) map[string]any {
	m := map[string]any{}
	for _, kv := range kvs {
		m[string(kv.Key)] = kv.Value.AsInterface()
	}
	return m
}

func mustClient(t *testing.T, o kyp.Options, extra ...kyp.Option) *kyp.Client {
	t.Helper()
	c, err := kyp.New(context.Background(), o, extra...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestAnnotateActiveSpan(t *testing.T) {
	x := newTel(t)
	c := mustClient(t, kyp.Options{App: "demo", SnapshotDir: fixture("v12"), Logger: quiet()})
	ins, err := Instrument(c, x.opts(WithCaptureContent(false))...)
	if err != nil {
		t.Fatal(err)
	}
	ctx, span := x.tp.Tracer("app").Start(context.Background(), "llm.call")
	m, err := ins.Annotate(ctx, "greeting", WithVariables(kyp.Vars{"name": "Ada"}))
	span.End()
	if err != nil || m.Version != 4 {
		t.Fatalf("%+v %v", m, err)
	}
	got := attrMap(x.named("llm.call")[0].Attributes)
	want := map[string]any{
		"kyp.prompt.name": "greeting", "kyp.prompt.version": int64(4), "kyp.prompt.sha256": greetingSHA,
		"kyp.app": "demo", "kyp.env": "prod", "kyp.revision": int64(12), "kyp.workspace": "acme", "kyp.source": "snapshot",
		"gen_ai.prompt.name": "greeting", "gen_ai.prompt.version": "4",
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s = %v, want %v (all: %v)", k, got[k], v, got)
		}
	}
	if _, err := ins.Annotate(ctx, "nope"); !errors.Is(err, kyp.ErrNotFound) {
		t.Fatalf("nope: %v", err)
	}
}

func TestAnnotateCaptureContentAndOpenInference(t *testing.T) {
	x := newTel(t)
	c := mustClient(t, kyp.Options{App: "demo", SnapshotDir: fixture("v12"), Logger: quiet()})
	ins, err := Instrument(c, x.opts(WithCaptureContent(true), WithOpenInference())...)
	if err != nil {
		t.Fatal(err)
	}
	ctx, span := x.tp.Tracer("app").Start(context.Background(), "llm.call")
	vars := kyp.Vars{"name": "Ada", "company": "Acme"}
	r, _ := c.RenderWithMeta("greeting", vars)
	ins.AnnotateMeta(ctx, r.Meta, WithVariables(vars))
	span.End()
	a := attrMap(x.named("llm.call")[0].Attributes)
	for k, v := range map[string]any{
		"kyp.prompt.template":            "Hello {{name}}, welcome to {{ company }}.",
		"gen_ai.prompt.variable.name":    "Ada",
		"gen_ai.prompt.variable.company": "Acme",
		"prompt.vendor":                  "keepyourprompts",
		"prompt.id":                      "demo/prod/greeting",
		"llm.prompt_template.version":    "4",
	} {
		if a[k] != v {
			t.Fatalf("%s = %v, want %v", k, a[k], v)
		}
	}

	// The free function: explicit span, no gen_ai, no capture.
	_, s2 := x.tp.Tracer("app").Start(context.Background(), "explicit")
	AnnotateSpan(context.Background(), r.Meta, OnSpan(s2), AnnotateSpanOptions(false, false), CaptureContent(false), WithVariables(vars))
	s2.End()
	b := attrMap(x.named("explicit")[0].Attributes)
	if b["kyp.prompt.version"] != int64(4) || b["gen_ai.prompt.name"] != nil || b["gen_ai.prompt.variable.name"] != nil {
		t.Fatalf("explicit %v", b)
	}
}

func TestRefreshSpansAndMetrics(t *testing.T) {
	x := newTel(t)
	m := newMirrors(t, "v12", "v12")
	ins, err := New(x.opts()...)
	if err != nil {
		t.Fatal(err)
	}
	c := mustClient(t, m.options(), kyp.WithObserver(ins)) // sees the start-up round
	if err := ins.Attach(c); err != nil {
		t.Fatal(err)
	}
	start := x.named("kyp.refresh")
	if len(start) != 1 || attrMap(start[0].Attributes)["kyp.refresh.trigger"] != "start" ||
		len(start[0].Events) != 1 || start[0].Events[0].Name != "kyp.update" || start[0].Parent.IsValid() {
		t.Fatalf("start span %+v", start)
	}

	// CDN down: a manual refresh under a parent span, with a fallback event.
	m.setDown("cdn", true)
	ctx, parent := x.tp.Tracer("app").Start(context.Background(), "parent")
	if err := c.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	parent.End()
	spans := x.named("kyp.refresh")
	if len(spans) != 2 {
		t.Fatalf("%d spans", len(spans))
	}
	s := spans[1]
	a := attrMap(s.Attributes)
	if a["kyp.refresh.trigger"] != "manual" || a["kyp.refresh.result"] != "not_modified" || a["kyp.source"] != "origin" ||
		a["kyp.revision"] != int64(12) || a["kyp.workspace"] != "acme" || s.Parent.SpanID() != parent.SpanContext().SpanID() {
		t.Fatalf("manual span %v parent %v", a, s.Parent)
	}
	if len(s.Events) != 1 || s.Events[0].Name != "kyp.fallback" || attrMap(s.Events[0].Attributes)["error.type"] != "http_503" {
		t.Fatalf("events %+v", s.Events)
	}

	// Tampered CDN, v13 on the origin: hash mismatch, fallback, update.
	m.setDown("cdn", false)
	m.set("cdn", "tampered-v14")
	m.set("origin", "v13")
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	s = x.named("kyp.refresh")[2]
	var names []string
	for _, e := range s.Events {
		names = append(names, e.Name)
	}
	if strings.Join(names, ",") != "kyp.hash_mismatch,kyp.fallback,kyp.update" {
		t.Fatalf("events %v", names)
	}

	// Everything down: an error span.
	m.setDown("cdn", true)
	m.setDown("origin", true)
	if err := c.Refresh(context.Background()); err == nil {
		t.Fatal("want failure")
	}
	s = x.named("kyp.refresh")[3]
	if s.Status.Code != codes.Error || attrMap(s.Attributes)["error.type"] != "http_503" || attrMap(s.Attributes)["kyp.source"] != nil {
		t.Fatalf("failed span %+v", s)
	}

	// Render errors.
	_, _ = c.Render("greeting", kyp.Vars{"name": "x"})
	_, _ = c.RenderWithMeta("nope", nil)

	md := x.metrics(t)
	sum := func(name string) map[string]int64 {
		out := map[string]int64{}
		for _, dp := range md[name].(metricdata.Sum[int64]).DataPoints {
			k := []string{}
			for _, kv := range dp.Attributes.ToSlice() {
				if kv.Key == "error.type" || kv.Key == "kyp.source" || kv.Key == "kyp.prompt.name" {
					k = append(k, kv.Value.Emit())
				}
			}
			out[strings.Join(k, "/")] += dp.Value
		}
		return out
	}
	if f := sum("kyp.fallbacks"); f["http_503/cdn"] != 2 || f["blob_unavailable/cdn"] != 1 || f["http_503/origin"] != 1 {
		t.Fatalf("fallbacks %v", f)
	}
	if h := sum("kyp.hash_mismatches"); h["cdn"] != 1 {
		t.Fatalf("mismatches %v", h)
	}
	if r := sum("kyp.render.errors"); r["missing_variable/greeting"] != 1 || r["not_found/nope"] != 1 {
		t.Fatalf("render errors %v", r)
	}
	hist := md["kyp.refresh.duration"].(metricdata.Histogram[float64])
	var rounds uint64
	for _, dp := range hist.DataPoints {
		rounds += dp.Count
	}
	if rounds != 4 {
		t.Fatalf("%d rounds recorded", rounds)
	}
	if g := md["kyp.revision"].(metricdata.Gauge[int64]); g.DataPoints[0].Value != 13 {
		t.Fatalf("revision gauge %v", g.DataPoints)
	}
	if g := md["kyp.staleness"].(metricdata.Gauge[float64]); g.DataPoints[0].Value < 0 {
		t.Fatalf("staleness %v", g.DataPoints)
	}
	ins.Shutdown()
}

func TestUneventfulRoundsAreNotTracedByDefault(t *testing.T) {
	for _, all := range []bool{false, true} {
		x := newTel(t)
		m := newMirrors(t, "v12", "v12")
		c := mustClient(t, m.options())
		opts := x.opts()
		if all {
			opts = append(opts, WithTraceAllRefreshes())
		}
		if _, err := Instrument(c, opts...); err != nil {
			t.Fatal(err)
		}
		if err := c.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		if n := len(x.named("kyp.refresh")); (n == 1) != all {
			t.Fatalf("traceAll=%v: %d spans", all, n)
		}
	}
}
