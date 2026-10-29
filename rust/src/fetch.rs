//! Mirror access: files, the embedded snapshot and HTTP transports.
#![cfg_attr(not(feature = "blocking"), allow(dead_code))]

use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::time::Duration;

/// Outcome of reading one path from a mirror.
#[derive(Debug)]
pub(crate) enum Fetched {
    Ok { body: Vec<u8>, etag: String },
    NotModified { etag: String },
    NotFound(String),
    Failed(String),
}

/// An HTTP client used for network mirrors. `get` returns a future so one
/// engine serves both the blocking client (futures that complete on first
/// poll) and the tokio client.
pub(crate) trait Transport: Send + Sync + 'static {
    fn get(&self, req: Request<'_>) -> impl Future<Output = Fetched> + Send;
}

pub(crate) struct Request<'a> {
    pub url: &'a str,
    pub etag: &'a str,
    pub bearer: &'a str,
    pub timeout: Duration,
}

/// Settings shared by the transports.
#[derive(Clone)]
pub(crate) struct HttpSettings {
    pub connect_timeout: Duration,
    pub user_agent: String,
}

/// Used when the crate is built without an HTTP feature.
#[allow(dead_code)]
pub(crate) struct NoTransport;

impl Transport for NoTransport {
    #[allow(clippy::manual_async_fn)]
    fn get(&self, _req: Request<'_>) -> impl Future<Output = Fetched> + Send {
        async { Fetched::Failed("built without HTTP support (enable the `blocking` feature)".into()) }
    }
}

const MAX_BODY: u64 = 32 << 20;

// ---------------------------------------------------------------------------
// Blocking transport: ureq + rustls.
// ---------------------------------------------------------------------------
#[cfg(feature = "blocking")]
pub(crate) struct UreqTransport {
    direct: ureq::Agent,
    https_proxy: Option<ureq::Agent>,
    http_proxy: Option<ureq::Agent>,
    no_proxy: NoProxy,
}

#[cfg(feature = "blocking")]
impl UreqTransport {
    pub fn new(s: &HttpSettings) -> Self {
        let agent = |proxy: Option<&str>| -> Option<ureq::Agent> {
            let mut b =
                ureq::AgentBuilder::new().timeout_connect(s.connect_timeout).user_agent(&s.user_agent).redirects(5);
            if let Some(p) = proxy {
                b = b.proxy(ureq::Proxy::new(p).ok()?);
            }
            Some(b.build())
        };
        let env = |names: &[&str]| names.iter().find_map(|n| std::env::var(n).ok().filter(|v| !v.is_empty()));
        UreqTransport {
            direct: agent(None).expect("agent without proxy"),
            https_proxy: env(&["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]).and_then(|p| agent(Some(&p))),
            http_proxy: env(&["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]).and_then(|p| agent(Some(&p))),
            no_proxy: NoProxy::from_env(),
        }
    }

    fn get_sync(&self, r: &Request<'_>) -> Fetched {
        let https = r.url.starts_with("https://");
        let proxied = if https { self.https_proxy.as_ref() } else { self.http_proxy.as_ref() };
        let agent = match proxied {
            Some(a) if !self.no_proxy.matches(host_of(r.url)) => a,
            _ => &self.direct,
        };
        let mut req = agent.get(r.url).timeout(r.timeout);
        if !r.etag.is_empty() {
            req = req.set("If-None-Match", r.etag);
        }
        if !r.bearer.is_empty() {
            req = req.set("Authorization", &format!("Bearer {}", r.bearer));
        }
        match req.call() {
            Ok(resp) => {
                let etag = resp.header("etag").unwrap_or_default().to_owned();
                if resp.status() == 304 {
                    return Fetched::NotModified { etag };
                }
                if resp.status() != 200 {
                    return Fetched::Failed(format!("HTTP {}", resp.status()));
                }
                let mut body = Vec::new();
                match std::io::Read::read_to_end(&mut resp.into_reader().take(MAX_BODY), &mut body) {
                    Ok(_) => Fetched::Ok { body, etag },
                    Err(e) => Fetched::Failed(format!("reading body: {e}")),
                }
            }
            Err(ureq::Error::Status(404, _)) | Err(ureq::Error::Status(410, _)) => Fetched::NotFound("HTTP 404".into()),
            Err(ureq::Error::Status(code, _)) => Fetched::Failed(format!("HTTP {code}")),
            Err(ureq::Error::Transport(t)) => Fetched::Failed(t.to_string()),
        }
    }
}

#[cfg(feature = "blocking")]
use std::io::Read as _;

#[cfg(feature = "blocking")]
impl Transport for UreqTransport {
    fn get(&self, req: Request<'_>) -> impl Future<Output = Fetched> + Send {
        let r = self.get_sync(&req);
        std::future::ready(r)
    }
}

// ---------------------------------------------------------------------------
// Async transport: reqwest + rustls (honours HTTPS_PROXY and NO_PROXY).
// ---------------------------------------------------------------------------
#[cfg(feature = "tokio")]
pub(crate) struct ReqwestTransport {
    client: reqwest::Client,
}

#[cfg(feature = "tokio")]
impl ReqwestTransport {
    pub fn new(s: &HttpSettings) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(s.connect_timeout)
            .user_agent(s.user_agent.clone())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        ReqwestTransport { client }
    }
}

#[cfg(feature = "tokio")]
impl Transport for ReqwestTransport {
    fn get(&self, r: Request<'_>) -> impl Future<Output = Fetched> + Send {
        let mut req = self.client.get(r.url).timeout(r.timeout);
        if !r.etag.is_empty() {
            req = req.header("If-None-Match", r.etag);
        }
        if !r.bearer.is_empty() {
            req = req.bearer_auth(r.bearer);
        }
        async move {
            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => return Fetched::Failed(e.without_url().to_string()),
            };
            let etag = resp.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
            match resp.status().as_u16() {
                200 => match resp.bytes().await {
                    Ok(b) if b.len() as u64 <= MAX_BODY => Fetched::Ok { body: b.to_vec(), etag },
                    Ok(_) => Fetched::Failed("body too large".into()),
                    Err(e) => Fetched::Failed(format!("reading body: {}", e.without_url())),
                },
                304 => Fetched::NotModified { etag },
                404 | 410 => Fetched::NotFound("HTTP 404".into()),
                code => Fetched::Failed(format!("HTTP {code}")),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// NO_PROXY matching (ureq 2 does not read it).
// ---------------------------------------------------------------------------
#[allow(dead_code)]
pub(crate) struct NoProxy(Vec<String>);

#[allow(dead_code)]
impl NoProxy {
    pub fn from_env() -> Self {
        let v = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")).unwrap_or_default();
        NoProxy::parse(&v)
    }

    pub fn parse(v: &str) -> Self {
        NoProxy(v.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect())
    }

    pub fn matches(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        let ip: Option<std::net::IpAddr> = host.parse().ok();
        self.0.iter().any(|e| {
            if e == "*" || *e == host {
                return true;
            }
            if let (Some((net, bits)), Some(std::net::IpAddr::V4(ip))) = (e.split_once('/'), ip) {
                if let (Ok(net), Ok(bits)) = (net.parse::<std::net::Ipv4Addr>(), bits.parse::<u32>()) {
                    if bits <= 32 {
                        let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
                        return u32::from(ip) & mask == u32::from(net) & mask;
                    }
                }
                return false;
            }
            let suffix = e.trim_start_matches("*.").trim_start_matches('.');
            ip.is_none() && (host == suffix || host.ends_with(&format!(".{suffix}")))
        })
    }
}

/// `https://user@host:443/path` -> `host`.
pub(crate) fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if let Some(stripped) = authority.strip_prefix('[') {
        return stripped.split(']').next().unwrap_or("");
    }
    authority.split(':').next().unwrap_or("")
}

// ---------------------------------------------------------------------------
// Files.
// ---------------------------------------------------------------------------
pub(crate) fn read_file(path: &Path) -> Fetched {
    match std::fs::read(path) {
        Ok(body) => Fetched::Ok { body, etag: String::new() },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Fetched::NotFound(format!("{} not found", path.display()))
        }
        Err(e) => Fetched::Failed(format!("{}: {e}", path.display())),
    }
}

/// `file:///dir` or `/dir` -> path.
pub(crate) fn file_url_to_path(url: &str) -> PathBuf {
    PathBuf::from(url.strip_prefix("file://").unwrap_or(url))
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Temp file, fsync, rename: readers see the old or the new file, never half of one.
pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.tmp.{}.{}", std::process::id(), TMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    let res = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

pub(crate) fn join_url(base: &str, rel: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{rel}")
    } else {
        format!("{base}/{rel}")
    }
}

// ---------------------------------------------------------------------------
// A minimal executor for the blocking client: its futures complete on the
// first poll, but park/unpark keeps this correct for any future.
// ---------------------------------------------------------------------------
struct ThreadWaker(std::thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

pub(crate) fn block_on<F: Future>(fut: F) -> F::Output {
    let mut fut = std::pin::pin!(fut);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    loop {
        if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::park();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_proxy_and_hosts() {
        let np = NoProxy::parse("localhost, 127.0.0.0/8,.svc.cluster.local,example.com");
        assert!(np.matches("127.0.0.1"));
        assert!(np.matches("localhost"));
        assert!(np.matches("a.svc.cluster.local"));
        assert!(np.matches("api.example.com"));
        assert!(!np.matches("cdn.keepyourprompts.com"));
        assert!(!np.matches("10.0.0.1"));
        assert_eq!(host_of("https://u:p@cdn.x.com:8443/v1?q"), "cdn.x.com");
        assert_eq!(host_of("http://[::1]:80/a"), "::1");
        assert_eq!(join_url("http://h/a/", "envs"), "http://h/a/envs");
    }
}
