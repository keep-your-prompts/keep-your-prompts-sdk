package kyp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type fetchKind int

const (
	fetchOK fetchKind = iota
	fetchNotModified
	fetchNotFound
	fetchFailed
)

type fetchResult struct {
	kind fetchKind
	body []byte
	etag string
	err  string
}

type mirrorKind int

const (
	kindFS mirrorKind = iota // embedded or any fs.FS
	kindFile
	kindCache
	kindHTTP
)

// maxBody caps any single response (manifest or blob).
const maxBody = 32 << 20

func classify(m Mirror) mirrorKind {
	switch {
	case m.FS != nil:
		return kindFS
	case strings.HasPrefix(m.URL, "http://"), strings.HasPrefix(m.URL, "https://"):
		return kindHTTP
	default:
		return kindFile
	}
}

// fileURLToPath accepts file:///dir, file://localhost/dir or a plain path.
func fileURLToPath(s string) string {
	if !strings.HasPrefix(s, "file://") {
		return s
	}
	u, err := url.Parse(s)
	if err != nil {
		return strings.TrimPrefix(s, "file://")
	}
	p := u.Path
	if runtime.GOOS == "windows" && len(p) >= 3 && p[0] == '/' && p[2] == ':' {
		p = p[1:] // file:///C:/dir
	}
	return filepath.FromSlash(p)
}

func readFile(name string) fetchResult {
	f, err := os.Open(name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fetchResult{kind: fetchNotFound, err: "not found"}
		}
		return fetchResult{kind: fetchFailed, err: err.Error()}
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxBody+1))
	if err != nil {
		return fetchResult{kind: fetchFailed, err: err.Error()}
	}
	if len(b) > maxBody {
		return fetchResult{kind: fetchFailed, err: "file too large"}
	}
	return fetchResult{kind: fetchOK, body: b}
}

func readFS(fsys fs.FS, rel string) fetchResult {
	b, err := fs.ReadFile(fsys, rel)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fetchResult{kind: fetchNotFound, err: "not found"}
		}
		return fetchResult{kind: fetchFailed, err: err.Error()}
	}
	return fetchResult{kind: fetchOK, body: b}
}

// relPath joins a slash-separated layout path to a directory.
func relPath(dir, rel string) string { return filepath.Join(dir, filepath.FromSlash(rel)) }

func newHTTPClient(o *Options) *http.Client {
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   o.ConnectTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   o.ConnectTimeout,
		ResponseHeaderTimeout: o.RequestTimeout,
	}
	return &http.Client{Transport: tr}
}

func (c *Client) httpGet(ctx context.Context, u, etag, token string) fetchResult {
	ctx, cancel := context.WithTimeout(ctx, c.opts.RequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return fetchResult{kind: fetchFailed, err: err.Error()}
	}
	req.Header.Set("User-Agent", c.opts.UserAgent)
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		msg := err.Error()
		var ue *url.Error
		if errors.As(err, &ue) {
			msg = ue.Err.Error() // drop the URL (it may hold the delivery key)
		}
		return fetchResult{kind: fetchFailed, err: msg}
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
		if err != nil {
			return fetchResult{kind: fetchFailed, err: "reading body: " + err.Error()}
		}
		if len(b) > maxBody {
			return fetchResult{kind: fetchFailed, err: "response too large"}
		}
		return fetchResult{kind: fetchOK, body: b, etag: resp.Header.Get("ETag")}
	case http.StatusNotModified:
		_, _ = io.Copy(io.Discard, resp.Body)
		e := resp.Header.Get("ETag")
		if e == "" {
			e = etag
		}
		return fetchResult{kind: fetchNotModified, etag: e}
	case http.StatusNotFound:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fetchResult{kind: fetchNotFound, err: "HTTP 404"}
	default:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fetchResult{kind: fetchFailed, err: fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}
}

// atomicWrite writes data to name via a temp file, fsync and rename, so readers
// (and other processes sharing the cache) never see a partial file.
func atomicWrite(name string, data []byte) error {
	dir := filepath.Dir(name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".tmp-"+path.Base(filepath.ToSlash(name))+"-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, werr := f.Write(data)
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmp, 0o644)
	}
	if werr == nil {
		werr = os.Rename(tmp, name)
	}
	if werr != nil {
		_ = os.Remove(tmp)
	}
	return werr
}
