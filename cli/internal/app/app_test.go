package app

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/golden files")

const (
	deliveryKey   = "kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f"
	conformance   = "../../../conformance"
	fixtureV12Dir = conformance + "/fixtures/v12"
)

type result struct {
	code           int
	stdout, stderr string
}

type env struct {
	t      *testing.T
	api    *fakeAPI
	vars   map[string]string
	config string
	tty    bool
	// scrub replaces machine-specific strings (temp dirs) in golden output.
	scrubs map[string]string
}

func newEnv(t *testing.T) *env {
	e := &env{t: t, api: newFakeAPI(t), config: t.TempDir(), scrubs: map[string]string{}}
	e.vars = map[string]string{"KYP_API_URL": e.api.srv.URL, "KYP_API_KEY": testAPIKey}
	return e
}

func (e *env) run(stdin string, args ...string) result {
	e.t.Helper()
	var out, errb bytes.Buffer
	a := &App{
		Stdin:      strings.NewReader(stdin),
		Stdout:     &out,
		Stderr:     &errb,
		Getenv:     func(k string) string { return e.vars[k] },
		HTTPClient: http.DefaultClient,
		StdoutTTY:  e.tty,
		ConfigDir:  e.config,
	}
	code := a.Run(context.Background(), args)
	return result{code: code, stdout: out.String(), stderr: errb.String()}
}

// golden compares a transcript of runs with testdata/golden/<name>.golden.
func (e *env) golden(name string, runs ...[]string) {
	e.t.Helper()
	var b strings.Builder
	for _, args := range runs {
		stdin := ""
		if len(args) > 0 && strings.HasPrefix(args[0], "<<") {
			stdin, args = args[0][2:], args[1:]
		}
		r := e.run(stdin, args...)
		b.WriteString("$ kyp " + strings.Join(args, " ") + "\n")
		b.WriteString(r.stdout)
		if r.stdout != "" && !strings.HasSuffix(r.stdout, "\n") {
			b.WriteString("\n[no newline at end of stdout]\n")
		}
		if r.stderr != "" {
			b.WriteString("[stderr]\n" + r.stderr)
		}
		b.WriteString("[exit " + strconv.Itoa(r.code) + "]\n\n")
	}
	got := e.scrub(b.String())
	path := filepath.Join("testdata", "golden", name+".golden")
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			e.t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		e.t.Fatalf("%v (run go test -update)", err)
	}
	if got != strings.ReplaceAll(string(want), "\r\n", "\n") {
		e.t.Errorf("%s: output differs from golden file (run go test -update to accept)\n--- got\n%s\n--- want\n%s", name, got, want)
	}
}

var goVersion = regexp.MustCompile(`go1\.[0-9.]+[a-z0-9]*, [a-z0-9]+/[a-z0-9]+`)

func (e *env) scrub(s string) string {
	s = strings.ReplaceAll(s, e.api.srv.URL, "http://API")
	repl := map[string]string{e.config: "$CONFIG"}
	for k, v := range e.scrubs {
		repl[k] = v
	}
	for from, to := range repl {
		// Paths print with the OS separator; golden files use "/".
		s = regexp.MustCompile(regexp.QuoteMeta(from)+`[\\/]?`).ReplaceAllStringFunc(s, func(m string) string {
			if strings.HasSuffix(m, "\\") || strings.HasSuffix(m, "/") {
				return to + "/"
			}
			return to
		})
		s = strings.ReplaceAll(s, filepath.ToSlash(from), to)
	}
	return goVersion.ReplaceAllString(s, "GOVERSION, OS/ARCH")
}

func args(a ...string) []string { return a }

// ---------------------------------------------------------------------------

func TestHelpAndVersion(t *testing.T) {
	e := newEnv(t)
	e.golden("help",
		args(),
		args("help"),
		args("help", "deploy"),
		args("push", "--help"),
		args("nope"),
		args("version"),
		args("ls", "--bogus"),
	)
	r := e.run("", "version", "--json")
	var v map[string]string
	if err := json.Unmarshal([]byte(r.stdout), &v); err != nil || v["version"] != Version || v["sdk"] != "0.1.0" || v["os"] != runtime.GOOS {
		t.Fatalf("version --json: %q %v", r.stdout, err)
	}
}

func TestLoginLogout(t *testing.T) {
	e := newEnv(t)
	delete(e.vars, "KYP_API_KEY")
	e.golden("login",
		args("ls"),
		args("<<kypd_xyz\n", "login"),
		args("<<wrong_key\n", "login"),
		args("<<"+testAPIKey+"\n", "login"),
		args("ls", "--limit", "1"),
		args("logout"),
		args("ls"),
		args("login", "--key", "kyp_live_unverified", "--no-verify"),
	)
	cfgPath := filepath.Join(e.config, "config.json")
	st, err := os.Stat(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Fatalf("config mode %v, want 0600", st.Mode().Perm())
	}
	b, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(b), "kyp_live_unverified") {
		t.Fatalf("config %s", b)
	}
	// --api-url is remembered by login.
	r := e.run(testAPIKey+"\n", "login", "--api-url", e.api.srv.URL, "--json")
	if r.code != 0 || !strings.Contains(r.stdout, `"email": "ana@acme.test"`) {
		t.Fatalf("login --json: %+v", r)
	}
	delete(e.vars, "KYP_API_URL")
	if r := e.run("", "ls", "--limit", "1"); r.code != 0 {
		t.Fatalf("ls with stored url: %+v", r)
	}
}

func TestListSearchShow(t *testing.T) {
	e := newEnv(t)
	e.golden("ls_search_show",
		args("ls"),
		args("ls", "--limit", "2"),
		args("search", "support", "agent"),
		args("search", "zebra"),
		args("search"),
		args("show", "triage"),
		args("show", "triage", "--version", "1"),
		args("show", "triage", "--version", "9"),
		args("show", "agents/reviewer"),
		args("show", "nope"),
	)
	r := e.run("", "ls", "--json")
	var out struct{ Data []map[string]any }
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil || len(out.Data) != 3 {
		t.Fatalf("ls --json: %v %q", err, r.stdout)
	}
	r = e.run("", "show", "triage", "--json")
	if !strings.Contains(r.stdout, `"currentVersion": 2`) || !strings.Contains(r.stdout, `"body"`) {
		t.Fatalf("show --json: %q", r.stdout)
	}
	if e.api.last().Path != "/v1/assets/triage" {
		t.Fatalf("path %s", e.api.last().Path)
	}
	e.run("", "show", "agents/reviewer")
	if p := e.api.last().Path; p != "/v1/assets/agents%2Freviewer" {
		t.Fatalf("nested slug path %s", p)
	}
}

func TestPush(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	e.scrubs[dir] = "$TMP"
	file := filepath.Join(dir, "welcome.txt")
	if err := os.WriteFile(file, []byte("Welcome {{name}}!"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := e.run("", "push", file, "--name", "Welcome Email", "-m", "first")
	if r.code != 0 || r.stdout != "Created welcome-email v1 (Welcome Email)\n" {
		t.Fatalf("create: %+v", r)
	}
	if b := e.api.last().Body; b["slug"] != "welcome-email" || b["body"] != "Welcome {{name}}!" || b["message"] != "first" || b["kind"] != "prompt" {
		t.Fatalf("create body %v", b)
	}
	os.WriteFile(file, []byte("Welcome back {{name}}!"), 0o644)
	r = e.run("", "push", file, "--slug", "welcome-email", "--message", "warmer")
	if r.code != 0 || r.stdout != "Updated welcome-email: v1 -> v2\n" {
		t.Fatalf("update: %+v", r)
	}
	if b := e.api.last().Body; b["baseVersion"] != float64(1) || b["message"] != "warmer" || b["name"] != nil {
		t.Fatalf("update body %v", b)
	}
	os.WriteFile(file, []byte("Welcome back, {{name}}!"), 0o644)
	e.golden("push",
		args("push", file, "--slug", "welcome-email", "--base", "1"),
		args("push", file, "--slug", "welcome-email"),
		args("push", file, "--slug", "welcome-email"),
		args("<<Escalate politely, always.", "push", "-", "--name", "Escalation"),
		args("push", file),
		args("push", "missing.txt", "--name", "X"),
		args("push", file, "--slug", "Bad Slug"),
		args("<<x", "push", "-", "--slug", "brand-new"),
	)
	os.WriteFile(file, []byte("Hello again {{name}}"), 0o644)
	r = e.run("", "push", file, "--slug", "welcome-email", "--base", "1", "--json")
	var je map[string]any
	if err := json.Unmarshal([]byte(r.stderr), &je); err != nil || r.code != ExitConflict || je["exitCode"] != float64(ExitConflict) {
		t.Fatalf("json conflict: %+v %v", r, err)
	}
	if p := je["problem"].(map[string]any); p["currentVersion"] != float64(3) || !strings.HasSuffix(p["type"].(string), "version-conflict") {
		t.Fatalf("problem %v", p)
	}
}

func TestDiff(t *testing.T) {
	e := newEnv(t)
	e.golden("diff",
		args("diff", "triage", "1", "2"),
		args("diff", "triage", "1", "2", "--color", "always"),
		args("diff", "triage", "1", "7"),
		args("diff", "triage", "x", "2"),
		args("diff", "triage"),
	)
	e.run("", "diff", "triage", "1", "2")
	if p := e.api.last().Path; p != "/v1/assets/ast_1/diff?from=1&to=2" {
		t.Fatalf("path %s", p)
	}
	// auto colour: on for a terminal, off with NO_COLOR.
	e.tty = true
	if r := e.run("", "diff", "triage", "1", "2"); !strings.Contains(r.stdout, "\x1b[32m") {
		t.Fatal("no colour on a terminal")
	}
	e.vars["NO_COLOR"] = "1"
	if r := e.run("", "diff", "triage", "1", "2"); strings.Contains(r.stdout, "\x1b[") {
		t.Fatal("colour despite NO_COLOR")
	}
}

func TestDeployRollback(t *testing.T) {
	e := newEnv(t)
	e.golden("deploy",
		args("deploy", "support-bot", "prod", "triage=triage@1", "agents/reviewer=agents/reviewer", "escalation", "-m", "ship it"),
		args("deploy", "support-bot", "prod"),
		args("deploy", "support-bot", "prod", "triage=triage@0"),
		args("deploy", "support-bot", "prod", "triage=triage@5"),
		args("deploy", "support-bot", "prod", "a=triage", "a=escalation"),
		args("deploy", "nope", "prod", "triage"),
		args("rollback", "support-bot", "prod", "5"),
		args("rollback", "support-bot", "prod", "99"),
		args("rollback", "support-bot", "prod"),
	)
	e.api.reset()
	e.run("", "deploy", "support-bot", "staging", "t=triage@2", "-m", "m")
	reqs := e.api.requests
	b := reqs[len(reqs)-1].Body
	if reqs[len(reqs)-1].Path != "/v1/apps/support-bot/deploy" || b["env"] != "staging" || b["message"] != "m" {
		t.Fatalf("deploy request %+v", reqs[len(reqs)-1])
	}
	p := b["prompts"].([]any)[0].(map[string]any)
	if p["name"] != "t" || p["assetId"] != "ast_1" || p["version"] != float64(2) {
		t.Fatalf("deploy prompt %v", p)
	}
	e.run("", "rollback", "support-bot", "prod", "r3")
	if b := e.api.last().Body; b["env"] != "prod" || b["toRevision"] != float64(3) {
		t.Fatalf("rollback body %v", b)
	}
	if r := e.run("", "rollback", "support-bot", "prod", "3", "--json"); !strings.Contains(r.stdout, `"kind": "rollback"`) {
		t.Fatalf("rollback --json %q", r.stdout)
	}
}

func TestCapture(t *testing.T) {
	e := newEnv(t)
	e.golden("capture",
		args("<<Summarise this thread in three bullets.", "capture", "--source", "ide", "--url", "https://claude.ai/chat/1"),
		args("<<   ", "capture"),
		args("capture", "file.txt"),
	)
	r := e.run("draft text", "capture", "--draft", "--client-id", "c1")
	if r.code != 0 {
		t.Fatalf("%+v", r)
	}
	if b := e.api.last().Body; b["text"] != "draft text" || b["draft"] != true || b["clientId"] != "c1" || b["source"] != "api" {
		t.Fatalf("capture body %v", b)
	}
}

func TestMCP(t *testing.T) {
	e := newEnv(t)
	e.golden("mcp",
		args("mcp"),
		args("mcp", "--client", "vscode", "--with-key"),
		args("mcp", "--client", "emacs"),
		args("mcp", "--client", "claude-code", "--json"),
	)
}

func TestAPIErrors(t *testing.T) {
	e := newEnv(t)
	e.vars["KYP_API_KEY"] = "kyp_live_wrong"
	e.golden("errors_auth", args("ls"), args("ls", "--json"))

	e = newEnv(t)
	e.api.failStatus = 422
	e.api.failBody = `{"type":"https://keepyourprompts.com/problems/validation-error","title":"Validation failed","status":422,"detail":"The request is invalid.","errors":[{"pointer":"/body","message":"String must contain at most 262144 character(s)"}]}`
	e.golden("errors_validation", args("<<x", "push", "-", "--name", "Big"))

	e.api.failStatus = 429
	e.api.failBody = `{"type":"https://keepyourprompts.com/problems/quota-exceeded","title":"Quota reached","status":429,"detail":"The free plan includes 3 apps.","upgradeUrl":"https://app.keepyourprompts.com/settings/billing"}`
	e.golden("errors_quota", args("deploy", "support-bot", "prod", "triage"))

	e.api.failStatus = 503
	e.api.failBody = `upstream unavailable`
	e.golden("errors_unavailable", args("search", "x"))

	// Nothing listening.
	srv := httptest.NewServer(http.NotFoundHandler())
	srv.Close()
	e.vars["KYP_API_URL"] = srv.URL
	r := e.run("", "ls")
	if r.code != ExitUnavailable || !strings.Contains(r.stderr, "GET /v1/assets") || !strings.Contains(r.stderr, "hint: check your network") {
		t.Fatalf("network error: %+v", r)
	}
}
