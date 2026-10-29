package app

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"runtime"
	"strings"

	kyp "github.com/keep-your-prompts/keep-your-prompts-sdk/go"
)

const keyPlaceholder = "kyp_live_…"

var mcpCmd = &command{
	name:    "mcp",
	group:   "other",
	usage:   "[--client claude-code|cursor|vscode] [--with-key]",
	summary: "Print MCP server config for Claude Code, Cursor and VS Code.",
	setup: func(fs *flag.FlagSet, c *cmdCtx) {
		c.str("client", "", "only this client: claude-code, cursor or vscode")
		c.bool("with-key", "insert your stored API key instead of a placeholder")
	},
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) > 0 {
			return usageErr("unexpected argument %q", c.args[0])
		}
		only := *c.s["client"]
		if only != "" && only != "claude-code" && only != "cursor" && only != "vscode" {
			return usageErr("--client must be claude-code, cursor or vscode")
		}
		cfg, err := a.loadConfig()
		if err != nil {
			return err
		}
		key := keyPlaceholder
		if *c.b["with-key"] {
			k := a.Getenv("KYP_API_KEY")
			if k == "" {
				k = cfg.APIKey
			}
			if k == "" {
				return errCode(ExitAuth, "run `kyp login` first", "no API key to insert")
			}
			key = k
		}
		url := strings.TrimRight(a.resolveAPIURL(c, cfg), "/") + "/mcp"
		auth := map[string]string{"Authorization": "Bearer " + key}
		claude := fmt.Sprintf(`claude mcp add --transport http kyp %s --header "Authorization: Bearer %s"`, url, key)
		cursor := map[string]any{"mcpServers": map[string]any{"keep-your-prompts": map[string]any{"url": url, "headers": auth}}}
		vscode := map[string]any{"servers": map[string]any{"keep-your-prompts": map[string]any{"type": "http", "url": url, "headers": auth}}}
		if c.json {
			out := map[string]any{"url": url}
			if only == "" || only == "claude-code" {
				out["claudeCode"] = claude
			}
			if only == "" || only == "cursor" {
				out["cursor"] = cursor
			}
			if only == "" || only == "vscode" {
				out["vscode"] = vscode
			}
			return a.printJSON(out)
		}
		pretty := func(v any) string {
			b, _ := json.MarshalIndent(v, "", "  ")
			return string(b)
		}
		var sections []string
		if only == "" || only == "claude-code" {
			sections = append(sections, "# Claude Code: run\n"+claude)
		}
		if only == "" || only == "cursor" {
			sections = append(sections, "# Cursor: ~/.cursor/mcp.json (all projects) or .cursor/mcp.json\n"+pretty(cursor))
		}
		if only == "" || only == "vscode" {
			sections = append(sections, "# VS Code: .vscode/mcp.json\n"+pretty(vscode))
		}
		fmt.Fprintln(a.Stdout, strings.Join(sections, "\n\n"))
		if key == keyPlaceholder {
			fmt.Fprintln(a.Stderr, "\nReplace "+keyPlaceholder+" with an API key (or re-run with --with-key after `kyp login`).")
		}
		return nil
	},
}

var versionCmd = &command{
	name:    "version",
	group:   "other",
	usage:   "",
	summary: "Print the kyp version.",
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		info := map[string]string{
			"version": Version, "sdk": kyp.Version, "go": runtime.Version(),
			"os": runtime.GOOS, "arch": runtime.GOARCH, "commit": commit,
		}
		if c.json {
			return a.printJSON(info)
		}
		line := fmt.Sprintf("kyp %s (sdk %s, %s, %s/%s", Version, kyp.Version, runtime.Version(), runtime.GOOS, runtime.GOARCH)
		if commit != "" {
			line += ", " + commit
		}
		fmt.Fprintln(a.Stdout, line+")")
		return nil
	},
}
