//! Test helpers: fixture folders and two fake mirror servers with the same
//! behaviour (routes, ETag/304, Cache-Control, /__down, /__up, /__stats):
//! an in-process tiny_http one (always) and conformance/fake_cdn.py (when python3 exists).
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const KEY: &str = "kypd_Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f";

pub fn conformance_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance")
}

pub fn fixture(name: &str) -> PathBuf {
    conformance_dir().join("fixtures").join(name)
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let dst = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_tree(&e.path(), &dst);
        } else {
            std::fs::copy(e.path(), dst).unwrap();
        }
    }
}

/// A folder served by a fake, initialised from a fixture.
pub struct Served {
    pub dir: tempfile::TempDir,
}

impl Served {
    pub fn new(fixture_name: &str) -> Served {
        let dir = tempfile::tempdir().unwrap();
        copy_tree(&fixture(fixture_name), dir.path());
        Served { dir }
    }
    pub fn path(&self) -> &Path {
        self.dir.path()
    }
    /// Deploy like the server does: blobs first, then the manifest by rename.
    pub fn deploy(&self, fixture_name: &str) {
        copy_tree(&fixture(fixture_name).join("blobs"), &self.path().join("blobs"));
        let src = fixture(fixture_name).join("envs/demo/prod.json");
        let tmp = self.path().join("envs/demo/prod.json.new");
        std::fs::copy(src, &tmp).unwrap();
        std::fs::rename(tmp, self.path().join("envs/demo/prod.json")).unwrap();
    }
}

#[derive(Debug, Default, Clone)]
pub struct RouteStats {
    pub ok: u64,
    pub not_modified: u64,
    pub not_found: u64,
    pub unavailable: u64,
    pub auth: Option<String>,
}

/// A running fake mirror server.
pub trait Fake: Send + Sync {
    fn kind(&self) -> &'static str;
    fn base(&self) -> String;
    fn down(&self, route: &str) {
        http_get(&self.base(), &format!("/__down/{route}"));
    }
    fn up(&self, route: &str) {
        http_get(&self.base(), &format!("/__up/{route}"));
    }
    fn stats(&self, route: &str) -> RouteStats {
        let body = http_get(&self.base(), "/__stats");
        let v: serde_json::Value = serde_json::from_str(&body).expect("stats json");
        let r = &v[route];
        let n = |k: &str| r[k].as_u64().unwrap_or(0);
        RouteStats {
            ok: n("200"),
            not_modified: n("304"),
            not_found: n("404"),
            unavailable: n("503"),
            auth: r["auth"].as_str().map(str::to_owned),
        }
    }
}

/// Minimal HTTP/1.1 GET with std only (control endpoints).
pub fn http_get(base: &str, path: &str) -> String {
    let hostport = base.trim_start_matches("http://");
    let mut s = TcpStream::connect(hostport).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(s, "GET {path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\n\r\n").unwrap();
    let mut resp = String::new();
    s.read_to_string(&mut resp).unwrap();
    resp.split_once("\r\n\r\n").map(|(_, b)| b.to_owned()).unwrap_or_default()
}

pub struct Route {
    pub name: String,
    pub prefix: String,
    pub dir: PathBuf,
}

pub fn route(name: &str, prefix: &str, dir: &Path) -> Route {
    Route { name: name.into(), prefix: prefix.trim_end_matches('/').into(), dir: dir.to_path_buf() }
}

/// The standard routes: cdn and origin under the delivery key, git under a repo path.
pub fn standard_routes(cdn: &Path, origin: &Path, git: &Path) -> Vec<Route> {
    vec![
        route("cdn", &format!("/v1/d/{KEY}"), cdn),
        route("origin", &format!("/v1/delivery/{KEY}"), origin),
        route("git", "/acme/prompts/main/.kyp", git),
    ]
}

// ---------------------------------------------------------------------------
// In-process fake (tiny_http)
// ---------------------------------------------------------------------------
#[derive(Default)]
struct TinyState {
    down: std::collections::HashSet<String>,
    stats: std::collections::BTreeMap<String, RouteStats>,
}

pub struct TinyFake {
    server: Arc<tiny_http::Server>,
    port: u16,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl TinyFake {
    pub fn start(routes: Vec<Route>) -> TinyFake {
        let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
        let port = server.server_addr().to_ip().unwrap().port();
        let state = Arc::new(Mutex::new(TinyState {
            stats: routes.iter().map(|r| (r.name.clone(), RouteStats::default())).collect(),
            ..Default::default()
        }));
        let srv = server.clone();
        let thread = std::thread::spawn(move || {
            for req in srv.incoming_requests() {
                let resp = handle(&routes, &state, &req);
                let _ = req.respond(resp);
            }
        });
        TinyFake { server, port, thread: Some(thread) }
    }
}

impl Drop for TinyFake {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

type Resp = tiny_http::Response<std::io::Cursor<Vec<u8>>>;

fn respond(code: u16, body: Vec<u8>, headers: &[(&str, String)]) -> Resp {
    let mut r = tiny_http::Response::from_data(body).with_status_code(code);
    for (k, v) in headers {
        r.add_header(tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap());
    }
    r
}

fn handle(routes: &[Route], state: &Mutex<TinyState>, req: &tiny_http::Request) -> Resp {
    let path = req.url().split('?').next().unwrap_or("").to_owned();
    if path == "/__stats" {
        let st = state.lock().unwrap();
        let mut obj = serde_json::Map::new();
        for (k, s) in &st.stats {
            obj.insert(
                k.clone(),
                serde_json::json!({"200": s.ok, "304": s.not_modified, "404": s.not_found, "503": s.unavailable, "auth": s.auth}),
            );
        }
        return respond(200, serde_json::Value::Object(obj).to_string().into_bytes(), &[]);
    }
    for verb in ["down", "up"] {
        if let Some(name) = path.strip_prefix(&format!("/__{verb}/")) {
            let mut st = state.lock().unwrap();
            if verb == "down" {
                st.down.insert(name.to_owned());
            } else {
                st.down.remove(name);
            }
            return respond(200, b"ok".to_vec(), &[]);
        }
    }
    let header = |name: &str| {
        req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.to_string())
    };
    for r in routes {
        let Some(rel) = path.strip_prefix(&format!("{}/", r.prefix)) else { continue };
        let mut st = state.lock().unwrap();
        let down = st.down.contains(&r.name);
        let stats = st.stats.get_mut(&r.name).unwrap();
        stats.auth = header("Authorization");
        if down {
            stats.unavailable += 1;
            return respond(503, b"down".to_vec(), &[]);
        }
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.contains(&"..") || parts.contains(&"") || !(rel.starts_with("envs/") || rel.starts_with("blobs/")) {
            return respond(404, b"not found".to_vec(), &[]);
        }
        let file = parts.iter().fold(r.dir.clone(), |p, s| p.join(s));
        let Ok(body) = std::fs::read(&file) else {
            stats.not_found += 1;
            return respond(404, b"not found".to_vec(), &[]);
        };
        let etag = format!("\"{}\"", &kyp::sha256_hex(&body)[..32]);
        let manifest = rel.starts_with("envs/");
        let headers = [
            ("ETag", etag.clone()),
            (
                "Cache-Control",
                if manifest {
                    "public, max-age=15, stale-while-revalidate=300, stale-if-error=86400".into()
                } else {
                    "public, max-age=31536000, immutable".into()
                },
            ),
            ("Content-Type", if manifest { "application/json".into() } else { "text/plain; charset=utf-8".into() }),
        ];
        if header("If-None-Match").as_deref() == Some(etag.as_str()) {
            stats.not_modified += 1;
            return respond(304, Vec::new(), &headers);
        }
        stats.ok += 1;
        return respond(200, body, &headers);
    }
    respond(404, b"no route".to_vec(), &[])
}

impl Fake for TinyFake {
    fn kind(&self) -> &'static str {
        "tiny_http"
    }
    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

// ---------------------------------------------------------------------------
// conformance/fake_cdn.py
// ---------------------------------------------------------------------------
pub struct PyFake {
    child: Child,
    port: u16,
}

pub fn python() -> Option<String> {
    for p in ["python3", "python"] {
        let ok = Command::new(p)
            .arg("-c")
            .arg("import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if ok {
            return Some(p.to_owned());
        }
    }
    None
}

impl PyFake {
    pub fn start(py: &str, routes: Vec<Route>) -> Option<PyFake> {
        let mut cmd = Command::new(py);
        cmd.arg(conformance_dir().join("fake_cdn.py"));
        for r in &routes {
            cmd.arg("--route").arg(format!("{}:{}:{}", r.name, r.prefix, r.dir.display()));
        }
        let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().ok()?;
        let mut line = String::new();
        BufReader::new(child.stdout.take()?).read_line(&mut line).ok()?;
        let port = line.trim().strip_prefix("PORT ")?.parse().ok()?;
        Some(PyFake { child, port })
    }
}

impl Drop for PyFake {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Fake for PyFake {
    fn kind(&self) -> &'static str {
        "fake_cdn.py"
    }
    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// Runs `f` against the in-process fake, and against fake_cdn.py when python3 exists.
pub fn with_fakes(routes: impl Fn() -> Vec<Route>, f: impl Fn(&dyn Fake)) {
    let tiny = TinyFake::start(routes());
    f(&tiny);
    drop(tiny);
    match python() {
        Some(py) => {
            let fake = PyFake::start(&py, routes()).expect("fake_cdn.py did not start");
            f(&fake);
        }
        None => eprintln!("python3 not found: skipping the fake_cdn.py run"),
    }
}

pub fn quiet() -> kyp::Builder {
    kyp::Client::builder().app("demo").env("prod").log_level(None).poll_interval(Duration::from_secs(3600))
}

/// A builder pointing the CDN and origin at `fake` (git optional).
pub fn http_builder(fake: &dyn Fake) -> kyp::Builder {
    quiet()
        .delivery_key(KEY)
        .cdn_base(format!("{}/v1/d", fake.base()))
        .origin_base(format!("{}/v1/delivery", fake.base()))
        .startup_timeout(Duration::from_secs(3))
        .max_backoff(Duration::from_millis(1))
}

pub fn eventually(mut f: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    f()
}
