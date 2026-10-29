//! The builder and the blocking client (a background thread keeps it fresh).

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::engine::{lock, read_api, Config, EmbeddedFiles, Engine, LogLevel, Mirror, Update};
use crate::error::{Error, Result};
use crate::fetch::{self, block_on};
use crate::telemetry::{Observer, RefreshTrigger};

#[cfg(feature = "blocking")]
pub(crate) type BlockingTransport = fetch::UreqTransport;
#[cfg(not(feature = "blocking"))]
pub(crate) type BlockingTransport = fetch::NoTransport;

#[cfg(feature = "blocking")]
fn blocking_transport(s: &fetch::HttpSettings) -> BlockingTransport {
    fetch::UreqTransport::new(s)
}
#[cfg(not(feature = "blocking"))]
fn blocking_transport(_: &fetch::HttpSettings) -> BlockingTransport {
    fetch::NoTransport
}

/// Options for a [`Client`]. Only `app` (and `env`, default `"prod"`) are required.
///
/// ```no_run
/// let prompts = kyp::Client::builder()
///     .app("support-bot")
///     .env("prod")
///     .delivery_key(std::env::var("KYP_DELIVERY_KEY").unwrap())
///     .cache_dir("/var/cache/kyp")
///     .build()?;
/// # Ok::<(), kyp::Error>(())
/// ```
#[derive(Clone, Default)]
#[must_use]
pub struct Builder {
    pub(crate) cfg: Config,
}

impl std::fmt::Debug for Builder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Builder").field("app", &self.cfg.app).field("env", &self.cfg.env).finish_non_exhaustive()
    }
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

impl Builder {
    /// Defaults: env `prod`, CDN and origin at keepyourprompts.com, poll every 30 s.
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads `KYP_APP`, `KYP_ENV`, `KYP_DELIVERY_KEY`, `KYP_WORKSPACE`, `KYP_SNAPSHOT_DIR`,
    /// `KYP_CACHE_DIR`, `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN`, `KYP_CDN_URL`, `KYP_ORIGIN_URL`,
    /// `KYP_POLL_INTERVAL` (seconds) and `KYP_LOG` (`debug|info|warn|error|off`).
    pub fn from_env() -> Self {
        let mut b = Builder::new();
        if let Some(v) = env_var("KYP_APP") {
            b = b.app(v);
        }
        if let Some(v) = env_var("KYP_ENV") {
            b = b.env(v);
        }
        if let Some(v) = env_var("KYP_DELIVERY_KEY") {
            b = b.delivery_key(v);
        }
        if let Some(v) = env_var("KYP_WORKSPACE") {
            b = b.workspace(v);
        }
        if let Some(v) = env_var("KYP_SNAPSHOT_DIR") {
            b = b.snapshot_dir(v);
        }
        if let Some(v) = env_var("KYP_CACHE_DIR") {
            b = b.cache_dir(v);
        }
        if let Some(v) = env_var("KYP_GIT_MIRROR") {
            b = b.git_mirror(v, env_var("KYP_GIT_TOKEN").unwrap_or_default());
        }
        if let Some(v) = env_var("KYP_CDN_URL") {
            b = b.cdn_base(v);
        }
        if let Some(v) = env_var("KYP_ORIGIN_URL") {
            b = b.origin_base(v);
        }
        if let Some(secs) = env_var("KYP_POLL_INTERVAL").and_then(|v| v.trim().parse::<f64>().ok()) {
            if secs > 0.0 && secs.is_finite() {
                b = b.poll_interval(Duration::from_secs_f64(secs));
            }
        }
        match env_var("KYP_LOG").as_deref() {
            Some("off") => b.cfg.log_level = None,
            Some("debug") => b.cfg.log_level = Some(LogLevel::Debug),
            Some("info") => b.cfg.log_level = Some(LogLevel::Info),
            Some("error") => b.cfg.log_level = Some(LogLevel::Error),
            _ => {}
        }
        b
    }

    /// App slug (required). `KYP_APP`.
    pub fn app(mut self, v: impl Into<String>) -> Self {
        self.cfg.app = v.into();
        self
    }
    /// Environment slug, default `prod`. `KYP_ENV`.
    pub fn env(mut self, v: impl Into<String>) -> Self {
        self.cfg.env = v.into();
        self
    }
    /// Delivery key (`kypd_...`): enables the CDN and origin mirrors. `KYP_DELIVERY_KEY`.
    pub fn delivery_key(mut self, v: impl Into<String>) -> Self {
        self.cfg.delivery_key = v.into();
        self
    }
    /// Workspace slug: lets the disk cache be found without scanning `cache_dir`. `KYP_WORKSPACE`.
    pub fn workspace(mut self, v: impl Into<String>) -> Self {
        self.cfg.workspace = v.into();
        self
    }
    /// A snapshot folder (from `kyp pull` / `kyp-snapshot`). `KYP_SNAPSHOT_DIR`.
    pub fn snapshot_dir(mut self, v: impl Into<PathBuf>) -> Self {
        self.cfg.snapshot_dir = Some(v.into());
        self
    }
    /// Disk cache directory written by the SDK. `KYP_CACHE_DIR`.
    pub fn cache_dir(mut self, v: impl Into<PathBuf>) -> Self {
        self.cfg.cache_dir = Some(v.into());
        self
    }
    /// A snapshot compiled into the binary, e.g. with [`include_snapshot!`](crate::include_snapshot).
    pub fn embedded(mut self, files: EmbeddedFiles) -> Self {
        self.cfg.embedded = Some(files);
        self
    }
    /// Use the embedded snapshot when one is set (default `true`).
    pub fn embedded_snapshot(mut self, enabled: bool) -> Self {
        self.cfg.use_embedded = enabled;
        self
    }
    /// Your git repo's `.kyp` folder, e.g. `https://raw.githubusercontent.com/acme/prompts/main/.kyp`,
    /// with an optional read-only token sent as `Authorization: Bearer`. `KYP_GIT_MIRROR`, `KYP_GIT_TOKEN`.
    pub fn git_mirror(mut self, base_url: impl Into<String>, token: impl Into<String>) -> Self {
        self.cfg.git_url = base_url.into();
        self.cfg.git_token = token.into();
        self
    }
    /// CDN base, default `https://cdn.keepyourprompts.com/v1/d`. `KYP_CDN_URL`.
    pub fn cdn_base(mut self, v: impl Into<String>) -> Self {
        self.cfg.cdn_base = v.into();
        self
    }
    /// Origin base, default `https://api.keepyourprompts.com/v1/delivery`. `KYP_ORIGIN_URL`.
    pub fn origin_base(mut self, v: impl Into<String>) -> Self {
        self.cfg.origin_base = v.into();
        self
    }
    /// Replace the snapshot/CDN/origin/git mirrors with an explicit ordered list.
    /// The embedded snapshot and the disk cache still apply.
    pub fn mirrors(mut self, v: Vec<Mirror>) -> Self {
        self.cfg.mirrors = Some(v);
        self
    }
    /// Append a mirror after the defaults.
    pub fn add_mirror(mut self, m: Mirror) -> Self {
        self.cfg.extra_mirrors.push(m);
        self
    }
    /// How often the manifest is revalidated (default 30 s, ±10% jitter, minimum 100 ms).
    pub fn poll_interval(mut self, v: Duration) -> Self {
        self.cfg.poll_interval = v;
        self
    }
    /// TCP/TLS connect timeout (default 2 s).
    pub fn connect_timeout(mut self, v: Duration) -> Self {
        self.cfg.connect_timeout = v;
        self
    }
    /// Whole-request timeout (default 5 s).
    pub fn request_timeout(mut self, v: Duration) -> Self {
        self.cfg.request_timeout = v;
        self
    }
    /// How long `build` waits on the network when nothing local exists (default 3 s).
    pub fn startup_timeout(mut self, v: Duration) -> Self {
        self.cfg.startup_timeout = v;
        self
    }
    /// Cap for the per-mirror backoff (default 5 min).
    pub fn max_backoff(mut self, v: Duration) -> Self {
        self.cfg.max_backoff = v;
        self
    }
    /// Start with no prompts instead of failing with [`Error::Unavailable`].
    pub fn start_empty(mut self, v: bool) -> Self {
        self.cfg.start_empty = v;
        self
    }
    /// `User-Agent`, default `kyp-rust/0.1.0`.
    pub fn user_agent(mut self, v: impl Into<String>) -> Self {
        self.cfg.user_agent = v.into();
        self
    }
    /// Called after a new revision was swapped in (on the refresher, never under a lock).
    pub fn on_update(mut self, f: impl Fn(&Update) + Send + Sync + 'static) -> Self {
        self.cfg.on_update = Some(Arc::new(f));
        self
    }
    /// Delivery telemetry hook (`protocol/tracing.md`), registered before start-up so the
    /// start-up round is reported too. May be called several times. The `otel` feature
    /// provides one ([`otel::Instrumentation`](crate::otel)).
    pub fn observer(mut self, observer: Arc<dyn Observer>) -> Self {
        self.cfg.observers.push(observer);
        self
    }
    /// Log sink. Default: stderr, `[kyp] warn: ...`.
    pub fn logger(mut self, f: impl Fn(LogLevel, &str) + Send + Sync + 'static) -> Self {
        self.cfg.logger = Some(Arc::new(f));
        self
    }
    /// Minimum level logged; `None` turns logging off. Default `Some(Warn)`. `KYP_LOG`.
    pub fn log_level(mut self, v: Option<LogLevel>) -> Self {
        self.cfg.log_level = v;
        self
    }

    /// Loads prompts and starts the background refresher (blocking client).
    ///
    /// Local mirrors (embedded, snapshot, disk cache) are read first; if any holds the
    /// manifest this returns at once. Otherwise it waits on the network for up to
    /// `startup_timeout`, then fails with [`Error::Unavailable`] (or starts empty).
    pub fn build(self) -> Result<Client> {
        Client::new(self)
    }
}

// ===========================================================================
// Client
// ===========================================================================
struct Wake {
    stop: Mutex<bool>,
    cv: Condvar,
    refresh: Mutex<()>,
}

/// The blocking client. Reads (`get`, `render`, `prompt`) are lock-free and never do I/O;
/// a background thread revalidates the manifest every `poll_interval`. Dropping the
/// client stops that thread.
pub struct Client {
    pub(crate) engine: Arc<Engine<BlockingTransport>>,
    wake: Arc<Wake>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client").field("what", &self.engine.what()).field("revision", &self.revision()).finish()
    }
}

impl Client {
    /// A [`Builder`].
    pub fn builder() -> Builder {
        Builder::new()
    }

    /// `Builder::from_env().build()`.
    pub fn from_env() -> Result<Client> {
        Builder::from_env().build()
    }

    fn new(b: Builder) -> Result<Client> {
        let engine = Arc::new(Engine::new(b.cfg, blocking_transport, false)?);
        block_on(engine.load_local());
        let loaded_locally = engine.current().is_some();
        engine.deliver_records();
        let wake = Arc::new(Wake { stop: Mutex::new(false), cv: Condvar::new(), refresh: Mutex::new(()) });
        if !loaded_locally {
            if engine.polled.is_empty() {
                if !engine.cfg.start_empty {
                    return Err(engine.unavailable(
                        "no snapshot or disk cache found and no remote mirror configured \
                         (set KYP_DELIVERY_KEY, KYP_SNAPSHOT_DIR or embed a snapshot)",
                    ));
                }
                engine.log(LogLevel::Warn, &format!("starting empty: no mirror for {}", engine.what()));
            } else {
                startup_from_network(&engine, &wake)?;
            }
        }
        let thread = if engine.polled.is_empty() {
            None
        } else {
            let immediate = loaded_locally || engine.current().is_none();
            let (e, w) = (engine.clone(), wake.clone());
            Some(
                std::thread::Builder::new()
                    .name("kyp-refresh".into())
                    .spawn(move || run(&e, &w, immediate))
                    .map_err(|err| Error::Config(format!("could not start the refresher thread: {err}")))?,
            )
        };
        Ok(Client { engine, wake, thread })
    }

    read_api!();

    /// Revalidates now across mirrors (ignoring backoff) and blocks for one round.
    /// Returns `true` if a mirror answered. Do not call it from `on_update`.
    pub fn refresh(&self) -> bool {
        if self.engine.polled.is_empty() || self.engine.stop.load(Ordering::Relaxed) {
            return false;
        }
        let ok = {
            let _g = lock(&self.wake.refresh);
            block_on(self.engine.round(true, None, RefreshTrigger::Manual))
        };
        self.engine.deliver_updates();
        ok
    }

    /// Stops the background refresher. Reads keep working. Called on drop.
    pub fn close(&mut self) {
        self.engine.stop.store(true, Ordering::Relaxed);
        *lock(&self.wake.stop) = true;
        self.wake.cv.notify_all();
        if let Some(t) = self.thread.take() {
            if t.thread().id() != std::thread::current().id() {
                let _ = t.join();
            }
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.close();
    }
}

fn startup_from_network(engine: &Engine<BlockingTransport>, wake: &Wake) -> Result<()> {
    let deadline = Instant::now() + engine.cfg.startup_timeout;
    let mut delay = Duration::from_millis(100);
    while engine.current().is_none() {
        {
            let _g = lock(&wake.refresh);
            block_on(engine.round(true, Some(deadline), RefreshTrigger::Start));
        }
        if engine.current().is_some() || Instant::now() + delay >= deadline {
            break;
        }
        std::thread::sleep(delay);
        delay = (delay * 2).min(Duration::from_secs(1));
    }
    engine.clear_pending(); // the first load is not an "update"
    engine.deliver_records();
    if engine.current().is_some() {
        return Ok(());
    }
    let err = engine.last_error();
    if !engine.cfg.start_empty {
        return Err(Error::Unavailable(format!(
            "could not load {} within {} ms: {err}",
            engine.what(),
            engine.cfg.startup_timeout.as_millis()
        )));
    }
    engine.log(LogLevel::Warn, &format!("starting empty, will keep trying: {err}"));
    Ok(())
}

fn run(engine: &Engine<BlockingTransport>, wake: &Wake, immediate: bool) {
    let mut first = immediate;
    loop {
        if !first {
            let wait = engine.cfg.poll_interval.mul_f64(crate::engine::jitter(0.9, 1.1));
            let until = Instant::now() + wait;
            let mut stopped = lock(&wake.stop);
            while !*stopped {
                let left = until.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                stopped = wake.cv.wait_timeout(stopped, left).unwrap_or_else(|e| e.into_inner()).0;
            }
            if *stopped {
                return;
            }
        } else if *lock(&wake.stop) {
            return;
        }
        first = false;
        {
            let _g = lock(&wake.refresh);
            block_on(engine.round(false, None, RefreshTrigger::Poll));
        }
        engine.deliver_updates();
    }
}

// ===========================================================================
// Snapshots
// ===========================================================================

/// What [`pull_snapshot`] wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotInfo {
    /// Workspace of the manifest.
    pub workspace: String,
    /// Revision written.
    pub revision: i64,
    /// Prompts in the manifest.
    pub prompt_count: usize,
    /// Blob files written (existing identical blobs are skipped).
    pub blobs_written: usize,
    /// Mirror that delivered it.
    pub source: String,
}

/// Pulls the deployed manifest and its blobs from the network mirrors configured in
/// `builder` and writes the layout to `out_dir` (what `kyp-snapshot` does).
pub fn pull_snapshot(builder: &Builder, out_dir: impl AsRef<Path>) -> Result<SnapshotInfo> {
    let out = out_dir.as_ref();
    let engine = Engine::new(builder.cfg.clone(), blocking_transport, true)?;
    let (st, source) = block_on(engine.pull())?;
    let io = |e: std::io::Error| Error::Unavailable(format!("writing {}: {e}", out.display()));
    let mut blobs_written = 0;
    for p in st.prompts.values() {
        let blob = out.join("blobs").join(&p.sha256);
        if std::fs::read(&blob).is_ok_and(|b| b == p.text.as_bytes()) {
            continue;
        }
        fetch::atomic_write(&blob, p.text.as_bytes()).map_err(io)?;
        blobs_written += 1;
    }
    fetch::atomic_write(&out.join(engine.manifest_path()), &st.raw).map_err(io)?;
    Ok(SnapshotInfo {
        workspace: st.manifest.workspace.clone(),
        revision: st.manifest.revision,
        prompt_count: st.prompts.len(),
        blobs_written,
        source,
    })
}

/// Rust source that embeds the snapshot in `snapshot_dir` with [`include_snapshot!`](crate::include_snapshot).
/// `dir_from_source` is the snapshot folder relative to the generated `.rs` file.
///
/// The output defines `pub static SNAPSHOT: kyp::EmbeddedFiles`; pass it to
/// [`Builder::embedded`].
pub fn embed_module_source(snapshot_dir: impl AsRef<Path>, dir_from_source: &str) -> std::io::Result<String> {
    let dir = snapshot_dir.as_ref();
    let mut files = Vec::new();
    for sub in ["envs", "blobs"] {
        collect(dir, &dir.join(sub), &mut files)?;
    }
    files.sort();
    let mut s = String::from(
        "// @generated by kyp-snapshot: a Keep Your Prompts snapshot compiled into the binary.\n\
         // Regenerate after pulling a new snapshot.\n",
    );
    s.push_str(&format!("pub static SNAPSHOT: kyp::EmbeddedFiles = kyp::include_snapshot!({dir_from_source:?}, [\n"));
    for f in files {
        s.push_str(&format!("    {f:?},\n"));
    }
    s.push_str("]);\n");
    Ok(s)
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in rd {
        let p = entry?.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            collect(root, &p, out)?;
        } else if let Ok(rel) = p.strip_prefix(root) {
            let rel: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            out.push(rel.join("/"));
        }
    }
    Ok(())
}
