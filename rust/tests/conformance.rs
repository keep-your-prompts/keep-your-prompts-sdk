//! The 12 required behaviours of conformance/README.md, with the shared fixtures.
//! Network behaviours run against the in-process fake and against
//! conformance/fake_cdn.py when python3 is installed.
#![cfg(feature = "blocking")]

mod common;

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use kyp::{Error, OnMissing};
use serde_json::Value;

fn cases() -> Value {
    let text = std::fs::read_to_string(conformance_dir().join("cases.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn vars_of(v: &Value) -> HashMap<String, String> {
    v.as_object()
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect())
        .unwrap_or_default()
}

// 1. Render
#[test]
fn b01_render_cases() {
    let cases = cases();
    let list = cases["render"].as_array().unwrap();
    assert!(!list.is_empty());
    for c in list {
        let tmpl = c["template"].as_str().unwrap();
        let vars = vars_of(&c["vars"]);
        let mode = if c["lenient"].as_bool().unwrap_or(false) { OnMissing::Keep } else { OnMissing::Error };
        let got = kyp::render(tmpl, &vars, mode);
        if let Some(out) = c.get("out") {
            assert_eq!(got.as_deref().ok(), out.as_str(), "case {c}");
        } else {
            assert_eq!(c["error"], "missing_variable");
            match got {
                Err(Error::MissingVariable { names }) => assert_eq!(names, vec![c["variable"].as_str().unwrap()]),
                other => panic!("case {c}: expected MissingVariable, got {other:?}"),
            }
        }
    }
}

// 2. Variables
#[test]
fn b02_variables_cases() {
    for c in cases()["variables"].as_array().unwrap() {
        let want: Vec<&str> = c["out"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(kyp::variables_in(c["template"].as_str().unwrap()), want);
    }
}

// 3. Manifest
#[test]
fn b03_manifest_cases() {
    for c in cases()["manifest"].as_array().unwrap() {
        let bytes = match c.get("file") {
            Some(f) => std::fs::read(conformance_dir().join(f.as_str().unwrap())).unwrap(),
            None => serde_json::to_vec(&c["json"]).unwrap(),
        };
        let parsed = kyp::parse_manifest(&bytes, "demo", "prod");
        let valid = c["valid"].as_bool().unwrap();
        assert_eq!(parsed.is_ok(), valid, "case {c}: {parsed:?}");
        if let Ok(m) = parsed {
            if let Some(names) = c.get("prompts") {
                let want: Vec<&str> = names.as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
                assert_eq!(m.prompts.keys().map(String::as_str).collect::<Vec<_>>(), want);
            }
            for p in m.prompts.values() {
                assert!(p.sha256.len() == 64);
            }
            if c.get("json").is_some() {
                assert!(m.prompts["p"].variables.is_empty(), "variables default to []");
            }
        }
    }
    // Wrong app/env is rejected.
    let v12 = std::fs::read(fixture("v12").join("envs/demo/prod.json")).unwrap();
    assert!(kyp::parse_manifest(&v12, "demo", "staging").is_err());
}

// 4. Hash check
#[test]
fn b04_hash_check() {
    for c in cases()["sha256"].as_array().unwrap() {
        assert_eq!(kyp::sha256_hex(c["in"].as_str().unwrap().as_bytes()), c["out"].as_str().unwrap());
    }
    // A snapshot mirror holding only tampered-v14 is refused outright.
    let err =
        quiet().snapshot_dir(fixture("tampered-v14")).startup_timeout(Duration::from_millis(200)).build().unwrap_err();
    assert!(matches!(err, Error::Unavailable(_)), "{err}");

    // A client holding v12 refuses the tampered revision 14 served by the CDN.
    with_fakes(
        || vec![route("cdn", &format!("/v1/d/{KEY}"), &fixture("tampered-v14"))],
        |fake| {
            let c = http_builder(fake).snapshot_dir(fixture("v12")).build().unwrap();
            assert!(!c.refresh(), "{}", fake.kind());
            assert_eq!(c.revision(), 12);
            assert_eq!(c.prompt("greeting").unwrap().version, 4);
            assert!(c.status().last_error.contains("failed sha256 verification"), "{}", c.status().last_error);
        },
    );
}

// 5. Start from local
#[test]
fn b05_start_from_local_without_network() {
    let start = Instant::now();
    let c = quiet()
        .snapshot_dir(fixture("v12"))
        .delivery_key(KEY)
        .cdn_base("http://127.0.0.1:9/v1/d") // nothing listens: no network
        .origin_base("http://127.0.0.1:9/v1/delivery")
        .build()
        .unwrap();
    assert!(start.elapsed() < Duration::from_millis(500), "{:?}", start.elapsed());
    let p = c.prompt("greeting").unwrap();
    assert_eq!(p.version, 4);
    assert_eq!(&*c.get("greeting").unwrap(), "Hello {{name}}, welcome to {{ company }}.");
    assert_eq!(c.render("greeting", &[("name", "Ana"), ("company", "Acme")]).unwrap(), "Hello Ana, welcome to Acme.");
    assert_eq!(
        c.render("triage", &[("company", "Acme")]).unwrap(),
        "You are a support agent for Acme. Literal {{braces}} stay."
    );
    assert_eq!(&*c.get("agents/reviewer").unwrap(), "Review the diff.");
    assert_eq!(&*c.get("empty").unwrap(), "");
    assert_eq!(c.status().source, "snapshot");
    assert_eq!(c.names(), ["agents/reviewer", "empty", "greeting", "triage"]);
    assert!(matches!(c.render("nope", &[("a", "b")]), Err(Error::NotFound { .. })));
    assert!(matches!(c.render("greeting", &[("name", "x")]), Err(Error::MissingVariable { .. })));
}

// 6. Mirror order and fallback
#[test]
fn b06_mirror_order_and_fallback() {
    let served = Served::new("v12");
    with_fakes(
        || standard_routes(served.path(), served.path(), served.path()),
        |fake| {
            let git = format!("{}/acme/prompts/main/.kyp", fake.base());
            let builder = || http_builder(fake).git_mirror(&git, "github_pat_test");

            // CDN first.
            let c = builder().build().unwrap();
            assert_eq!(c.status().source, "cdn", "{}", fake.kind());
            assert!(fake.stats("cdn").ok >= 1);
            assert_eq!(fake.stats("origin").ok, 0);
            assert_eq!(fake.stats("git").ok, 0);
            assert_eq!(
                c.status().mirrors.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
                ["cdn", "origin", "git"]
            );
            for m in c.status().mirrors {
                assert!(!m.url.contains(KEY), "delivery key must be redacted: {}", m.url);
            }
            assert!(fake.stats("cdn").auth.is_none());
            drop(c);

            // CDN down: the origin serves.
            fake.down("cdn");
            let c = builder().build().unwrap();
            assert_eq!(c.status().source, "origin");
            assert_eq!(c.prompt("greeting").unwrap().version, 4);
            assert!(c.status().last_error.contains("cdn: HTTP 503"), "{}", c.status().last_error);
            drop(c);

            // Both down: git, with the bearer token.
            fake.down("origin");
            let c = builder().build().unwrap();
            assert_eq!(c.status().source, "git");
            assert_eq!(c.prompt("greeting").unwrap().version, 4);
            assert_eq!(fake.stats("git").auth.as_deref(), Some("Bearer github_pat_test"));
            drop(c);

            // Recovery: the CDN is preferred again.
            fake.up("cdn");
            fake.up("origin");
            let c = builder().build().unwrap();
            assert_eq!(c.status().source, "cdn");
        },
    );
}

// 7. Revalidation
#[test]
fn b07_revalidation_with_etag() {
    let served = Served::new("v12");
    with_fakes(
        || standard_routes(served.path(), served.path(), served.path()),
        |fake| {
            let updates = Arc::new(AtomicUsize::new(0));
            let u = updates.clone();
            let c = http_builder(fake)
                .on_update(move |_| {
                    u.fetch_add(1, Ordering::SeqCst);
                })
                .build()
                .unwrap();
            let before = fake.stats("cdn");
            assert_eq!(before.not_modified, 0);
            assert!(c.refresh());
            let after = fake.stats("cdn");
            assert_eq!(after.not_modified, 1, "{}: second poll must send If-None-Match", fake.kind());
            assert_eq!(after.ok, before.ok, "a 304 fetches nothing");
            assert_eq!(c.revision(), 12);
            assert_eq!(updates.load(Ordering::SeqCst), 0);
            assert!(c.status().last_success.is_some());
            assert!(c.status().last_error.is_empty());
        },
    );
}

// 8. Hot update
#[test]
fn b08_hot_update_fires_callback_once() {
    let run = |fake: &dyn Fake, served: &Served| {
        let seen: Arc<Mutex<Vec<kyp::Update>>> = Arc::default();
        let s = seen.clone();
        let c = http_builder(fake).on_update(move |u| s.lock().unwrap().push(u.clone())).build().unwrap();
        assert_eq!(c.prompt("greeting").unwrap().version, 4);
        served.deploy("v13");
        assert!(c.refresh());
        assert_eq!(c.revision(), 13);
        assert_eq!(c.prompt("greeting").unwrap().version, 5);
        assert_eq!(&*c.get("greeting").unwrap(), "Hi {{name}}! {{company}} is glad you are here.");
        assert!(c.refresh()); // a 304 afterwards fires nothing
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "{}: {seen:?}", fake.kind());
        assert_eq!(seen[0].old_revision, 12);
        assert_eq!(seen[0].new_revision, 13);
        assert_eq!(seen[0].changed, ["greeting"]);
        assert_eq!(seen[0].source, "cdn");
    };
    let served = Served::new("v12");
    let tiny = TinyFake::start(standard_routes(served.path(), served.path(), served.path()));
    run(&tiny, &served);
    if let Some(py) = python() {
        let served = Served::new("v12");
        let fake = PyFake::start(&py, standard_routes(served.path(), served.path(), served.path())).unwrap();
        run(&fake, &served);
    }
}

// 9. Stale mirror
#[test]
fn b09_stale_mirror_never_replaces_newer() {
    with_fakes(
        || vec![route("cdn", &format!("/v1/d/{KEY}"), &fixture("v11-stale"))],
        |fake| {
            let c = http_builder(fake).snapshot_dir(fixture("v12")).build().unwrap();
            assert!(!c.refresh());
            assert_eq!(c.revision(), 12);
            assert_eq!(c.prompt("greeting").unwrap().version, 4);
            assert!(c.status().last_error.contains("stale manifest ignored"), "{}", c.status().last_error);
        },
    );
    // Locally too: the highest revision among local mirrors wins.
    let c = quiet()
        .mirrors(vec![kyp::Mirror::file(fixture("v11-stale"), "old"), kyp::Mirror::file(fixture("v12"), "new")])
        .build()
        .unwrap();
    assert_eq!(c.revision(), 12);
    assert_eq!(c.status().source, "new");
}

// 10. Failures never evict
#[test]
fn b10_failures_never_evict() {
    let served = Served::new("v12");
    with_fakes(
        || standard_routes(served.path(), served.path(), served.path()),
        |fake| {
            let c = http_builder(fake).build().unwrap();
            let confirmed = c.status().last_success.expect("confirmed at start-up");
            fake.down("cdn");
            fake.down("origin");
            std::thread::sleep(Duration::from_millis(30));
            assert!(!c.refresh());
            assert_eq!(&*c.get("greeting").unwrap(), "Hello {{name}}, welcome to {{ company }}.");
            let st = c.status();
            assert!(st.ready);
            assert_eq!(st.revision, 12);
            assert!(st.last_error.contains("cdn: HTTP 503"), "{}", st.last_error);
            assert!(st.last_error.contains("origin: HTTP 503"), "{}", st.last_error);
            assert_eq!(st.last_success, Some(confirmed));
            assert!(st.stale_for >= Duration::from_millis(30), "{:?}", st.stale_for);
            assert!(st.mirrors[0].consecutive_failures >= 1);
            fake.up("cdn");
            fake.up("origin");
        },
    );
}

// 11. Disk cache
#[test]
fn b11_disk_cache_restart_without_network() {
    let served = Served::new("v12");
    with_fakes(
        || standard_routes(served.path(), served.path(), served.path()),
        |fake| {
            let cache = tempfile::tempdir().unwrap();
            let c = http_builder(fake).cache_dir(cache.path()).build().unwrap();
            assert_eq!(c.status().source, "cdn");
            drop(c);
            let cached = cache.path().join("acme/demo/prod/envs/demo/prod.json");
            assert!(cached.exists(), "{}", cached.display());

            // Only the cache directory, no network mirror at all.
            let start = Instant::now();
            let c2 = quiet().cache_dir(cache.path()).build().unwrap();
            assert!(start.elapsed() < Duration::from_millis(500));
            assert_eq!(c2.status().source, "disk-cache");
            assert_eq!(c2.prompt("greeting").unwrap().version, 4);

            // And with every network mirror down.
            fake.down("cdn");
            fake.down("origin");
            let c3 = http_builder(fake).cache_dir(cache.path()).build().unwrap();
            assert_eq!(c3.status().source, "disk-cache");
            assert_eq!(c3.revision(), 12);
            fake.up("cdn");
            fake.up("origin");
        },
    );
}

// 12. Read path
#[test]
fn b12_read_path_no_io_and_thread_safe() {
    // No I/O: the snapshot folder can disappear after start-up.
    let snap = Served::new("v12");
    let c = quiet().snapshot_dir(snap.path()).build().unwrap();
    drop(snap);
    assert_eq!(c.prompt("greeting").unwrap().version, 4);

    // Many threads read while the state is swapped back and forth.
    let served = Served::new("v12");
    let fake = TinyFake::start(standard_routes(served.path(), served.path(), served.path()));
    let c = http_builder(&fake).build().unwrap();
    let stop = std::sync::atomic::AtomicBool::new(false);
    let reads = AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..8 {
            s.spawn(|| {
                while !stop.load(Ordering::Relaxed) {
                    let g = c.get("greeting").expect("never evicted");
                    assert!(g.starts_with("Hello") || g.starts_with("Hi"));
                    assert!(c.render("triage", &[("company", "A")]).is_ok());
                    reads.fetch_add(1, Ordering::Relaxed);
                }
            });
        }
        // Each deploy is a higher revision: rewrite v13 as 14, 15, ... to keep swapping.
        let manifest13 = std::fs::read_to_string(fixture("v13").join("envs/demo/prod.json")).unwrap();
        let manifest12 = std::fs::read_to_string(fixture("v12").join("envs/demo/prod.json")).unwrap();
        served.deploy("v13");
        for rev in 13..33 {
            let body = if rev % 2 == 0 { &manifest12 } else { &manifest13 };
            let body = body
                .replace("\"revision\": 12", &format!("\"revision\": {rev}"))
                .replace("\"revision\": 13", &format!("\"revision\": {rev}"));
            let tmp = served.path().join("envs/demo/prod.json.new");
            std::fs::write(&tmp, body).unwrap();
            std::fs::rename(&tmp, served.path().join("envs/demo/prod.json")).unwrap();
            assert!(c.refresh());
            assert_eq!(c.revision(), rev);
        }
        stop.store(true, Ordering::Relaxed);
    });
    assert!(reads.load(Ordering::Relaxed) > 1000);
}

/// Timing (not a pass/fail benchmark): ns per get() and render() from memory.
#[test]
fn timing_get_and_render() {
    let c = quiet().snapshot_dir(fixture("v12")).build().unwrap();
    let n = 200_000u32;
    let t = Instant::now();
    for _ in 0..n {
        std::hint::black_box(c.get(std::hint::black_box("greeting")));
    }
    let get_ns = t.elapsed().as_nanos() as f64 / f64::from(n);
    let t = Instant::now();
    for _ in 0..n {
        std::hint::black_box(c.render("greeting", &[("name", "Ana"), ("company", "Acme")]).unwrap());
    }
    let render_ns = t.elapsed().as_nanos() as f64 / f64::from(n);
    eprintln!("timing: get {get_ns:.1} ns/op, render {render_ns:.1} ns/op");
    assert!(get_ns < 50_000.0);
}
