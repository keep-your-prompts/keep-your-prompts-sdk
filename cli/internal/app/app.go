// Package app implements the kyp command-line tool.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Version is the CLI version. commit is set at build time with
// -ldflags "-X github.com/keep-your-prompts/keep-your-prompts-sdk/cli/internal/app.commit=<sha>".
const Version = "0.1.0"

var commit = ""

// Exit codes.
const (
	ExitOK          = 0 // success
	ExitError       = 1 // anything else
	ExitUsage       = 2 // bad flags or arguments
	ExitAuth        = 3 // no API key, 401 or 403
	ExitNotFound    = 4 // 404, unknown prompt
	ExitConflict    = 5 // 409, e.g. version-conflict on push
	ExitUnavailable = 6 // network failure, 5xx, no mirror answered
	ExitInvalid     = 7 // 400/422 validation, missing template variables
	ExitQuota       = 8 // 429 rate limit or plan quota
)

// App holds the process environment so tests can replace it.
type App struct {
	Stdin          io.Reader
	Stdout, Stderr io.Writer
	Getenv         func(string) string
	HTTPClient     *http.Client
	// StdoutTTY and StdinTTY enable colour and interactive prompts.
	StdoutTTY, StdinTTY bool
	// ConfigDir overrides the OS config directory (os.UserConfigDir).
	ConfigDir string
}

// New returns an App wired to the real process.
func New() *App {
	return &App{
		Stdin:      os.Stdin,
		Stdout:     os.Stdout,
		Stderr:     os.Stderr,
		Getenv:     os.Getenv,
		HTTPClient: &http.Client{Timeout: 60 * time.Second},
		StdoutTTY:  isTerminal(os.Stdout),
		StdinTTY:   isTerminal(os.Stdin),
	}
}

func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

// command is one subcommand.
type command struct {
	name    string
	usage   string // after "kyp <name> "
	summary string
	run     func(a *App, ctx context.Context, c *cmdCtx) error
	setup   func(fs *flag.FlagSet, c *cmdCtx)
	group   string
}

// cmdCtx carries parsed flags for one invocation.
type cmdCtx struct {
	cmd    *command
	fs     *flag.FlagSet
	args   []string
	json   bool
	color  string
	apiURL string
	// command-specific flags
	s map[string]*string
	i map[string]*int
	b map[string]*bool
	l map[string]*stringList
	d map[string]*time.Duration
}

func (c *cmdCtx) str(name, def, usage string)        { c.s[name] = c.fs.String(name, def, usage) }
func (c *cmdCtx) int(name string, def int, u string) { c.i[name] = c.fs.Int(name, def, u) }
func (c *cmdCtx) bool(name string, u string)         { c.b[name] = c.fs.Bool(name, false, u) }
func (c *cmdCtx) dur(name string, def time.Duration, u string) {
	c.d[name] = c.fs.Duration(name, def, u)
}
func (c *cmdCtx) list(name, u string) {
	v := &stringList{}
	c.fs.Var(v, name, u)
	c.l[name] = v
}

// alias registers another name for an existing string flag.
func (c *cmdCtx) alias(alias, name string) {
	c.fs.StringVar(c.s[name], alias, *c.s[name], "same as --"+name)
}

type stringList []string

func (l *stringList) String() string     { return strings.Join(*l, ",") }
func (l *stringList) Set(v string) error { *l = append(*l, v); return nil }

var commands []*command

func init() {
	commands = []*command{
		pullCmd, getCmd,
		loginCmd, logoutCmd, searchCmd, lsCmd, showCmd, pushCmd, diffCmd, deployCmd, rollbackCmd, captureCmd,
		mcpCmd, versionCmd,
	}
}

func findCommand(name string) *command {
	for _, c := range commands {
		if c.name == name {
			return c
		}
	}
	return nil
}

// Run executes kyp with args (without the program name) and returns the exit code.
func (a *App) Run(ctx context.Context, args []string) int {
	if len(args) == 0 {
		a.printHelp(a.Stderr)
		return ExitUsage
	}
	name := args[0]
	switch name {
	case "-h", "--help", "help":
		if len(args) > 1 {
			if c := findCommand(args[1]); c != nil {
				a.commandHelp(a.Stdout, c)
				return ExitOK
			}
		}
		a.printHelp(a.Stdout)
		return ExitOK
	case "-v", "--version":
		name = "version"
	}
	cmd := findCommand(name)
	if cmd == nil {
		fmt.Fprintf(a.Stderr, "kyp: unknown command %q\n\n", name)
		a.printHelp(a.Stderr)
		return ExitUsage
	}
	c := &cmdCtx{cmd: cmd, s: map[string]*string{}, i: map[string]*int{}, b: map[string]*bool{}, l: map[string]*stringList{}, d: map[string]*time.Duration{}}
	c.fs = flag.NewFlagSet("kyp "+cmd.name, flag.ContinueOnError)
	c.fs.SetOutput(io.Discard)
	c.fs.BoolVar(&c.json, "json", false, "print JSON")
	c.fs.StringVar(&c.color, "color", "auto", "colour output: auto, always or never")
	c.fs.StringVar(&c.apiURL, "api-url", "", "API base URL (default $KYP_API_URL or https://api.keepyourprompts.com)")
	if cmd.setup != nil {
		cmd.setup(c.fs, c)
	}
	pos, err := parseInterspersed(c.fs, args[1:])
	if errors.Is(err, flag.ErrHelp) {
		a.commandHelp(a.Stdout, cmd)
		return ExitOK
	}
	if err != nil {
		return a.fail(c, usageErr("%v", err))
	}
	c.args = pos
	if err := cmd.run(a, ctx, c); err != nil {
		return a.fail(c, err)
	}
	return ExitOK
}

// parseInterspersed lets flags appear after positional arguments
// (kyp push FILE --name N). Everything after "--" is positional.
func parseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var tail []string
	for i, a := range args {
		if a == "--" {
			tail = append(tail, args[i+1:]...)
			args = args[:i]
			break
		}
	}
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		rest := fs.Args()
		if len(rest) == 0 {
			break
		}
		pos = append(pos, rest[0])
		args = rest[1:]
	}
	return append(pos, tail...), nil
}

// ---------------------------------------------------------------------------
// Errors and exit codes.
// ---------------------------------------------------------------------------

type cliError struct {
	code    int
	msg     string
	hint    string
	problem *Problem
}

func (e *cliError) Error() string { return e.msg }

func usageErr(format string, args ...any) error {
	return &cliError{code: ExitUsage, msg: fmt.Sprintf(format, args...)}
}

func errCode(code int, hint, format string, args ...any) error {
	return &cliError{code: code, msg: fmt.Sprintf(format, args...), hint: hint}
}

func (a *App) fail(c *cmdCtx, err error) int {
	code := ExitError
	var ce *cliError
	var ae *APIError
	msg, hint := err.Error(), ""
	var prob *Problem
	switch {
	case errors.As(err, &ae):
		code, hint, prob = ae.exitCode(), ae.hint(), &ae.Problem
	case errors.As(err, &ce):
		code, hint, prob = ce.code, ce.hint, ce.problem
	}
	if c != nil && c.json {
		out := map[string]any{"error": msg, "exitCode": code}
		if hint != "" {
			out["hint"] = hint
		}
		if prob != nil {
			out["problem"] = prob
		}
		_ = writeJSON(a.Stderr, out)
		return code
	}
	fmt.Fprintf(a.Stderr, "kyp: %s\n", msg)
	if prob != nil {
		for _, fe := range prob.Errors {
			fmt.Fprintf(a.Stderr, "  %s: %s\n", fe.Pointer, fe.Message)
		}
	}
	if hint != "" {
		fmt.Fprintf(a.Stderr, "hint: %s\n", hint)
	}
	if code == ExitUsage && c != nil {
		fmt.Fprintf(a.Stderr, "usage: kyp %s %s\n", c.cmd.name, c.cmd.usage)
	}
	return code
}

// ---------------------------------------------------------------------------
// Output helpers.
// ---------------------------------------------------------------------------

func (a *App) printJSON(v any) error { return writeJSON(a.Stdout, v) }

// writeJSON writes indented JSON without HTML escaping (so "<", ">" and "&" stay readable).
func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func (a *App) colorOn(c *cmdCtx) bool {
	switch c.color {
	case "always":
		return true
	case "never":
		return false
	}
	return a.StdoutTTY && a.Getenv("NO_COLOR") == "" && a.Getenv("TERM") != "dumb"
}

func (a *App) printHelp(w io.Writer) {
	fmt.Fprintf(w, "kyp %s: Keep Your Prompts from the command line.\n\nUsage: kyp <command> [arguments] [flags]\n", Version)
	groups := []struct{ key, title string }{
		{"delivery", "Prompts in your app (delivery key: KYP_DELIVERY_KEY)"},
		{"api", "Your workspace (API key: kyp login or KYP_API_KEY)"},
		{"other", "Other"},
	}
	for _, g := range groups {
		fmt.Fprintf(w, "\n%s:\n", g.title)
		var cs []*command
		for _, c := range commands {
			if c.group == g.key {
				cs = append(cs, c)
			}
		}
		for _, c := range cs {
			fmt.Fprintf(w, "  %-10s %s\n", c.name, c.summary)
		}
	}
	fmt.Fprint(w, `
Every command takes --json (machine-readable output) and --color=auto|always|never.
Run "kyp help <command>" for its flags. Exit codes: 0 ok, 1 error, 2 usage, 3 auth,
4 not found, 5 conflict, 6 unavailable, 7 invalid input, 8 quota.
`)
}

func (a *App) commandHelp(w io.Writer, cmd *command) {
	fmt.Fprintf(w, "Usage: kyp %s %s\n\n%s\n\nFlags:\n", cmd.name, cmd.usage, cmd.summary)
	c := &cmdCtx{cmd: cmd, s: map[string]*string{}, i: map[string]*int{}, b: map[string]*bool{}, l: map[string]*stringList{}, d: map[string]*time.Duration{}}
	c.fs = flag.NewFlagSet(cmd.name, flag.ContinueOnError)
	if cmd.setup != nil {
		cmd.setup(c.fs, c)
	}
	c.fs.Bool("json", false, "print JSON")
	c.fs.String("color", "auto", "colour output: auto, always or never")
	c.fs.String("api-url", "", "API base URL (default $KYP_API_URL or https://api.keepyourprompts.com)")
	c.fs.SetOutput(w)
	c.fs.VisitAll(func(f *flag.Flag) {
		name, usage := flag.UnquoteUsage(f)
		dash := "--"
		if len(f.Name) == 1 {
			dash = "-"
		}
		line := "  " + dash + f.Name
		if name != "" {
			line += " " + name
		}
		def := ""
		if f.DefValue != "" && f.DefValue != "false" && f.DefValue != "0" && f.DefValue != "[]" {
			def = fmt.Sprintf(" (default %s)", f.DefValue)
		}
		fmt.Fprintf(w, "%-24s %s%s\n", line, usage, def)
	})
}
