package kyp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type logger struct {
	l   *slog.Logger
	key string
}

func (l logger) debug(msg string) { l.l.Debug(redactKey(msg, l.key)) }
func (l logger) info(msg string)  { l.l.Info(redactKey(msg, l.key)) }
func (l logger) warn(msg string)  { l.l.Warn(redactKey(msg, l.key)) }
func (l logger) error(msg string) { l.l.Error(redactKey(msg, l.key)) }

// OutcomeKind is what happened when a prompt was used.
type OutcomeKind string

// Outcome kinds accepted by the API.
const (
	OutcomeSuccess          OutcomeKind = "success"
	OutcomeFailure          OutcomeKind = "failure"
	OutcomeFeedbackPositive OutcomeKind = "feedback_positive"
	OutcomeFeedbackNegative OutcomeKind = "feedback_negative"
)

// Outcome is one use of a deployed prompt, reported with RecordOutcome.
type Outcome struct {
	Prompt string // prompt name, e.g. "triage"
	// Meta, when set, pins the body that was used (from Meta or RenderWithMeta):
	// its name and sha256 are reported even if a newer revision arrived since.
	Meta         *PromptMeta
	Result       OutcomeKind // success, failure, feedback_positive, feedback_negative
	Latency      time.Duration
	InputTokens  int
	OutputTokens int
}

type outcomeRecord struct {
	Env          string `json:"env"`
	Prompt       string `json:"prompt"`
	SHA256       string `json:"sha256"`
	Outcome      string `json:"outcome"`
	LatencyMs    *int64 `json:"latencyMs,omitempty"`
	InputTokens  *int   `json:"inputTokens,omitempty"`
	OutputTokens *int   `json:"outputTokens,omitempty"`
}

const (
	outcomeBatch    = 100
	outcomeMaxQueue = 5000
	outcomeInterval = 10 * time.Second
)

// outcomeReporter batches outcomes and posts them to
// POST <APIURL>/v1/apps/<app>/outcomes in the background.
type outcomeReporter struct {
	c       *Client
	key     string
	mu      sync.Mutex
	queue   []outcomeRecord
	dropped int
	started bool
	closed  bool
	kick    chan struct{}
	done    chan struct{}
	sendMu  sync.Mutex
}

func newOutcomeReporter(c *Client) *outcomeReporter {
	key := c.opts.APIKey
	if key == "" {
		return nil
	}
	return &outcomeReporter{c: c, key: key, kick: make(chan struct{}, 1), done: make(chan struct{})}
}

// RecordOutcome queues an outcome for the given prompt (its sha256 is taken
// from the current revision) and returns without blocking; batches are sent in
// the background every 10 s or 100 outcomes, and on Close. It authenticates
// with KYP_API_KEY (Options.APIKey); delivery keys are read-only, so it
// returns ErrOutcomesDisabled when no API key is set.
func (c *Client) RecordOutcome(o Outcome) error {
	if c.outcomes == nil {
		return ErrOutcomesDisabled
	}
	name, sha, env := o.Prompt, "", c.opts.Env
	if o.Meta != nil {
		name, sha, env = o.Meta.Name, o.Meta.SHA256, o.Meta.Env
	} else {
		p, err := c.find(o.Prompt)
		if err != nil {
			return err
		}
		sha = p.SHA256
	}
	switch o.Result {
	case OutcomeSuccess, OutcomeFailure, OutcomeFeedbackPositive, OutcomeFeedbackNegative:
	default:
		return fmt.Errorf("kyp: unknown outcome %q", o.Result)
	}
	rec := outcomeRecord{Env: env, Prompt: name, SHA256: sha, Outcome: string(o.Result)}
	if o.Latency > 0 {
		ms := o.Latency.Milliseconds()
		rec.LatencyMs = &ms
	}
	if o.InputTokens > 0 {
		v := o.InputTokens
		rec.InputTokens = &v
	}
	if o.OutputTokens > 0 {
		v := o.OutputTokens
		rec.OutputTokens = &v
	}
	c.outcomes.add(rec)
	return nil
}

// FlushOutcomes sends every queued outcome now.
func (c *Client) FlushOutcomes(ctx context.Context) error {
	if c.outcomes == nil {
		return nil
	}
	return c.outcomes.flush(ctx)
}

func (r *outcomeReporter) add(rec outcomeRecord) {
	r.mu.Lock()
	if len(r.queue) >= outcomeMaxQueue {
		r.dropped++
		r.mu.Unlock()
		return
	}
	r.queue = append(r.queue, rec)
	n := len(r.queue)
	if !r.started && !r.closed {
		r.started = true
		go r.loop()
	}
	r.mu.Unlock()
	if n >= outcomeBatch {
		select {
		case r.kick <- struct{}{}:
		default:
		}
	}
}

func (r *outcomeReporter) loop() {
	defer close(r.done)
	t := time.NewTicker(outcomeInterval)
	defer t.Stop()
	for {
		select {
		case <-r.c.ctx.Done():
			return
		case <-t.C:
		case <-r.kick:
		}
		ctx, cancel := context.WithTimeout(r.c.ctx, 10*time.Second)
		if err := r.flush(ctx); err != nil {
			r.c.log.warn("outcome report failed: " + err.Error())
		}
		cancel()
	}
}

// close is called by Client.Close after the client context was cancelled.
func (r *outcomeReporter) close(ctx context.Context) error {
	r.mu.Lock()
	r.closed = true
	started := r.started
	r.mu.Unlock()
	if started {
		<-r.done
	}
	return r.flush(ctx)
}

func (r *outcomeReporter) flush(ctx context.Context) error {
	r.sendMu.Lock()
	defer r.sendMu.Unlock()
	for {
		r.mu.Lock()
		n := min(len(r.queue), 500)
		batch := append([]outcomeRecord(nil), r.queue[:n]...)
		r.mu.Unlock()
		if n == 0 {
			return nil
		}
		if err := r.send(ctx, batch); err != nil {
			return err
		}
		r.mu.Lock()
		r.queue = r.queue[n:]
		r.mu.Unlock()
	}
}

func (r *outcomeReporter) send(ctx context.Context, batch []outcomeRecord) error {
	body, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	u := joinURL(r.c.opts.APIURL, "/v1/apps/"+url.PathEscape(r.c.opts.App)+"/outcomes")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.key)
	req.Header.Set("User-Agent", r.c.opts.UserAgent)
	resp, err := r.c.httpc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("kyp: outcomes: HTTP %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	}
	return nil
}
