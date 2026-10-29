package kyp

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Prompt is a deployed prompt. Treat Variables as read-only: it is shared with
// the client's state.
type Prompt struct {
	Name      string
	Version   int64
	SHA256    string
	Variables []string
	Text      string // the raw template
}

// Render renders the prompt's template (see RenderTemplate).
func (p Prompt) Render(vars Vars, onMissing ...OnMissing) (string, error) {
	return RenderTemplate(p.Text, vars, onMissing...)
}

// MirrorStatus is the health of one mirror.
type MirrorStatus struct {
	Name                string
	URL                 string // delivery key redacted
	ConsecutiveFailures int
	LastError           string
	LastSuccess         time.Time // zero if never
}

// Status reports what the client holds and how fresh it is.
type Status struct {
	Ready       bool   // a manifest is loaded
	Source      string // mirror that served or last confirmed the state: embedded, snapshot, disk-cache, cdn, origin, git
	Revision    int64
	Workspace   string
	DeployedAt  string
	PromptCount int
	// LastSuccess is the last time a polled mirror confirmed the manifest (200 or 304). Zero if never.
	LastSuccess time.Time
	// LastError lists failures of the latest refresh round; empty when the first mirror answered.
	LastError string
	// StaleFor is the time since LastSuccess (since start-up if never). Alert on it.
	StaleFor time.Duration
	Mirrors  []MirrorStatus
}

// state is immutable once published.
type state struct {
	manifest *Manifest
	raw      []byte
	prompts  map[string]*Prompt
	names    []string
	bySHA    map[string]string
}

type mirrorRT struct {
	cfg    Mirror
	kind   mirrorKind
	source string // kyp.source
	fsys   fs.FS  // kindFS
	dir    string // kindFile
	etag   string // guarded by refreshMu

	// guarded by statusMu
	failures int
	retryAt  time.Time
	lastErr  string
	lastOK   time.Time
}

type callback struct{ fn func(Update) }

// Client serves deployed prompts from memory and keeps them fresh in the
// background. It is safe for concurrent use. Create one with New or FromEnv and
// call Close when done.
type Client struct {
	opts     Options
	cur      atomic.Pointer[state]
	mirrors  []*mirrorRT
	polled   []int
	cacheIdx int
	httpc    *http.Client
	log      logger

	refreshMu sync.Mutex
	cacheRoot string // guarded by refreshMu

	statusMu    sync.Mutex
	source      string
	lastError   string
	lastSuccess time.Time
	started     time.Time

	cbMu      sync.Mutex
	cbs       []*callback
	pendingMu sync.Mutex
	pending   []Update
	deliverMu sync.Mutex

	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	closeOnce sync.Once
	closeErr  error

	outcomes *outcomeReporter

	obsMu      sync.Mutex
	observers  atomic.Pointer[[]*observerBox]
	events     []TelemetryEvent // span events of the round in progress; guarded by refreshMu
	sourceKind atomic.Value     // string: kyp.source of the mirror that served or confirmed the state
}

type outcome int

const (
	outUpdated outcome = iota
	outUnchanged
	outStale
	outFailed
)

// New creates a client. It loads the embedded snapshot, snapshot folder and
// disk cache without touching the network and returns at once when any of
// them holds the manifest (the highest revision wins). Otherwise it blocks on
// the network mirrors for up to Options.StartupTimeout (or until ctx is done)
// and returns an error matching ErrUnavailable, unless Options.StartEmpty is
// set. ctx only bounds start-up; the background refresher runs until Close.
func New(ctx context.Context, opts Options, extra ...Option) (*Client, error) {
	for _, fn := range extra {
		fn(&opts)
	}
	if opts.App == "" {
		return nil, errors.New("kyp: app is not set (Options.App or KYP_APP)")
	}
	opts.applyDefaults()
	if !IsSlug(opts.App) || !IsSlug(opts.Env) {
		return nil, fmt.Errorf("kyp: app %q and env %q must be lowercase slugs ([a-z0-9][a-z0-9-]{0,62})", opts.App, opts.Env)
	}
	c := &Client{opts: opts, cacheIdx: -1, started: time.Now(), log: logger{opts.Logger, opts.DeliveryKey}}
	if opts.DeliveryKey != "" && !strings.HasPrefix(opts.DeliveryKey, "kypd_") {
		c.log.warn("delivery key does not start with kypd_; check KYP_DELIVERY_KEY")
	}
	c.httpc = opts.HTTPClient
	if c.httpc == nil {
		c.httpc = newHTTPClient(&c.opts)
	}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	c.buildMirrors()
	if opts.OnUpdate != nil {
		c.cbs = append(c.cbs, &callback{fn: opts.OnUpdate})
	}
	c.outcomes = newOutcomeReporter(c)
	for _, o := range opts.Observers {
		if o != nil {
			c.AddObserver(o)
		}
	}

	c.loadLocal()
	loadedLocally := c.cur.Load() != nil
	if !loadedLocally {
		if len(c.polled) == 0 {
			if !opts.StartEmpty {
				c.cancel()
				return nil, &unavailableError{msg: "no prompts for " + c.what() +
					": no snapshot or disk cache found and no remote mirror configured " +
					"(set KYP_DELIVERY_KEY, KYP_SNAPSHOT_DIR or embed a snapshot)"}
			}
			c.log.warn("starting empty: no mirror for " + c.what())
		} else if err := c.startupFromNetwork(ctx); err != nil {
			c.cancel()
			return nil, err
		}
	}
	if len(c.polled) > 0 {
		immediate := loadedLocally || c.cur.Load() == nil
		c.wg.Add(1)
		go c.run(immediate)
	}
	return c, nil
}

func (c *Client) what() string { return c.opts.App + "/" + c.opts.Env }

func (c *Client) manifestPath() string { return "envs/" + c.opts.App + "/" + c.opts.Env + ".json" }

func (c *Client) buildMirrors() {
	o := &c.opts
	add := func(m Mirror, kind mirrorKind) {
		rt := &mirrorRT{cfg: m, kind: kind, source: NormalizeSource(m.Name, m)}
		switch kind {
		case kindFS:
			rt.fsys = embeddedRoot(m.FS, o.App, o.Env)
		case kindFile, kindCache:
			rt.dir = fileURLToPath(m.URL)
		}
		c.mirrors = append(c.mirrors, rt)
	}
	var rest []Mirror
	if len(o.Mirrors) > 0 {
		rest = append(rest, o.Mirrors...)
	} else {
		if o.SnapshotDir != "" {
			rest = append(rest, FileMirror(o.SnapshotDir, "snapshot"))
		}
		if o.DeliveryKey != "" {
			rest = append(rest, HTTPMirror(joinURL(o.CDNBase, o.DeliveryKey), "cdn", ""))
			rest = append(rest, HTTPMirror(joinURL(o.OriginBase, o.DeliveryKey), "origin", ""))
		}
		if o.GitMirror != "" {
			rest = append(rest, HTTPMirror(o.GitMirror, "git", o.GitToken))
		}
	}
	rest = append(rest, o.ExtraMirrors...)
	if o.Embedded != nil {
		add(FSMirror(o.Embedded, "embedded"), kindFS)
	}
	addCache := func() {
		if o.CacheDir != "" && c.cacheIdx < 0 {
			c.cacheIdx = len(c.mirrors)
			add(Mirror{Name: "disk-cache", URL: o.CacheDir}, kindCache)
		}
	}
	for _, m := range rest {
		k := classify(m)
		if k == kindHTTP {
			addCache()
		}
		if m.Name == "" {
			m.Name = fmt.Sprintf("mirror-%d", len(c.mirrors)+1)
		}
		add(m, k)
	}
	addCache()
	for i, m := range c.mirrors {
		if m.kind == kindHTTP {
			c.polled = append(c.polled, i)
		}
	}
	if len(c.polled) == 0 {
		// No network mirrors: poll the file mirrors instead, so a snapshot folder
		// kept current by a sidecar or `git pull` is picked up live.
		for i, m := range c.mirrors {
			if m.kind == kindFile {
				c.polled = append(c.polled, i)
			}
		}
	}
}

// embeddedRoot finds envs/<app>/<env>.json at the root of fsys or one level
// below (//go:embed prompts yields an FS whose root holds "prompts/").
func embeddedRoot(fsys fs.FS, app, env string) fs.FS {
	mp := "envs/" + app + "/" + env + ".json"
	if _, err := fs.Stat(fsys, mp); err == nil {
		return fsys
	}
	if entries, err := fs.ReadDir(fsys, "."); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			if _, err := fs.Stat(fsys, e.Name()+"/"+mp); err == nil {
				if sub, err := fs.Sub(fsys, e.Name()); err == nil {
					return sub
				}
			}
		}
	}
	return fsys
}

// ---------------------------------------------------------------------------
// Read path: one atomic load and a map lookup. No I/O, no locks.
// ---------------------------------------------------------------------------

func (c *Client) find(name string) (*Prompt, error) {
	return c.findIn(c.cur.Load(), name)
}

func (c *Client) findIn(s *state, name string) (*Prompt, error) {
	if s == nil {
		return nil, &NotFoundError{Name: name, Detail: "nothing loaded for " + c.what()}
	}
	if p, ok := s.prompts[name]; ok {
		return p, nil
	}
	return nil, &NotFoundError{Name: name, Detail: fmt.Sprintf("%s revision %d", c.what(), s.manifest.Revision)}
}

// Get returns the raw template of a deployed prompt, or a *NotFoundError.
func (c *Client) Get(name string) (string, error) {
	p, err := c.find(name)
	if err != nil {
		return "", err
	}
	return p.Text, nil
}

// Contains reports whether name is deployed.
func (c *Client) Contains(name string) bool {
	s := c.cur.Load()
	if s == nil {
		return false
	}
	_, ok := s.prompts[name]
	return ok
}

// Prompt returns name, version, sha256, variables and text of a deployed prompt.
func (c *Client) Prompt(name string) (Prompt, error) {
	p, err := c.find(name)
	if err != nil {
		return Prompt{}, err
	}
	return *p, nil
}

// Render renders a deployed prompt. Errors: *NotFoundError, *MissingVariableError.
func (c *Client) Render(name string, vars Vars, onMissing ...OnMissing) (string, error) {
	p, err := c.find(name)
	if err != nil {
		c.renderFailed(name, err)
		return "", err
	}
	text, err := RenderTemplate(p.Text, vars, onMissing...)
	if err != nil {
		c.renderFailed(name, err)
	}
	return text, err
}

// Names returns the prompt names of the current revision, sorted.
func (c *Client) Names() []string {
	s := c.cur.Load()
	if s == nil {
		return nil
	}
	return append([]string(nil), s.names...)
}

// Revision returns the current revision, 0 when nothing is loaded.
func (c *Client) Revision() int64 {
	if s := c.cur.Load(); s != nil {
		return s.manifest.Revision
	}
	return 0
}

// Status reports health, for logs and metrics.
func (c *Client) Status() Status {
	s := c.cur.Load()
	var st Status
	if s != nil {
		st.Ready = true
		st.Revision = s.manifest.Revision
		st.Workspace = s.manifest.Workspace
		st.DeployedAt = s.manifest.DeployedAt
		st.PromptCount = len(s.prompts)
	}
	c.statusMu.Lock()
	defer c.statusMu.Unlock()
	st.Source = c.source
	st.LastSuccess = c.lastSuccess
	st.LastError = c.lastError
	since := c.lastSuccess
	if since.IsZero() {
		since = c.started
	}
	st.StaleFor = time.Since(since)
	for _, m := range c.mirrors {
		u := m.cfg.URL
		if m.kind == kindFS {
			u = "embedded:"
		}
		st.Mirrors = append(st.Mirrors, MirrorStatus{
			Name:                m.cfg.Name,
			URL:                 redactKey(u, c.opts.DeliveryKey),
			ConsecutiveFailures: m.failures,
			LastError:           m.lastErr,
			LastSuccess:         m.lastOK,
		})
	}
	return st
}

// OnUpdate registers fn to be called after each new revision is swapped in
// (not for the state loaded by New). Callbacks run on the refresher goroutine
// (or the goroutine calling Refresh), one at a time; a panic is recovered and
// logged. It returns a function that unregisters fn.
func (c *Client) OnUpdate(fn func(Update)) (unregister func()) {
	cb := &callback{fn: fn}
	c.cbMu.Lock()
	c.cbs = append(c.cbs, cb)
	c.cbMu.Unlock()
	return func() {
		c.cbMu.Lock()
		defer c.cbMu.Unlock()
		for i, x := range c.cbs {
			if x == cb {
				c.cbs = append(c.cbs[:i:i], c.cbs[i+1:]...)
				return
			}
		}
	}
}

// Refresh revalidates now across the mirrors, ignoring backoff, and blocks for
// at most one round of requests. It returns nil if a mirror answered (with a
// new revision or a confirmation), otherwise an error matching ErrUnavailable.
// What is held is never evicted.
func (c *Client) Refresh(ctx context.Context) error {
	if c.ctx.Err() != nil {
		return ErrClosed
	}
	if len(c.polled) == 0 {
		return nil // nothing to poll: the local state is all there is
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(c.ctx, cancel)
	defer stop()
	c.refreshMu.Lock()
	ok, errs := c.round(ctx, true, TriggerManual)
	c.refreshMu.Unlock()
	c.deliverUpdates()
	if !ok {
		return &unavailableError{msg: "refresh failed: " + errs}
	}
	return nil
}

// Close stops the background refresher and flushes recorded outcomes (for up
// to 2 s). Reads keep working after Close.
func (c *Client) Close() error {
	c.closeOnce.Do(func() {
		c.cancel()
		c.wg.Wait()
		if c.outcomes != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			c.closeErr = c.outcomes.close(ctx)
			cancel()
		}
	})
	return c.closeErr
}

// ---------------------------------------------------------------------------
// Mirrors, backoff and loading. Everything below runs under refreshMu.
// ---------------------------------------------------------------------------

func (c *Client) fetch(ctx context.Context, i int, rel, etag string) fetchResult {
	m := c.mirrors[i]
	var r fetchResult
	switch m.kind {
	case kindFS:
		r = readFS(m.fsys, rel)
	case kindFile:
		r = readFile(relPath(m.dir, rel))
	case kindCache:
		if c.cacheRoot == "" {
			r = fetchResult{kind: fetchNotFound, err: "empty"}
		} else {
			r = readFile(relPath(c.cacheRoot, rel))
		}
	case kindHTTP:
		r = c.httpGet(ctx, joinURL(m.cfg.URL, rel), etag, m.cfg.BearerToken)
	}
	r.err = redactKey(r.err, c.opts.DeliveryKey)
	return r
}

func (c *Client) inBackoff(i int) bool {
	c.statusMu.Lock()
	defer c.statusMu.Unlock()
	return c.mirrors[i].retryAt.After(time.Now())
}

func (c *Client) recordOK(i int) {
	c.statusMu.Lock()
	m := c.mirrors[i]
	recovered := m.failures > 0
	m.failures = 0
	m.retryAt = time.Time{}
	m.lastErr = ""
	m.lastOK = time.Now()
	c.statusMu.Unlock()
	if recovered {
		c.log.info(m.cfg.Name + " is answering again")
	}
}

func jitter() float64 { return 0.9 + 0.2*rand.Float64() }

func (c *Client) recordFail(i int, err string, count bool) {
	c.statusMu.Lock()
	m := c.mirrors[i]
	m.lastErr = err
	failures := 0
	if count {
		m.failures++
		failures = m.failures
		// Skip the mirror for 0, 1, 3, 7, ... poll intervals, capped at MaxBackoff.
		mult := int64(1)<<min(failures-1, 20) - 1
		d := time.Duration(int64(c.opts.PollInterval) * mult)
		if d > c.opts.MaxBackoff || d < 0 {
			d = c.opts.MaxBackoff
		}
		m.retryAt = time.Now().Add(time.Duration(float64(d) * jitter()))
	}
	c.statusMu.Unlock()
	if failures == 1 {
		c.log.warn(m.cfg.Name + ": " + err)
	} else {
		c.log.debug(m.cfg.Name + ": " + err)
	}
}

func (c *Client) resolveBlob(ctx context.Context, mi int, sha string) ([]byte, string) {
	order := make([]int, 0, len(c.mirrors)+2)
	if c.cacheIdx >= 0 {
		order = append(order, c.cacheIdx)
	}
	order = append(order, mi)
	for i := range c.mirrors {
		order = append(order, i)
	}
	seen := make([]bool, len(c.mirrors))
	var errs []string
	for _, i := range order {
		if seen[i] {
			continue
		}
		seen[i] = true
		if ctx.Err() != nil {
			break
		}
		if i != mi && c.mirrors[i].kind == kindHTTP && c.inBackoff(i) {
			continue
		}
		r := c.fetch(ctx, i, "blobs/"+sha, "")
		if r.kind != fetchOK {
			if i == mi {
				errs = append(errs, c.mirrors[i].cfg.Name+": "+r.err)
			}
			continue
		}
		if SHA256Hex(r.body) != sha {
			msg := "blob " + sha[:12] + " failed sha256 verification"
			c.event("kyp.hash_mismatch", map[string]any{
				"kyp.mirror":      c.mirrors[i].cfg.Name,
				"kyp.source":      c.mirrors[i].source,
				"kyp.blob.sha256": sha,
			})
			c.log.warn(c.mirrors[i].cfg.Name + ": " + msg + " (discarded)")
			errs = append(errs, c.mirrors[i].cfg.Name+": "+msg)
			continue
		}
		return r.body, ""
	}
	e := "blob " + sha[:12] + " unavailable"
	if len(errs) > 0 {
		e += " (" + strings.Join(errs, "; ") + ")"
	}
	return nil, e
}

func (c *Client) build(ctx context.Context, mi int, man *Manifest, raw []byte, cur *state) (*state, string) {
	st := &state{
		manifest: man,
		raw:      raw,
		prompts:  make(map[string]*Prompt, len(man.Prompts)),
		bySHA:    make(map[string]string, len(man.Prompts)),
	}
	for name, mp := range man.Prompts {
		text, have := st.bySHA[mp.SHA256]
		if !have && cur != nil {
			text, have = cur.bySHA[mp.SHA256]
		}
		if !have {
			body, err := c.resolveBlob(ctx, mi, mp.SHA256)
			if body == nil {
				return nil, err
			}
			text = string(body)
		}
		vars := mp.Variables
		if len(vars) == 0 {
			vars = TemplateVariables(text)
		}
		st.prompts[name] = &Prompt{Name: name, Version: mp.Version, SHA256: mp.SHA256, Variables: vars, Text: text}
		st.bySHA[mp.SHA256] = text
		st.names = append(st.names, name)
	}
	sort.Strings(st.names)
	return st, ""
}

type candidate struct {
	state   *state
	etag    string
	missing bool
}

func (c *Client) tryMirror(ctx context.Context, mi int, cur *state, useETag bool) (outcome, candidate, string) {
	var cand candidate
	etag := ""
	if useETag && cur != nil {
		etag = c.mirrors[mi].etag
	}
	r := c.fetch(ctx, mi, c.manifestPath(), etag)
	switch r.kind {
	case fetchNotModified:
		cand.etag = r.etag
		return outUnchanged, cand, ""
	case fetchNotFound:
		cand.missing = true
		return outFailed, cand, "manifest not found (" + r.err + ")"
	case fetchFailed:
		return outFailed, cand, r.err
	}
	man, err := ParseManifest(r.body)
	if err != nil {
		return outFailed, cand, "bad manifest: " + strings.TrimPrefix(err.Error(), "kyp: ")
	}
	if man.App != c.opts.App || man.Env != c.opts.Env {
		return outFailed, cand, fmt.Sprintf("bad manifest: it is for %s/%s, expected %s", man.App, man.Env, c.what())
	}
	if cur != nil && man.Revision < cur.manifest.Revision {
		return outStale, cand, fmt.Sprintf("stale manifest ignored (revision %d < held %d)", man.Revision, cur.manifest.Revision)
	}
	if cur != nil && man.Revision == cur.manifest.Revision {
		cand.etag = r.etag
		return outUnchanged, cand, ""
	}
	st, berr := c.build(ctx, mi, man, r.body, cur)
	if st == nil {
		return outFailed, cand, berr
	}
	cand.state = st
	cand.etag = r.etag
	return outUpdated, cand, ""
}

func (c *Client) install(st *state, mi int, notify bool) {
	old := c.cur.Swap(st)
	name := c.mirrors[mi].cfg.Name
	c.statusMu.Lock()
	c.source = name
	c.statusMu.Unlock()
	c.sourceKind.Store(c.mirrors[mi].source)
	if len(c.loadObservers()) > 0 {
		var prev int64
		changed := int64(0)
		if old != nil {
			prev = old.manifest.Revision
			for _, n := range old.names {
				if st.prompts[n] == nil {
					changed++
				}
			}
		}
		for _, n := range st.names {
			if old == nil || old.prompts[n] == nil || old.prompts[n].SHA256 != st.prompts[n].SHA256 {
				changed++
			}
		}
		c.event("kyp.update", map[string]any{
			"kyp.revision.previous": prev,
			"kyp.revision":          st.manifest.Revision,
			"kyp.prompts.changed":   changed,
		})
	}
	c.log.info(fmt.Sprintf("loaded %s revision %d (%d prompts) from %s", c.what(), st.manifest.Revision, len(st.prompts), name))
	if !notify {
		return
	}
	u := Update{NewRevision: st.manifest.Revision, Source: name}
	if old != nil {
		u.OldRevision = old.manifest.Revision
	}
	for _, n := range st.names {
		if old == nil || old.prompts[n] == nil || old.prompts[n].SHA256 != st.prompts[n].SHA256 {
			u.Changed = append(u.Changed, n)
		}
	}
	if old != nil {
		for _, n := range old.names {
			if st.prompts[n] == nil {
				u.Changed = append(u.Changed, n)
			}
		}
	}
	c.pendingMu.Lock()
	c.pending = append(c.pending, u)
	c.pendingMu.Unlock()
}

func (c *Client) deliverUpdates() {
	for {
		if !c.deliverMu.TryLock() {
			return // the goroutine holding it delivers ours too
		}
		c.pendingMu.Lock()
		todo := c.pending
		c.pending = nil
		c.pendingMu.Unlock()
		c.cbMu.Lock()
		cbs := append([]*callback(nil), c.cbs...)
		c.cbMu.Unlock()
		for _, u := range todo {
			for _, cb := range cbs {
				c.callSafely(cb.fn, u)
			}
		}
		c.deliverMu.Unlock()
		c.pendingMu.Lock()
		more := len(c.pending) > 0
		c.pendingMu.Unlock()
		if !more {
			return
		}
	}
}

func (c *Client) callSafely(fn func(Update), u Update) {
	defer func() {
		if r := recover(); r != nil {
			c.log.error(fmt.Sprintf("update callback panicked: %v", r))
		}
	}()
	fn(u)
}

// loadLocal is start-up step 1: local mirrors only (embedded, snapshot, disk
// cache). The highest revision wins; ties go to the earlier mirror.
func (c *Client) loadLocal() {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()
	start := time.Now()
	c.events = nil
	c.locateCache()
	var best *state
	bestMI := -1
	anyLocal := false
	var errs []string
	for mi, m := range c.mirrors {
		if m.kind == kindHTTP {
			continue
		}
		anyLocal = true
		oc, cand, err := c.tryMirror(c.ctx, mi, best, false)
		switch {
		case oc == outUpdated:
			best, bestMI = cand.state, mi
		case oc == outFailed && !cand.missing:
			c.recordFail(mi, err, false)
			c.fallback(mi, err)
			errs = append(errs, m.cfg.Name+": "+err)
		}
	}
	if best != nil {
		c.install(best, bestMI, false)
		if bestMI != c.cacheIdx {
			c.writeCache(best)
		}
	}
	if !anyLocal { // only a round when there was something local to read
		c.events = nil
		return
	}
	msg := strings.Join(errs, "; ")
	if msg == "" {
		msg = "no local copy"
	}
	c.emitRound(roundInfo{trigger: TriggerStart, start: start, answeredBy: bestMI, updated: best != nil, err: msg})
}

// startupFromNetwork is start-up step 2: nothing local, so block on the
// network mirrors for up to StartupTimeout.
func (c *Client) startupFromNetwork(ctx context.Context) error {
	deadline := time.Now().Add(c.opts.StartupTimeout)
	sctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	delay := 100 * time.Millisecond
	for c.cur.Load() == nil {
		c.refreshMu.Lock()
		c.round(sctx, true, TriggerStart)
		c.refreshMu.Unlock()
		if c.cur.Load() != nil || time.Now().Add(delay).After(deadline) || sctx.Err() != nil {
			break
		}
		t := time.NewTimer(delay)
		select {
		case <-sctx.Done():
		case <-t.C:
		}
		t.Stop()
		delay = min(delay*2, time.Second)
	}
	c.pendingMu.Lock()
	c.pending = nil // the first load is not an "update"
	c.pendingMu.Unlock()
	if c.cur.Load() != nil {
		return nil
	}
	c.statusMu.Lock()
	lastErr := c.lastError
	c.statusMu.Unlock()
	if c.opts.StartEmpty {
		c.log.warn("starting empty, will keep trying: " + lastErr)
		return nil
	}
	if ctx.Err() != nil {
		return &unavailableError{msg: fmt.Sprintf("could not load %s: %v: %s", c.what(), ctx.Err(), lastErr)}
	}
	return &unavailableError{msg: fmt.Sprintf("could not load %s within %s: %s", c.what(), c.opts.StartupTimeout, lastErr)}
}

// round is one refresh round over the polled mirrors, in order, stopping at the
// first that answers. Mirrors in backoff are skipped unless all others fail.
func (c *Client) round(ctx context.Context, ignoreBackoff bool, trigger string) (bool, string) {
	ri := roundInfo{ctx: ctx, trigger: trigger, start: time.Now(), answeredBy: -1}
	c.events = nil
	cur := c.cur.Load()
	if cur != nil {
		ri.prev = cur.manifest.Revision
	}
	var errs []string
	var skipped []int
	attempt := func(mi int) bool {
		oc, cand, err := c.tryMirror(ctx, mi, cur, true)
		name := c.mirrors[mi].cfg.Name
		switch oc {
		case outUpdated:
			c.mirrors[mi].etag = cand.etag
			c.install(cand.state, mi, true)
			c.writeCache(cand.state)
			c.recordOK(mi)
			ri.answeredBy, ri.updated = mi, true
			return true
		case outUnchanged:
			c.mirrors[mi].etag = cand.etag
			c.recordOK(mi)
			if cur != nil {
				c.statusMu.Lock()
				c.source = name
				c.statusMu.Unlock()
				c.sourceKind.Store(c.mirrors[mi].source)
			}
			ri.answeredBy = mi
			return true
		case outStale:
			errs = append(errs, name+": "+err)
			c.recordFail(mi, err, false)
			c.fallback(mi, err)
		default:
			errs = append(errs, name+": "+err)
			c.recordFail(mi, err, true)
			c.fallback(mi, err)
		}
		return false
	}
	answered := false
	for _, mi := range c.polled {
		if ctx.Err() != nil {
			break
		}
		if !ignoreBackoff && c.inBackoff(mi) {
			skipped = append(skipped, mi)
			continue
		}
		if answered = attempt(mi); answered {
			break
		}
	}
	if !answered {
		// Everything we tried failed: give the mirrors in backoff a chance too.
		for _, mi := range skipped {
			if ctx.Err() != nil {
				break
			}
			if answered = attempt(mi); answered {
				break
			}
		}
	}
	joined := strings.Join(errs, "; ")
	if !answered && joined == "" {
		if ctx.Err() != nil {
			joined = ctx.Err().Error()
		} else {
			joined = "all mirrors backing off"
		}
	}
	c.statusMu.Lock()
	if answered {
		c.lastSuccess = time.Now()
	}
	c.lastError = joined
	if answered && len(errs) == 0 {
		c.lastError = ""
	}
	c.statusMu.Unlock()
	if !answered && c.ctx.Err() == nil {
		c.log.warn("refresh failed, serving what is held: " + joined)
	}
	ri.err = joined
	c.emitRound(ri)
	return answered, joined
}

func (c *Client) run(immediate bool) {
	defer c.wg.Done()
	first := immediate
	for {
		if !first {
			wait := time.Duration(float64(c.opts.PollInterval) * jitter())
			t := time.NewTimer(wait)
			select {
			case <-c.ctx.Done():
				t.Stop()
				return
			case <-t.C:
			}
		}
		first = false
		c.refreshMu.Lock()
		c.round(c.ctx, false, TriggerPoll)
		c.refreshMu.Unlock()
		c.deliverUpdates()
		if c.ctx.Err() != nil {
			return
		}
	}
}

// ---------------------------------------------------------------------------
// Disk cache: <CacheDir>/<workspace>/<app>/<env>/{envs,blobs}
// ---------------------------------------------------------------------------

func (c *Client) cacheRootFor(workspace string) string {
	return filepath.Join(c.opts.CacheDir, workspace, c.opts.App, c.opts.Env)
}

// locateCache finds the cache root holding the highest revision.
func (c *Client) locateCache() {
	if c.cacheIdx < 0 || c.cacheRoot != "" {
		return
	}
	if c.opts.Workspace != "" {
		c.cacheRoot = c.cacheRootFor(c.opts.Workspace)
		return
	}
	entries, err := os.ReadDir(c.opts.CacheDir)
	if err != nil {
		return
	}
	best := int64(-1)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		root := c.cacheRootFor(e.Name())
		r := readFile(relPath(root, c.manifestPath()))
		if r.kind != fetchOK {
			continue
		}
		if m, err := ParseManifest(r.body); err == nil && m.App == c.opts.App && m.Env == c.opts.Env && m.Revision > best {
			best = m.Revision
			c.cacheRoot = root
		}
	}
}

func (c *Client) writeCache(st *state) {
	if c.cacheIdx < 0 {
		return
	}
	root := c.cacheRootFor(st.manifest.Workspace)
	for _, p := range st.prompts {
		blob := relPath(root, "blobs/"+p.SHA256)
		if _, err := os.Stat(blob); err == nil {
			continue
		}
		if err := atomicWrite(blob, []byte(p.Text)); err != nil {
			c.log.warn("disk cache write failed: " + err.Error())
			return
		}
	}
	mpath := relPath(root, c.manifestPath())
	if existing := readFile(mpath); existing.kind == fetchOK {
		if string(existing.body) == string(st.raw) {
			c.cacheRoot = root
			return
		}
		if m, err := ParseManifest(existing.body); err == nil && m.Revision > st.manifest.Revision {
			return
		}
	}
	if err := atomicWrite(mpath, st.raw); err != nil {
		c.log.warn("disk cache write failed: " + err.Error())
		return
	}
	c.cacheRoot = root
}
