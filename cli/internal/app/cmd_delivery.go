package app

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	kyp "github.com/keep-your-prompts/keep-your-prompts-sdk/go"
)

// sdkOptions builds SDK options from the environment plus --app/--env flags.
func (a *App) sdkOptions(c *cmdCtx) kyp.Options {
	o := kyp.Options{
		App:         a.Getenv("KYP_APP"),
		Env:         a.Getenv("KYP_ENV"),
		DeliveryKey: a.Getenv("KYP_DELIVERY_KEY"),
		Workspace:   a.Getenv("KYP_WORKSPACE"),
		SnapshotDir: a.Getenv("KYP_SNAPSHOT_DIR"),
		CacheDir:    a.Getenv("KYP_CACHE_DIR"),
		GitMirror:   a.Getenv("KYP_GIT_MIRROR"),
		GitToken:    a.Getenv("KYP_GIT_TOKEN"),
		CDNBase:     a.Getenv("KYP_CDN_URL"),
		OriginBase:  a.Getenv("KYP_ORIGIN_URL"),
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		HTTPClient:  a.HTTPClient,
	}
	if v := *c.s["app"]; v != "" {
		o.App = v
	}
	if v := *c.s["env"]; v != "" {
		o.Env = v
	}
	if p, ok := c.s["git-mirror"]; ok && *p != "" {
		o.GitMirror = *p
	}
	if o.Env == "" {
		o.Env = "prod"
	}
	return o
}

func deliveryErr(err error) error {
	switch {
	case errors.Is(err, kyp.ErrNotFound):
		return errCode(ExitNotFound, "", "%s", strings.TrimPrefix(err.Error(), "kyp: "))
	case errors.Is(err, kyp.ErrMissingVariable):
		return errCode(ExitInvalid, "pass each one with --var name=value (or --lenient to keep the placeholders)", "%s", strings.TrimPrefix(err.Error(), "kyp: "))
	case errors.Is(err, kyp.ErrUnavailable):
		return errCode(ExitUnavailable, "set KYP_DELIVERY_KEY (and KYP_APP), point --snapshot at a folder written by `kyp pull`, or check the network", "%s", strings.TrimPrefix(err.Error(), "kyp: "))
	}
	return err
}

// ---------------------------------------------------------------------------
// kyp pull
// ---------------------------------------------------------------------------

var pullCmd = &command{
	name:    "pull",
	group:   "delivery",
	usage:   "--app APP [--env ENV] --out DIR [--format folder|go|ts|json]",
	summary: "Write the deployed prompts of an app environment to a snapshot (uses KYP_DELIVERY_KEY).",
	setup: func(fs *flag.FlagSet, c *cmdCtx) {
		c.str("app", "", "app slug (default $KYP_APP)")
		c.str("env", "", "environment (default $KYP_ENV or prod)")
		c.str("out", "", "output folder, or a file for --format ts/json (- for stdout with json)")
		c.str("format", "folder", "folder (protocol layout), go (layout + embed.go), ts (TypeScript module) or json")
		c.str("package", "", "Go package name for --format go (default: the folder name)")
		c.str("git-mirror", "", "pull from a git mirror base URL instead (default $KYP_GIT_MIRROR)")
		c.dur("timeout", 20*time.Second, "give up after this long")
	},
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) > 0 {
			return usageErr("unexpected argument %q", c.args[0])
		}
		o := a.sdkOptions(c)
		out, format := *c.s["out"], *c.s["format"]
		switch {
		case o.App == "":
			return usageErr("--app is required (or set KYP_APP)")
		case out == "":
			return usageErr("--out is required")
		case format != "folder" && format != "go" && format != "ts" && format != "json":
			return usageErr("--format must be folder, go, ts or json")
		case out == "-" && format != "json":
			return usageErr("--out - (stdout) needs --format json")
		}
		if o.DeliveryKey == "" && o.GitMirror == "" {
			return errCode(ExitAuth, "export KYP_DELIVERY_KEY=kypd_… (Settings > Delivery keys) or pass --git-mirror", "no delivery key")
		}
		o.StartupTimeout = *c.d["timeout"]
		ctx, cancel := context.WithTimeout(ctx, *c.d["timeout"])
		defer cancel()
		snap, err := kyp.PullSnapshot(ctx, o)
		if err != nil {
			return deliveryErr(err)
		}
		files, written, err := writeSnapshot(snap, out, format, *c.s["package"], a.Stdout)
		if err != nil {
			return err
		}
		m := snap.Manifest
		if c.json && out != "-" {
			return a.printJSON(map[string]any{
				"app": m.App, "env": m.Env, "workspace": m.Workspace, "revision": m.Revision,
				"prompts": len(m.Prompts), "blobs": len(snap.Blobs), "written": written,
				"source": snap.Source, "format": format, "out": out, "files": files,
			})
		}
		if out != "-" {
			fmt.Fprintf(a.Stdout, "Pulled %s/%s revision %d (%d prompts) from %s into %s\n", m.App, m.Env, m.Revision, len(m.Prompts), snap.Source, out)
			if format == "go" {
				fmt.Fprintf(a.Stdout, "Use it with kyp.WithEmbeddedSnapshot(%s.Snapshot)\n", goPackageName(*c.s["package"], out))
			}
		}
		return nil
	},
}

// snapshotFiles is the layout as path -> text, the shape the TypeScript SDK's
// EmbeddedSnapshot uses ({kyp: 1, files}).
func snapshotFiles(s *kyp.Snapshot) map[string]string {
	files := map[string]string{"envs/" + s.Manifest.App + "/" + s.Manifest.Env + ".json": string(s.RawManifest)}
	for sha, b := range s.Blobs {
		files["blobs/"+sha] = string(b)
	}
	return files
}

func writeSnapshot(s *kyp.Snapshot, out, format, pkg string, stdout io.Writer) ([]string, int, error) {
	switch format {
	case "folder", "go":
		n, err := s.WriteDir(out)
		if err != nil {
			return nil, n, err
		}
		files := []string{filepath.ToSlash(filepath.Join("envs", s.Manifest.App, s.Manifest.Env+".json"))}
		for sha := range s.Blobs {
			files = append(files, "blobs/"+sha)
		}
		if format == "go" {
			src := goEmbedSource(s, goPackageName(pkg, out))
			if err := os.WriteFile(filepath.Join(out, "embed.go"), []byte(src), 0o644); err != nil {
				return nil, n, err
			}
			files = append(files, "embed.go")
			n++
		}
		sort.Strings(files)
		return files, n, nil
	case "ts", "json":
		doc := map[string]any{"kyp": 1, "files": snapshotFiles(s)}
		body, _ := json.MarshalIndent(doc, "", "  ")
		var src []byte
		name := "snapshot." + format
		if format == "ts" {
			src = []byte(fmt.Sprintf("// Generated by kyp %s pull (%s/%s revision %d). Do not edit: re-run kyp pull.\n"+
				"import type { EmbeddedSnapshot } from '@keepyourprompts/sdk';\n\nconst snapshot: EmbeddedSnapshot = %s;\nexport default snapshot;\n",
				Version, s.Manifest.App, s.Manifest.Env, s.Manifest.Revision, body))
		} else {
			src = append(body, '\n')
		}
		if out == "-" {
			_, err := stdout.Write(src)
			return []string{"-"}, 0, err
		}
		path := out
		if !strings.HasSuffix(out, "."+format) {
			path = filepath.Join(out, name)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, 0, err
		}
		if err := os.WriteFile(path, src, 0o644); err != nil {
			return nil, 0, err
		}
		return []string{filepath.ToSlash(path)}, 1, nil
	}
	return nil, 0, usageErr("unknown format %q", format)
}

func goPackageName(pkg, out string) string {
	if pkg != "" {
		return pkg
	}
	base := filepath.Base(filepath.Clean(out))
	var b strings.Builder
	for _, r := range strings.ToLower(base) {
		if r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_') {
			b.WriteRune(r)
		}
	}
	name := b.String()
	if name == "" || unicode.IsDigit(rune(name[0])) {
		name = "prompts" + name
	}
	return name
}

func goEmbedSource(s *kyp.Snapshot, pkg string) string {
	dirs := "envs"
	if len(s.Blobs) > 0 {
		dirs += " blobs"
	}
	return fmt.Sprintf(`// Code generated by kyp %s pull; DO NOT EDIT.

// Package %[2]s holds the deployed prompts of %[3]s/%[4]s (revision %[5]d) for
// kyp.WithEmbeddedSnapshot, so the app starts with zero network.
package %[2]s

import "embed"

// Snapshot is the protocol layout (envs/, blobs/) of %[3]s/%[4]s.
//
//go:embed %[6]s
var Snapshot embed.FS
`, Version, pkg, s.Manifest.App, s.Manifest.Env, s.Manifest.Revision, dirs)
}

// ---------------------------------------------------------------------------
// kyp get
// ---------------------------------------------------------------------------

var getCmd = &command{
	name:    "get",
	group:   "delivery",
	usage:   "NAME [--var key=value]... [--app APP] [--env ENV] [--snapshot DIR]",
	summary: "Print a deployed prompt, rendered, from a snapshot folder or the delivery mirrors.",
	setup: func(fs *flag.FlagSet, c *cmdCtx) {
		c.list("var", "template value key=value (repeatable)")
		c.str("app", "", "app slug (default $KYP_APP)")
		c.str("env", "", "environment (default $KYP_ENV or prod)")
		c.str("snapshot", "", "snapshot folder (default $KYP_SNAPSHOT_DIR)")
		c.bool("raw", "print the template without rendering")
		c.bool("lenient", "keep {{placeholders}} that have no --var instead of failing")
		c.bool("offline", "do not ask the network when a snapshot or cache is available")
		c.dur("timeout", 10*time.Second, "give up after this long")
	},
	run: func(a *App, ctx context.Context, c *cmdCtx) error {
		if len(c.args) != 1 {
			return usageErr("expected one prompt NAME")
		}
		name := c.args[0]
		vars := kyp.Vars{}
		for _, kv := range *c.l["var"] {
			k, v, ok := strings.Cut(kv, "=")
			if !ok || k == "" {
				return usageErr("--var %q: want key=value", kv)
			}
			vars[k] = v
		}
		o := a.sdkOptions(c)
		if v := *c.s["snapshot"]; v != "" {
			o.SnapshotDir = v
		}
		if o.App == "" {
			return usageErr("--app is required (or set KYP_APP)")
		}
		offline := *c.b["offline"]
		if offline {
			o.DeliveryKey, o.GitMirror = "", ""
		}
		o.StartupTimeout = *c.d["timeout"]
		o.PollInterval = 24 * time.Hour
		ctx, cancel := context.WithTimeout(ctx, *c.d["timeout"])
		defer cancel()
		client, err := kyp.New(ctx, o)
		if err != nil {
			return deliveryErr(err)
		}
		defer client.Close()
		// Started from a local copy: ask the network once for anything newer.
		if st := client.Status(); !offline && (o.DeliveryKey != "" || o.GitMirror != "") && st.LastSuccess.IsZero() {
			if err := client.Refresh(ctx); err != nil {
				fmt.Fprintf(a.Stderr, "kyp: warning: serving %s revision %d: %s\n", st.Source, st.Revision, strings.TrimPrefix(err.Error(), "kyp: "))
			}
		}
		p, err := client.Prompt(name)
		if err != nil {
			return deliveryErr(err)
		}
		text := p.Text
		if !*c.b["raw"] {
			mode := kyp.MissingError
			if *c.b["lenient"] {
				mode = kyp.MissingKeep
			}
			if text, err = p.Render(vars, mode); err != nil {
				return deliveryErr(err)
			}
		}
		if c.json {
			st := client.Status()
			return a.printJSON(map[string]any{
				"name": p.Name, "version": p.Version, "sha256": p.SHA256, "variables": p.Variables,
				"revision": st.Revision, "source": st.Source, "template": p.Text, "text": text,
			})
		}
		_, err = io.WriteString(a.Stdout, text)
		if err == nil && a.StdoutTTY && !strings.HasSuffix(text, "\n") {
			_, err = io.WriteString(a.Stdout, "\n")
		}
		return err
	},
}
