# Keep Your Prompts: Rust SDK

Read deployed prompts from memory in nanoseconds, keep them fresh in the background, and keep serving when the network does not.

```rust
let prompts = kyp::Client::from_env()?; // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
let text = prompts.render("triage", &[("company", "Acme"), ("billing_queue", "refunds")])?;
```

- Crate `keepyourprompts`, imported as `kyp`. Edition 2021, MSRV **1.75**.
- Blocking client by default (`ureq` + rustls, one background thread). Optional `tokio` feature: `AsyncClient` with `reqwest` + rustls.
- Dependencies: `arc-swap`, `sha2`, `serde_json`, plus the HTTP client of the feature you pick. No OpenSSL, no `unsafe`.
- Implements [prompt delivery protocol v1](../protocol/README.md) and passes the shared [conformance suite](../conformance/README.md).

## Install

```toml
[dependencies]
keepyourprompts = "0.1"                                                     # blocking client
# keepyourprompts = { version = "0.1", features = ["tokio"] }               # + AsyncClient
# keepyourprompts = { version = "0.1", default-features = false }           # file-only: embedded/snapshot/disk cache
```

| Feature | Default | Effect |
| --- | --- | --- |
| `blocking` | yes | HTTP(S) mirrors for `Client` via `ureq` + rustls. Without it `Client` reads only the embedded snapshot, snapshot folders and the disk cache. |
| `tokio` | no | `AsyncClient` and `Builder::build_async()`: `reqwest` + rustls, the refresher is a tokio task. |
| `native-certs` | no | Trust the OS certificate store (corporate TLS proxies) instead of the bundled webpki roots (blocking client). |

## Quickstart

```rust
use std::time::Duration;

fn main() -> kyp::Result<()> {
    let prompts = kyp::Client::builder()
        .app("support-bot")
        .env("prod")
        .delivery_key(std::env::var("KYP_DELIVERY_KEY").unwrap_or_default())
        .cache_dir("/var/cache/kyp")
        .poll_interval(Duration::from_secs(30))
        .on_update(|u| eprintln!("prompts: revision {} -> {} {:?}", u.old_revision, u.new_revision, u.changed))
        .build()?;

    let raw: Option<std::sync::Arc<str>> = prompts.get("triage");      // memory only
    let text = prompts.render("triage", &[("company", "Acme"), ("billing_queue", "refunds")])?;
    let p = prompts.prompt("triage").expect("deployed");               // name, version, sha256, variables, text
    println!("{} v{} -> {text}", p.name, p.version);

    let st = prompts.status();
    println!("revision {} from {} (stale for {:?})", st.revision, st.source, st.stale_for);
    Ok(())
} // dropping the client stops the refresher thread
```

`render` accepts `&[("k", "v")]`, arrays, `Vec<(K, V)>`, `HashMap` and `BTreeMap` with string-like keys/values (the `kyp::Vars` trait).

### Async (feature `tokio`)

```rust
let prompts = kyp::Client::builder().app("support-bot").delivery_key(key).build_async().await?;
let text = prompts.render("triage", &[("company", "Acme")])?; // reads are still sync and lock-free
prompts.refresh().await;                                       // optional: revalidate now
```

`build_async` must run inside a tokio runtime; the refresher is a spawned task that is aborted when the `AsyncClient` is dropped. The read API is identical to `Client`.

## How it works

Every copy of your prompts uses the same layout: `envs/<app>/<env>.json` (the manifest: which body is live) and `blobs/<sha256>` (immutable bodies). The client treats every copy as a mirror and tries them in order:

| # | Mirror | Name in `status()` | Enabled when |
| --- | --- | --- | --- |
| 1 | Snapshot compiled into the binary | `embedded` | `Builder::embedded(...)` holds this app/env |
| 2 | Snapshot folder | `snapshot` | `snapshot_dir` / `KYP_SNAPSHOT_DIR` |
| 3 | Disk cache written by the SDK | `disk-cache` | `cache_dir` / `KYP_CACHE_DIR` |
| 4 | CDN `https://cdn.keepyourprompts.com/v1/d/<key>` | `cdn` | a delivery key is set |
| 5 | Origin `https://api.keepyourprompts.com/v1/delivery/<key>` | `origin` | a delivery key is set |
| 6 | Your git repo (`.kyp` folder) | `git` | `git_mirror` / `KYP_GIT_MIRROR` (+ `KYP_GIT_TOKEN` as `Authorization: Bearer`) |

**Availability.** Four independent copies (yours, Cloudflare's, ours, GitHub's), any one of which is enough, plus the in-memory state that keeps serving through all of them failing.

**Start-up.** Mirrors 1 to 3 are read without the network. If any holds the manifest, `build()` returns at once with the highest revision found (ties go to the earlier mirror) and a background refresh starts immediately. Otherwise it waits on the network mirrors for up to `startup_timeout` (3 s), then returns `Error::Unavailable`, or starts empty with `start_empty(true)`.

**Refresh.** Every `poll_interval` (30 s, ±10% jitter) the manifest is revalidated with `If-None-Match`, asking the network mirrors in order and stopping at the first that answers; a `304` changes nothing. A new revision has its missing blobs fetched (disk cache, then the same mirror, then any other), each verified with SHA-256, written to the disk cache, then the whole state is swapped in one atomic step and `on_update` fires once. A lower revision than the one held is ignored (stale mirror). A failing mirror is skipped for 0, 1, 3, 7, ... poll intervals (capped at `max_backoff`, 5 min, with jitter) and retried if nothing else answers. **Failures never evict what is held.** With no network mirror configured, the file mirrors are polled instead, so a snapshot folder kept current by `git pull` is picked up live.

**Reads.** `get`, `get_with`, `render`, `prompt`, `contains`, `names` read an immutable state published through `arc_swap::ArcSwapOption`: no locks, no I/O. `get` returns an `Arc<str>` (one atomic increment); `get_with(name, |text| ...)` borrows the text without touching any reference count, the fastest option under heavy multi-threaded load.

## Configuration

| Builder method | Default | Env var (`from_env`) |
| --- | --- | --- |
| `app(..)` | required | `KYP_APP` |
| `env(..)` | `"prod"` | `KYP_ENV` |
| `delivery_key(..)` | none: no CDN/origin | `KYP_DELIVERY_KEY` |
| `workspace(..)` | found by scanning `cache_dir` | `KYP_WORKSPACE` |
| `snapshot_dir(path)` | none | `KYP_SNAPSHOT_DIR` |
| `cache_dir(path)` | none: no disk cache | `KYP_CACHE_DIR` |
| `git_mirror(url, token)` | none | `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN` |
| `cdn_base(url)` / `origin_base(url)` | `https://cdn.keepyourprompts.com/v1/d`, `https://api.keepyourprompts.com/v1/delivery` | `KYP_CDN_URL`, `KYP_ORIGIN_URL` |
| `embedded(files)` / `embedded_snapshot(bool)` | none / `true` | |
| `mirrors(Vec<Mirror>)` / `add_mirror(Mirror)` | snapshot, CDN, origin, git | |
| `poll_interval(d)` | 30 s (min 100 ms) | `KYP_POLL_INTERVAL` (seconds) |
| `connect_timeout(d)` / `request_timeout(d)` | 2 s / 5 s | |
| `startup_timeout(d)` | 3 s | |
| `max_backoff(d)` | 5 min | |
| `start_empty(bool)` | `false` | |
| `user_agent(..)` | `kyp-rust/0.1.0` | |
| `on_update(Fn(&Update))` | none | |
| `logger(Fn(LogLevel, &str))` / `log_level(Option<LogLevel>)` | stderr / `Some(Warn)` | `KYP_LOG=debug\|info\|warn\|error\|off` |

`mirrors(...)` replaces the snapshot/CDN/origin/git defaults with your own ordered list (`Mirror::file(dir, name)`, `Mirror::http(url, name, bearer)`, `Mirror::embedded()`); the embedded snapshot and the disk cache still apply. To send the delivery key as a header instead of in the path: `Mirror::http("https://api.keepyourprompts.com/v1/delivery", "origin", key)`.

The delivery key never appears in logs, errors or `status()`: it is shortened to `kypd_Ab3d...`. The HTTP clients honour `HTTPS_PROXY`/`HTTP_PROXY` and `NO_PROXY`.

## Status

`client.status()` returns `ready`, `source` (mirror that served or last confirmed the state), `revision`, `workspace`, `deployed_at`, `prompt_count`, `last_success`, `last_error` (e.g. `cdn: HTTP 503; origin: HTTP 503`), `stale_for` (alert on this) and per-mirror `consecutive_failures`, `last_error`, `last_success`.

## Errors

`kyp::Error`: `NotFound { name }`, `MissingVariable { names }`, `Unavailable(..)`, `Protocol(..)`, `Config(..)`. `get`/`prompt` return `Option`; `render` returns `Result`. Choose lenient rendering with `render_with(name, vars, OnMissing::Keep | OnMissing::Empty)`.

## Snapshots: start with zero network

Pull the deployed state into a folder (a complete mirror) with the bundled CLI:

```sh
cargo install keepyourprompts            # installs kyp-snapshot
kyp-snapshot --app support-bot --env prod --out ./prompts --rust-module src/prompts_snapshot.rs   # uses $KYP_DELIVERY_KEY
```

Ship the folder (`KYP_SNAPSHOT_DIR=./prompts`) or compile it in. `--rust-module` writes a file that uses the `include_snapshot!` macro (no build script needed):

```rust
mod prompts_snapshot; // pub static SNAPSHOT: kyp::EmbeddedFiles = kyp::include_snapshot!("../prompts", [...]);

let prompts = kyp::Client::builder().app("support-bot").embedded(prompts_snapshot::SNAPSHOT).build()?;
assert_eq!(prompts.status().source, "embedded"); // then upgrades in the background
```

You can also pass any `&'static [(&'static str, &'static [u8])]`. In code: `kyp::pull_snapshot(&builder, dir)` and `kyp::embed_module_source(dir, rel)`.

## Disk cache

With `cache_dir` set, every verified state is written to `<cache_dir>/<workspace>/<app>/<env>/` in the same layout (temp file, fsync, rename), so a restart without network comes up on the last version this machine saw. Several processes can share one directory; blobs are re-verified when read back.

## Tests and benchmarks

```sh
cargo test --all-features                 # conformance (in-process fake + ../conformance/fake_cdn.py when python3 exists), unit, proptest
cargo clippy --all-features --all-targets -- -D warnings && cargo fmt --check
cargo run --release --example bench       # ns per get()/render()
```

On a shared 4-vCPU Linux VM (release): `get` ≈ 40 ns, `get_with` ≈ 25 ns, `render` (2 variables) ≈ 125 ns per call on one thread; with 4 threads in parallel `get_with` stays ≈ 70 ns (a plain `HashMap` lookup on the same VM goes from 15 to 45 ns).

## License

See the [LICENSE](../LICENSE) file at the repository root.
