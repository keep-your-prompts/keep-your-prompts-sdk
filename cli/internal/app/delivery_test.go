package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeCDN serves a conformance fixture under /v1/d/<key>/ and /v1/delivery/<key>/.
func fakeCDN(t *testing.T, fixture string) *httptest.Server {
	dir := filepath.Join(conformance, "fixtures", fixture)
	fsrv := http.FileServer(http.Dir(dir))
	mux := http.NewServeMux()
	mux.Handle("/v1/d/"+deliveryKey+"/", http.StripPrefix("/v1/d/"+deliveryKey, fsrv))
	mux.Handle("/v1/delivery/"+deliveryKey+"/", http.StripPrefix("/v1/delivery/"+deliveryKey, fsrv))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func (e *env) useCDN(srv *httptest.Server) {
	e.vars["KYP_DELIVERY_KEY"] = deliveryKey
	e.vars["KYP_CDN_URL"] = srv.URL + "/v1/d"
	e.vars["KYP_ORIGIN_URL"] = srv.URL + "/v1/delivery"
}

func TestPull(t *testing.T) {
	e := newEnv(t)
	out := t.TempDir()
	e.scrubs[out] = "$TMP"
	e.golden("pull_errors",
		args("pull", "--out", out),
		args("pull", "--app", "demo"),
		args("pull", "--app", "demo", "--out", out),
		args("pull", "--app", "demo", "--out", out, "--format", "yaml"),
		args("pull", "--app", "demo", "--out", "-"),
	)
	e.useCDN(fakeCDN(t, "v12"))

	folder := filepath.Join(out, "prompts")
	r := e.run("", "pull", "--app", "demo", "--env", "prod", "--out", folder)
	if r.code != 0 || r.stdout != "Pulled demo/prod revision 12 (4 prompts) from cdn into "+folder+"\n" {
		t.Fatalf("pull: %+v", r)
	}
	for _, f := range []string{"envs/demo/prod.json", "blobs/5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"} {
		got, _ := os.ReadFile(filepath.Join(folder, f))
		want, _ := os.ReadFile(filepath.Join(fixtureV12Dir, f))
		if len(want) == 0 || string(got) != string(want) {
			t.Fatalf("%s differs", f)
		}
	}
	// The folder is a snapshot `kyp get` can read without the network.
	delete(e.vars, "KYP_DELIVERY_KEY")
	r = e.run("", "get", "greeting", "--app", "demo", "--snapshot", folder, "--var", "name=Ana", "--var", "company=Acme")
	if r.code != 0 || r.stdout != "Hello Ana, welcome to Acme." {
		t.Fatalf("get from pulled snapshot: %+v", r)
	}
	e.vars["KYP_DELIVERY_KEY"] = deliveryKey

	// --format go writes the layout plus an embed.go.
	gofolder := filepath.Join(out, "kypprompts")
	r = e.run("", "pull", "--app", "demo", "--out", gofolder, "--format", "go", "--json")
	var info map[string]any
	if err := json.Unmarshal([]byte(r.stdout), &info); err != nil || info["revision"] != float64(12) || info["source"] != "cdn" || len(info["files"].([]any)) != 6 {
		t.Fatalf("pull go --json: %v %q", err, r.stdout)
	}
	src, _ := os.ReadFile(filepath.Join(gofolder, "embed.go"))
	for _, want := range []string{"package kypprompts", "//go:embed envs blobs", "var Snapshot embed.FS", "demo/prod (revision 12)"} {
		if !strings.Contains(string(src), want) {
			t.Fatalf("embed.go lacks %q:\n%s", want, src)
		}
	}

	// --format ts and json write the TypeScript SDK's EmbeddedSnapshot shape.
	r = e.run("", "pull", "--app", "demo", "--out", out, "--format", "ts")
	ts, _ := os.ReadFile(filepath.Join(out, "snapshot.ts"))
	if r.code != 0 || !strings.Contains(string(ts), "import type { EmbeddedSnapshot } from '@keepyourprompts/sdk';") ||
		!strings.Contains(string(ts), `"blobs/f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf": "You are a support agent for {{company}}. Literal {{{{braces}} stay."`) {
		t.Fatalf("ts: %+v\n%s", r, ts)
	}
	r = e.run("", "pull", "--app", "demo", "--out", "-", "--format", "json")
	var doc struct {
		Kyp   int               `json:"kyp"`
		Files map[string]string `json:"files"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &doc); err != nil || doc.Kyp != 1 || len(doc.Files) != 5 {
		t.Fatalf("json: %v %q", err, r.stdout)
	}
	r = e.run("", "pull", "--app", "demo", "--out", filepath.Join(out, "x", "snap.json"), "--format", "json")
	if _, err := os.Stat(filepath.Join(out, "x", "snap.json")); err != nil || r.code != 0 {
		t.Fatalf("json file: %+v %v", r, err)
	}

	// Unknown app: the mirrors answer 404.
	r = e.run("", "pull", "--app", "nope", "--out", out, "--timeout", "1s")
	if r.code != ExitUnavailable || !strings.Contains(r.stderr, "manifest not found") || strings.Contains(r.stderr, deliveryKey) {
		t.Fatalf("unknown app: %+v", r)
	}
}

func TestGet(t *testing.T) {
	e := newEnv(t)
	snap := fixtureV12Dir
	e.golden("get",
		args("get", "greeting", "--app", "demo", "--snapshot", snap, "--var", "name=Ana", "--var", "company=Acme"),
		args("get", "greeting", "--app", "demo", "--snapshot", snap, "--var", "name=Ana"),
		args("get", "greeting", "--app", "demo", "--snapshot", snap, "--var", "name=Ana", "--lenient"),
		args("get", "greeting", "--app", "demo", "--snapshot", snap, "--raw"),
		args("get", "triage", "--app", "demo", "--snapshot", snap, "--var", "company=Acme"),
		args("get", "agents/reviewer", "--app", "demo", "--snapshot", snap),
		args("get", "nope", "--app", "demo", "--snapshot", snap),
		args("get", "greeting", "--app", "demo", "--snapshot", snap, "--var", "oops"),
		args("get", "greeting", "--app", "demo"),
		args("get", "greeting"),
	)
	r := e.run("", "get", "greeting", "--app", "demo", "--snapshot", snap, "--var", "name=A", "--var", "company=B", "--json")
	var out map[string]any
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil || out["version"] != float64(4) || out["text"] != "Hello A, welcome to B." || out["source"] != "snapshot" || out["revision"] != float64(12) {
		t.Fatalf("get --json: %v %q", err, r.stdout)
	}
	// KYP_SNAPSHOT_DIR and KYP_APP work like the flags.
	e.vars["KYP_APP"], e.vars["KYP_SNAPSHOT_DIR"] = "demo", snap
	if r := e.run("", "get", "empty"); r.code != 0 || r.stdout != "" {
		t.Fatalf("empty: %+v", r)
	}

	// With a delivery key the snapshot is upgraded from the network (v13 deployed).
	e.useCDN(fakeCDN(t, "v13"))
	if r := e.run("", "get", "greeting", "--var", "name=Ana", "--var", "company=Acme"); r.code != 0 || r.stdout != "Hi Ana! Acme is glad you are here." {
		t.Fatalf("network upgrade: %+v", r)
	}
	// --offline sticks to the snapshot.
	if r := e.run("", "get", "greeting", "--offline", "--raw"); r.stdout != "Hello {{name}}, welcome to {{ company }}." {
		t.Fatalf("offline: %+v", r)
	}
	// Network down: serve the snapshot with a warning.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer srv.Close()
	e.vars["KYP_CDN_URL"], e.vars["KYP_ORIGIN_URL"] = srv.URL, srv.URL
	r = e.run("", "get", "greeting", "--raw")
	if r.code != 0 || r.stdout != "Hello {{name}}, welcome to {{ company }}." || !strings.Contains(r.stderr, "warning: serving snapshot revision 12") {
		t.Fatalf("network down: %+v", r)
	}
	// TTY: a newline is added for the terminal.
	e.tty = true
	if r := e.run("", "get", "greeting", "--raw", "--offline"); !strings.HasSuffix(r.stdout, "}}.\n") {
		t.Fatalf("tty: %q", r.stdout)
	}
}

func TestParseInterspersed(t *testing.T) {
	e := newEnv(t)
	// Flags before, between and after positionals; "--" ends flags.
	r := e.run("", "get", "--app", "demo", "--", "greeting", "--snapshot")
	if r.code != ExitUsage {
		t.Fatalf("%+v", r)
	}
	if got := slugify("  Support Triage (v2)!  "); got != "support-triage-v2" {
		t.Fatalf("slugify %q", got)
	}
	if goPackageName("", "./my-prompts") != "myprompts" || goPackageName("", "2024") != "prompts2024" || goPackageName("x", "y") != "x" {
		t.Fatal("goPackageName")
	}
}
