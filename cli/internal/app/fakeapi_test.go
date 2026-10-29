package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

const testAPIKey = "kyp_live_testkey123"

type fakeVersion struct {
	Body, Message string
}

type fakeAsset struct {
	ID, Slug, Name, Kind string
	Versions             []fakeVersion
}

type recorded struct {
	Method, Path string
	Body         map[string]any
	Auth         string
}

// fakeAPI is an in-memory stand-in for the parts of api.keepyourprompts.com the CLI uses.
type fakeAPI struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	assets   []*fakeAsset
	requests []recorded
	nextID   int
	revision int
	// fail, when set, answers every request with this status and problem body.
	failStatus int
	failBody   string
}

func newFakeAPI(t *testing.T) *fakeAPI {
	f := &fakeAPI{t: t, revision: 6}
	f.assets = []*fakeAsset{
		{ID: "ast_1", Slug: "triage", Name: "Support triage", Kind: "prompt", Versions: []fakeVersion{
			{Body: "You are a support agent for {{company}}.", Message: "First version"},
			{Body: "You are a friendly support agent for {{company}}. Route billing to {{billing_queue}}.", Message: "Friendlier"},
		}},
		{ID: "ast_2", Slug: "agents/reviewer", Name: "Code reviewer", Kind: "agent", Versions: []fakeVersion{{Body: "Review the diff.", Message: "First version"}}},
		{ID: "ast_3", Slug: "escalation", Name: "Escalation", Kind: "prompt", Versions: []fakeVersion{{Body: "Escalate politely.", Message: "First version"}}},
	}
	f.nextID = 4
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAPI) problem(w http.ResponseWriter, status int, slug, title, detail string, ext map[string]any) {
	p := map[string]any{"type": "https://keepyourprompts.com/problems/" + slug, "title": title, "status": status, "detail": detail}
	for k, v := range ext {
		p[k] = v
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(p)
}

func (f *fakeAPI) reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeAPI) find(idOrSlug string) *fakeAsset {
	for _, a := range f.assets {
		if a.ID == idOrSlug || a.Slug == idOrSlug {
			return a
		}
	}
	return nil
}

func (a *fakeAsset) json(withBody bool) map[string]any {
	m := map[string]any{
		"id": a.ID, "kind": a.Kind, "name": a.Name, "slug": a.Slug, "description": "", "tags": []string{},
		"nodeId": nil, "currentVersion": len(a.Versions), "visibility": "workspace",
		"createdAt": "2026-10-01T09:00:00.000Z", "updatedAt": fmt.Sprintf("2026-10-%02dT10:30:00.000Z", 10+len(a.Versions)),
	}
	if withBody {
		body := a.Versions[len(a.Versions)-1].Body
		m["body"] = body
		vars := []string{}
		for _, part := range strings.Split(body, "{{")[1:] {
			if i := strings.Index(part, "}}"); i > 0 {
				vars = append(vars, strings.TrimSpace(part[:i]))
			}
		}
		m["variables"] = vars
		m["sha256"] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	}
	return m
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var body map[string]any
	if b, _ := io.ReadAll(r.Body); len(b) > 0 {
		if err := json.Unmarshal(b, &body); err != nil {
			f.problem(w, 400, "bad-request", "Bad request", "invalid JSON", nil)
			return
		}
	}
	f.requests = append(f.requests, recorded{Method: r.Method, Path: r.URL.RequestURI(), Body: body, Auth: r.Header.Get("Authorization")})
	if f.failStatus != 0 {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(f.failStatus)
		_, _ = io.WriteString(w, f.failBody)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+testAPIKey {
		f.problem(w, 401, "unauthorized", "Unauthorized", "Sign in or send an API key.", nil)
		return
	}
	var seg []string
	for _, s := range strings.Split(strings.TrimPrefix(r.URL.EscapedPath(), "/v1/"), "/") {
		u, _ := url.PathUnescape(s)
		seg = append(seg, u)
	}
	route := r.Method + " " + strings.Join(seg, "/")
	q := r.URL.Query()
	switch {
	case route == "GET me":
		f.reply(w, 200, map[string]any{
			"user":      map[string]any{"id": "usr_1", "email": "ana@acme.test", "name": "Ana"},
			"workspace": map[string]any{"id": "ws_1", "name": "Acme", "slug": "acme", "role": "editor"},
		})
	case route == "GET search":
		var data []map[string]any
		for _, a := range f.assets {
			body := a.Versions[len(a.Versions)-1].Body
			if strings.Contains(strings.ToLower(a.Name+" "+body), strings.ToLower(q.Get("q"))) {
				data = append(data, map[string]any{"asset": a.json(false), "score": 0.87, "snippet": body})
			}
		}
		f.reply(w, 200, map[string]any{"data": data})
	case route == "GET assets":
		// Two per page, to exercise cursors.
		start, _ := strconv.Atoi(q.Get("cursor"))
		var data []map[string]any
		for i := start; i < len(f.assets) && len(data) < 2; i++ {
			if k := q.Get("kind"); k == "" || f.assets[i].Kind == k {
				data = append(data, f.assets[i].json(false))
			}
		}
		var next any
		if start+2 < len(f.assets) {
			next = strconv.Itoa(start + 2)
		}
		f.reply(w, 200, map[string]any{"data": data, "nextCursor": next})
	case route == "POST assets":
		if body["name"] == nil || body["body"] == nil {
			f.problem(w, 422, "validation-error", "Validation failed", "The request is invalid.", map[string]any{"errors": []map[string]string{{"pointer": "/name", "message": "Required"}}})
			return
		}
		a := &fakeAsset{ID: fmt.Sprintf("ast_%d", f.nextID), Slug: body["slug"].(string), Name: body["name"].(string), Kind: body["kind"].(string),
			Versions: []fakeVersion{{Body: body["body"].(string)}}}
		f.nextID++
		f.assets = append(f.assets, a)
		f.reply(w, 201, a.json(false))
	case r.Method == "GET" && len(seg) == 2 && seg[0] == "assets":
		a := f.find(seg[1])
		if a == nil {
			f.problem(w, 404, "not-found", "Not found", "Asset not found.", nil)
			return
		}
		f.reply(w, 200, a.json(true))
	case r.Method == "PATCH" && len(seg) == 2 && seg[0] == "assets":
		a := f.find(seg[1])
		if a == nil {
			f.problem(w, 404, "not-found", "Not found", "Asset not found.", nil)
			return
		}
		if bv, ok := body["baseVersion"].(float64); ok && int(bv) < len(a.Versions) {
			f.problem(w, 409, "version-conflict", "Conflict", "This prompt was saved by someone else a moment ago. Reload and try again.", map[string]any{"currentVersion": len(a.Versions)})
			return
		}
		if n, ok := body["name"].(string); ok {
			a.Name = n
		}
		if b, ok := body["body"].(string); ok {
			m, _ := body["message"].(string)
			a.Versions = append(a.Versions, fakeVersion{Body: b, Message: m})
		}
		f.reply(w, 200, a.json(false))
	case r.Method == "GET" && len(seg) == 4 && seg[0] == "assets" && seg[2] == "versions":
		a := f.find(seg[1])
		v, _ := strconv.Atoi(seg[3])
		if a == nil || v < 1 || v > len(a.Versions) {
			f.problem(w, 404, "not-found", "Not found", "Version not found.", nil)
			return
		}
		f.reply(w, 200, map[string]any{"version": v, "sha256": "ab", "message": a.Versions[v-1].Message, "authorType": "user",
			"authorName": "Ana", "createdAt": "2026-10-02T08:00:00.000Z", "body": a.Versions[v-1].Body})
	case r.Method == "GET" && len(seg) == 3 && seg[0] == "assets" && seg[2] == "diff":
		f.reply(w, 200, map[string]any{"from": q.Get("from"), "to": q.Get("to"), "hunks": []map[string]string{
			{"op": "equal", "text": "You are a "},
			{"op": "insert", "text": "friendly "},
			{"op": "equal", "text": "support agent for {{company}}."},
			{"op": "insert", "text": " Route billing to {{billing_queue}}."},
		}, "variables": map[string]any{"added": []string{"billing_queue"}, "removed": []string{}}})
	case r.Method == "POST" && len(seg) == 3 && seg[0] == "apps" && seg[2] == "deploy":
		if seg[1] != "support-bot" {
			f.problem(w, 404, "not-found", "Not found", "App not found.", nil)
			return
		}
		f.revision++
		var prompts []map[string]any
		for _, p := range body["prompts"].([]any) {
			pm := p.(map[string]any)
			a := f.find(pm["assetId"].(string))
			v := len(a.Versions)
			if pv, ok := pm["version"].(float64); ok {
				v = int(pv)
			}
			prompts = append(prompts, map[string]any{"name": pm["name"], "assetId": a.ID, "version": v, "sha256": fmt.Sprintf("%064d", v)})
		}
		sort.Slice(prompts, func(i, j int) bool { return prompts[i]["name"].(string) < prompts[j]["name"].(string) })
		f.reply(w, 201, map[string]any{"id": "dep_1", "env": body["env"], "revision": f.revision, "kind": "deploy", "message": body["message"],
			"deployedBy": "agent: cli", "prompts": prompts, "deployedAt": "2026-10-29T10:00:00.000Z", "publishedAt": nil})
	case r.Method == "POST" && len(seg) == 3 && seg[0] == "apps" && seg[2] == "rollback":
		if tr := int(body["toRevision"].(float64)); tr > f.revision {
			f.problem(w, 404, "not-found", "Not found", "Revision not found.", nil)
			return
		}
		f.revision++
		f.reply(w, 201, map[string]any{"id": "dep_2", "env": body["env"], "revision": f.revision, "kind": "rollback",
			"prompts": []map[string]any{{"name": "triage", "assetId": "ast_1", "version": 1, "sha256": fmt.Sprintf("%064d", 1)}}})
	case route == "POST captures":
		f.reply(w, 201, map[string]any{"id": "cap_42", "source": body["source"], "text": body["text"]})
	default:
		f.problem(w, 404, "not-found", "Not found", "Route not found: "+route, nil)
	}
}

func (f *fakeAPI) last() recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[len(f.requests)-1]
}

func (f *fakeAPI) reset() {
	f.mu.Lock()
	f.requests = nil
	f.mu.Unlock()
}
