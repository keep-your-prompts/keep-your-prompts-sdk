package kyp

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Prompt metadata, metadata maps and the observer hook (protocol/tracing.md).
// No dependency on OpenTelemetry: the go/otel submodule builds on these.

// Normalised mirror kinds reported as kyp.source.
const (
	SourceEmbedded = "embedded"
	SourceSnapshot = "snapshot"
	SourceCache    = "cache"
	SourceCDN      = "cdn"
	SourceOrigin   = "origin"
	SourceGit      = "git"
	SourceCustom   = "custom"
)

// PromptMeta says which deployed body a call used. See Client.Meta.
type PromptMeta struct {
	Name      string
	Version   int64
	SHA256    string
	App       string
	Env       string
	Workspace string
	Revision  int64
	Source    string // normalised mirror kind; "" before anything is loaded
}

// KypAttributes returns the kyp.* span attributes as a plain map (values are
// string or int64).
func (m PromptMeta) KypAttributes() map[string]any {
	a := map[string]any{
		"kyp.prompt.name":    m.Name,
		"kyp.prompt.version": m.Version,
		"kyp.prompt.sha256":  m.SHA256,
		"kyp.app":            m.App,
		"kyp.env":            m.Env,
		"kyp.revision":       m.Revision,
	}
	if m.Workspace != "" {
		a["kyp.workspace"] = m.Workspace
	}
	if m.Source != "" {
		a["kyp.source"] = m.Source
	}
	return a
}

// Attributes returns KypAttributes plus gen_ai.prompt.name and
// gen_ai.prompt.version (a decimal string), the OpenTelemetry GenAI names.
func (m PromptMeta) Attributes() map[string]any {
	a := m.KypAttributes()
	a["gen_ai.prompt.name"] = m.Name
	a["gen_ai.prompt.version"] = strconv.FormatInt(m.Version, 10)
	return a
}

// TraceMetadata returns the kyp.* attributes with flat keys (kyp_prompt_name,
// ...), for any tool's free-form metadata.
func (m PromptMeta) TraceMetadata() map[string]any {
	out := map[string]any{}
	for k, v := range m.KypAttributes() {
		out[strings.ReplaceAll(k, ".", "_")] = v
	}
	return out
}

// LangfuseMetadata is TraceMetadata, for Langfuse observation or trace metadata.
func (m PromptMeta) LangfuseMetadata() map[string]any { return m.TraceMetadata() }

// LangSmithMetadata is TraceMetadata, for LangSmith run metadata.
func (m PromptMeta) LangSmithMetadata() map[string]any { return m.TraceMetadata() }

// Rendered is what RenderWithMeta returns.
type Rendered struct {
	Text string
	Meta PromptMeta
}

// Refresh triggers and results (kyp.refresh.trigger, kyp.refresh.result).
const (
	TriggerStart  = "start"
	TriggerPoll   = "poll"
	TriggerManual = "manual"

	ResultUpdated     = "updated"
	ResultNotModified = "not_modified"
	ResultFailed      = "failed"
)

// TelemetryEvent is a span event recorded during a refresh round:
// kyp.fallback, kyp.hash_mismatch or kyp.update.
type TelemetryEvent struct {
	Name       string
	Time       time.Time
	Attributes map[string]any // string or int64 values
}

// RefreshRecord describes one refresh round. Passed to Observer.OnRefresh.
type RefreshRecord struct {
	// Ctx is the caller's context for a manual Refresh (so a span can join its
	// trace), nil otherwise.
	Ctx              context.Context
	App, Env         string
	Trigger          string // start, poll, manual
	Result           string // updated, not_modified, failed
	Start            time.Time
	Duration         time.Duration
	Mirror           string // configured name of the mirror that answered ("" when failed)
	Source           string
	Revision         int64
	PreviousRevision int64
	Workspace        string
	Error            string // when failed, delivery key redacted
	ErrorType        string
	Events           []TelemetryEvent
}

// RenderError describes a failed Render or RenderWithMeta.
type RenderError struct {
	App, Env  string
	Name      string
	ErrorType string // not_found or missing_variable
}

// Observer receives delivery telemetry. Calls happen on the refresher
// goroutine (or the caller of Refresh / Render); a panic is recovered and logged.
type Observer interface {
	OnRefresh(RefreshRecord)
	OnRenderError(RenderError)
}

// ObserverFuncs adapts functions to Observer; nil fields are ignored.
type ObserverFuncs struct {
	Refresh     func(RefreshRecord)
	RenderError func(RenderError)
}

// OnRefresh implements Observer.
func (f ObserverFuncs) OnRefresh(r RefreshRecord) {
	if f.Refresh != nil {
		f.Refresh(r)
	}
}

// OnRenderError implements Observer.
func (f ObserverFuncs) OnRenderError(r RenderError) {
	if f.RenderError != nil {
		f.RenderError(r)
	}
}

// WithObserver registers an Observer before start-up, so the start-up round is seen too.
func WithObserver(o Observer) Option {
	return func(opts *Options) { opts.Observers = append(opts.Observers, o) }
}

// NormalizeSource maps a mirror name to kyp.source (see protocol/tracing.md).
func NormalizeSource(name string, m Mirror) string {
	switch name {
	case "":
		return ""
	case "disk-cache":
		return SourceCache
	case SourceEmbedded, SourceSnapshot, SourceCache, SourceCDN, SourceOrigin, SourceGit:
		return name
	}
	switch classify(m) {
	case kindFS:
		return SourceEmbedded
	case kindFile:
		return SourceSnapshot
	}
	return SourceCustom
}

var (
	reBlobUnavailable = regexp.MustCompile(`blob \S+ unavailable`)
	reNotFoundHTTP    = regexp.MustCompile(`http (404|410)\b`)
	reHTTP            = regexp.MustCompile(`http (\d{3})\b`)
	reNetwork         = regexp.MustCompile(`connection|network|socket|no such host|dial|refused|unreachable|eof`)
)

// ClassifyError maps a failure message to a low-cardinality error.type.
func ClassifyError(msg string) string {
	m := strings.ToLower(msg)
	switch {
	case reBlobUnavailable.MatchString(m):
		return "blob_unavailable"
	case strings.Contains(m, "sha256 verification"), strings.Contains(m, "hash mismatch"):
		return "hash_mismatch"
	case strings.Contains(m, "stale manifest"):
		return "stale"
	case strings.Contains(m, "bad manifest"), strings.Contains(m, "invalid manifest"):
		return "bad_manifest"
	case reNotFoundHTTP.MatchString(m), strings.Contains(m, "not found"), strings.Contains(m, "no such file"),
		strings.Contains(m, "not embedded"), m == "empty":
		return "not_found"
	}
	if h := reHTTP.FindStringSubmatch(m); h != nil {
		return "http_" + h[1]
	}
	switch {
	case strings.Contains(m, "timeout"), strings.Contains(m, "timed out"), strings.Contains(m, "deadline"):
		return "timeout"
	case reNetwork.MatchString(m):
		return "network"
	}
	return "_OTHER"
}

// --- client side -------------------------------------------------------------

// App returns the app slug the client serves.
func (c *Client) App() string { return c.opts.App }

// Env returns the environment slug the client serves.
func (c *Client) Env() string { return c.opts.Env }

// Meta returns which deployed body name is (name, version, sha256, app, env,
// workspace, revision and the mirror kind that served it). Memory only; a
// *NotFoundError for an unknown name.
func (c *Client) Meta(name string) (PromptMeta, error) {
	s := c.cur.Load()
	p, err := c.findIn(s, name)
	if err != nil {
		return PromptMeta{}, err
	}
	return c.metaOf(p, s), nil
}

// RenderWithMeta is Render plus the metadata of the exact body rendered.
func (c *Client) RenderWithMeta(name string, vars Vars, onMissing ...OnMissing) (Rendered, error) {
	s := c.cur.Load()
	p, err := c.findIn(s, name)
	if err != nil {
		c.renderFailed(name, err)
		return Rendered{}, err
	}
	text, err := RenderTemplate(p.Text, vars, onMissing...)
	if err != nil {
		c.renderFailed(name, err)
		return Rendered{}, err
	}
	return Rendered{Text: text, Meta: c.metaOf(p, s)}, nil
}

// AddObserver subscribes to delivery telemetry; it returns a function that unsubscribes.
func (c *Client) AddObserver(o Observer) (remove func()) {
	box := &observerBox{o}
	c.obsMu.Lock()
	next := append(append([]*observerBox(nil), c.loadObservers()...), box)
	c.observers.Store(&next)
	c.obsMu.Unlock()
	return func() {
		c.obsMu.Lock()
		defer c.obsMu.Unlock()
		cur := c.loadObservers()
		next := make([]*observerBox, 0, len(cur))
		for _, b := range cur {
			if b != box {
				next = append(next, b)
			}
		}
		c.observers.Store(&next)
	}
}

type observerBox struct{ o Observer }

func (c *Client) loadObservers() []*observerBox {
	if p := c.observers.Load(); p != nil {
		return *p
	}
	return nil
}

func (c *Client) metaOf(p *Prompt, s *state) PromptMeta {
	m := PromptMeta{Name: p.Name, Version: p.Version, SHA256: p.SHA256, App: c.opts.App, Env: c.opts.Env}
	if s != nil {
		m.Workspace = s.manifest.Workspace
		m.Revision = s.manifest.Revision
	}
	m.Source, _ = c.sourceKind.Load().(string)
	return m
}

func (c *Client) renderFailed(name string, err error) {
	obs := c.loadObservers()
	if len(obs) == 0 {
		return
	}
	var typ string
	switch {
	case errors.Is(err, ErrMissingVariable):
		typ = "missing_variable"
	case errors.Is(err, ErrNotFound):
		typ = "not_found"
	default:
		return
	}
	ev := RenderError{App: c.opts.App, Env: c.opts.Env, Name: name, ErrorType: typ}
	for _, b := range obs {
		c.safeObserve(func() { b.o.OnRenderError(ev) })
	}
}

func (c *Client) safeObserve(fn func()) {
	defer func() {
		if r := recover(); r != nil {
			c.log.error(fmt.Sprintf("observer panicked: %v", r))
		}
	}()
	fn()
}

// event records a span event of the round in progress (runs under refreshMu).
func (c *Client) event(name string, attrs map[string]any) {
	if len(c.loadObservers()) == 0 {
		return
	}
	c.events = append(c.events, TelemetryEvent{Name: name, Time: time.Now(), Attributes: attrs})
}

func (c *Client) fallback(mi int, err string) {
	m := c.mirrors[mi]
	c.event("kyp.fallback", map[string]any{
		"kyp.mirror": m.cfg.Name,
		"kyp.source": m.source,
		"error.type": ClassifyError(err),
		"kyp.error":  redactKey(err, c.opts.DeliveryKey),
	})
}

type roundInfo struct {
	ctx        context.Context
	trigger    string
	start      time.Time
	answeredBy int
	prev       int64
	updated    bool
	err        string
}

func (c *Client) emitRound(ri roundInfo) {
	events := c.events
	c.events = nil
	obs := c.loadObservers()
	if len(obs) == 0 {
		return
	}
	rec := RefreshRecord{
		App: c.opts.App, Env: c.opts.Env, Trigger: ri.trigger, Start: ri.start,
		Duration: time.Since(ri.start), PreviousRevision: ri.prev, Events: events,
	}
	if ri.trigger == TriggerManual {
		rec.Ctx = ri.ctx
	}
	if s := c.cur.Load(); s != nil {
		rec.Revision = s.manifest.Revision
		rec.Workspace = s.manifest.Workspace
	}
	if ri.answeredBy >= 0 {
		m := c.mirrors[ri.answeredBy]
		rec.Mirror, rec.Source = m.cfg.Name, m.source
		rec.Result = ResultNotModified
		if ri.updated {
			rec.Result = ResultUpdated
		}
	} else {
		rec.Result = ResultFailed
		rec.Error = redactKey(ri.err, c.opts.DeliveryKey)
		rec.ErrorType = ClassifyError(ri.err)
		for i := len(events) - 1; i >= 0; i-- {
			if events[i].Name == "kyp.fallback" {
				rec.ErrorType, _ = events[i].Attributes["error.type"].(string)
				break
			}
		}
	}
	for _, b := range obs {
		c.safeObserve(func() { b.o.OnRefresh(rec) })
	}
}
