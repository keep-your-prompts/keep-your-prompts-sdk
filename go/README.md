# Keep Your Prompts: Go SDK

Read deployed prompts from memory in nanoseconds, keep them fresh in the background, and keep serving when the network does not.

```go
import kyp "github.com/keep-your-prompts/keep-your-prompts-sdk/go"

prompts, err := kyp.FromEnv(ctx) // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
if err != nil {
	log.Fatal(err)
}
defer prompts.Close()

text, err := prompts.Render("triage", kyp.Vars{"company": "Acme", "billing_queue": "refunds"})
```

- Go 1.22 or newer, standard library only (no dependencies).
- Implements [prompt delivery protocol v1](../protocol/README.md) and passes every required behaviour of the [conformance suite](../conformance/README.md).
- Version 0.1.0. Licensed under the repository's [LICENSE](../LICENSE).

## Install

```sh
go get github.com/keep-your-prompts/keep-your-prompts-sdk/go@latest
```

The module lives in the `go/` folder of the SDK repository, so its releases are tagged `go/vX.Y.Z`.

## Start with zero network: embed a snapshot

Pull the deployed state with the [`kyp` CLI](../cli/README.md) and compile it into the binary:

```sh
kyp pull --app support-bot --env prod --out ./prompts --format go   # uses $KYP_DELIVERY_KEY
```

That writes the protocol layout plus an `embed.go` declaring `var Snapshot embed.FS`. Or embed the folder yourself:

```go
//go:embed prompts
var snapshot embed.FS

prompts, err := kyp.FromEnv(ctx, kyp.WithEmbeddedSnapshot(snapshot))
```

`WithEmbeddedSnapshot` accepts any `fs.FS` that holds `envs/` and `blobs/` at its root or one directory below it (what `//go:embed prompts` produces). The client starts from it at once (`Status().Source == "embedded"`) and upgrades in the background as soon as a network mirror answers.

## How it works

Every copy of your prompts uses the same layout: `envs/<app>/<env>.json` (the manifest: which body is live) and `blobs/<sha256>` (immutable bodies). The client treats every copy as a mirror and tries them in order:

| # | Mirror | Name in `Status()` | Enabled when |
| --- | --- | --- | --- |
| 1 | Snapshot compiled into the binary | `embedded` | `WithEmbeddedSnapshot` / `Options.Embedded` |
| 2 | Snapshot folder | `snapshot` | `SnapshotDir` / `KYP_SNAPSHOT_DIR` |
| 3 | Disk cache written by the SDK | `disk-cache` | `CacheDir` / `KYP_CACHE_DIR` |
| 4 | CDN `https://cdn.keepyourprompts.com/v1/d/<key>` | `cdn` | a delivery key is set |
| 5 | Origin `https://api.keepyourprompts.com/v1/delivery/<key>` | `origin` | a delivery key is set |
| 6 | Your git repo | `git` | `GitMirror` / `KYP_GIT_MIRROR` (+ `KYP_GIT_TOKEN`, sent as `Authorization: Bearer`) |

**Start-up.** Mirrors 1 to 3 are read without the network. If any holds the manifest, `New` returns at once with the highest revision found (ties go to the earlier mirror) and a background refresh starts immediately. Otherwise it blocks on the network mirrors for up to `StartupTimeout` (3 s, or until `ctx` is done) and returns an error matching `kyp.ErrUnavailable`, or starts empty if `StartEmpty` is set.

**Refresh.** A goroutine revalidates the manifest every `PollInterval` (30 s, plus or minus 10% jitter) with `If-None-Match`, asking the network mirrors in order and stopping at the first that answers; a `304` costs nothing. A new revision has its missing blobs fetched (disk cache first, then the same mirror, then any other), each verified with SHA-256, written to the disk cache, and then the whole state is swapped in one `atomic.Pointer` store. A manifest with a lower revision than the one held is ignored. A failing mirror is skipped for 0, 1, 3, 7, ... poll intervals (with jitter, capped at `MaxBackoff`, 5 min) and retried first if nothing else answers. **Failures never evict what is held.**

**Reads.** `Get`, `Render`, `Prompt`, `Contains`, `Names` and `Revision` do one atomic load and a map lookup: no I/O, no locks, safe from any number of goroutines.

**Network.** One `http.Client` per client with keep-alive, HTTP/2 when offered, `HTTPS_PROXY` honoured, 2 s connect and 5 s request timeouts. `Close` cancels any request in flight. The delivery key never appears in logs, errors or `Status()`: it is shortened to `kypd_Ab3d...`.

When no network mirror is configured, the snapshot folder itself is polled, so a folder kept current by a sidecar or `git pull` is picked up live.

## API

### Creating a client

| Function | Description |
| --- | --- |
| `kyp.FromEnv(ctx, opts ...Option) (*Client, error)` | `New(ctx, OptionsFromEnv(), opts...)`. |
| `kyp.New(ctx, kyp.Options{...}, opts ...Option) (*Client, error)` | See start-up above. `ctx` bounds start-up only. |
| `kyp.OptionsFromEnv() Options` | Reads the environment variables below. |
| `kyp.WithEmbeddedSnapshot(fs.FS)`, `WithOnUpdate(func(Update))`, `WithLogger(*slog.Logger)`, `WithHTTPClient(*http.Client)` | `Option`s. |

### `kyp.Options`

| Field | Default | Environment |
| --- | --- | --- |
| `App` | required | `KYP_APP` |
| `Env` | `"prod"` | `KYP_ENV` |
| `DeliveryKey` | none: no CDN/origin | `KYP_DELIVERY_KEY` |
| `Workspace` | found by scanning `CacheDir` | `KYP_WORKSPACE` |
| `SnapshotDir` | none | `KYP_SNAPSHOT_DIR` |
| `CacheDir` | none: no disk cache | `KYP_CACHE_DIR` |
| `GitMirror`, `GitToken` | none | `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN` |
| `CDNBase`, `OriginBase` | `https://cdn.keepyourprompts.com/v1/d`, `https://api.keepyourprompts.com/v1/delivery` | `KYP_CDN_URL`, `KYP_ORIGIN_URL` |
| `Embedded` | none | |
| `Mirrors` (replace snapshot/CDN/origin/git), `ExtraMirrors` (append) | | |
| `PollInterval` | 30 s (minimum 100 ms) | `KYP_POLL_INTERVAL` (seconds) |
| `RequestTimeout`, `ConnectTimeout`, `StartupTimeout`, `MaxBackoff` | 5 s, 2 s, 3 s, 5 min | |
| `StartEmpty` | `false` | |
| `UserAgent` | `kyp-go/0.1.0` | |
| `HTTPClient` | proxy-aware client with the timeouts above | |
| `OnUpdate` | none | |
| `Logger` | `slog` text to stderr at warn | `KYP_LOG=debug\|info\|warn\|error\|off` |
| `APIKey`, `APIURL` (outcome reporting) | none (outcomes off), `https://api.keepyourprompts.com` | `KYP_API_KEY`, `KYP_API_URL` |

Build explicit mirrors with `kyp.FileMirror(dir, name)` (also `file:///dir`), `kyp.HTTPMirror(baseURL, name, bearerToken)` and `kyp.FSMirror(fsys, name)`. To send the delivery key to the origin as a header instead of in the path: `kyp.HTTPMirror("https://api.keepyourprompts.com/v1/delivery", "origin", key)`.

### `*kyp.Client`

| Method | Description |
| --- | --- |
| `Get(name) (string, error)` | Raw template. `*NotFoundError` (matches `kyp.ErrNotFound`). |
| `Render(name, kyp.Vars, ...OnMissing) (string, error)` | Renders. `*NotFoundError`, `*MissingVariableError` (matches `kyp.ErrMissingVariable`). |
| `Prompt(name) (Prompt, error)` | `{Name, Version, SHA256, Variables, Text}` plus `Prompt.Render`. |
| `Contains(name) bool`, `Names() []string`, `Revision() int64` | |
| `Status() Status` | `Ready`, `Source`, `Revision`, `Workspace`, `DeployedAt`, `PromptCount`, `LastSuccess`, `LastError`, `StaleFor` (alert on it), `Mirrors` (per mirror: failures, last error, last success). |
| `Refresh(ctx) error` | Revalidate now, ignoring backoff; nil if a mirror answered. Never evicts. |
| `OnUpdate(func(Update)) (unregister func())` | Called after each swap with `{OldRevision, NewRevision, Source, Changed}`; panics are recovered. |
| `Snapshot() (*Snapshot, error)` | The held state; `(*Snapshot).WriteDir(dir)` writes the layout. |
| `RecordOutcome(kyp.Outcome) error`, `FlushOutcomes(ctx) error` | Optional outcome reporting, below. |
| `Close() error` | Stops the refresher, flushes outcomes. Reads keep working. |

`kyp.PullSnapshot(ctx, opts)` fetches what is deployed now from the network mirrors (what `kyp pull` does).

### Templates and helpers

```go
kyp.RenderTemplate(tmpl string, vars kyp.Vars, onMissing ...kyp.OnMissing) (string, error)
kyp.TemplateVariables(tmpl string) []string        // distinct names, in order
kyp.ParseManifest(data []byte) (*kyp.Manifest, error) // validates; unknown fields ignored; variables default to []
kyp.SHA256Hex(data []byte) string
```

`{{name}}` (spaces inside the braces allowed, names `[A-Za-z_][A-Za-z0-9_]*`) is replaced by `vars[name]`. `{{{{` renders a literal `{{`. Anything else is plain text: no logic, no escaping, values are not rendered again. A missing variable is an error listing every missing name, unless you pass `kyp.MissingKeep` (leave `{{name}}`) or `kyp.MissingEmpty`.

### Outcome reporting (optional)

With `KYP_API_KEY` set (or, failing that, the delivery key), report how a prompt version performed; the SHA-256 of the current revision is attached for you:

```go
start := time.Now()
// ... call the model ...
_ = prompts.RecordOutcome(kyp.Outcome{Prompt: "triage", Result: kyp.OutcomeSuccess, Latency: time.Since(start), InputTokens: in, OutputTokens: out})
```

`RecordOutcome` never blocks: outcomes are batched and sent to `POST /v1/apps/<app>/outcomes` every 10 s or 100 outcomes, and on `Close`. Without a key it returns `kyp.ErrOutcomesDisabled`.

## Tests and benchmarks

```sh
cd go
go test -race ./...                                   # unit, conformance, examples
go test -run '^$' -fuzz FuzzRenderTemplate -fuzztime 30s .
go test -run '^$' -bench . -benchmem .
go vet ./... && staticcheck ./...
```

The conformance tests load `../conformance/cases.json` and the fixtures, and run every HTTP behaviour twice: against an in-process `httptest` port of `fake_cdn.py` (always), and against `conformance/fake_cdn.py` itself when `python3` is on the PATH (`KYP_PYTHON` picks the interpreter; skipped otherwise).

Benchmarks on a shared 4-vCPU Intel Xeon 2.1 GHz VM, Go 1.27, `greeting` from the `v12` fixture (two variables):

| Benchmark | ns/op | allocs/op |
| --- | --- | --- |
| `Get` | 11 | 0 |
| `Get`, 4 goroutines (`RunParallel`) | 3.3 | 0 |
| `Render` (2 variables, 41-byte template) | 270 to 350 | 1 |
| `RenderTemplate`, 4 KB template | 15,000 (about 270 MB/s) | 1 |
