//! The tokio client (feature `tokio`).
#![cfg(feature = "tokio")]

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_client_conformance_subset() {
    let served = Served::new("v12");
    let fake = TinyFake::start(standard_routes(served.path(), served.path(), served.path()));
    let seen: Arc<Mutex<Vec<kyp::Update>>> = Arc::default();
    let s = seen.clone();
    let c = http_builder(&fake).on_update(move |u| s.lock().unwrap().push(u.clone())).build_async().await.unwrap();
    assert_eq!(c.status().source, "cdn");
    assert_eq!(c.prompt("greeting").unwrap().version, 4);

    // Revalidation: 304.
    assert!(c.refresh().await);
    assert_eq!(fake.stats("cdn").not_modified, 1);

    // Hot update, callback once.
    served.deploy("v13");
    assert!(c.refresh().await);
    assert_eq!(c.prompt("greeting").unwrap().version, 5);
    assert_eq!(seen.lock().unwrap().len(), 1);

    // Fallback to origin, then failures never evict.
    fake.down("cdn");
    assert!(c.refresh().await);
    assert_eq!(c.status().source, "origin");
    fake.down("origin");
    assert!(!c.refresh().await);
    assert_eq!(c.render("greeting", &[("name", "A"), ("company", "B")]).unwrap(), "Hi A! B is glad you are here.");
    assert!(c.status().last_error.contains("origin: HTTP 503"));
}

#[tokio::test(flavor = "current_thread")]
async fn async_client_polls_in_background_and_stops_on_drop() {
    let served = Served::new("v12");
    let fake = TinyFake::start(standard_routes(served.path(), served.path(), served.path()));
    let c = http_builder(&fake).poll_interval(Duration::from_millis(100)).build_async().await.unwrap();
    served.deploy("v13");
    let mut ok = false;
    for _ in 0..100 {
        if c.revision() == 13 {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(ok, "background task picked up v13");
    drop(c);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let a = fake.stats("cdn");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let b = fake.stats("cdn");
    assert_eq!(a.ok + a.not_modified, b.ok + b.not_modified);
}

#[tokio::test(flavor = "current_thread")]
async fn async_client_starts_from_snapshot() {
    let c = quiet().snapshot_dir(fixture("v12")).build_async().await.unwrap();
    assert_eq!(c.revision(), 12);
    assert_eq!(c.status().source, "snapshot");
}
