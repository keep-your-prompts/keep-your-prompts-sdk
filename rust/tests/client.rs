//! Client features beyond the conformance list.
#![cfg(feature = "blocking")]

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use proptest::prelude::*;

static V12: kyp::EmbeddedFiles = kyp::include_snapshot!(
    "../../conformance/fixtures/v12",
    [
        "envs/demo/prod.json",
        "blobs/5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d",
        "blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "blobs/cd952634e4090147e67501128bd1b92e8a54b749568ada27af25a86a31b70059",
        "blobs/f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf",
    ]
);

#[test]
fn embedded_snapshot_starts_with_zero_files() {
    let c = quiet().embedded(V12).build().unwrap();
    assert_eq!(c.status().source, "embedded");
    assert_eq!(c.revision(), 12);
    assert_eq!(c.prompt("greeting").unwrap().version, 4);
    // A newer snapshot folder wins over the embedded one; ties go to the earlier mirror.
    let c = quiet().embedded(V12).snapshot_dir(fixture("v13")).build().unwrap();
    assert_eq!(c.status().source, "snapshot");
    assert_eq!(c.revision(), 13);
    // Disabled: nothing else configured, so start-up fails.
    assert!(quiet().embedded(V12).embedded_snapshot(false).build().is_err());
    // Inline use (rvalue promotion to 'static).
    let c = quiet()
        .embedded(kyp::include_snapshot!(
            "../../conformance/fixtures/v12",
            [
                "envs/demo/prod.json",
                "blobs/cd952634e4090147e67501128bd1b92e8a54b749568ada27af25a86a31b70059",
                "blobs/5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d",
                "blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                "blobs/f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf",
            ]
        ))
        .build()
        .unwrap();
    assert_eq!(c.revision(), 12);
}

#[test]
fn from_env_reads_kyp_variables() {
    // The only test that touches the process environment.
    std::env::set_var("KYP_APP", "demo");
    std::env::set_var("KYP_ENV", "prod");
    std::env::set_var("KYP_SNAPSHOT_DIR", fixture("v12"));
    std::env::set_var("KYP_POLL_INTERVAL", "0.5");
    std::env::set_var("KYP_LOG", "off");
    let c = kyp::Client::from_env().unwrap();
    assert_eq!(c.revision(), 12);
    assert_eq!(c.status().source, "snapshot");
    for k in ["KYP_APP", "KYP_ENV", "KYP_SNAPSHOT_DIR", "KYP_POLL_INTERVAL", "KYP_LOG"] {
        std::env::remove_var(k);
    }
}

#[test]
fn invalid_options_are_rejected() {
    assert!(matches!(kyp::Client::builder().build(), Err(kyp::Error::Config(_))));
    assert!(matches!(quiet().app("Bad App").build(), Err(kyp::Error::Config(_))));
    assert!(matches!(quiet().env("-x").build(), Err(kyp::Error::Config(_))));
    assert!(matches!(
        quiet().delivery_key("kypd_a/b").snapshot_dir(fixture("v12")).build(),
        Err(kyp::Error::Config(_))
    ));
    assert!(matches!(quiet().build(), Err(kyp::Error::Unavailable(_))));
}

#[test]
fn background_poller_hot_reloads_and_drop_stops_it() {
    let served = Served::new("v12");
    let fake = TinyFake::start(standard_routes(served.path(), served.path(), served.path()));
    let updates = Arc::new(AtomicUsize::new(0));
    let u = updates.clone();
    let c = http_builder(&fake)
        .poll_interval(Duration::from_millis(100))
        .on_update(move |_| {
            u.fetch_add(1, Ordering::SeqCst);
            panic!("a panicking callback must not break the refresher");
        })
        .build()
        .unwrap();
    assert!(eventually(|| fake.stats("cdn").not_modified >= 2), "polls revalidate");
    served.deploy("v13");
    assert!(eventually(|| c.revision() == 13));
    assert!(eventually(|| updates.load(Ordering::SeqCst) == 1));
    drop(c);
    let after = fake.stats("cdn");
    std::thread::sleep(Duration::from_millis(400));
    let later = fake.stats("cdn");
    assert_eq!(after.ok + after.not_modified, later.ok + later.not_modified, "no polls after drop");
}

#[test]
fn startup_timeout_or_start_empty() {
    let served = Served::new("v12");
    let fake = TinyFake::start(standard_routes(served.path(), served.path(), served.path()));
    fake.down("cdn");
    fake.down("origin");
    let start = Instant::now();
    let err = http_builder(&fake).startup_timeout(Duration::from_millis(400)).build().unwrap_err();
    assert!(matches!(err, kyp::Error::Unavailable(_)), "{err}");
    let took = start.elapsed();
    assert!(took >= Duration::from_millis(300) && took < Duration::from_secs(2), "{took:?}");
    assert!(!err.to_string().contains(KEY), "key redacted in errors: {err}");

    let c = http_builder(&fake)
        .startup_timeout(Duration::from_millis(200))
        .start_empty(true)
        .poll_interval(Duration::from_millis(100))
        .build()
        .unwrap();
    assert!(!c.status().ready);
    assert!(c.get("greeting").is_none());
    fake.up("origin");
    assert!(eventually(|| c.get("greeting").is_some()));
    assert_eq!(c.status().source, "origin");
}

#[test]
fn unreachable_host_respects_startup_timeout() {
    let start = Instant::now();
    let r = quiet()
        .delivery_key(KEY)
        .cdn_base("http://127.0.0.1:9/v1/d")
        .origin_base("http://127.0.0.1:9/v1/delivery")
        .startup_timeout(Duration::from_millis(300))
        .build();
    assert!(matches!(r, Err(kyp::Error::Unavailable(_))));
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn tampered_cdn_blob_is_taken_from_the_next_mirror() {
    // The CDN serves v12's manifest with a corrupted greeting blob; the origin is genuine.
    let bad = Served::new("v12");
    let good = Served::new("v12");
    let sha = "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d";
    std::fs::write(bad.path().join("blobs").join(sha), "evil").unwrap();
    let fake = TinyFake::start(standard_routes(bad.path(), good.path(), good.path()));
    let c = http_builder(&fake).build().unwrap();
    assert_eq!(c.status().source, "cdn");
    assert_eq!(&*c.get("greeting").unwrap(), "Hello {{name}}, welcome to {{ company }}.");
}

#[test]
fn file_mirrors_are_polled_without_network() {
    let snap = Served::new("v12");
    let c = quiet().snapshot_dir(snap.path()).build().unwrap();
    snap.deploy("v13");
    assert!(c.refresh());
    assert_eq!(c.revision(), 13);
}

#[test]
fn pull_snapshot_and_embed_module() {
    let served = Served::new("v12");
    let fake = TinyFake::start(standard_routes(served.path(), served.path(), served.path()));
    let out = tempfile::tempdir().unwrap();
    let info = kyp::pull_snapshot(&http_builder(&fake), out.path()).unwrap();
    assert_eq!((info.revision, info.prompt_count, info.blobs_written), (12, 4, 4));
    assert_eq!(info.source, "cdn");
    let offline = quiet().snapshot_dir(out.path()).build().unwrap();
    assert_eq!(offline.revision(), 12);
    let src = kyp::embed_module_source(out.path(), "../prompts").unwrap();
    assert!(src.contains("kyp::include_snapshot!(\"../prompts\""));
    assert!(src.contains("\"envs/demo/prod.json\""));
    assert_eq!(src.matches("\"blobs/").count(), 4);
}

#[test]
fn prompt_metadata_and_render_modes() {
    let c = quiet().snapshot_dir(fixture("v12")).build().unwrap();
    let p = c.prompt("greeting").unwrap();
    assert_eq!(p.variables, ["name", "company"]);
    assert_eq!(p.sha256, kyp::sha256_hex(p.text.as_bytes()));
    assert_eq!(p.render(&[("name", "A"), ("company", "B")]).unwrap(), "Hello A, welcome to B.");
    assert_eq!(
        c.render_with("greeting", &[("name", "A")], kyp::OnMissing::Keep).unwrap(),
        "Hello A, welcome to {{ company }}."
    );
    assert_eq!(c.render_with("greeting", &[("name", "A")], kyp::OnMissing::Empty).unwrap(), "Hello A, welcome to .");
    let mut m = std::collections::HashMap::new();
    m.insert("company".to_string(), "Acme".to_string());
    assert_eq!(c.render("triage", &m).unwrap(), "You are a support agent for Acme. Literal {{braces}} stay.");
    assert!(c.contains("agents/reviewer"));
    assert!(!c.contains("agents"));
}

proptest! {
    // Text without braces renders to itself.
    #[test]
    fn plain_text_is_unchanged(s in "[^{}]*") {
        let none: [(&str, &str); 0] = [];
        prop_assert_eq!(kyp::render(&s, &none, kyp::OnMissing::Error).unwrap(), s);
    }

    // Lenient rendering with no values is the identity, except for {{{{ -> {{.
    #[test]
    fn keep_mode_is_identity_without_quadruple_braces(s in "([a-z ]|\\{\\{|\\}\\}|\\{\\{ ?[a-z_][a-z0-9_]* ?\\}\\})*") {
        prop_assume!(!s.contains("{{{{"));
        let none: [(&str, &str); 0] = [];
        prop_assert_eq!(kyp::render(&s, &none, kyp::OnMissing::Keep).unwrap(), s);
    }

    // Values are inserted verbatim and never rendered again.
    #[test]
    fn values_are_not_rerendered(name in "[a-z_][a-z0-9_]{0,8}", value in "\\PC*") {
        let t = format!("<{{{{ {name} }}}}>");
        prop_assert_eq!(kyp::render(&t, &[(name.as_str(), value.as_str())], kyp::OnMissing::Error).unwrap(), format!("<{value}>"));
    }

    // variables_in finds exactly the names that strict rendering needs.
    #[test]
    fn variables_match_missing(s in "([a-z ]|\\{\\{|\\{\\{ ?[a-z_][a-z0-9_]* ?\\}\\})*") {
        let none: [(&str, &str); 0] = [];
        let vars = kyp::variables_in(&s);
        match kyp::render(&s, &none, kyp::OnMissing::Error) {
            Ok(_) => prop_assert!(vars.is_empty()),
            Err(kyp::Error::MissingVariable { names }) => prop_assert_eq!(names, vars),
            Err(e) => prop_assert!(false, "unexpected {}", e),
        }
    }
}
