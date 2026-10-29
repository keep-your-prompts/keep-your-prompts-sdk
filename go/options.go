package kyp

import (
	"context"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Default endpoints.
const (
	DefaultCDNBase    = "https://cdn.keepyourprompts.com/v1/d"
	DefaultOriginBase = "https://api.keepyourprompts.com/v1/delivery"
	DefaultAPIURL     = "https://api.keepyourprompts.com"
)

// Mirror is one copy of a workspace in the protocol layout
// (envs/<app>/<env>.json, blobs/<sha256>).
type Mirror struct {
	// Name is shown in Status and logs, e.g. "cdn".
	Name string
	// URL is https://host/base, http://host/base, file:///dir or a plain
	// directory path. Ignored when FS is set.
	URL string
	// BearerToken is sent as "Authorization: Bearer <token>" (git mirror, origin).
	BearerToken string
	// FS serves the layout from an fs.FS (for example an embed.FS).
	FS fs.FS
}

// FileMirror reads the layout from a directory.
func FileMirror(dir, name string) Mirror { return Mirror{Name: name, URL: dir} }

// HTTPMirror reads the layout over HTTP(S). token may be empty.
func HTTPMirror(baseURL, name, token string) Mirror {
	return Mirror{Name: name, URL: baseURL, BearerToken: token}
}

// FSMirror reads the layout from fsys (the root of fsys holds envs/ and blobs/).
func FSMirror(fsys fs.FS, name string) Mirror { return Mirror{Name: name, FS: fsys} }

// Update is passed to update callbacks after a new revision was swapped in.
type Update struct {
	OldRevision int64    // 0 if nothing was loaded before
	NewRevision int64    //
	Source      string   // mirror that delivered it
	Changed     []string // prompts added, removed or with a new body
}

// Options configures a Client. Only App is required (Env defaults to "prod").
// Zero values mean "use the default".
type Options struct {
	App         string // KYP_APP (required)
	Env         string // KYP_ENV, default "prod"
	DeliveryKey string // KYP_DELIVERY_KEY: enables the CDN and origin mirrors
	// Workspace lets the disk cache be found without scanning CacheDir (KYP_WORKSPACE).
	Workspace string

	SnapshotDir string // KYP_SNAPSHOT_DIR: a folder written by `kyp pull`
	CacheDir    string // KYP_CACHE_DIR: verified state is written here and read on start-up
	GitMirror   string // KYP_GIT_MIRROR: e.g. https://raw.githubusercontent.com/acme/prompts/main/.kyp
	GitToken    string // KYP_GIT_TOKEN: read-only token for a private repo
	CDNBase     string // KYP_CDN_URL, default DefaultCDNBase
	OriginBase  string // KYP_ORIGIN_URL, default DefaultOriginBase

	// Embedded is a snapshot compiled into the binary (see WithEmbeddedSnapshot).
	// Its root, or one directory below it, holds envs/ and blobs/.
	Embedded fs.FS

	// Mirrors replaces the snapshot/CDN/origin/git defaults with an explicit
	// ordered list. The embedded snapshot and disk cache still apply.
	Mirrors []Mirror
	// ExtraMirrors are appended after the others.
	ExtraMirrors []Mirror

	PollInterval   time.Duration // KYP_POLL_INTERVAL (seconds), default 30s, minimum 100ms
	RequestTimeout time.Duration // per HTTP request, default 5s
	ConnectTimeout time.Duration // TCP/TLS connect, default 2s
	StartupTimeout time.Duration // how long New may block on the network, default 3s
	MaxBackoff     time.Duration // cap for skipping a failing mirror, default 5m
	// StartEmpty starts with no prompts instead of returning ErrUnavailable.
	StartEmpty bool

	UserAgent  string       // default "kyp-go/<Version>"
	HTTPClient *http.Client // default: a client honouring HTTPS_PROXY with the timeouts above
	OnUpdate   func(Update) // called on the refresher goroutine after each swap
	Logger     *slog.Logger // default: stderr at warn level (KYP_LOG=debug|info|warn|error|off)

	// Outcome reporting (RecordOutcome). APIKey is KYP_API_KEY; when empty the
	// delivery key is used. APIURL is KYP_API_URL, default DefaultAPIURL.
	APIKey string
	APIURL string
}

// Option adjusts Options; pass them to New or FromEnv.
type Option func(*Options)

// WithEmbeddedSnapshot uses fsys as the first mirror, so the client starts
// with zero network:
//
//	//go:embed prompts
//	var snapshot embed.FS
//	c, err := kyp.FromEnv(ctx, kyp.WithEmbeddedSnapshot(snapshot))
//
// fsys may hold envs/ and blobs/ at its root or one directory below (as
// //go:embed prompts produces).
func WithEmbeddedSnapshot(fsys fs.FS) Option { return func(o *Options) { o.Embedded = fsys } }

// WithOnUpdate sets Options.OnUpdate.
func WithOnUpdate(fn func(Update)) Option { return func(o *Options) { o.OnUpdate = fn } }

// WithLogger sets Options.Logger.
func WithLogger(l *slog.Logger) Option { return func(o *Options) { o.Logger = l } }

// WithHTTPClient sets Options.HTTPClient.
func WithHTTPClient(c *http.Client) Option { return func(o *Options) { o.HTTPClient = c } }

// OptionsFromEnv reads KYP_APP, KYP_ENV, KYP_DELIVERY_KEY, KYP_WORKSPACE,
// KYP_SNAPSHOT_DIR, KYP_CACHE_DIR, KYP_GIT_MIRROR, KYP_GIT_TOKEN, KYP_CDN_URL,
// KYP_ORIGIN_URL, KYP_POLL_INTERVAL (seconds), KYP_LOG, KYP_API_KEY and
// KYP_API_URL.
func OptionsFromEnv() Options {
	o := Options{
		App:         os.Getenv("KYP_APP"),
		Env:         os.Getenv("KYP_ENV"),
		DeliveryKey: os.Getenv("KYP_DELIVERY_KEY"),
		Workspace:   os.Getenv("KYP_WORKSPACE"),
		SnapshotDir: os.Getenv("KYP_SNAPSHOT_DIR"),
		CacheDir:    os.Getenv("KYP_CACHE_DIR"),
		GitMirror:   os.Getenv("KYP_GIT_MIRROR"),
		GitToken:    os.Getenv("KYP_GIT_TOKEN"),
		CDNBase:     os.Getenv("KYP_CDN_URL"),
		OriginBase:  os.Getenv("KYP_ORIGIN_URL"),
		APIKey:      os.Getenv("KYP_API_KEY"),
		APIURL:      os.Getenv("KYP_API_URL"),
	}
	if v := strings.TrimSpace(os.Getenv("KYP_POLL_INTERVAL")); v != "" {
		if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
			o.PollInterval = time.Duration(secs * float64(time.Second))
		}
	}
	if v := os.Getenv("KYP_LOG"); v != "" {
		o.Logger = defaultLogger(v)
	}
	return o
}

// FromEnv is New(ctx, OptionsFromEnv(), opts...).
func FromEnv(ctx context.Context, opts ...Option) (*Client, error) {
	return New(ctx, OptionsFromEnv(), opts...)
}

func (o *Options) applyDefaults() {
	if o.Env == "" {
		o.Env = "prod"
	}
	if o.CDNBase == "" {
		o.CDNBase = DefaultCDNBase
	}
	if o.OriginBase == "" {
		o.OriginBase = DefaultOriginBase
	}
	if o.APIURL == "" {
		o.APIURL = DefaultAPIURL
	}
	if o.PollInterval == 0 {
		o.PollInterval = 30 * time.Second
	}
	if o.PollInterval < 100*time.Millisecond {
		o.PollInterval = 100 * time.Millisecond
	}
	if o.RequestTimeout <= 0 {
		o.RequestTimeout = 5 * time.Second
	}
	if o.ConnectTimeout <= 0 {
		o.ConnectTimeout = 2 * time.Second
	}
	if o.StartupTimeout <= 0 {
		o.StartupTimeout = 3 * time.Second
	}
	if o.MaxBackoff <= 0 {
		o.MaxBackoff = 5 * time.Minute
	}
	if o.UserAgent == "" {
		o.UserAgent = "kyp-go/" + Version
	}
	if o.Logger == nil {
		o.Logger = defaultLogger("warn")
	}
}

func defaultLogger(level string) *slog.Logger {
	var lv slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lv = slog.LevelDebug
	case "info":
		lv = slog.LevelInfo
	case "error":
		lv = slog.LevelError
	case "off", "none":
		return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.Level(1 << 20)}))
	default:
		lv = slog.LevelWarn
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv})).With("component", "kyp")
}

// redactKey shortens a delivery key to "kypd_Ab3d..." so it never reaches logs.
func redactKey(s, key string) string {
	if key == "" {
		return s
	}
	short := key
	if len(short) > 9 {
		short = short[:9] + "..."
	}
	return strings.ReplaceAll(s, key, short)
}

func joinURL(base, rel string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(rel, "/")
}
