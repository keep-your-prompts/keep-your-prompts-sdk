package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const defaultAPIURL = "https://api.keepyourprompts.com"

// Problem is an RFC 9457 application/problem+json body.
type Problem struct {
	Type      string         `json:"type,omitempty"`
	Title     string         `json:"title,omitempty"`
	Status    int            `json:"status,omitempty"`
	Detail    string         `json:"detail,omitempty"`
	Errors    []ProblemField `json:"errors,omitempty"`
	RequestID string         `json:"requestId,omitempty"`
	// Extensions such as currentVersion (version-conflict) or upgradeUrl.
	Extra map[string]any `json:"-"`
}

// ProblemField points at one invalid field.
type ProblemField struct {
	Pointer string `json:"pointer"`
	Message string `json:"message"`
}

// MarshalJSON keeps the extension members.
func (p Problem) MarshalJSON() ([]byte, error) {
	m := map[string]any{}
	for k, v := range p.Extra {
		m[k] = v
	}
	type plain Problem
	b, _ := json.Marshal(plain(p))
	_ = json.Unmarshal(b, &m)
	return json.Marshal(m)
}

// Slug is the last segment of Type, e.g. "version-conflict".
func (p *Problem) Slug() string {
	if i := strings.LastIndex(p.Type, "/"); i >= 0 {
		return p.Type[i+1:]
	}
	return p.Type
}

// APIError is a non-2xx answer from the API.
type APIError struct {
	Method, Path string
	Problem      Problem
}

func (e *APIError) Error() string {
	title := e.Problem.Title
	if title == "" {
		title = http.StatusText(e.Problem.Status)
	}
	msg := title
	if e.Problem.Detail != "" {
		msg += ": " + e.Problem.Detail
	}
	tag := fmt.Sprintf("HTTP %d", e.Problem.Status)
	if s := e.Problem.Slug(); s != "" && s != "about:blank" {
		tag += " " + s
	}
	return fmt.Sprintf("%s (%s)", msg, tag)
}

func (e *APIError) exitCode() int {
	switch s := e.Problem.Status; {
	case s == 401 || s == 403:
		if e.Problem.Slug() == "plan-upgrade-required" {
			return ExitQuota
		}
		return ExitAuth
	case s == 404:
		return ExitNotFound
	case s == 409:
		return ExitConflict
	case s == 400 || s == 422:
		return ExitInvalid
	case s == 429:
		return ExitQuota
	case s >= 500:
		return ExitUnavailable
	}
	return ExitError
}

func (e *APIError) hint() string {
	switch e.Problem.Status {
	case 401:
		return "run `kyp login` or set KYP_API_KEY to a workspace API key (Settings > API keys)"
	case 403:
		if u, ok := e.Problem.Extra["upgradeUrl"].(string); ok {
			return "upgrade at " + u
		}
		return "this API key's role cannot do that; ask a workspace admin for an editor key"
	case 429:
		if u, ok := e.Problem.Extra["upgradeUrl"].(string); ok {
			return "upgrade at " + u
		}
		return "wait a moment and try again"
	}
	return ""
}

// apiClient talks to the Keep Your Prompts API with an API key.
type apiClient struct {
	base, key string
	http      *http.Client
}

func (c *apiClient) do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	u := strings.TrimRight(c.base, "/") + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("Accept", "application/json, application/problem+json")
	req.Header.Set("User-Agent", "kyp-cli/"+Version)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		var ue *url.Error
		msg := err.Error()
		if errors.As(err, &ue) {
			msg = ue.Err.Error()
		}
		var ne net.Error
		hint := "check your network and --api-url / KYP_API_URL (" + c.base + ")"
		if errors.As(err, &ne) && ne.Timeout() {
			msg = "request timed out"
		}
		return errCode(ExitUnavailable, hint, "%s %s: %s", method, path, msg)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return errCode(ExitUnavailable, "", "%s %s: reading response: %v", method, path, err)
	}
	if resp.StatusCode/100 != 2 {
		return parseProblem(method, path, resp.StatusCode, data)
	}
	if out == nil || resp.StatusCode == http.StatusNoContent || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if raw, ok := out.(*json.RawMessage); ok {
		*raw = append((*raw)[:0], data...)
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%s %s: unexpected response: %v", method, path, err)
	}
	return nil
}

func parseProblem(method, path string, status int, data []byte) error {
	e := &APIError{Method: method, Path: path}
	var m map[string]any
	if json.Unmarshal(data, &m) == nil && m != nil {
		_ = json.Unmarshal(data, &e.Problem)
		known := map[string]bool{"type": true, "title": true, "status": true, "detail": true, "errors": true, "requestId": true}
		for k, v := range m {
			if !known[k] {
				if e.Problem.Extra == nil {
					e.Problem.Extra = map[string]any{}
				}
				e.Problem.Extra[k] = v
			}
		}
	} else if t := strings.TrimSpace(string(data)); t != "" && len(t) < 500 {
		e.Problem.Detail = t
	}
	if e.Problem.Status == 0 {
		e.Problem.Status = status
	}
	return e
}

// ---------------------------------------------------------------------------
// Config: <UserConfigDir>/kyp/config.json, mode 0600.
// ---------------------------------------------------------------------------

type config struct {
	APIKey string `json:"api_key,omitempty"`
	APIURL string `json:"api_url,omitempty"`
}

func (a *App) configPath() (string, error) {
	dir := a.ConfigDir
	if dir == "" {
		dir = a.Getenv("KYP_CONFIG_DIR")
	}
	if dir == "" {
		d, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(d, "kyp")
	}
	return filepath.Join(dir, "config.json"), nil
}

func (a *App) loadConfig() (config, error) {
	var cfg config
	p, err := a.configPath()
	if err != nil {
		return cfg, nil
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, fmt.Errorf("%s: %v", p, err)
	}
	return cfg, nil
}

func (a *App) saveConfig(cfg config) (string, error) {
	p, err := a.configPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return "", err
	}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	tmp, err := os.CreateTemp(filepath.Dir(p), ".config-*")
	if err != nil {
		return "", err
	}
	name := tmp.Name()
	if err := tmp.Chmod(0o600); err != nil && !isWindows() {
		tmp.Close()
		os.Remove(name)
		return "", err
	}
	_, werr := tmp.Write(append(b, '\n'))
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(name, p)
	}
	if werr != nil {
		os.Remove(name)
		return "", werr
	}
	_ = os.Chmod(p, 0o600)
	return p, nil
}

func (a *App) resolveAPIURL(c *cmdCtx, cfg config) string {
	switch {
	case c.apiURL != "":
		return c.apiURL
	case a.Getenv("KYP_API_URL") != "":
		return a.Getenv("KYP_API_URL")
	case cfg.APIURL != "":
		return cfg.APIURL
	}
	return defaultAPIURL
}

// api returns a client authenticated with KYP_API_KEY or the stored key.
func (a *App) api(c *cmdCtx) (*apiClient, error) {
	cfg, err := a.loadConfig()
	if err != nil {
		return nil, err
	}
	key := a.Getenv("KYP_API_KEY")
	if key == "" {
		key = cfg.APIKey
	}
	if key == "" {
		return nil, errCode(ExitAuth, "run `kyp login` or set KYP_API_KEY (create a key in Settings > API keys)", "no API key")
	}
	return &apiClient{base: a.resolveAPIURL(c, cfg), key: key, http: a.HTTPClient}, nil
}
