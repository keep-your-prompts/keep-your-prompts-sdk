package kyp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
)

const greetingSHA = "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"

type recorder struct {
	mu      sync.Mutex
	rounds  []RefreshRecord
	renders []RenderError
}

func (r *recorder) OnRefresh(rec RefreshRecord) {
	r.mu.Lock()
	r.rounds = append(r.rounds, rec)
	r.mu.Unlock()
}

func (r *recorder) OnRenderError(e RenderError) {
	r.mu.Lock()
	r.renders = append(r.renders, e)
	r.mu.Unlock()
}

func (r *recorder) last(t *testing.T) RefreshRecord {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.rounds) == 0 {
		t.Fatal("no refresh record")
	}
	return r.rounds[len(r.rounds)-1]
}

func eventNames(rec RefreshRecord) []string {
	var out []string
	for _, e := range rec.Events {
		out = append(out, e.Name)
	}
	return out
}

func TestMetaAndMaps(t *testing.T) {
	c := mustNew(t, Options{App: "demo", SnapshotDir: fixturePath("v12"), Logger: quietLogger()})
	m, err := c.Meta("greeting")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"kyp.prompt.name": "greeting", "kyp.prompt.version": int64(4), "kyp.prompt.sha256": greetingSHA,
		"kyp.app": "demo", "kyp.env": "prod", "kyp.revision": int64(12), "kyp.workspace": "acme", "kyp.source": "snapshot",
		"gen_ai.prompt.name": "greeting", "gen_ai.prompt.version": "4",
	}
	if got := m.Attributes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("attributes\n got %v\nwant %v", got, want)
	}
	flat := map[string]any{
		"kyp_prompt_name": "greeting", "kyp_prompt_version": int64(4), "kyp_prompt_sha256": greetingSHA,
		"kyp_app": "demo", "kyp_env": "prod", "kyp_revision": int64(12), "kyp_workspace": "acme", "kyp_source": "snapshot",
	}
	for _, got := range []map[string]any{m.TraceMetadata(), m.LangfuseMetadata(), m.LangSmithMetadata()} {
		if !reflect.DeepEqual(got, flat) {
			t.Fatalf("metadata\n got %v\nwant %v", got, flat)
		}
	}
	r, err := c.RenderWithMeta("greeting", Vars{"name": "Ada", "company": "Acme"})
	if err != nil || r.Text != "Hello Ada, welcome to Acme." || r.Meta != m {
		t.Fatalf("RenderWithMeta: %+v %v", r, err)
	}
	if _, err := c.Meta("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Meta(nope): %v", err)
	}
}

func TestObserverFallbackUpdateAndHashMismatch(t *testing.T) {
	h := newHarness(t, newInprocCDN, "v12")
	rec := &recorder{}
	c := mustNew(t, h.options(), WithObserver(rec))
	start := rec.last(t)
	if start.Trigger != TriggerStart || start.Result != ResultUpdated || start.Source != SourceCDN || start.Revision != 12 ||
		!reflect.DeepEqual(eventNames(start), []string{"kyp.update"}) {
		t.Fatalf("start round: %+v", start)
	}

	// CDN down: fallback to origin, which confirms (not modified).
	h.srv.down("cdn")
	ctx := context.WithValue(context.Background(), struct{}{}, "caller")
	if err := c.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	r := rec.last(t)
	if r.Trigger != TriggerManual || r.Result != ResultNotModified || r.Source != SourceOrigin || r.Ctx == nil || r.Ctx.Value(struct{}{}) != "caller" {
		t.Fatalf("manual round: %+v", r)
	}
	if len(r.Events) != 1 || r.Events[0].Name != "kyp.fallback" || r.Events[0].Attributes["error.type"] != "http_503" ||
		r.Events[0].Attributes["kyp.source"] != SourceCDN {
		t.Fatalf("events: %+v", r.Events)
	}
	if m, _ := c.Meta("greeting"); m.Source != SourceOrigin {
		t.Fatalf("meta source %q", m.Source)
	}
	h.srv.up("cdn")

	// A tampered blob on the CDN, v13 on the origin.
	h.set(t, "cdn", "tampered-v14")
	h.set(t, "origin", "v13")
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	r = rec.last(t)
	if got := eventNames(r); !reflect.DeepEqual(got, []string{"kyp.hash_mismatch", "kyp.fallback", "kyp.update"}) {
		t.Fatalf("events %v", got)
	}
	if r.Events[1].Attributes["error.type"] != "blob_unavailable" || r.Result != ResultUpdated || r.Revision != 13 || r.PreviousRevision != 12 {
		t.Fatalf("round %+v", r)
	}
	if u := r.Events[2].Attributes; u["kyp.revision.previous"] != int64(12) || u["kyp.prompts.changed"] != int64(1) {
		t.Fatalf("update %v", u)
	}

	// Everything down: failed with the last error type.
	for _, n := range []string{"cdn", "origin", "git"} {
		h.srv.down(n)
	}
	if err := c.Refresh(context.Background()); err == nil {
		t.Fatal("refresh should fail")
	}
	r = rec.last(t)
	if r.Result != ResultFailed || r.ErrorType != "http_503" || r.Source != "" || r.Error == "" {
		t.Fatalf("failed round %+v", r)
	}
}

func TestRenderErrorsAndPanickingObserver(t *testing.T) {
	rec := &recorder{}
	c := mustNew(t, Options{App: "demo", SnapshotDir: fixturePath("v12"), Logger: quietLogger()},
		WithObserver(rec), WithObserver(ObserverFuncs{
			Refresh:     func(RefreshRecord) { panic("boom") },
			RenderError: func(RenderError) { panic("boom") },
		}))
	if _, err := c.Render("greeting", Vars{"name": "x"}); !errors.Is(err, ErrMissingVariable) {
		t.Fatal(err)
	}
	if _, err := c.RenderWithMeta("nope", nil); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	want := []RenderError{{App: "demo", Env: "prod", Name: "greeting", ErrorType: "missing_variable"}, {App: "demo", Env: "prod", Name: "nope", ErrorType: "not_found"}}
	if !reflect.DeepEqual(rec.renders, want) {
		t.Fatalf("renders %+v", rec.renders)
	}
}

func TestRecordOutcomeWithMeta(t *testing.T) {
	var mu sync.Mutex
	var sent []map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b []map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		sent = append(sent, b...)
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	defer api.Close()
	h := newHarness(t, newInprocCDN, "v12")
	o := h.options()
	o.APIKey, o.APIURL = "kyp_live_test", api.URL
	c := mustNew(t, o)
	r, err := c.RenderWithMeta("greeting", Vars{"name": "a", "company": "b"})
	if err != nil {
		t.Fatal(err)
	}
	h.set(t, "cdn", "v13")
	if err := c.Refresh(context.Background()); err != nil || c.Revision() != 13 {
		t.Fatalf("refresh: %v rev %d", err, c.Revision())
	}
	if err := c.RecordOutcome(Outcome{Meta: &r.Meta, Result: OutcomeSuccess}); err != nil {
		t.Fatal(err)
	}
	if err := c.FlushOutcomes(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 1 || sent[0]["sha256"] != greetingSHA || sent[0]["prompt"] != "greeting" {
		t.Fatalf("sent %v", sent)
	}
}

func TestClassifyError(t *testing.T) {
	for in, want := range map[string]string{
		"HTTP 503":                                          "http_503",
		"manifest not found (HTTP 404)":                     "not_found",
		"stale manifest ignored (revision 11 < 12)":         "stale",
		"bad manifest: schema 2":                            "bad_manifest",
		"blob 5d3d1a279222 unavailable (cdn: x)":            "blob_unavailable",
		"context deadline exceeded":                         "timeout",
		"dial tcp 127.0.0.1:1: connect: connection refused": "network",
		"weird": "_OTHER",
	} {
		if got := ClassifyError(in); got != want {
			t.Errorf("ClassifyError(%q) = %q, want %q", in, got, want)
		}
	}
	if NormalizeSource("disk-cache", Mirror{}) != SourceCache || NormalizeSource("mine", Mirror{URL: "https://x"}) != SourceCustom ||
		NormalizeSource("mine", Mirror{URL: "/srv/p"}) != SourceSnapshot {
		t.Fatal("NormalizeSource")
	}
}
