package kyp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

// embedFixture builds an fs.FS like //go:embed <prefix> would, holding a fixture.
func embedFixture(t *testing.T, prefix, fixture string) fs.FS {
	t.Helper()
	m := fstest.MapFS{}
	src := fixturePath(fixture)
	err := filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		b, err := os.ReadFile(p)
		m[prefix+"/"+filepath.ToSlash(rel)] = &fstest.MapFile{Data: b}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestNewValidation(t *testing.T) {
	if _, err := New(context.Background(), Options{}); err == nil || !strings.Contains(err.Error(), "KYP_APP") {
		t.Fatalf("missing app: %v", err)
	}
	if _, err := New(context.Background(), Options{App: "Bad App"}); err == nil {
		t.Fatal("accepted a bad app slug")
	}
	_, err := New(context.Background(), Options{App: "demo", Logger: quietLogger()})
	if !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "KYP_DELIVERY_KEY") {
		t.Fatalf("no mirrors: %v", err)
	}
	c, err := New(context.Background(), Options{App: "demo", StartEmpty: true, Logger: quietLogger()})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Get("greeting"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty client Get: %v", err)
	}
	if c.Revision() != 0 || c.Names() != nil || c.Status().Ready || c.Contains("greeting") {
		t.Fatal("empty client reports state")
	}
	if _, err := c.Snapshot(); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("snapshot of empty client: %v", err)
	}
}

func TestStartupTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	o := Options{App: "demo", DeliveryKey: testKey, CDNBase: srv.URL, OriginBase: srv.URL, StartupTimeout: 300 * time.Millisecond, Logger: quietLogger()}
	t0 := time.Now()
	_, err := New(context.Background(), o)
	if !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "HTTP 503") {
		t.Fatalf("got %v", err)
	}
	if strings.Contains(err.Error(), testKey) {
		t.Fatalf("error leaks the delivery key: %v", err)
	}
	if d := time.Since(t0); d > 2*time.Second {
		t.Fatalf("took %s", d)
	}
	// A cancelled context stops start-up early.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New(ctx, o); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("cancelled: %v", err)
	}
	// StartEmpty starts and keeps trying.
	o.StartEmpty = true
	c := mustNew(t, o)
	if c.Status().Ready {
		t.Fatal("ready without a manifest")
	}
}

func TestNotFoundError(t *testing.T) {
	c := mustNew(t, Options{App: "demo", SnapshotDir: fixturePath("v12"), Logger: quietLogger()})
	_, err := c.Render("nope", nil)
	var nf *NotFoundError
	if !errors.As(err, &nf) || nf.Name != "nope" || !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
	if err.Error() != `kyp: prompt not found: "nope" (demo/prod revision 12)` {
		t.Fatalf("message %q", err.Error())
	}
	if _, err := c.Render("greeting", Vars{"name": "x"}); !errors.Is(err, ErrMissingVariable) {
		t.Fatalf("got %v", err)
	}
	if s, _ := c.Render("greeting", Vars{"name": "x"}, MissingKeep); s != "Hello x, welcome to {{ company }}." {
		t.Fatalf("lenient %q", s)
	}
	p, _ := c.Prompt("greeting")
	if strings.Join(p.Variables, ",") != "name,company" || p.SHA256[:6] != "5d3d1a" {
		t.Fatalf("prompt %+v", p)
	}
	if s, _ := p.Render(Vars{"name": "A", "company": "B"}); s != "Hello A, welcome to B." {
		t.Fatalf("Prompt.Render %q", s)
	}
	if got := strings.Join(c.Names(), ","); got != "agents/reviewer,empty,greeting,triage" {
		t.Fatalf("names %s", got)
	}
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatalf("refresh of a file mirror: %v", err)
	}
}

// With no network mirror, the snapshot folder is polled so a sidecar or
// `git pull` that updates it is picked up live.
func TestFileMirrorPolling(t *testing.T) {
	dir := t.TempDir()
	copyFixture(t, dir, "v12")
	updated := make(chan Update, 4)
	c := mustNew(t, Options{App: "demo", SnapshotDir: dir, PollInterval: 100 * time.Millisecond, Logger: quietLogger(),
		OnUpdate: func(u Update) { updated <- u }})
	copyFixture(t, dir, "v13")
	select {
	case u := <-updated:
		if u.NewRevision != 13 || u.Source != "snapshot" {
			t.Fatalf("update %+v", u)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("background poll did not pick up v13")
	}
	wantGreeting(t, c, 5, greetingV5)
}

// The background refresher upgrades from a local snapshot as soon as the network answers.
func TestBackgroundRefresh(t *testing.T) {
	h := newHarness(t, newInprocCDN, "v13")
	o := h.options()
	o.SnapshotDir = fixturePath("v12")
	o.PollInterval = 100 * time.Millisecond
	updated := make(chan Update, 4)
	c := mustNew(t, o, WithOnUpdate(func(u Update) { updated <- u }))
	select {
	case u := <-updated:
		if u.OldRevision != 12 || u.NewRevision != 13 || u.Source != "cdn" {
			t.Fatalf("update %+v", u)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no background update")
	}
	wantGreeting(t, c, 5, greetingV5)
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	if err := c.Refresh(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("refresh after close: %v", err)
	}
	wantGreeting(t, c, 5, greetingV5) // reads keep working
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
}

// A failing mirror is skipped (backoff) on scheduled rounds while another answers.
func TestBackoff(t *testing.T) {
	h := newHarness(t, newInprocCDN, "v12")
	c := mustNew(t, h.options())
	h.srv.down("cdn")
	for i := 0; i < 3; i++ {
		c.refreshMu.Lock()
		ok, _ := c.round(context.Background(), false)
		c.refreshMu.Unlock()
		if !ok {
			t.Fatal("origin should answer")
		}
	}
	// Round 1 tries the CDN (no backoff after the first failure), round 2 too
	// (0 intervals), round 3 skips it (1 poll interval).
	if got := h.srv.stats()["cdn"].Down; got != 2 {
		t.Fatalf("cdn tried %d times, want 2", got)
	}
	if !c.inBackoff(0) {
		t.Fatal("cdn should be backing off")
	}
	// Every mirror down: the ones in backoff get a chance too.
	h.srv.down("origin")
	h.srv.down("git")
	c.refreshMu.Lock()
	ok, errs := c.round(context.Background(), false)
	c.refreshMu.Unlock()
	if ok || !strings.Contains(errs, "cdn: HTTP 503") {
		t.Fatalf("ok=%v errs=%q", ok, errs)
	}
}

func TestPullSnapshot(t *testing.T) {
	h := newHarness(t, newInprocCDN, "v12")
	if _, err := PullSnapshot(context.Background(), Options{App: "demo"}); err == nil {
		t.Fatal("pull without a source")
	}
	o := h.options()
	o.SnapshotDir = fixturePath("v13") // ignored: a pull reflects what is deployed
	snap, err := PullSnapshot(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Manifest.Revision != 12 || len(snap.Blobs) != 4 || snap.Source != "cdn" {
		t.Fatalf("snapshot rev %d blobs %d source %s", snap.Manifest.Revision, len(snap.Blobs), snap.Source)
	}
	out := t.TempDir()
	n, err := snap.WriteDir(out)
	if err != nil || n != 4 {
		t.Fatalf("wrote %d: %v", n, err)
	}
	if n, _ := snap.WriteDir(out); n != 0 {
		t.Fatalf("rewrote %d existing blobs", n)
	}
	raw, _ := os.ReadFile(filepath.Join(out, "envs", "demo", "prod.json"))
	orig, _ := os.ReadFile(filepath.Join(fixturePath("v12"), "envs", "demo", "prod.json"))
	if !bytes.Equal(raw, orig) {
		t.Fatal("manifest not byte-identical")
	}
	// The written folder is a mirror.
	c := mustNew(t, Options{App: "demo", SnapshotDir: out, Logger: quietLogger()})
	wantGreeting(t, c, 4, greetingV4)
}

func TestOutcomes(t *testing.T) {
	var mu sync.Mutex
	var bodies [][]map[string]any
	var auth string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/apps/demo/outcomes" {
			http.NotFound(w, r)
			return
		}
		var b []map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		bodies = append(bodies, b)
		auth = r.Header.Get("Authorization")
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	defer api.Close()

	noKey := mustNew(t, Options{App: "demo", SnapshotDir: fixturePath("v12"), Logger: quietLogger()})
	if err := noKey.RecordOutcome(Outcome{Prompt: "greeting", Result: OutcomeSuccess}); !errors.Is(err, ErrOutcomesDisabled) {
		t.Fatalf("got %v", err)
	}

	c, err := New(context.Background(), Options{App: "demo", SnapshotDir: fixturePath("v12"), APIKey: "kyp_live_test", APIURL: api.URL, Logger: quietLogger()})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.RecordOutcome(Outcome{Prompt: "nope", Result: OutcomeSuccess}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown prompt: %v", err)
	}
	if err := c.RecordOutcome(Outcome{Prompt: "greeting", Result: "meh"}); err == nil {
		t.Fatal("accepted a bad outcome")
	}
	if err := c.RecordOutcome(Outcome{Prompt: "greeting", Result: OutcomeSuccess, Latency: 1500 * time.Millisecond, InputTokens: 10, OutputTokens: 20}); err != nil {
		t.Fatal(err)
	}
	if err := c.RecordOutcome(Outcome{Prompt: "triage", Result: OutcomeFailure}); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err != nil { // Close flushes
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 1 || len(bodies[0]) != 2 || auth != "Bearer kyp_live_test" {
		t.Fatalf("bodies %v auth %q", bodies, auth)
	}
	first := bodies[0][0]
	if first["env"] != "prod" || first["prompt"] != "greeting" || first["sha256"] != "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d" ||
		first["outcome"] != "success" || first["latencyMs"] != float64(1500) || first["inputTokens"] != float64(10) {
		t.Fatalf("record %v", first)
	}
	if _, ok := bodies[0][1]["latencyMs"]; ok {
		t.Fatal("zero latency should be omitted")
	}
}

func TestOptionsFromEnv(t *testing.T) {
	t.Setenv("KYP_APP", "demo")
	t.Setenv("KYP_ENV", "staging")
	t.Setenv("KYP_DELIVERY_KEY", testKey)
	t.Setenv("KYP_SNAPSHOT_DIR", "/snap")
	t.Setenv("KYP_CACHE_DIR", "/cache")
	t.Setenv("KYP_GIT_MIRROR", "https://git.example/.kyp")
	t.Setenv("KYP_GIT_TOKEN", "tok")
	t.Setenv("KYP_CDN_URL", "https://cdn.example")
	t.Setenv("KYP_ORIGIN_URL", "https://origin.example")
	t.Setenv("KYP_POLL_INTERVAL", "2.5")
	t.Setenv("KYP_WORKSPACE", "acme")
	t.Setenv("KYP_API_KEY", "kyp_live_x")
	t.Setenv("KYP_API_URL", "https://api.example")
	t.Setenv("KYP_LOG", "off")
	o := OptionsFromEnv()
	if o.App != "demo" || o.Env != "staging" || o.DeliveryKey != testKey || o.SnapshotDir != "/snap" || o.CacheDir != "/cache" ||
		o.GitMirror != "https://git.example/.kyp" || o.GitToken != "tok" || o.CDNBase != "https://cdn.example" ||
		o.OriginBase != "https://origin.example" || o.PollInterval != 2500*time.Millisecond || o.Workspace != "acme" ||
		o.APIKey != "kyp_live_x" || o.APIURL != "https://api.example" || o.Logger == nil {
		t.Fatalf("options %+v", o)
	}
	// Mirror order: embedded, snapshot, disk-cache, cdn, origin, git.
	c := &Client{opts: o, cacheIdx: -1}
	c.opts.Embedded = fstest.MapFS{}
	c.opts.applyDefaults()
	c.buildMirrors()
	var names []string
	for _, m := range c.mirrors {
		names = append(names, m.cfg.Name)
	}
	if got := strings.Join(names, ","); got != "embedded,snapshot,disk-cache,cdn,origin,git" {
		t.Fatalf("mirror order %s", got)
	}
	if c.mirrors[3].cfg.URL != "https://cdn.example/"+testKey || c.mirrors[5].cfg.BearerToken != "tok" {
		t.Fatalf("mirrors %+v", c.mirrors[3].cfg)
	}
}

func TestFromEnvAndLogging(t *testing.T) {
	t.Setenv("KYP_APP", "demo")
	t.Setenv("KYP_SNAPSHOT_DIR", fixturePath("v12"))
	t.Setenv("KYP_DELIVERY_KEY", "")
	t.Setenv("KYP_LOG", "")
	var buf safeBuffer
	c, err := FromEnv(context.Background(), WithLogger(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	wantGreeting(t, c, 4, greetingV4)
	if !strings.Contains(buf.String(), "loaded demo/prod revision 12") {
		t.Fatalf("log: %s", buf.String())
	}

	// The delivery key never reaches the logs.
	buf.Reset()
	o := Options{App: "demo", DeliveryKey: testKey, CDNBase: "http://127.0.0.1:1", OriginBase: "http://127.0.0.1:1",
		SnapshotDir: fixturePath("v12"), Logger: slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))}
	c2 := mustNew(t, o)
	_ = c2.Refresh(context.Background())
	c2.Close()
	if strings.Contains(buf.String(), testKey) || buf.Len() == 0 {
		t.Fatalf("log leaks the key or is empty: %s", buf.String())
	}
}

type safeBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *safeBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *safeBuffer) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }
func (s *safeBuffer) Len() int       { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Len() }
func (s *safeBuffer) Reset()         { s.mu.Lock(); defer s.mu.Unlock(); s.b.Reset() }

// A panicking callback is recovered and does not stop later updates.
func TestCallbackPanic(t *testing.T) {
	h := newHarness(t, newInprocCDN, "v12")
	c := mustNew(t, h.options())
	var calls atomic.Int64
	c.OnUpdate(func(Update) { calls.Add(1); panic("boom") })
	h.set(t, "cdn", "v13")
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || c.Revision() != 13 {
		t.Fatalf("calls %d revision %d", calls.Load(), c.Revision())
	}
}

func TestFileURLMirror(t *testing.T) {
	abs, err := filepath.Abs(fixturePath("v12"))
	if err != nil {
		t.Fatal(err)
	}
	u := "file://" + filepath.ToSlash(abs)
	if !strings.HasPrefix(filepath.ToSlash(abs), "/") {
		u = "file:///" + filepath.ToSlash(abs) // file:///C:/...
	}
	c := mustNew(t, Options{App: "demo", Mirrors: []Mirror{FileMirror(u, "bundle")}, Logger: quietLogger()})
	if st := c.Status(); st.Source != "bundle" {
		t.Fatalf("status %+v", st)
	}
}
