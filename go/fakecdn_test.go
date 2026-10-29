package kyp

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The conformance suite lives next to the SDKs in this repository.
const conformanceDir = "../conformance"

// route is one URL prefix served from a fixture folder.
type route struct {
	name, prefix, dir string
}

type routeStats struct {
	OK          int     `json:"200"`
	NotModified int     `json:"304"`
	NotFound    int     `json:"404"`
	Down        int     `json:"503"`
	Auth        *string `json:"auth"`
}

// cdnServer is either conformance/fake_cdn.py (run with python3) or
// newInprocCDN, an in-process httptest server with the same behaviour and the
// same control endpoints, so the conformance tests drive both identically.
type cdnServer struct {
	t    *testing.T
	base string
}

func (s *cdnServer) ctl(path string) []byte {
	s.t.Helper()
	resp, err := http.Get(s.base + path)
	if err != nil {
		s.t.Fatalf("control %s: %v", path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return b
}

func (s *cdnServer) down(name string) { s.ctl("/__down/" + name) }
func (s *cdnServer) up(name string)   { s.ctl("/__up/" + name) }
func (s *cdnServer) stats() map[string]routeStats {
	var m map[string]routeStats
	if err := json.Unmarshal(s.ctl("/__stats"), &m); err != nil {
		s.t.Fatalf("stats: %v", err)
	}
	return m
}

const (
	manifestCC = "public, max-age=15, stale-while-revalidate=300, stale-if-error=86400"
	blobCC     = "public, max-age=31536000, immutable"
)

// newInprocCDN is a Go port of conformance/fake_cdn.py.
func newInprocCDN(t *testing.T, routes []route) *cdnServer {
	var mu sync.Mutex
	stats := map[string]*routeStats{}
	for _, r := range routes {
		stats[r.name] = &routeStats{}
	}
	down := map[string]bool{}
	send := func(w http.ResponseWriter, code int, body []byte, h map[string]string) {
		for k, v := range h {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		w.WriteHeader(code)
		_, _ = w.Write(body)
	}
	h := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		path := req.URL.Path
		if path == "/__stats" {
			mu.Lock()
			b, _ := json.Marshal(stats)
			mu.Unlock()
			send(w, 200, b, map[string]string{"Content-Type": "application/json"})
			return
		}
		for _, verb := range []string{"down", "up"} {
			if p := "/__" + verb + "/"; strings.HasPrefix(path, p) {
				mu.Lock()
				if verb == "down" {
					down[path[len(p):]] = true
				} else {
					delete(down, path[len(p):])
				}
				mu.Unlock()
				send(w, 200, []byte("ok"), nil)
				return
			}
		}
		for _, r := range routes {
			if !strings.HasPrefix(path, r.prefix+"/") {
				continue
			}
			rel := path[len(r.prefix)+1:]
			mu.Lock()
			st := stats[r.name]
			if a := req.Header.Get("Authorization"); a != "" {
				st.Auth = &a
			} else {
				st.Auth = nil
			}
			if down[r.name] {
				st.Down++
				mu.Unlock()
				send(w, 503, []byte("down"), nil)
				return
			}
			mu.Unlock()
			parts := strings.Split(rel, "/")
			bad := !(strings.HasPrefix(rel, "envs/") || strings.HasPrefix(rel, "blobs/"))
			for _, p := range parts {
				if p == ".." || p == "" {
					bad = true
				}
			}
			if bad {
				send(w, 404, []byte("not found"), nil)
				return
			}
			body, err := os.ReadFile(filepath.Join(append([]string{r.dir}, parts...)...))
			if err != nil {
				mu.Lock()
				st.NotFound++
				mu.Unlock()
				send(w, 404, []byte("not found"), nil)
				return
			}
			sum := sha256.Sum256(body)
			etag := `"` + hex.EncodeToString(sum[:])[:32] + `"`
			hdr := map[string]string{"ETag": etag, "Cache-Control": blobCC, "Content-Type": "text/plain; charset=utf-8"}
			if strings.HasPrefix(rel, "envs/") {
				hdr["Cache-Control"] = manifestCC
				hdr["Content-Type"] = "application/json"
			}
			if req.Header.Get("If-None-Match") == etag {
				mu.Lock()
				st.NotModified++
				mu.Unlock()
				send(w, 304, nil, hdr)
				return
			}
			mu.Lock()
			st.OK++
			mu.Unlock()
			send(w, 200, body, hdr)
			return
		}
		send(w, 404, []byte("no route"), nil)
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &cdnServer{t: t, base: srv.URL}
}

// pythonCDN runs conformance/fake_cdn.py. It skips the test when python3 is
// not available (set KYP_PYTHON to choose the interpreter).
func pythonCDN(t *testing.T, routes []route) *cdnServer {
	py := os.Getenv("KYP_PYTHON")
	if py == "" {
		py = "python3"
	}
	if _, err := exec.LookPath(py); err != nil {
		t.Skipf("%s not found: skipping fake_cdn.py run (the in-process server covers the same cases)", py)
	}
	args := []string{filepath.Join(conformanceDir, "fake_cdn.py")}
	for _, r := range routes {
		args = append(args, "--route", r.name+":"+r.prefix+":"+r.dir)
	}
	cmd := exec.Command(py, args...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start %s: %v", py, err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	lines := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(out)
		if sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
		_, _ = io.Copy(io.Discard, out)
	}()
	select {
	case line, ok := <-lines:
		var port int
		if !ok {
			t.Skipf("%s exited before printing its port", py)
		}
		if _, err := fmt.Sscanf(line, "PORT %d", &port); err != nil {
			t.Fatalf("fake_cdn.py printed %q", line)
		}
		return &cdnServer{t: t, base: fmt.Sprintf("http://127.0.0.1:%d", port)}
	case <-time.After(15 * time.Second):
		t.Fatal("fake_cdn.py did not start")
	}
	return nil
}

// backends runs fn against the in-process server and against fake_cdn.py.
func backends(t *testing.T, fn func(t *testing.T, start func(*testing.T, []route) *cdnServer)) {
	t.Run("inproc", func(t *testing.T) { fn(t, newInprocCDN) })
	t.Run("fake_cdn.py", func(t *testing.T) { fn(t, pythonCDN) })
}

// copyFixture replaces dir's contents with conformance/fixtures/<name>.
func copyFixture(t *testing.T, dir, name string) {
	t.Helper()
	for _, sub := range []string{"envs", "blobs"} {
		if err := os.RemoveAll(filepath.Join(dir, sub)); err != nil {
			t.Fatal(err)
		}
	}
	src := filepath.Join(conformanceDir, "fixtures", name)
	err := filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		dst := filepath.Join(dir, rel)
		if info.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func fixturePath(name string) string { return filepath.Join(conformanceDir, "fixtures", name) }
