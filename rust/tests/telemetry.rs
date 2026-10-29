//! Prompt metadata and the observer hook (protocol/tracing.md), without OpenTelemetry.
#![cfg(feature = "blocking")]

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use kyp::{AttrValue, Mirror, Observer, PromptMeta, RefreshRecord, RefreshResult, RefreshTrigger, RenderError};

#[derive(Default)]
pub struct Recorder {
    pub refreshes: Mutex<Vec<RefreshRecord>>,
    pub render_errors: Mutex<Vec<RenderError>>,
}

impl Observer for Recorder {
    fn on_refresh(&self, r: &RefreshRecord) {
        self.refreshes.lock().unwrap().push(r.clone());
    }
    fn on_render_error(&self, e: &RenderError) {
        self.render_errors.lock().unwrap().push(e.clone());
    }
}

impl Recorder {
    fn last(&self) -> RefreshRecord {
        self.refreshes.lock().unwrap().last().cloned().unwrap()
    }
    fn count(&self) -> usize {
        self.refreshes.lock().unwrap().len()
    }
}

/// Two folder mirrors: "broken" (a manifest that is not JSON) first, then "snapshot" (v12).
/// Folder-only clients poll their folders, right after start-up: wait for that round.
pub fn setup(obs: Arc<dyn Observer>, rec: &Recorder) -> (tempfile::TempDir, Served, kyp::Client) {
    let broken = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(broken.path().join("envs/demo")).unwrap();
    std::fs::write(broken.path().join("envs/demo/prod.json"), "not json").unwrap();
    let good = Served::new("v12");
    let c = quiet()
        .mirrors(vec![Mirror::file(broken.path(), "broken"), Mirror::file(good.path(), "snapshot")])
        .observer(obs)
        .build()
        .unwrap();
    assert!(eventually(|| rec.count() >= 2), "start-up and first poll rounds");
    (broken, good, c)
}

fn names(r: &RefreshRecord) -> Vec<&'static str> {
    r.events.iter().map(|e| e.name).collect()
}

#[test]
fn meta_and_render_with_meta() {
    let rec = Arc::new(Recorder::default());
    let (_b, _g, c) = setup(rec.clone(), &rec);
    let m = c.meta("greeting").unwrap();
    assert_eq!(
        m,
        PromptMeta {
            name: "greeting".into(),
            version: 4,
            sha256: "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d".into(),
            app: "demo".into(),
            env: "prod".into(),
            workspace: "acme".into(),
            revision: 12,
            source: "snapshot".into(),
        }
    );
    let r = c.render_with_meta("greeting", &[("name", "Ada"), ("company", "Acme")]).unwrap();
    assert_eq!(r.text, c.render("greeting", &[("name", "Ada"), ("company", "Acme")]).unwrap());
    assert_eq!(r.meta, m);
    assert!(matches!(c.meta("nope"), Err(kyp::Error::NotFound { .. })));
}

#[test]
fn attributes_and_metadata_maps() {
    let rec = Arc::new(Recorder::default());
    let (_b, _g, c) = setup(rec.clone(), &rec);
    let m = c.meta("triage").unwrap();
    let keys: Vec<&str> = m.attributes(true).iter().map(|(k, _)| *k).collect();
    assert_eq!(
        keys,
        [
            "kyp.prompt.name",
            "kyp.prompt.version",
            "kyp.prompt.sha256",
            "kyp.app",
            "kyp.env",
            "kyp.revision",
            "kyp.workspace",
            "kyp.source",
            "gen_ai.prompt.name",
            "gen_ai.prompt.version"
        ]
    );
    let a = m.attributes(true);
    assert!(a.contains(&("kyp.prompt.version", AttrValue::Int(7))));
    assert!(a.contains(&("gen_ai.prompt.version", AttrValue::Str("7".into()))));
    assert!(!m.attributes(false).iter().any(|(k, _)| k.starts_with("gen_ai.")));
    let flat: Vec<&str> = m.trace_metadata().iter().map(|(k, _)| *k).collect();
    assert_eq!(
        flat,
        [
            "kyp_prompt_name",
            "kyp_prompt_version",
            "kyp_prompt_sha256",
            "kyp_app",
            "kyp_env",
            "kyp_revision",
            "kyp_workspace",
            "kyp_source"
        ]
    );
    assert_eq!(m.langfuse_metadata(), m.trace_metadata());
    assert_eq!(m.langsmith_metadata(), m.trace_metadata());
    assert_eq!(m.trace_metadata_json()["kyp_revision"], 12);
    let bare = PromptMeta { workspace: String::new(), source: String::new(), ..m };
    assert!(!bare.attributes(true).iter().any(|(k, _)| *k == "kyp.workspace" || *k == "kyp.source"));
}

#[test]
fn start_round_with_fallback_and_update() {
    let rec = Arc::new(Recorder::default());
    let (_b, _g, _c) = setup(rec.clone(), &rec);
    let r = rec.refreshes.lock().unwrap()[0].clone();
    assert_eq!((r.trigger, r.result), (RefreshTrigger::Start, RefreshResult::Updated));
    assert_eq!(
        (r.mirror.as_str(), r.source.as_str(), r.revision, r.previous_revision),
        ("snapshot", "snapshot", 12, 0)
    );
    assert_eq!(r.workspace, "acme");
    assert_eq!(names(&r), ["kyp.fallback", "kyp.update"]);
    let fb = &r.events[0];
    assert_eq!(fb.attr("kyp.mirror"), Some(&AttrValue::Str("broken".into())));
    assert_eq!(fb.attr("kyp.source"), Some(&AttrValue::Str("snapshot".into())));
    assert_eq!(fb.attr("error.type"), Some(&AttrValue::Str("bad_manifest".into())));
    let up = &r.events[1];
    assert_eq!(up.attr("kyp.revision.previous"), Some(&AttrValue::Int(0)));
    assert_eq!(up.attr("kyp.revision"), Some(&AttrValue::Int(12)));
    assert_eq!(up.attr("kyp.prompts.changed"), Some(&AttrValue::Int(4)));
    // The first background poll confirmed it.
    let p = rec.refreshes.lock().unwrap()[1].clone();
    assert_eq!((p.trigger, p.result), (RefreshTrigger::Poll, RefreshResult::NotModified));
}

#[test]
fn update_not_modified_and_hash_mismatch() {
    let rec = Arc::new(Recorder::default());
    let (_b, good, c) = setup(rec.clone(), &rec);
    good.deploy("v13");
    assert!(c.refresh());
    let r = rec.last();
    assert_eq!(
        (r.trigger, r.result, r.previous_revision, r.revision),
        (RefreshTrigger::Manual, RefreshResult::Updated, 12, 13)
    );
    assert_eq!(r.events.last().unwrap().attr("kyp.prompts.changed"), Some(&AttrValue::Int(1)));

    assert!(c.refresh());
    assert_eq!(rec.last().result, RefreshResult::NotModified);

    good.deploy("tampered-v14");
    assert!(!c.refresh());
    let r = rec.last();
    assert_eq!((r.result, r.source.as_str(), r.error_type.as_str()), (RefreshResult::Failed, "", "blob_unavailable"));
    let hm: Vec<_> = r.events.iter().filter(|e| e.name == "kyp.hash_mismatch").collect();
    assert_eq!(hm.len(), 1);
    assert_eq!(hm[0].attr("kyp.mirror"), Some(&AttrValue::Str("snapshot".into())));
    assert_eq!(
        hm[0].attr("kyp.blob.sha256"),
        Some(&AttrValue::Str("fcadfa6b70f5b153be065e4f32dc011328b1aff4749fb3b748bba68a60c0838e".into()))
    );
    assert_eq!(c.revision(), 13);
}

#[test]
fn render_errors_and_observer_isolation() {
    let rec = Arc::new(Recorder::default());
    let (_b, _g, c) = setup(rec.clone(), &rec);
    assert!(matches!(c.render("greeting", &[("name", "Ada")]), Err(kyp::Error::MissingVariable { .. })));
    assert!(matches!(c.render_with_meta("nope", &[("a", "b")]), Err(kyp::Error::NotFound { .. })));
    let got: Vec<(String, &str)> =
        rec.render_errors.lock().unwrap().iter().map(|e| (e.name.clone(), e.error_type)).collect();
    assert_eq!(got, [("greeting".to_owned(), "missing_variable"), ("nope".to_owned(), "not_found")]);

    struct Boom;
    impl Observer for Boom {
        fn on_refresh(&self, _: &RefreshRecord) {
            panic!("boom");
        }
    }
    let id = c.add_observer(Arc::new(Boom));
    assert!(c.refresh());
    assert!(c.remove_observer(id));
    let extra = Arc::new(Recorder::default());
    let id = c.add_observer(extra.clone());
    c.refresh();
    assert!(c.remove_observer(id));
    assert!(!c.remove_observer(id));
    c.refresh();
    assert_eq!(extra.count(), 1);
}
