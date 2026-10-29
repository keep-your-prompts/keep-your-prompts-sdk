package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
)

// Asset is the API's asset object (only the fields the CLI uses are typed).
type Asset struct {
	ID             string   `json:"id"`
	Kind           string   `json:"kind"`
	Name           string   `json:"name"`
	Slug           string   `json:"slug"`
	Description    string   `json:"description,omitempty"`
	Tags           []string `json:"tags,omitempty"`
	CurrentVersion int      `json:"currentVersion"`
	Visibility     string   `json:"visibility,omitempty"`
	UpdatedAt      string   `json:"updatedAt,omitempty"`
	Body           *string  `json:"body,omitempty"`
	Variables      []string `json:"variables,omitempty"`
	SHA256         string   `json:"sha256,omitempty"`
}

func assetPath(idOrSlug string) string { return "/v1/assets/" + url.PathEscape(idOrSlug) }

func (a *App) getAsset(ctx context.Context, api *apiClient, slug string) (*Asset, json.RawMessage, error) {
	var raw json.RawMessage
	if err := api.do(ctx, "GET", assetPath(slug), nil, nil, &raw); err != nil {
		var ae *APIError
		if errors.As(err, &ae) && ae.Problem.Status == 404 {
			return nil, nil, errCode(ExitNotFound, "list your prompts with `kyp ls` or `kyp search`", "no prompt %q in this workspace", slug)
		}
		return nil, nil, err
	}
	var as Asset
	if err := json.Unmarshal(raw, &as); err != nil {
		return nil, nil, err
	}
	return &as, raw, nil
}

func shortDate(s string) string {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC().Format("2006-01-02 15:04")
	}
	return s
}

func positiveInt(s, what string) (int, error) {
	n, err := strconv.Atoi(strings.TrimPrefix(s, "v"))
	if err != nil || n < 1 {
		return 0, usageErr("%s must be a positive integer, got %q", what, s)
	}
	return n, nil
}

// ---------------------------------------------------------------------------
// kyp login / logout
// ---------------------------------------------------------------------------

var loginCmd = &command{
	name:    "login",
	group:   "api",
	usage:   "[--key KEY] [--api-url URL] [--no-verify]",
	summary: "Store a workspace API key (kyp_live_…) in the OS config folder, readable only by you.",
	setup: func(fs *flag.FlagSet, c *cmdCtx) {
		c.str("key", "", "API key (default: read from stdin; prefer that over this flag, which lands in shell history)")
		c.bool("no-verify", "store the key without checking it against GET /v1/me")
	},
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) > 0 {
			return usageErr("unexpected argument %q", c.args[0])
		}
		key := strings.TrimSpace(*c.s["key"])
		if key == "" {
			if a.StdinTTY {
				fmt.Fprint(a.Stderr, "Paste an API key from Settings > API keys (kyp_live_…): ")
			}
			line, err := bufio.NewReader(a.Stdin).ReadString('\n')
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			key = strings.TrimSpace(line)
		}
		if key == "" {
			return usageErr("no API key given")
		}
		if strings.HasPrefix(key, "kypd_") {
			return usageErr("that is a delivery key (kypd_…), which only reads deployed prompts: export it as KYP_DELIVERY_KEY instead")
		}
		if !strings.HasPrefix(key, "kyp_") {
			fmt.Fprintln(a.Stderr, "kyp: warning: API keys start with kyp_live_")
		}
		cfg, err := a.loadConfig()
		if err != nil {
			return err
		}
		cfg.APIKey = key
		if c.apiURL != "" {
			cfg.APIURL = c.apiURL
		}
		var me struct {
			User      struct{ Email, Name string }      `json:"user"`
			Workspace struct{ Name, Slug, Role string } `json:"workspace"`
		}
		if !*c.b["no-verify"] {
			api := &apiClient{base: a.resolveAPIURL(c, cfg), key: key, http: a.HTTPClient}
			if err := api.do(ctx, "GET", "/v1/me", nil, nil, &me); err != nil {
				return err
			}
		}
		path, err := a.saveConfig(cfg)
		if err != nil {
			return err
		}
		if c.json {
			return a.printJSON(map[string]any{"config": path, "email": me.User.Email, "workspace": me.Workspace.Slug, "role": me.Workspace.Role, "verified": !*c.b["no-verify"]})
		}
		if *c.b["no-verify"] {
			fmt.Fprintf(a.Stdout, "Saved the API key (not verified) to %s\n", path)
		} else {
			fmt.Fprintf(a.Stdout, "Logged in as %s to %s (%s). Key saved to %s\n", me.User.Email, me.Workspace.Name, me.Workspace.Role, path)
		}
		return nil
	},
}

var logoutCmd = &command{
	name:    "logout",
	group:   "api",
	usage:   "",
	summary: "Remove the stored API key.",
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		cfg, err := a.loadConfig()
		if err != nil {
			return err
		}
		had := cfg.APIKey != ""
		cfg.APIKey = ""
		path, err := a.saveConfig(cfg)
		if err != nil {
			return err
		}
		if c.json {
			return a.printJSON(map[string]any{"config": path, "removed": had})
		}
		if had {
			fmt.Fprintf(a.Stdout, "Removed the API key from %s\n", path)
		} else {
			fmt.Fprintln(a.Stdout, "No stored API key.")
		}
		if a.Getenv("KYP_API_KEY") != "" {
			fmt.Fprintln(a.Stderr, "kyp: note: KYP_API_KEY is still set in your environment")
		}
		return nil
	},
}

// ---------------------------------------------------------------------------
// kyp search / ls / show
// ---------------------------------------------------------------------------

var searchCmd = &command{
	name:    "search",
	group:   "api",
	usage:   "QUERY... [--limit N] [--scope mine|public|all]",
	summary: "Search prompts (full text and semantic).",
	setup: func(fs *flag.FlagSet, c *cmdCtx) {
		c.int("limit", 20, "maximum results (1-50)")
		c.str("scope", "mine", "mine (workspace), public (library) or all")
	},
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		q := strings.TrimSpace(strings.Join(c.args, " "))
		if q == "" {
			return usageErr("expected a QUERY")
		}
		if s := *c.s["scope"]; s != "mine" && s != "public" && s != "all" {
			return usageErr("--scope must be mine, public or all")
		}
		api, err := a.api(c)
		if err != nil {
			return err
		}
		var raw json.RawMessage
		query := url.Values{"q": {q}, "limit": {strconv.Itoa(*c.i["limit"])}, "scope": {*c.s["scope"]}}
		if err := api.do(ctx, "GET", "/v1/search", query, nil, &raw); err != nil {
			return err
		}
		if c.json {
			return a.printJSON(raw)
		}
		var res struct {
			Data []struct {
				Asset   Asset   `json:"asset"`
				Score   float64 `json:"score"`
				Snippet string  `json:"snippet"`
			} `json:"data"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return err
		}
		if len(res.Data) == 0 {
			fmt.Fprintf(a.Stderr, "No prompts match %q.\n", q)
			return nil
		}
		tw := tabwriter.NewWriter(a.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "SLUG\tKIND\tVERSION\tSCORE\tNAME")
		for _, r := range res.Data {
			fmt.Fprintf(tw, "%s\t%s\tv%d\t%.2f\t%s\n", r.Asset.Slug, r.Asset.Kind, r.Asset.CurrentVersion, r.Score, r.Asset.Name)
			if s := oneLine(r.Snippet, 100); s != "" {
				fmt.Fprintf(tw, "\t\t\t\t  %s\n", s)
			}
		}
		return tw.Flush()
	},
}

func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > max {
		s = string(r[:max-1]) + "…"
	}
	return s
}

var lsCmd = &command{
	name:    "ls",
	group:   "api",
	usage:   "[--kind KIND] [--limit N]",
	summary: "List the prompts in your workspace.",
	setup: func(fs *flag.FlagSet, c *cmdCtx) {
		c.str("kind", "", "prompt, system_prompt, skill, agent, mcp_config, snippet or test_set")
		c.int("limit", 100, "maximum results")
	},
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) > 0 {
			return usageErr("unexpected argument %q", c.args[0])
		}
		api, err := a.api(c)
		if err != nil {
			return err
		}
		limit := *c.i["limit"]
		var all []json.RawMessage
		cursor := ""
		for len(all) < limit {
			q := url.Values{"limit": {strconv.Itoa(min(limit-len(all), 200))}}
			if k := *c.s["kind"]; k != "" {
				q.Set("kind", k)
			}
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			var page struct {
				Data       []json.RawMessage `json:"data"`
				NextCursor *string           `json:"nextCursor"`
			}
			if err := api.do(ctx, "GET", "/v1/assets", q, nil, &page); err != nil {
				return err
			}
			all = append(all, page.Data...)
			if page.NextCursor == nil || *page.NextCursor == "" || len(page.Data) == 0 {
				break
			}
			cursor = *page.NextCursor
		}
		if len(all) > limit {
			all = all[:limit]
		}
		if c.json {
			return a.printJSON(map[string]any{"data": all})
		}
		if len(all) == 0 {
			fmt.Fprintln(a.Stderr, "No prompts yet. Add one with `kyp push FILE --name NAME`.")
			return nil
		}
		tw := tabwriter.NewWriter(a.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "SLUG\tKIND\tVERSION\tUPDATED\tNAME")
		for _, r := range all {
			var as Asset
			_ = json.Unmarshal(r, &as)
			fmt.Fprintf(tw, "%s\t%s\tv%d\t%s\t%s\n", as.Slug, as.Kind, as.CurrentVersion, shortDate(as.UpdatedAt), as.Name)
		}
		return tw.Flush()
	},
}

var showCmd = &command{
	name:    "show",
	group:   "api",
	usage:   "SLUG [--version N]",
	summary: "Print a prompt's body (details go to stderr).",
	setup: func(fs *flag.FlagSet, c *cmdCtx) {
		c.int("version", 0, "a specific version (default: current)")
	},
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) != 1 {
			return usageErr("expected one SLUG")
		}
		api, err := a.api(c)
		if err != nil {
			return err
		}
		as, raw, err := a.getAsset(ctx, api, c.args[0])
		if err != nil {
			return err
		}
		body := ""
		if as.Body != nil {
			body = *as.Body
		}
		version := as.CurrentVersion
		detail := ""
		if v := *c.i["version"]; v != 0 {
			if v < 0 {
				return usageErr("--version must be positive")
			}
			var ver struct {
				Version    int    `json:"version"`
				SHA256     string `json:"sha256"`
				Message    string `json:"message"`
				AuthorName string `json:"authorName"`
				CreatedAt  string `json:"createdAt"`
				Body       string `json:"body"`
			}
			var vraw json.RawMessage
			if err := api.do(ctx, "GET", assetPath(as.ID)+"/versions/"+strconv.Itoa(v), nil, nil, &vraw); err != nil {
				var ae *APIError
				if errors.As(err, &ae) && ae.Problem.Status == 404 {
					return errCode(ExitNotFound, fmt.Sprintf("%s has versions 1 to %d", as.Slug, as.CurrentVersion), "%s has no version %d", as.Slug, v)
				}
				return err
			}
			if c.json {
				return a.printJSON(vraw)
			}
			_ = json.Unmarshal(vraw, &ver)
			body, version = ver.Body, ver.Version
			detail = strings.TrimSpace(fmt.Sprintf("%s by %s, %s", ver.Message, ver.AuthorName, shortDate(ver.CreatedAt)))
		} else if c.json {
			return a.printJSON(raw)
		} else {
			detail = "updated " + shortDate(as.UpdatedAt)
		}
		fmt.Fprintf(a.Stderr, "%s (%s) v%d of %d, %s\n", as.Name, as.Slug, version, as.CurrentVersion, detail)
		if len(as.Variables) > 0 && version == as.CurrentVersion {
			fmt.Fprintf(a.Stderr, "variables: %s\n", strings.Join(as.Variables, ", "))
		}
		_, err = io.WriteString(a.Stdout, body)
		if err == nil && !strings.HasSuffix(body, "\n") {
			_, err = io.WriteString(a.Stdout, "\n")
		}
		return err
	},
}

// ---------------------------------------------------------------------------
// kyp push
// ---------------------------------------------------------------------------

// slugify turns a name into a prompt slug: lowercase letters, digits and dashes.
func slugify(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > 63 {
		s = strings.TrimRight(s[:63], "-")
	}
	return s
}

func validSlug(s string) bool {
	for _, part := range strings.Split(s, "/") {
		if part == "" || len(part) > 63 || part[0] == '-' {
			return false
		}
		for _, r := range part {
			if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-') {
				return false
			}
		}
	}
	return s != ""
}

var pushCmd = &command{
	name:    "push",
	group:   "api",
	usage:   "FILE --name NAME [--slug SLUG] [-m MESSAGE] [--base N]",
	summary: "Create a prompt from FILE (- for stdin), or save it as a new version of an existing one.",
	setup: func(fs *flag.FlagSet, c *cmdCtx) {
		c.str("name", "", "display name (required to create; default slug derives from it)")
		c.str("slug", "", "prompt slug, e.g. support/triage (default: from --name)")
		c.str("message", "", "version message")
		c.alias("m", "message")
		c.int("base", 0, "the version your edit started from (default: the current version); an older one fails with a conflict")
		c.str("kind", "prompt", "kind when creating: prompt, system_prompt, skill, agent, mcp_config, snippet or test_set")
	},
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) != 1 {
			return usageErr("expected one FILE (or - for stdin)")
		}
		name, slug, msg := strings.TrimSpace(*c.s["name"]), strings.TrimSpace(*c.s["slug"]), *c.s["message"]
		if slug == "" {
			slug = slugify(name)
		}
		if slug == "" {
			return usageErr("--name (or --slug) is required")
		}
		if !validSlug(slug) {
			return usageErr("--slug %q: use lowercase letters, digits and dashes, segments joined by /", slug)
		}
		var data []byte
		var err error
		if c.args[0] == "-" {
			data, err = io.ReadAll(a.Stdin)
		} else {
			data, err = os.ReadFile(c.args[0])
		}
		if errors.Is(err, fs.ErrNotExist) {
			return errCode(ExitNotFound, "", "%s: file not found", c.args[0])
		}
		if err != nil {
			return errCode(ExitError, "", "%v", err)
		}
		body := string(data)
		api, err := a.api(c)
		if err != nil {
			return err
		}
		existing, _, err := a.getAsset(ctx, api, slug)
		var ce *cliError
		if err != nil && !(errors.As(err, &ce) && ce.code == ExitNotFound) {
			return err
		}
		var result Asset
		var raw json.RawMessage
		action := ""
		if existing == nil {
			if name == "" {
				return usageErr("--name is required to create %q", slug)
			}
			req := map[string]any{"kind": *c.s["kind"], "name": name, "slug": slug, "body": body}
			if msg != "" {
				req["message"] = msg
			}
			if err := api.do(ctx, "POST", "/v1/assets", nil, req, &raw); err != nil {
				return err
			}
			action = "created"
		} else {
			base := *c.i["base"]
			if base == 0 {
				base = existing.CurrentVersion
			}
			if existing.Body != nil && *existing.Body == body && (name == "" || name == existing.Name) {
				result = *existing
				action = "unchanged"
			} else {
				req := map[string]any{"body": body, "baseVersion": base}
				if name != "" && name != existing.Name {
					req["name"] = name
				}
				if msg != "" {
					req["message"] = msg
				}
				if err := api.do(ctx, "PATCH", assetPath(existing.ID), nil, req, &raw); err != nil {
					var ae *APIError
					if errors.As(err, &ae) && ae.Problem.Status == 409 {
						cur := ae.Problem.Extra["currentVersion"]
						ae2 := &cliError{code: ExitConflict, problem: &ae.Problem,
							msg:  fmt.Sprintf("%s changed on the server (now v%v) since v%d", slug, cur, base),
							hint: fmt.Sprintf("review with `kyp diff %s %d %v`, merge your edit, then push again with --base %v", slug, base, cur, cur)}
						return ae2
					}
					return err
				}
				action = "updated"
			}
		}
		if raw != nil {
			if err := json.Unmarshal(raw, &result); err != nil {
				return err
			}
		}
		if c.json {
			return a.printJSON(map[string]any{"action": action, "asset": result})
		}
		switch action {
		case "created":
			fmt.Fprintf(a.Stdout, "Created %s v%d (%s)\n", result.Slug, result.CurrentVersion, result.Name)
		case "updated":
			fmt.Fprintf(a.Stdout, "Updated %s: v%d -> v%d\n", result.Slug, existing.CurrentVersion, result.CurrentVersion)
		default:
			fmt.Fprintf(a.Stdout, "Unchanged %s (v%d): the body is identical\n", result.Slug, result.CurrentVersion)
		}
		return nil
	},
}

// ---------------------------------------------------------------------------
// kyp diff
// ---------------------------------------------------------------------------

var diffCmd = &command{
	name:    "diff",
	group:   "api",
	usage:   "SLUG FROM TO",
	summary: "Word diff between two versions of a prompt (red: removed, green: added).",
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) != 3 {
			return usageErr("expected SLUG FROM TO (version numbers)")
		}
		from, err := positiveInt(c.args[1], "FROM")
		if err != nil {
			return err
		}
		to, err := positiveInt(c.args[2], "TO")
		if err != nil {
			return err
		}
		api, err := a.api(c)
		if err != nil {
			return err
		}
		as, _, err := a.getAsset(ctx, api, c.args[0])
		if err != nil {
			return err
		}
		for _, v := range []int{from, to} {
			if v > as.CurrentVersion {
				return errCode(ExitNotFound, fmt.Sprintf("%s has versions 1 to %d", as.Slug, as.CurrentVersion), "%s has no version %d", as.Slug, v)
			}
		}
		var raw json.RawMessage
		q := url.Values{"from": {strconv.Itoa(from)}, "to": {strconv.Itoa(to)}}
		if err := api.do(ctx, "GET", assetPath(as.ID)+"/diff", q, nil, &raw); err != nil {
			return err
		}
		if c.json {
			return a.printJSON(raw)
		}
		var d struct {
			Hunks []struct {
				Op   string `json:"op"`
				Text string `json:"text"`
			} `json:"hunks"`
			Variables struct {
				Added   []string `json:"added"`
				Removed []string `json:"removed"`
			} `json:"variables"`
		}
		if err := json.Unmarshal(raw, &d); err != nil {
			return err
		}
		color := a.colorOn(c)
		var b strings.Builder
		fmt.Fprintf(&b, "%s v%d -> v%d\n", as.Slug, from, to)
		for _, h := range d.Hunks {
			switch {
			case h.Op == "delete" && color:
				b.WriteString(paint("\x1b[31m", h.Text))
			case h.Op == "insert" && color:
				b.WriteString(paint("\x1b[32m", h.Text))
			case h.Op == "delete":
				b.WriteString("[-" + h.Text + "-]")
			case h.Op == "insert":
				b.WriteString("{+" + h.Text + "+}")
			default:
				b.WriteString(h.Text)
			}
		}
		if !strings.HasSuffix(b.String(), "\n") {
			b.WriteString("\n")
		}
		if len(d.Variables.Added)+len(d.Variables.Removed) > 0 {
			var parts []string
			for _, v := range d.Variables.Added {
				parts = append(parts, paintIf(color, "\x1b[32m", "+"+v))
			}
			for _, v := range d.Variables.Removed {
				parts = append(parts, paintIf(color, "\x1b[31m", "-"+v))
			}
			fmt.Fprintf(&b, "variables: %s\n", strings.Join(parts, " "))
		}
		_, err = io.WriteString(a.Stdout, b.String())
		return err
	},
}

// paint colours text, re-opening the colour after each newline so pagers keep it.
func paint(code, text string) string {
	return code + strings.ReplaceAll(text, "\n", "\x1b[0m\n"+code) + "\x1b[0m"
}

func paintIf(on bool, code, text string) string {
	if on {
		return paint(code, text)
	}
	return text
}

// ---------------------------------------------------------------------------
// kyp deploy / rollback
// ---------------------------------------------------------------------------

type deployment struct {
	ID       string `json:"id"`
	Env      string `json:"env"`
	Revision int    `json:"revision"`
	Kind     string `json:"kind"`
	Message  string `json:"message"`
	Prompts  []struct {
		Name    string `json:"name"`
		AssetID string `json:"assetId"`
		Version int    `json:"version"`
		SHA256  string `json:"sha256"`
	} `json:"prompts"`
}

func (a *App) printDeployment(d deployment) error {
	tw := tabwriter.NewWriter(a.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "  NAME\tVERSION\tSHA256")
	for _, p := range d.Prompts {
		sha := p.SHA256
		if len(sha) > 12 {
			sha = sha[:12]
		}
		fmt.Fprintf(tw, "  %s\tv%d\t%s\n", p.Name, p.Version, sha)
	}
	return tw.Flush()
}

func isSlug(s string) bool { return validSlug(s) && !strings.Contains(s, "/") }

var deployCmd = &command{
	name:    "deploy",
	group:   "api",
	usage:   "APP ENV NAME=SLUG[@VERSION]... [-m MESSAGE]",
	summary: "Deploy prompt versions to an app environment (a new revision; apps pick it up within seconds).",
	setup: func(fs *flag.FlagSet, c *cmdCtx) {
		c.str("message", "", "deploy message")
		c.alias("m", "message")
	},
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) < 3 {
			return usageErr("expected APP ENV and at least one NAME=SLUG[@VERSION]")
		}
		app, env := c.args[0], c.args[1]
		if !isSlug(app) || !isSlug(env) {
			return usageErr("APP and ENV must be lowercase slugs")
		}
		type spec struct {
			name, slug string
			version    int
		}
		var specs []spec
		seen := map[string]bool{}
		for _, s := range c.args[2:] {
			name, ref, ok := strings.Cut(s, "=")
			if !ok {
				ref = name // "triage" means triage=triage
			}
			slug, ver := ref, 0
			if i := strings.LastIndex(ref, "@"); i >= 0 {
				slug = ref[:i]
				v, err := positiveInt(ref[i+1:], "VERSION in "+s)
				if err != nil {
					return err
				}
				ver = v
			}
			if !validSlug(name) || !validSlug(slug) {
				return usageErr("%q: want NAME=SLUG[@VERSION] with lowercase slugs", s)
			}
			if seen[name] {
				return usageErr("prompt name %q given twice", name)
			}
			seen[name] = true
			specs = append(specs, spec{name, slug, ver})
		}
		api, err := a.api(c)
		if err != nil {
			return err
		}
		ids := map[string]string{}
		var prompts []map[string]any
		for _, s := range specs {
			id, ok := ids[s.slug]
			if !ok {
				as, _, err := a.getAsset(ctx, api, s.slug)
				if err != nil {
					return err
				}
				if s.version > as.CurrentVersion {
					return errCode(ExitNotFound, fmt.Sprintf("%s has versions 1 to %d", s.slug, as.CurrentVersion), "%s has no version %d", s.slug, s.version)
				}
				id = as.ID
				ids[s.slug] = id
			}
			p := map[string]any{"name": s.name, "assetId": id}
			if s.version > 0 {
				p["version"] = s.version
			}
			prompts = append(prompts, p)
		}
		req := map[string]any{"env": env, "prompts": prompts}
		if m := *c.s["message"]; m != "" {
			req["message"] = m
		}
		var raw json.RawMessage
		if err := api.do(ctx, "POST", "/v1/apps/"+url.PathEscape(app)+"/deploy", nil, req, &raw); err != nil {
			return err
		}
		if c.json {
			return a.printJSON(raw)
		}
		var d deployment
		if err := json.Unmarshal(raw, &d); err != nil {
			return err
		}
		fmt.Fprintf(a.Stdout, "Deployed %s/%s revision %d (%d prompts)\n", app, env, d.Revision, len(d.Prompts))
		return a.printDeployment(d)
	},
}

var rollbackCmd = &command{
	name:    "rollback",
	group:   "api",
	usage:   "APP ENV REVISION",
	summary: "Roll an app environment back to an earlier revision (published as a new revision).",
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) != 3 {
			return usageErr("expected APP ENV REVISION")
		}
		app, env := c.args[0], c.args[1]
		if !isSlug(app) || !isSlug(env) {
			return usageErr("APP and ENV must be lowercase slugs")
		}
		rev, err := positiveInt(strings.TrimPrefix(c.args[2], "r"), "REVISION")
		if err != nil {
			return err
		}
		api, err := a.api(c)
		if err != nil {
			return err
		}
		var raw json.RawMessage
		req := map[string]any{"env": env, "toRevision": rev}
		if err := api.do(ctx, "POST", "/v1/apps/"+url.PathEscape(app)+"/rollback", nil, req, &raw); err != nil {
			return err
		}
		if c.json {
			return a.printJSON(raw)
		}
		var d deployment
		if err := json.Unmarshal(raw, &d); err != nil {
			return err
		}
		fmt.Fprintf(a.Stdout, "Rolled %s/%s back to revision %d (now live as revision %d)\n", app, env, rev, d.Revision)
		return a.printDeployment(d)
	},
}

// ---------------------------------------------------------------------------
// kyp capture
// ---------------------------------------------------------------------------

var captureCmd = &command{
	name:    "capture",
	group:   "api",
	usage:   "[--source api|ide|other] [--url URL] [--draft] < TEXT",
	summary: "Send text from stdin to the workspace Inbox, to promote into a prompt later.",
	setup: func(fs *flag.FlagSet, c *cmdCtx) {
		c.str("source", "api", "where it came from: api, ide, other, claude.ai, chatgpt.com, …")
		c.str("url", "", "conversation URL")
		c.str("client-id", "", "client id: repeated captures with the same id update one draft")
		c.bool("draft", "mark as a draft (not yet sent)")
	},
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) > 0 {
			return usageErr("capture reads stdin; unexpected argument %q (try: kyp capture < %s)", c.args[0], c.args[0])
		}
		if a.StdinTTY {
			fmt.Fprintln(a.Stderr, "Reading the capture from stdin; end with Ctrl-D.")
		}
		data, err := io.ReadAll(a.Stdin)
		if err != nil {
			return err
		}
		text := string(data)
		if strings.TrimSpace(text) == "" {
			return usageErr("nothing on stdin to capture")
		}
		req := map[string]any{"source": *c.s["source"], "text": text, "draft": *c.b["draft"]}
		if u := *c.s["url"]; u != "" {
			req["conversationUrl"] = u
		}
		if id := *c.s["client-id"]; id != "" {
			req["clientId"] = id
		}
		api, err := a.api(c)
		if err != nil {
			return err
		}
		var raw json.RawMessage
		if err := api.do(ctx, "POST", "/v1/captures", nil, req, &raw); err != nil {
			return err
		}
		if c.json {
			return a.printJSON(raw)
		}
		var res struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(raw, &res)
		fmt.Fprintf(a.Stdout, "Captured %d characters to the Inbox (%s)\n", len([]rune(text)), res.ID)
		return nil
	},
}
