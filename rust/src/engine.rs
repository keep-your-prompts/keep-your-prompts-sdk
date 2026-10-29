//! Mirrors, refresh rounds, the disk cache and the atomically swapped state.
//! Shared by the blocking [`Client`](crate::Client) and the tokio `AsyncClient`.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use arc_swap::ArcSwapOption;

use crate::error::{Error, Result};
use crate::fetch::{self, Fetched, Request, Transport};
use crate::manifest::{self, Manifest};
use crate::template::{self, OnMissing, Vars};

// ===========================================================================
// Public types
// ===========================================================================

/// A deployed prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    /// Name in the manifest (may contain `/`).
    pub name: String,
    /// Version from the manifest.
    pub version: i64,
    /// Lowercase hex SHA-256 of `text`.
    pub sha256: String,
    /// Declared variables (extracted from the text when the manifest lists none).
    pub variables: Vec<String>,
    /// The raw template.
    pub text: Arc<str>,
}

impl Prompt {
    /// Renders this prompt; a missing variable is an error.
    pub fn render<V: Vars + ?Sized>(&self, vars: &V) -> Result<String> {
        template::render(&self.text, vars, OnMissing::Error)
    }
}

/// One copy of a workspace. Every mirror uses the layout
/// `envs/<app>/<env>.json` + `blobs/<sha256>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mirror {
    /// Shown in `status()` and logs, e.g. `"cdn"`.
    pub name: String,
    /// `file:///dir`, `/dir`, `https://host/base`, or `embedded:`.
    pub url: String,
    /// Sent as `Authorization: Bearer` (git mirror, origin). Empty: none.
    pub bearer_token: String,
}

impl Mirror {
    /// A snapshot folder.
    pub fn file(dir: impl Into<PathBuf>, name: impl Into<String>) -> Mirror {
        Mirror { name: name.into(), url: dir.into().to_string_lossy().into_owned(), bearer_token: String::new() }
    }
    /// An HTTP(S) mirror.
    pub fn http(base_url: impl Into<String>, name: impl Into<String>, bearer_token: impl Into<String>) -> Mirror {
        Mirror { name: name.into(), url: base_url.into(), bearer_token: bearer_token.into() }
    }
    /// The snapshot passed to [`Builder::embedded`](crate::Builder::embedded).
    pub fn embedded() -> Mirror {
        Mirror { name: "embedded".into(), url: "embedded:".into(), bearer_token: String::new() }
    }
}

/// Log severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    /// Every request outcome.
    Debug,
    /// Loads and recoveries.
    Info,
    /// A mirror started failing, a refresh round failed (default threshold).
    Warn,
    /// Callback panics.
    Error,
}

impl LogLevel {
    fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}

/// Passed to `on_update` after a new revision was swapped in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    /// 0 if nothing was loaded before.
    pub old_revision: i64,
    /// The revision now served.
    pub new_revision: i64,
    /// Mirror that delivered it.
    pub source: String,
    /// Prompts added, removed or with a new body.
    pub changed: Vec<String>,
}

/// Per-mirror health.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorStatus {
    /// Mirror name.
    pub name: String,
    /// URL with the delivery key redacted.
    pub url: String,
    /// Failures since the last success.
    pub consecutive_failures: u32,
    /// Latest error from this mirror.
    pub last_error: String,
    /// Last time it answered.
    pub last_success: Option<SystemTime>,
}

/// Health of a client, for logs and metrics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// A manifest is loaded.
    pub ready: bool,
    /// Mirror that served or last confirmed the current state.
    pub source: String,
    /// Current revision (0 when nothing is loaded).
    pub revision: i64,
    /// Workspace from the manifest.
    pub workspace: String,
    /// `deployed_at` from the manifest.
    pub deployed_at: String,
    /// Number of prompts.
    pub prompt_count: usize,
    /// Last time a polled mirror confirmed the manifest (200 or 304).
    pub last_success: Option<SystemTime>,
    /// Failures in the latest refresh round; empty when the first mirror answered.
    pub last_error: String,
    /// Time since `last_success` (since start-up if never). Alert on this.
    pub stale_for: Duration,
    /// Per-mirror health, in the order they are tried.
    pub mirrors: Vec<MirrorStatus>,
}

/// Embedded snapshot files: `(path in the layout, contents)`.
pub type EmbeddedFiles = &'static [(&'static str, &'static [u8])];

pub(crate) type UpdateFn = Arc<dyn Fn(&Update) + Send + Sync>;
pub(crate) type LogFn = Arc<dyn Fn(LogLevel, &str) + Send + Sync>;

// ===========================================================================
// Configuration (built by Builder)
// ===========================================================================
#[derive(Clone)]
pub(crate) struct Config {
    pub app: String,
    pub env: String,
    pub delivery_key: String,
    pub workspace: String,
    pub mirrors: Option<Vec<Mirror>>,
    pub extra_mirrors: Vec<Mirror>,
    pub snapshot_dir: Option<PathBuf>,
    pub cache_dir: Option<PathBuf>,
    pub embedded: Option<EmbeddedFiles>,
    pub use_embedded: bool,
    pub git_url: String,
    pub git_token: String,
    pub cdn_base: String,
    pub origin_base: String,
    pub poll_interval: Duration,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub startup_timeout: Duration,
    pub max_backoff: Duration,
    pub start_empty: bool,
    pub user_agent: String,
    pub on_update: Option<UpdateFn>,
    pub logger: Option<LogFn>,
    pub log_level: Option<LogLevel>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            app: String::new(),
            env: "prod".into(),
            delivery_key: String::new(),
            workspace: String::new(),
            mirrors: None,
            extra_mirrors: Vec::new(),
            snapshot_dir: None,
            cache_dir: None,
            embedded: None,
            use_embedded: true,
            git_url: String::new(),
            git_token: String::new(),
            cdn_base: "https://cdn.keepyourprompts.com/v1/d".into(),
            origin_base: "https://api.keepyourprompts.com/v1/delivery".into(),
            poll_interval: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(2),
            request_timeout: Duration::from_secs(5),
            startup_timeout: Duration::from_secs(3),
            max_backoff: Duration::from_secs(300),
            start_empty: false,
            user_agent: concat!("kyp-rust/", env!("CARGO_PKG_VERSION")).into(),
            on_update: None,
            logger: None,
            log_level: Some(LogLevel::Warn),
        }
    }
}

// ===========================================================================
// State: immutable once published.
// ===========================================================================
pub(crate) struct State {
    pub manifest: Manifest,
    pub raw: Vec<u8>,
    pub prompts: HashMap<String, Arc<Prompt>>,
    pub names: Vec<String>,
}

impl State {
    fn text_by_sha(&self, sha: &str) -> Option<Arc<str>> {
        // Called only while building a new state (refresh path), never on reads.
        self.prompts.values().find(|p| p.sha256 == sha).map(|p| p.text.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Embedded,
    File,
    Cache,
    Http,
}

fn kind_of(url: &str) -> Kind {
    if url == "embedded:" || url.starts_with("embedded:") {
        Kind::Embedded
    } else if url.starts_with("http://") || url.starts_with("https://") {
        Kind::Http
    } else {
        Kind::File
    }
}

#[derive(Default)]
struct MirrorRt {
    etag: String,
    failures: u32,
    retry_at: Option<Instant>,
    last_error: String,
    last_ok: Option<SystemTime>,
}

pub(crate) struct MirrorEntry {
    cfg: Mirror,
    kind: Kind,
    shown_url: String,
    rt: Mutex<MirrorRt>,
}

struct StatusInner {
    started: SystemTime,
    last_success: Option<SystemTime>,
    last_error: String,
    source: String,
}

enum Outcome {
    Updated(Arc<State>, String),
    Unchanged(String),
    Stale(String),
    Failed { err: String, missing: bool },
}

/// Locks a mutex, ignoring poisoning (a panicking callback never wedges the client).
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A random float in [lo, hi) without a `rand` dependency.
pub(crate) fn jitter(lo: f64, hi: f64) -> f64 {
    let r = std::collections::hash_map::RandomState::new().build_hasher().finish();
    lo + (hi - lo) * ((r >> 11) as f64 / (1u64 << 53) as f64)
}

pub(crate) fn redact(s: &str, key: &str) -> String {
    if key.len() < 10 {
        return s.to_owned();
    }
    s.replace(key, &format!("{}...", &key[..9]))
}

// ===========================================================================
// Engine
// ===========================================================================
pub(crate) struct Engine<T: Transport> {
    pub cfg: Config,
    transport: Option<T>,
    mirrors: Vec<MirrorEntry>,
    pub polled: Vec<usize>,
    cache_idx: Option<usize>,
    cache_root: Mutex<Option<PathBuf>>,
    state: ArcSwapOption<State>,
    install_mu: Mutex<()>,
    status: Mutex<StatusInner>,
    pending: Mutex<Vec<Update>>,
    pub stop: AtomicBool,
}

impl<T: Transport> Engine<T> {
    pub fn new(
        mut cfg: Config,
        make_transport: impl FnOnce(&fetch::HttpSettings) -> T,
        for_snapshot: bool,
    ) -> Result<Self> {
        if cfg.app.is_empty() {
            return Err(Error::Config("app is not set (Builder::app or KYP_APP)".into()));
        }
        if !manifest::is_slug(&cfg.app) {
            return Err(Error::Config(format!("app \"{}\" is not a slug ([a-z0-9][a-z0-9-]{{0,62}})", cfg.app)));
        }
        if !manifest::is_slug(&cfg.env) {
            return Err(Error::Config(format!("env \"{}\" is not a slug ([a-z0-9][a-z0-9-]{{0,62}})", cfg.env)));
        }
        if !cfg.delivery_key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
            return Err(Error::Config("the delivery key contains an invalid character".into()));
        }
        cfg.poll_interval = cfg.poll_interval.max(Duration::from_millis(100));
        if for_snapshot {
            cfg.use_embedded = false;
            cfg.cache_dir = None;
        }

        let mut rest: Vec<Mirror> = match &cfg.mirrors {
            Some(m) => m.clone(),
            None => {
                let mut v = Vec::new();
                if let Some(d) = &cfg.snapshot_dir {
                    v.push(Mirror::file(d.clone(), "snapshot"));
                }
                if !cfg.delivery_key.is_empty() {
                    v.push(Mirror::http(fetch::join_url(&cfg.cdn_base, &cfg.delivery_key), "cdn", ""));
                    v.push(Mirror::http(fetch::join_url(&cfg.origin_base, &cfg.delivery_key), "origin", ""));
                }
                if !cfg.git_url.is_empty() {
                    v.push(Mirror::http(cfg.git_url.clone(), "git", cfg.git_token.clone()));
                }
                v
            }
        };
        rest.extend(cfg.extra_mirrors.iter().cloned());

        let manifest_path = format!("envs/{}/{}.json", cfg.app, cfg.env);
        let has_embedded =
            cfg.embedded.is_some_and(|files| files.iter().any(|(p, _)| p.trim_start_matches("./") == manifest_path));
        let mut mirrors = Vec::new();
        let key = cfg.delivery_key.clone();
        let mut add = |m: Mirror, kind: Kind| {
            mirrors.push(MirrorEntry { shown_url: redact(&m.url, &key), cfg: m, kind, rt: Mutex::default() });
        };
        let explicit_embedded = rest.iter().any(|m| kind_of(&m.url) == Kind::Embedded);
        if cfg.use_embedded && has_embedded && !explicit_embedded {
            add(Mirror::embedded(), Kind::Embedded);
        }
        let mut cache_idx = None;
        let mut idx = usize::from(cfg.use_embedded && has_embedded && !explicit_embedded);
        for m in rest {
            let k = kind_of(&m.url);
            if k == Kind::Embedded && !(cfg.use_embedded && cfg.embedded.is_some()) {
                continue;
            }
            if cache_idx.is_none() && k == Kind::Http {
                if let Some(d) = &cfg.cache_dir {
                    cache_idx = Some(idx);
                    add(Mirror::file(d.clone(), "disk-cache"), Kind::Cache);
                    idx += 1;
                }
            }
            add(m, k);
            idx += 1;
        }
        if cache_idx.is_none() {
            if let Some(d) = &cfg.cache_dir {
                cache_idx = Some(idx);
                add(Mirror::file(d.clone(), "disk-cache"), Kind::Cache);
            }
        }

        let mut polled: Vec<usize> = (0..mirrors.len()).filter(|&i| mirrors[i].kind == Kind::Http).collect();
        let transport = if polled.is_empty() {
            // No network mirrors: poll the file mirrors (a snapshot folder kept
            // fresh by a sidecar or `git pull`).
            polled = (0..mirrors.len()).filter(|&i| mirrors[i].kind == Kind::File).collect();
            None
        } else {
            Some(make_transport(&fetch::HttpSettings {
                connect_timeout: cfg.connect_timeout,
                user_agent: cfg.user_agent.clone(),
            }))
        };

        let e = Engine {
            transport,
            mirrors,
            polled,
            cache_idx,
            cache_root: Mutex::new(None),
            state: ArcSwapOption::empty(),
            install_mu: Mutex::new(()),
            status: Mutex::new(StatusInner {
                started: SystemTime::now(),
                last_success: None,
                last_error: String::new(),
                source: String::new(),
            }),
            pending: Mutex::new(Vec::new()),
            stop: AtomicBool::new(false),
            cfg,
        };
        if !e.cfg.delivery_key.is_empty() && !e.cfg.delivery_key.starts_with("kypd_") {
            e.log(LogLevel::Warn, "delivery key does not start with kypd_; check KYP_DELIVERY_KEY");
        }
        Ok(e)
    }

    pub fn manifest_path(&self) -> String {
        format!("envs/{}/{}.json", self.cfg.app, self.cfg.env)
    }

    pub fn what(&self) -> String {
        format!("{}/{}", self.cfg.app, self.cfg.env)
    }

    pub fn log(&self, level: LogLevel, msg: &str) {
        let Some(threshold) = self.cfg.log_level else { return };
        if level < threshold {
            return;
        }
        let m = redact(msg, &self.cfg.delivery_key);
        match &self.cfg.logger {
            Some(l) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| l(level, &m)));
            }
            None => eprintln!("[kyp] {}: {m}", level.as_str()),
        }
    }

    // --- read path --------------------------------------------------------
    pub fn state(&self) -> arc_swap::Guard<Option<Arc<State>>> {
        self.state.load()
    }

    pub fn current(&self) -> Option<Arc<State>> {
        self.state.load_full()
    }

    pub fn status(&self) -> Status {
        let s = self.state.load_full();
        let st = lock(&self.status);
        let since = st.last_success.unwrap_or(st.started);
        Status {
            ready: s.is_some(),
            source: st.source.clone(),
            revision: s.as_ref().map_or(0, |s| s.manifest.revision),
            workspace: s.as_ref().map(|s| s.manifest.workspace.clone()).unwrap_or_default(),
            deployed_at: s.as_ref().map(|s| s.manifest.deployed_at.clone()).unwrap_or_default(),
            prompt_count: s.as_ref().map_or(0, |s| s.prompts.len()),
            last_success: st.last_success,
            last_error: st.last_error.clone(),
            stale_for: SystemTime::now().duration_since(since).unwrap_or_default(),
            mirrors: self
                .mirrors
                .iter()
                .map(|m| {
                    let rt = lock(&m.rt);
                    MirrorStatus {
                        name: m.cfg.name.clone(),
                        url: m.shown_url.clone(),
                        consecutive_failures: rt.failures,
                        last_error: rt.last_error.clone(),
                        last_success: rt.last_ok,
                    }
                })
                .collect(),
        }
    }

    pub fn last_error(&self) -> String {
        lock(&self.status).last_error.clone()
    }

    // --- mirror access ----------------------------------------------------
    fn fetch_local(&self, mi: usize, rel: &str) -> Fetched {
        let m = &self.mirrors[mi];
        match m.kind {
            Kind::Embedded => {
                let files = self.cfg.embedded.unwrap_or(&[]);
                match files.iter().find(|(p, _)| p.trim_start_matches("./") == rel) {
                    Some((_, data)) => Fetched::Ok { body: data.to_vec(), etag: String::new() },
                    None => Fetched::NotFound(format!("not embedded: {rel}")),
                }
            }
            Kind::File => fetch::read_file(&fetch::file_url_to_path(&m.cfg.url).join(rel)),
            Kind::Cache => match lock(&self.cache_root).clone() {
                Some(root) => fetch::read_file(&root.join(rel)),
                None => Fetched::NotFound("empty".into()),
            },
            Kind::Http => Fetched::Failed("not a local mirror".into()),
        }
    }

    async fn fetch(&self, mi: usize, rel: &str, etag: &str, deadline: Option<Instant>) -> Fetched {
        let m = &self.mirrors[mi];
        let r = if m.kind != Kind::Http {
            self.fetch_local(mi, rel)
        } else if let Some(t) = &self.transport {
            let mut timeout = self.cfg.request_timeout;
            if let Some(d) = deadline {
                let left = d.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Fetched::Failed("start-up timeout".into());
                }
                timeout = timeout.min(left);
            }
            let url = fetch::join_url(&m.cfg.url, rel);
            t.get(Request { url: &url, etag, bearer: &m.cfg.bearer_token, timeout }).await
        } else {
            Fetched::Failed("no HTTP client".into())
        };
        match r {
            Fetched::Failed(e) => Fetched::Failed(redact(&e, &self.cfg.delivery_key)),
            Fetched::NotFound(e) => Fetched::NotFound(redact(&e, &self.cfg.delivery_key)),
            ok => ok,
        }
    }

    fn in_backoff(&self, mi: usize) -> bool {
        lock(&self.mirrors[mi].rt).retry_at.is_some_and(|t| t > Instant::now())
    }

    fn record_ok(&self, mi: usize, etag: Option<String>) {
        let recovered = {
            let mut rt = lock(&self.mirrors[mi].rt);
            let r = rt.failures > 0;
            rt.failures = 0;
            rt.retry_at = None;
            rt.last_error.clear();
            rt.last_ok = Some(SystemTime::now());
            if let Some(e) = etag {
                rt.etag = e;
            }
            r
        };
        if recovered {
            self.log(LogLevel::Info, &format!("{} is answering again", self.mirrors[mi].cfg.name));
        }
    }

    fn record_fail(&self, mi: usize, err: &str, count: bool) {
        let failures = {
            let mut rt = lock(&self.mirrors[mi].rt);
            rt.last_error = err.to_owned();
            if count {
                rt.failures += 1;
                // Skip the mirror for 0, 1, 3, 7, ... poll intervals, capped at max_backoff.
                let mult = (1u64 << (rt.failures - 1).min(20)) - 1;
                let base = self.cfg.poll_interval.saturating_mul(mult as u32).min(self.cfg.max_backoff);
                rt.retry_at = Some(Instant::now() + base.mul_f64(jitter(0.9, 1.1)));
                rt.failures
            } else {
                0
            }
        };
        let level = if failures == 1 { LogLevel::Warn } else { LogLevel::Debug };
        self.log(level, &format!("{}: {err}", self.mirrors[mi].cfg.name));
    }

    // --- loading ------------------------------------------------------------
    async fn resolve_blob(
        &self,
        mi: usize,
        sha: &str,
        deadline: Option<Instant>,
        local_only: bool,
    ) -> Result<Arc<str>, String> {
        let mut order: Vec<usize> = Vec::with_capacity(self.mirrors.len() + 2);
        order.extend(self.cache_idx);
        order.push(mi);
        order.extend(0..self.mirrors.len());
        let mut seen = vec![false; self.mirrors.len()];
        let mut errors = String::new();
        let rel = format!("blobs/{sha}");
        for i in order {
            if std::mem::replace(&mut seen[i], true) || self.stop.load(Ordering::Relaxed) {
                continue;
            }
            let http = self.mirrors[i].kind == Kind::Http;
            if http && (local_only || (i != mi && self.in_backoff(i))) {
                continue;
            }
            let body = match self.fetch(i, &rel, "", deadline).await {
                Fetched::Ok { body, .. } => body,
                Fetched::Failed(e) | Fetched::NotFound(e) => {
                    if i == mi {
                        errors.push_str(&format!("{}: {e}; ", self.mirrors[i].cfg.name));
                    }
                    continue;
                }
                Fetched::NotModified { .. } => continue,
            };
            if manifest::sha256_hex(&body) != sha {
                let msg = format!("blob {} failed sha256 verification", &sha[..12]);
                self.log(LogLevel::Warn, &format!("{}: {msg} (discarded)", self.mirrors[i].cfg.name));
                errors.push_str(&format!("{}: {msg}; ", self.mirrors[i].cfg.name));
                continue;
            }
            match String::from_utf8(body) {
                Ok(s) => return Ok(Arc::from(s)),
                Err(_) => errors.push_str(&format!("{}: blob {} is not UTF-8; ", self.mirrors[i].cfg.name, &sha[..12])),
            }
        }
        let detail = errors.trim_end_matches("; ");
        Err(if detail.is_empty() {
            format!("blob {} unavailable", &sha[..12])
        } else {
            format!("blob {} unavailable ({detail})", &sha[..12])
        })
    }

    async fn build(
        &self,
        mi: usize,
        man: Manifest,
        raw: Vec<u8>,
        cur: Option<&State>,
        deadline: Option<Instant>,
        local_only: bool,
    ) -> Result<State, String> {
        let mut fetched: HashMap<String, Arc<str>> = HashMap::new();
        let mut prompts = HashMap::with_capacity(man.prompts.len());
        let mut names = Vec::with_capacity(man.prompts.len());
        for (name, mp) in &man.prompts {
            let text = match cur.and_then(|c| c.text_by_sha(&mp.sha256)).or_else(|| fetched.get(&mp.sha256).cloned()) {
                Some(t) => t,
                None => {
                    let t = self.resolve_blob(mi, &mp.sha256, deadline, local_only).await?;
                    fetched.insert(mp.sha256.clone(), t.clone());
                    t
                }
            };
            let variables = if mp.variables.is_empty() { template::variables_in(&text) } else { mp.variables.clone() };
            names.push(name.clone());
            prompts.insert(
                name.clone(),
                Arc::new(Prompt {
                    name: name.clone(),
                    version: mp.version,
                    sha256: mp.sha256.clone(),
                    variables,
                    text,
                }),
            );
        }
        Ok(State { manifest: man, raw, prompts, names })
    }

    async fn try_mirror(
        &self,
        mi: usize,
        cur: Option<&State>,
        use_etag: bool,
        deadline: Option<Instant>,
        local_only: bool,
    ) -> Outcome {
        let etag = if use_etag && cur.is_some() { lock(&self.mirrors[mi].rt).etag.clone() } else { String::new() };
        let (body, etag) = match self.fetch(mi, &self.manifest_path(), &etag, deadline).await {
            Fetched::NotModified { etag } => return Outcome::Unchanged(etag),
            Fetched::Ok { body, etag } => (body, etag),
            Fetched::NotFound(e) => return Outcome::Failed { err: format!("manifest not found ({e})"), missing: true },
            Fetched::Failed(e) => return Outcome::Failed { err: e, missing: false },
        };
        let man = match manifest::parse_manifest(&body, &self.cfg.app, &self.cfg.env) {
            Ok(m) => m,
            Err(Error::Protocol(e)) => return Outcome::Failed { err: format!("bad manifest: {e}"), missing: false },
            Err(e) => return Outcome::Failed { err: format!("bad manifest: {e}"), missing: false },
        };
        if let Some(c) = cur {
            if man.revision < c.manifest.revision {
                return Outcome::Stale(format!(
                    "stale manifest ignored (revision {} < held {})",
                    man.revision, c.manifest.revision
                ));
            }
            if man.revision == c.manifest.revision {
                return Outcome::Unchanged(etag);
            }
        }
        match self.build(mi, man, body, cur, deadline, local_only).await {
            Ok(st) => Outcome::Updated(Arc::new(st), etag),
            Err(err) => Outcome::Failed { err, missing: false },
        }
    }

    /// Publishes `st` unless a newer state was installed concurrently.
    fn install(&self, st: Arc<State>, mi: usize, notify: bool) -> bool {
        let _g = lock(&self.install_mu);
        let old = self.state.load_full();
        if old.as_ref().is_some_and(|o| o.manifest.revision >= st.manifest.revision) {
            return false;
        }
        self.state.store(Some(st.clone()));
        let name = self.mirrors[mi].cfg.name.clone();
        lock(&self.status).source = name.clone();
        self.log(
            LogLevel::Info,
            &format!(
                "loaded {} revision {} ({} prompts) from {name}",
                self.what(),
                st.manifest.revision,
                st.prompts.len()
            ),
        );
        if notify && self.cfg.on_update.is_some() {
            let mut changed: Vec<String> = st
                .names
                .iter()
                .filter(|n| {
                    let before = old.as_ref().and_then(|o| o.prompts.get(*n));
                    before.map_or(true, |b| b.sha256 != st.prompts[*n].sha256)
                })
                .cloned()
                .collect();
            if let Some(o) = &old {
                changed.extend(o.names.iter().filter(|n| !st.prompts.contains_key(*n)).cloned());
            }
            lock(&self.pending).push(Update {
                old_revision: old.map_or(0, |o| o.manifest.revision),
                new_revision: st.manifest.revision,
                source: name,
                changed,
            });
        }
        true
    }

    /// Runs `on_update` for swaps made since the last call (outside any lock).
    pub fn deliver_updates(&self) {
        let todo = std::mem::take(&mut *lock(&self.pending));
        let Some(cb) = &self.cfg.on_update else { return };
        for u in todo {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(&u))).is_err() {
                self.log(LogLevel::Error, "on_update callback panicked");
            }
        }
    }

    pub fn clear_pending(&self) {
        lock(&self.pending).clear();
    }

    /// Start-up step 1: local mirrors only. The highest revision wins; ties go to the earlier mirror.
    pub async fn load_local(&self) {
        self.locate_cache();
        let mut best: Option<(Arc<State>, usize)> = None;
        for mi in 0..self.mirrors.len() {
            if self.mirrors[mi].kind == Kind::Http {
                continue;
            }
            let cur = best.as_ref().map(|(s, _)| s.as_ref());
            match self.try_mirror(mi, cur, false, None, true).await {
                Outcome::Updated(st, _) => best = Some((st, mi)),
                Outcome::Failed { err, missing: false } => self.record_fail(mi, &err, false),
                _ => {}
            }
        }
        if let Some((st, mi)) = best {
            self.install(st.clone(), mi, false);
            if Some(mi) != self.cache_idx {
                self.write_cache(&st);
            }
        }
    }

    /// One refresh round over the polled mirrors, in order. Returns true if a mirror answered.
    pub async fn round(&self, ignore_backoff: bool, deadline: Option<Instant>) -> bool {
        let cur = self.state.load_full();
        let mut errs: Vec<String> = Vec::new();
        let mut skipped = Vec::new();
        let mut answered = false;
        for &mi in &self.polled {
            if self.stop.load(Ordering::Relaxed) {
                break;
            }
            if !ignore_backoff && self.in_backoff(mi) {
                skipped.push(mi);
                continue;
            }
            if self.attempt(mi, cur.as_deref(), deadline, &mut errs).await {
                answered = true;
                break;
            }
        }
        // Everything tried failed: give the mirrors in backoff a chance too.
        if !answered {
            for mi in skipped {
                if self.stop.load(Ordering::Relaxed) {
                    break;
                }
                if self.attempt(mi, cur.as_deref(), deadline, &mut errs).await {
                    answered = true;
                    break;
                }
            }
        }
        let joined = errs.join("; ");
        {
            let mut st = lock(&self.status);
            if answered {
                st.last_success = Some(SystemTime::now());
            }
            st.last_error =
                if !answered && joined.is_empty() { "all mirrors backing off".into() } else { joined.clone() };
        }
        if !answered && !self.stop.load(Ordering::Relaxed) {
            self.log(LogLevel::Warn, &format!("refresh failed, serving what is held: {joined}"));
        }
        answered
    }

    async fn attempt(&self, mi: usize, cur: Option<&State>, deadline: Option<Instant>, errs: &mut Vec<String>) -> bool {
        let name = self.mirrors[mi].cfg.name.clone();
        match self.try_mirror(mi, cur, true, deadline, false).await {
            Outcome::Updated(st, etag) => {
                self.record_ok(mi, Some(etag));
                if self.install(st.clone(), mi, true) {
                    self.write_cache(&st);
                }
                true
            }
            Outcome::Unchanged(etag) => {
                self.record_ok(mi, Some(etag));
                if cur.is_some() {
                    lock(&self.status).source = name;
                }
                true
            }
            Outcome::Stale(err) => {
                errs.push(format!("{name}: {err}"));
                self.record_fail(mi, &err, false);
                false
            }
            Outcome::Failed { err, .. } => {
                errs.push(format!("{name}: {err}"));
                self.record_fail(mi, &err, true);
                false
            }
        }
    }

    // --- disk cache ---------------------------------------------------------
    fn cache_root_for(&self, workspace: &str) -> Option<PathBuf> {
        self.cfg.cache_dir.as_ref().map(|d| d.join(workspace).join(&self.cfg.app).join(&self.cfg.env))
    }

    /// Finds `<cache_dir>/<workspace>/<app>/<env>` holding the highest revision.
    fn locate_cache(&self) {
        if self.cache_idx.is_none() || lock(&self.cache_root).is_some() {
            return;
        }
        if !self.cfg.workspace.is_empty() {
            *lock(&self.cache_root) = self.cache_root_for(&self.cfg.workspace);
            return;
        }
        let Some(dir) = &self.cfg.cache_dir else { return };
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut best: Option<(i64, PathBuf)> = None;
        for entry in rd.flatten() {
            let root = entry.path().join(&self.cfg.app).join(&self.cfg.env);
            if let Fetched::Ok { body, .. } = fetch::read_file(&root.join(self.manifest_path())) {
                if let Ok(m) = manifest::parse_manifest(&body, &self.cfg.app, &self.cfg.env) {
                    if best.as_ref().map_or(true, |(r, _)| m.revision > *r) {
                        best = Some((m.revision, root));
                    }
                }
            }
        }
        *lock(&self.cache_root) = best.map(|(_, p)| p);
    }

    fn write_cache(&self, st: &State) {
        if self.cache_idx.is_none() {
            return;
        }
        let Some(root) = self.cache_root_for(&st.manifest.workspace) else { return };
        let res = (|| -> std::io::Result<()> {
            for p in st.prompts.values() {
                let blob = root.join("blobs").join(&p.sha256);
                if !blob.exists() {
                    fetch::atomic_write(&blob, p.text.as_bytes())?;
                }
            }
            let mpath = root.join(self.manifest_path());
            if let Fetched::Ok { body, .. } = fetch::read_file(&mpath) {
                if body == st.raw {
                    *lock(&self.cache_root) = Some(root.clone());
                    return Ok(());
                }
                if manifest::parse_manifest(&body, &self.cfg.app, &self.cfg.env)
                    .is_ok_and(|m| m.revision > st.manifest.revision)
                {
                    return Ok(());
                }
            }
            fetch::atomic_write(&mpath, &st.raw)?;
            *lock(&self.cache_root) = Some(root.clone());
            Ok(())
        })();
        if let Err(e) = res {
            self.log(LogLevel::Warn, &format!("disk cache write failed: {e}"));
        }
    }

    /// For `pull_snapshot`: the first polled mirror that delivers a complete state.
    pub async fn pull(&self) -> Result<(Arc<State>, String)> {
        let mut errors = Vec::new();
        for &mi in &self.polled {
            match self.try_mirror(mi, None, false, None, false).await {
                Outcome::Updated(st, _) => return Ok((st, self.mirrors[mi].cfg.name.clone())),
                Outcome::Failed { err, .. } | Outcome::Stale(err) => {
                    errors.push(format!("{}: {err}", self.mirrors[mi].cfg.name))
                }
                Outcome::Unchanged(_) => {}
            }
        }
        if self.polled.is_empty() {
            errors.push("no remote mirror configured (set a delivery key or a mirror)".into());
        }
        Err(Error::Unavailable(format!("could not pull {}: {}", self.what(), errors.join("; "))))
    }

    pub fn unavailable(&self, why: &str) -> Error {
        Error::Unavailable(format!("no prompts for {}: {why}", self.what()))
    }
}

/// The read API shared by `Client` and `AsyncClient` (all reads are memory-only).
macro_rules! read_api {
    () => {
        /// Raw template of `name`, or `None` if it is not deployed. Lock-free, no I/O.
        #[inline]
        pub fn get(&self, name: &str) -> Option<std::sync::Arc<str>> {
            let g = self.engine.state();
            (*g).as_ref()?.prompts.get(name).map(|p| p.text.clone())
        }

        /// Calls `f` with the raw template of `name` without touching any reference count:
        /// the fastest read when many threads hit the same prompt.
        #[inline]
        pub fn get_with<R>(&self, name: &str, f: impl FnOnce(&str) -> R) -> Option<R> {
            let g = self.engine.state();
            (*g).as_ref()?.prompts.get(name).map(|p| f(&p.text))
        }

        /// Whether `name` is in the current revision.
        pub fn contains(&self, name: &str) -> bool {
            self.engine.state().as_ref().is_some_and(|s| s.prompts.contains_key(name))
        }

        /// Name, version, sha256, variables and text of `name`.
        pub fn prompt(&self, name: &str) -> Option<std::sync::Arc<$crate::Prompt>> {
            let g = self.engine.state();
            (*g).as_ref()?.prompts.get(name).cloned()
        }

        /// Renders `name` with `vars` (`&[("k", "v")]`, a `HashMap`, ...). A missing variable is an error.
        pub fn render<V: $crate::Vars + ?Sized>(&self, name: &str, vars: &V) -> $crate::Result<String> {
            self.render_with(name, vars, $crate::OnMissing::Error)
        }

        /// Renders `name`, choosing what happens to variables without a value.
        pub fn render_with<V: $crate::Vars + ?Sized>(
            &self,
            name: &str,
            vars: &V,
            on_missing: $crate::OnMissing,
        ) -> $crate::Result<String> {
            let g = self.engine.state();
            match (*g).as_ref().and_then(|s| s.prompts.get(name)) {
                Some(p) => $crate::render(&p.text, vars, on_missing),
                None => Err($crate::Error::NotFound { name: name.to_owned() }),
            }
        }

        /// Prompt names in the current revision, sorted.
        pub fn names(&self) -> Vec<String> {
            self.engine.state().as_ref().map(|s| s.names.clone()).unwrap_or_default()
        }

        /// Current revision, 0 when nothing is loaded.
        pub fn revision(&self) -> i64 {
            self.engine.state().as_ref().map_or(0, |s| s.manifest.revision)
        }

        /// Health, for logs and metrics.
        pub fn status(&self) -> $crate::Status {
            self.engine.status()
        }
    };
}
pub(crate) use read_api;
