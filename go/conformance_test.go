package kyp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testKey = "kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f"

const (
	greetingV4 = "Hello {{name}}, welcome to {{ company }}."
	greetingV5 = "Hi {{name}}! {{company}} is glad you are here."
)

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// harness: one server with cdn, origin and git routes, each serving its own
// copy of a fixture so tests can switch them independently.
type harness struct {
	srv  *cdnServer
	dirs map[string]string
}

func newHarness(t *testing.T, start func(*testing.T, []route) *cdnServer, fixture string) *harness {
	h := &harness{dirs: map[string]string{}}
	var routes []route
	for _, r := range []route{
		{name: "cdn", prefix: "/v1/d/" + testKey},
		{name: "origin", prefix: "/v1/delivery/" + testKey},
		{name: "git", prefix: "/git/acme/prompts/main/.kyp"},
	} {
		r.dir = t.TempDir()
		copyFixture(t, r.dir, fixture)
		h.dirs[r.name] = r.dir
		routes = append(routes, r)
	}
	h.srv = start(t, routes)
	return h
}

func (h *harness) set(t *testing.T, routeName, fixture string) {
	copyFixture(t, h.dirs[routeName], fixture)
}

func (h *harness) options() Options {
	return Options{
		App:            "demo",
		Env:            "prod",
		DeliveryKey:    testKey,
		CDNBase:        h.srv.base + "/v1/d",
		OriginBase:     h.srv.base + "/v1/delivery",
		GitMirror:      h.srv.base + "/git/acme/prompts/main/.kyp",
		GitToken:       "github_pat_test",
		PollInterval:   time.Hour, // tests drive refreshes with Refresh
		StartupTimeout: 5 * time.Second,
		Logger:         quietLogger(),
	}
}

func mustNew(t *testing.T, o Options, extra ...Option) *Client {
	t.Helper()
	c, err := New(context.Background(), o, extra...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func wantGreeting(t *testing.T, c *Client, version int64, text string) {
	t.Helper()
	p, err := c.Prompt("greeting")
	if err != nil {
		t.Fatal(err)
	}
	if p.Version != version || p.Text != text {
		t.Fatalf("greeting = v%d %q, want v%d %q", p.Version, p.Text, version, text)
	}
}

// Required behaviour 4: a blob whose SHA-256 differs from its name is rejected.
func TestConformanceHashCheck(t *testing.T) {
	backends(t, func(t *testing.T, start func(*testing.T, []route) *cdnServer) {
		h := newHarness(t, start, "v12")
		c := mustNew(t, h.options())
		for _, r := range []string{"cdn", "origin", "git"} {
			h.set(t, r, "tampered-v14")
		}
		if err := c.Refresh(context.Background()); err == nil {
			t.Fatal("refresh accepted a tampered manifest")
		}
		if c.Revision() != 12 {
			t.Fatalf("revision %d, want 12", c.Revision())
		}
		wantGreeting(t, c, 4, greetingV4)
		if st := c.Status(); !strings.Contains(st.LastError, "sha256") {
			t.Fatalf("last error %q does not mention sha256", st.LastError)
		}
	})
	// A tampered snapshot folder is refused at start-up too.
	_, err := New(context.Background(), Options{App: "demo", SnapshotDir: fixturePath("tampered-v14"), StartupTimeout: 200 * time.Millisecond, Logger: quietLogger()})
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("want ErrUnavailable, got %v", err)
	}
}

// Required behaviour 5: start from a local snapshot with no network.
func TestConformanceStartFromLocal(t *testing.T) {
	var requests atomic.Int64
	o := Options{
		App:         "demo",
		Env:         "prod",
		SnapshotDir: fixturePath("v12"),
		DeliveryKey: testKey,
		CDNBase:     "http://127.0.0.1:1/v1/d", // nothing listens there
		OriginBase:  "http://127.0.0.1:1/v1/delivery",
		Logger:      quietLogger(),
		HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			requests.Add(1)
			return nil, errors.New("network is off")
		})},
	}
	t0 := time.Now()
	c := mustNew(t, o)
	if d := time.Since(t0); d > time.Second {
		t.Fatalf("start-up took %s", d)
	}
	wantGreeting(t, c, 4, greetingV4)
	if st := c.Status(); st.Source != "snapshot" || st.Revision != 12 || !st.Ready || st.Workspace != "acme" || st.PromptCount != 4 {
		t.Fatalf("status %+v", st)
	}
	got, err := c.Render("greeting", Vars{"name": "Ana", "company": "Acme"})
	if err != nil || got != "Hello Ana, welcome to Acme." {
		t.Fatalf("render = %q, %v", got, err)
	}
	if s, _ := c.Get("agents/reviewer"); s != "Review the diff." {
		t.Fatalf("nested name: %q", s)
	}
	if s, err := c.Get("empty"); s != "" || err != nil {
		t.Fatalf("empty: %q %v", s, err)
	}
	if s, _ := c.Render("triage", Vars{"company": "Acme"}); s != "You are a support agent for Acme. Literal {{braces}} stay." {
		t.Fatalf("triage: %q", s)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Required behaviour 6: CDN first, origin second, git third (with bearer token).
func TestConformanceMirrorOrder(t *testing.T) {
	backends(t, func(t *testing.T, start func(*testing.T, []route) *cdnServer) {
		h := newHarness(t, start, "v12")
		c := mustNew(t, h.options())
		if src := c.Status().Source; src != "cdn" {
			t.Fatalf("source %q, want cdn", src)
		}
		st := h.srv.stats()
		if st["cdn"].OK == 0 || st["origin"].OK+st["git"].OK != 0 {
			t.Fatalf("stats after start: %+v", st)
		}
		if st["cdn"].Auth != nil {
			t.Fatalf("cdn got Authorization %q", *st["cdn"].Auth)
		}

		h.srv.down("cdn")
		if err := c.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		if s := c.Status(); s.Source != "origin" || !strings.Contains(s.LastError, "cdn: HTTP 503") {
			t.Fatalf("status %+v", s)
		}

		h.srv.down("origin")
		if err := c.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		if src := c.Status().Source; src != "git" {
			t.Fatalf("source %q, want git", src)
		}
		if a := h.srv.stats()["git"].Auth; a == nil || *a != "Bearer github_pat_test" {
			t.Fatalf("git Authorization = %v", a)
		}

		// A fresh client with CDN and origin down starts from git.
		c2 := mustNew(t, h.options())
		if src := c2.Status().Source; src != "git" {
			t.Fatalf("fresh client source %q, want git", src)
		}
		wantGreeting(t, c2, 4, greetingV4)

		// The CDN comes back and is preferred again.
		h.srv.up("cdn")
		if err := c.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		if src := c.Status().Source; src != "cdn" {
			t.Fatalf("source %q, want cdn", src)
		}
	})
}

// Required behaviour 7: the second poll sends If-None-Match and a 304 changes nothing.
func TestConformanceRevalidation(t *testing.T) {
	backends(t, func(t *testing.T, start func(*testing.T, []route) *cdnServer) {
		h := newHarness(t, start, "v12")
		var updates atomic.Int64
		c := mustNew(t, h.options(), WithOnUpdate(func(Update) { updates.Add(1) }))
		before := h.srv.stats()["cdn"]
		if before.NotModified != 0 {
			t.Fatalf("first poll got a 304: %+v", before)
		}
		for i := 0; i < 2; i++ {
			if err := c.Refresh(context.Background()); err != nil {
				t.Fatal(err)
			}
		}
		after := h.srv.stats()["cdn"]
		if after.NotModified != 2 {
			t.Fatalf("304s = %d, want 2 (stats %+v)", after.NotModified, after)
		}
		// Only the manifest was asked for again: no blob refetches.
		if after.OK != before.OK {
			t.Fatalf("200s went from %d to %d", before.OK, after.OK)
		}
		if c.Revision() != 12 || updates.Load() != 0 {
			t.Fatalf("revision %d, updates %d", c.Revision(), updates.Load())
		}
		if st := c.Status(); st.LastSuccess.IsZero() || st.LastError != "" || st.StaleFor > time.Minute {
			t.Fatalf("status %+v", st)
		}
	})
}

// Required behaviour 8: hot update from v12 to v13 after one refresh; the callback fires once.
func TestConformanceHotUpdate(t *testing.T) {
	backends(t, func(t *testing.T, start func(*testing.T, []route) *cdnServer) {
		h := newHarness(t, start, "v12")
		var mu sync.Mutex
		var got []Update
		c := mustNew(t, h.options(), WithOnUpdate(func(u Update) {
			mu.Lock()
			got = append(got, u)
			mu.Unlock()
		}))
		var second atomic.Int64
		unregister := c.OnUpdate(func(Update) { second.Add(1) })
		wantGreeting(t, c, 4, greetingV4)

		h.set(t, "cdn", "v13")
		if err := c.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		wantGreeting(t, c, 5, greetingV5)
		out, _ := c.Render("greeting", Vars{"name": "Ana", "company": "Acme"})
		if out != "Hi Ana! Acme is glad you are here." {
			t.Fatalf("render %q", out)
		}
		// Unchanged blobs are reused, only the new one is fetched.
		mu.Lock()
		if len(got) != 1 {
			t.Fatalf("callback fired %d times, want 1", len(got))
		}
		want := Update{OldRevision: 12, NewRevision: 13, Source: "cdn", Changed: []string{"greeting"}}
		if !reflect.DeepEqual(got[0], want) {
			t.Fatalf("update %+v, want %+v", got[0], want)
		}
		mu.Unlock()
		if second.Load() != 1 {
			t.Fatalf("registered callback fired %d times", second.Load())
		}
		unregister()
		// Another refresh with nothing new does not fire again.
		if err := c.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		defer mu.Unlock()
		if len(got) != 1 || second.Load() != 1 {
			t.Fatalf("callbacks fired again: %d, %d", len(got), second.Load())
		}
	})
}

// Required behaviour 9: a mirror serving v11-stale never replaces revision 12.
func TestConformanceStaleMirror(t *testing.T) {
	backends(t, func(t *testing.T, start func(*testing.T, []route) *cdnServer) {
		h := newHarness(t, start, "v12")
		c := mustNew(t, h.options())
		h.set(t, "cdn", "v11-stale")
		h.srv.down("origin")
		h.srv.down("git")
		if err := c.Refresh(context.Background()); err == nil {
			t.Fatal("a stale-only round counted as an answer")
		}
		if c.Revision() != 12 {
			t.Fatalf("revision %d", c.Revision())
		}
		wantGreeting(t, c, 4, greetingV4)
		if st := c.Status(); !strings.Contains(st.LastError, "stale manifest ignored (revision 11 < held 12)") {
			t.Fatalf("last error %q", st.LastError)
		}
		// With the origin back (still at 12) the stale CDN is skipped and 12 confirmed.
		h.srv.up("origin")
		if err := c.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		if st := c.Status(); st.Revision != 12 || st.Source != "origin" {
			t.Fatalf("status %+v", st)
		}
		// A local snapshot at 12 beats a network mirror at 11 for a fresh client.
		o := h.options()
		o.SnapshotDir = fixturePath("v12")
		h.srv.down("origin")
		c2 := mustNew(t, o)
		if err := c2.Refresh(context.Background()); err == nil {
			t.Fatal("expected the stale CDN to be ignored")
		}
		if c2.Revision() != 12 {
			t.Fatalf("revision %d", c2.Revision())
		}
	})
}

// Required behaviour 10: failures never evict; status reports the error and staleness.
func TestConformanceNeverEvict(t *testing.T) {
	backends(t, func(t *testing.T, start func(*testing.T, []route) *cdnServer) {
		h := newHarness(t, start, "v12")
		c := mustNew(t, h.options())
		for _, r := range []string{"cdn", "origin", "git"} {
			h.srv.down(r)
		}
		time.Sleep(30 * time.Millisecond)
		for i := 0; i < 3; i++ {
			if err := c.Refresh(context.Background()); !errors.Is(err, ErrUnavailable) {
				t.Fatalf("refresh with every mirror down: %v", err)
			}
		}
		wantGreeting(t, c, 4, greetingV4)
		st := c.Status()
		if !st.Ready || st.Revision != 12 {
			t.Fatalf("status %+v", st)
		}
		for _, want := range []string{"cdn: HTTP 503", "origin: HTTP 503", "git: HTTP 503"} {
			if !strings.Contains(st.LastError, want) {
				t.Fatalf("last error %q lacks %q", st.LastError, want)
			}
		}
		if st.StaleFor < 30*time.Millisecond {
			t.Fatalf("stale for %s", st.StaleFor)
		}
		var cdn MirrorStatus
		for _, m := range st.Mirrors {
			if m.Name == "cdn" {
				cdn = m
			}
		}
		if cdn.ConsecutiveFailures != 3 || cdn.LastError != "HTTP 503" {
			t.Fatalf("cdn mirror status %+v", cdn)
		}
		if strings.Contains(cdn.URL, testKey) || !strings.Contains(cdn.URL, "kypd_Ab3d...") {
			t.Fatalf("delivery key not redacted: %s", cdn.URL)
		}
	})
}

// Required behaviour 11: a new client starts from the disk cache alone.
func TestConformanceDiskCache(t *testing.T) {
	backends(t, func(t *testing.T, start func(*testing.T, []route) *cdnServer) {
		h := newHarness(t, start, "v12")
		cache := t.TempDir()
		o := h.options()
		o.CacheDir = cache
		c := mustNew(t, o)
		h.set(t, "cdn", "v13")
		if err := c.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		c.Close()
		root := filepath.Join(cache, "acme", "demo", "prod")
		if _, err := os.Stat(filepath.Join(root, "envs", "demo", "prod.json")); err != nil {
			t.Fatal(err)
		}

		// No delivery key, no network: only the cache directory.
		c2 := mustNew(t, Options{App: "demo", Env: "prod", CacheDir: cache, Logger: quietLogger()})
		if st := c2.Status(); st.Source != "disk-cache" || st.Revision != 13 {
			t.Fatalf("status %+v", st)
		}
		wantGreeting(t, c2, 5, greetingV5)
		if s, _ := c2.Get("agents/reviewer"); s != "Review the diff." {
			t.Fatalf("reviewer %q", s)
		}

		// Blobs are verified when read back: a damaged cache is never served.
		if err := os.WriteFile(filepath.Join(root, "blobs", "a413e0e86cf132f04fbac888b900733641d384cd0e9b42fd0042cf6942701cf2"), []byte("evil"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := New(context.Background(), Options{App: "demo", CacheDir: cache, Workspace: "acme", Logger: quietLogger()}); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("damaged cache: %v", err)
		}
	})
}

// Required behaviour 12: Get performs no I/O and is safe from many goroutines.
func TestConformanceReadPath(t *testing.T) {
	h := newHarness(t, newInprocCDN, "v12")
	var requests atomic.Int64
	base := http.DefaultTransport
	o := h.options()
	o.HTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requests.Add(1)
		return base.RoundTrip(r)
	})}
	c := mustNew(t, o)
	n := requests.Load()
	for i := 0; i < 100000; i++ {
		if _, err := c.Get("greeting"); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Render("triage", Vars{"company": "x"}); err != nil {
			t.Fatal(err)
		}
	}
	if requests.Load() != n {
		t.Fatalf("Get/Render did %d requests", requests.Load()-n)
	}

	// Many readers while the state is swapped back and forth.
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	var reads atomic.Int64
	for g := 0; g < 32; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				p, err := c.Prompt("greeting")
				if err != nil {
					t.Error(err)
					return
				}
				if !(p.Version == 4 && p.Text == greetingV4) && !(p.Version == 5 && p.Text == greetingV5) {
					t.Errorf("torn read: %+v", p)
					return
				}
				_ = c.Status()
				reads.Add(1)
			}
		}()
	}
	// Alternate greeting between v4 and v5 under ever-increasing revisions.
	dir := h.dirs["cdn"]
	v5blob, err := os.ReadFile(filepath.Join(fixturePath("v13"), "blobs", "a413e0e86cf132f04fbac888b900733641d384cd0e9b42fd0042cf6942701cf2"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "blobs", "a413e0e86cf132f04fbac888b900733641d384cd0e9b42fd0042cf6942701cf2"), v5blob, 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		sha, ver := "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d", 4
		if i%2 == 0 {
			sha, ver = "a413e0e86cf132f04fbac888b900733641d384cd0e9b42fd0042cf6942701cf2", 5
		}
		m := fmt.Sprintf(`{"schema":1,"workspace":"acme","app":"demo","env":"prod","revision":%d,"deployed_at":"x","prompts":{"greeting":{"sha256":%q,"version":%d}}}`, 13+i, sha, ver)
		if err := os.WriteFile(filepath.Join(dir, "envs", "demo", "prod.json"), []byte(m), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := c.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		if c.Revision() != int64(13+i) {
			t.Fatalf("revision %d, want %d", c.Revision(), 13+i)
		}
	}
	time.Sleep(20 * time.Millisecond)
	cancel()
	wg.Wait()
	if reads.Load() == 0 {
		t.Fatal("no reads")
	}
}

// The embedded snapshot (an fs.FS, as //go:embed produces) starts with zero network.
func TestEmbeddedSnapshot(t *testing.T) {
	fsys := embedFixture(t, "prompts", "v12")
	c := mustNew(t, Options{App: "demo", Logger: quietLogger()}, WithEmbeddedSnapshot(fsys))
	if st := c.Status(); st.Source != "embedded" || st.Revision != 12 {
		t.Fatalf("status %+v", st)
	}
	wantGreeting(t, c, 4, greetingV4)
	if st := c.Status(); st.Mirrors[0].URL != "embedded:" {
		t.Fatalf("mirror url %q", st.Mirrors[0].URL)
	}

	// Root-level layout works too, and a newer snapshot folder wins over it.
	c2 := mustNew(t, Options{App: "demo", SnapshotDir: fixturePath("v13"), Logger: quietLogger()},
		WithEmbeddedSnapshot(os.DirFS(fixturePath("v12"))))
	if st := c2.Status(); st.Source != "snapshot" || st.Revision != 13 {
		t.Fatalf("status %+v", st)
	}
}
