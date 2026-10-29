package kyp

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
)

// Manifest is envs/<app>/<env>.json: which prompt body is live for each name.
type Manifest struct {
	Schema     int                       `json:"schema"`
	Workspace  string                    `json:"workspace"`
	App        string                    `json:"app"`
	Env        string                    `json:"env"`
	Revision   int64                     `json:"revision"`
	DeployedAt string                    `json:"deployed_at"`
	Prompts    map[string]ManifestPrompt `json:"prompts"`
}

// ManifestPrompt is one entry of Manifest.Prompts.
type ManifestPrompt struct {
	SHA256    string   `json:"sha256"`
	Version   int64    `json:"version"`
	Variables []string `json:"variables"`
}

// Names returns the prompt names, sorted.
func (m *Manifest) Names() []string {
	names := make([]string, 0, len(m.Prompts))
	for n := range m.Prompts {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// IsSlug reports whether s is an app or env slug: [a-z0-9][a-z0-9-]{0,62}.
func IsSlug(s string) bool {
	if len(s) == 0 || len(s) > 63 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || (i > 0 && c == '-')) {
			return false
		}
	}
	return true
}

func isWorkspaceSlug(s string) bool {
	if s == "" || len(s) > 128 || s == "." || s == ".." {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}

// IsSHA256Hex reports whether s is 64 lowercase hex characters.
func IsSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func validPromptName(name string) bool {
	if name == "" || name[0] == '/' || name[len(name)-1] == '/' || strings.Contains(name, "//") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "." || part == ".." || strings.ContainsAny(part, "\\\x00") {
			return false
		}
	}
	return true
}

// ParseManifest parses and validates a manifest. Unknown fields are ignored and
// a missing "variables" list becomes []. Errors are *ProtocolError.
func ParseManifest(data []byte) (*Manifest, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var raw map[string]json.RawMessage
	if err := dec.Decode(&raw); err != nil || raw == nil {
		return nil, protocolErrorf("manifest is not a JSON object")
	}
	m := &Manifest{Schema: 1}
	if s, ok := raw["schema"]; ok && string(s) != "null" {
		if strings.TrimSpace(string(s)) != "1" {
			return nil, protocolErrorf("unsupported manifest schema %s (this SDK reads schema 1)", string(s))
		}
	}
	str := func(key string, required bool) (string, error) {
		v, ok := raw[key]
		if !ok || string(v) == "null" {
			if required {
				return "", protocolErrorf("manifest is missing %q", key)
			}
			return "", nil
		}
		var s string
		if json.Unmarshal(v, &s) != nil {
			return "", protocolErrorf("manifest %q must be a string", key)
		}
		return s, nil
	}
	var err error
	if m.Workspace, err = str("workspace", true); err != nil {
		return nil, err
	}
	if m.App, err = str("app", true); err != nil {
		return nil, err
	}
	if m.Env, err = str("env", true); err != nil {
		return nil, err
	}
	if m.DeployedAt, err = str("deployed_at", false); err != nil {
		return nil, err
	}
	if !isWorkspaceSlug(m.Workspace) {
		return nil, protocolErrorf("manifest workspace %q is not a valid slug", m.Workspace)
	}
	if !IsSlug(m.App) || !IsSlug(m.Env) {
		return nil, protocolErrorf("manifest app/env %q/%q are not valid slugs", m.App, m.Env)
	}
	rev, ok := raw["revision"]
	var n json.Number
	if !ok || isJSONString(rev) || json.Unmarshal(rev, &n) != nil {
		return nil, protocolErrorf("manifest \"revision\" must be a non-negative integer")
	}
	r, convErr := n.Int64()
	if convErr != nil || r < 0 {
		return nil, protocolErrorf("manifest \"revision\" must be a non-negative integer")
	}
	m.Revision = r

	var prompts map[string]json.RawMessage
	if p, ok := raw["prompts"]; !ok || json.Unmarshal(p, &prompts) != nil || prompts == nil {
		return nil, protocolErrorf("manifest \"prompts\" must be an object")
	}
	m.Prompts = make(map[string]ManifestPrompt, len(prompts))
	for name, pv := range prompts {
		if !validPromptName(name) {
			return nil, protocolErrorf("invalid prompt name %q", name)
		}
		var p map[string]json.RawMessage
		if json.Unmarshal(pv, &p) != nil || p == nil {
			return nil, protocolErrorf("prompt %q must be an object", name)
		}
		var mp ManifestPrompt
		if json.Unmarshal(p["sha256"], &mp.SHA256) != nil {
			return nil, protocolErrorf("prompt %q has no sha256", name)
		}
		mp.SHA256 = strings.ToLower(mp.SHA256)
		if !IsSHA256Hex(mp.SHA256) {
			return nil, protocolErrorf("prompt %q has an invalid sha256", name)
		}
		if v, ok := p["version"]; ok {
			var vn json.Number
			if !isJSONString(v) && json.Unmarshal(v, &vn) == nil {
				if iv, err := vn.Int64(); err == nil {
					mp.Version = iv
				}
			}
		}
		mp.Variables = []string{}
		if v, ok := p["variables"]; ok {
			var list []json.RawMessage
			if json.Unmarshal(v, &list) == nil {
				for _, item := range list {
					var s string
					if json.Unmarshal(item, &s) == nil {
						mp.Variables = append(mp.Variables, s)
					}
				}
			}
		}
		m.Prompts[name] = mp
	}
	return m, nil
}

// isJSONString: json.Number also accepts "12" (a quoted number); the protocol does not.
func isJSONString(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	return len(t) > 0 && t[0] == '"'
}
