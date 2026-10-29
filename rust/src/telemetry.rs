//! Prompt metadata, metadata maps and the observer hook (`protocol/tracing.md`).
//!
//! No dependency on OpenTelemetry: the `otel` feature ([`crate::otel`]) builds on these.

use std::fmt;
use std::time::{Duration, SystemTime};

/// An attribute value: the SDK's attributes are strings or integers.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum AttrValue {
    /// A string.
    Str(String),
    /// An integer.
    Int(i64),
}

impl fmt::Display for AttrValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AttrValue::Str(s) => f.write_str(s),
            AttrValue::Int(i) => write!(f, "{i}"),
        }
    }
}

impl From<&str> for AttrValue {
    fn from(s: &str) -> Self {
        AttrValue::Str(s.to_owned())
    }
}
impl From<String> for AttrValue {
    fn from(s: String) -> Self {
        AttrValue::Str(s)
    }
}
impl From<i64> for AttrValue {
    fn from(i: i64) -> Self {
        AttrValue::Int(i)
    }
}
impl From<AttrValue> for serde_json::Value {
    fn from(v: AttrValue) -> Self {
        match v {
            AttrValue::Str(s) => serde_json::Value::String(s),
            AttrValue::Int(i) => serde_json::Value::from(i),
        }
    }
}

/// Ordered `(key, value)` pairs: span attributes or a flat metadata map.
pub type Attributes = Vec<(&'static str, AttrValue)>;

/// Which deployed body a call used. Read from memory with `meta` / `render_with_meta`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PromptMeta {
    /// Prompt name, e.g. `triage`, `agents/reviewer`.
    pub name: String,
    /// Prompt version from the manifest.
    pub version: i64,
    /// 64 lowercase hex: the body actually used.
    pub sha256: String,
    /// App slug the client is configured with.
    pub app: String,
    /// Environment slug the client is configured with.
    pub env: String,
    /// `workspace` from the manifest.
    pub workspace: String,
    /// Manifest revision held.
    pub revision: i64,
    /// Normalised mirror kind (`embedded`, `snapshot`, `cache`, `cdn`, `origin`, `git`, `custom`);
    /// empty before anything is loaded.
    pub source: String,
}

impl PromptMeta {
    /// Span attributes: `kyp.*` plus `gen_ai.prompt.name` / `gen_ai.prompt.version` (a string)
    /// when `gen_ai` is true. `kyp.workspace` and `kyp.source` are left out when empty. No content.
    pub fn attributes(&self, gen_ai: bool) -> Attributes {
        let mut a: Attributes = vec![
            ("kyp.prompt.name", self.name.as_str().into()),
            ("kyp.prompt.version", self.version.into()),
            ("kyp.prompt.sha256", self.sha256.as_str().into()),
            ("kyp.app", self.app.as_str().into()),
            ("kyp.env", self.env.as_str().into()),
            ("kyp.revision", self.revision.into()),
        ];
        if !self.workspace.is_empty() {
            a.push(("kyp.workspace", self.workspace.as_str().into()));
        }
        if !self.source.is_empty() {
            a.push(("kyp.source", self.source.as_str().into()));
        }
        if gen_ai {
            a.push(("gen_ai.prompt.name", self.name.as_str().into()));
            a.push(("gen_ai.prompt.version", self.version.to_string().into()));
        }
        a
    }

    /// Flat `kyp_*` keys (the attribute names with `.` replaced by `_`) for any tool's
    /// free-form metadata.
    pub fn trace_metadata(&self) -> Attributes {
        self.attributes(false)
            .into_iter()
            .map(|(k, v)| {
                let flat = match k {
                    "kyp.prompt.name" => "kyp_prompt_name",
                    "kyp.prompt.version" => "kyp_prompt_version",
                    "kyp.prompt.sha256" => "kyp_prompt_sha256",
                    "kyp.app" => "kyp_app",
                    "kyp.env" => "kyp_env",
                    "kyp.revision" => "kyp_revision",
                    "kyp.workspace" => "kyp_workspace",
                    _ => "kyp_source",
                };
                (flat, v)
            })
            .collect()
    }

    /// The same map, for the metadata of a Langfuse observation.
    pub fn langfuse_metadata(&self) -> Attributes {
        self.trace_metadata()
    }

    /// The same map, for LangSmith run metadata.
    pub fn langsmith_metadata(&self) -> Attributes {
        self.trace_metadata()
    }

    /// [`trace_metadata`](Self::trace_metadata) as a JSON object, for HTTP APIs that take metadata.
    pub fn trace_metadata_json(&self) -> serde_json::Value {
        serde_json::Value::Object(self.trace_metadata().into_iter().map(|(k, v)| (k.to_owned(), v.into())).collect())
    }
}

/// What `render_with_meta` returns: the rendered text and the metadata of the exact body
/// that was rendered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// The rendered prompt.
    pub text: String,
    /// Which body it came from.
    pub meta: PromptMeta,
}

impl fmt::Display for Rendered {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

/// What started a refresh round (`kyp.refresh.trigger`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefreshTrigger {
    /// Start-up load (local mirrors, then the network).
    Start,
    /// Background poll.
    Poll,
    /// `refresh()`.
    Manual,
}

impl RefreshTrigger {
    /// `start`, `poll` or `manual`.
    pub fn as_str(self) -> &'static str {
        match self {
            RefreshTrigger::Start => "start",
            RefreshTrigger::Poll => "poll",
            RefreshTrigger::Manual => "manual",
        }
    }
}

/// How a refresh round ended (`kyp.refresh.result`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefreshResult {
    /// A new revision was installed.
    Updated,
    /// A mirror confirmed what is held (`304` or the same revision).
    NotModified,
    /// No mirror answered.
    Failed,
}

impl RefreshResult {
    /// `updated`, `not_modified` or `failed`.
    pub fn as_str(self) -> &'static str {
        match self {
            RefreshResult::Updated => "updated",
            RefreshResult::NotModified => "not_modified",
            RefreshResult::Failed => "failed",
        }
    }
}

/// A span event recorded during a refresh round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelemetryEvent {
    /// `kyp.fallback`, `kyp.hash_mismatch` or `kyp.update`.
    pub name: &'static str,
    /// Wall clock.
    pub time: SystemTime,
    /// Event attributes (see `protocol/tracing.md`).
    pub attributes: Attributes,
}

impl TelemetryEvent {
    /// The value of attribute `key`, if present.
    pub fn attr(&self, key: &str) -> Option<&AttrValue> {
        self.attributes.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }
}

/// One refresh round, passed to [`Observer::on_refresh`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshRecord {
    /// App slug.
    pub app: String,
    /// Environment slug.
    pub env: String,
    /// What started the round.
    pub trigger: RefreshTrigger,
    /// How it ended.
    pub result: RefreshResult,
    /// Wall clock at the start.
    pub start_time: SystemTime,
    /// How long it took.
    pub duration: Duration,
    /// Configured name of the mirror that answered (empty when failed).
    pub mirror: String,
    /// Its normalised kind (empty when failed).
    pub source: String,
    /// Revision held after the round (0 when nothing).
    pub revision: i64,
    /// Revision held before the round (0 when nothing).
    pub previous_revision: i64,
    /// Workspace of the state held (empty when nothing).
    pub workspace: String,
    /// When failed: a short message, delivery key redacted.
    pub error: String,
    /// When failed: the low-cardinality `error.type`.
    pub error_type: String,
    /// Span events, in order.
    pub events: Vec<TelemetryEvent>,
}

/// A failed `render` / `render_with_meta`, passed to [`Observer::on_render_error`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderError {
    /// App slug.
    pub app: String,
    /// Environment slug.
    pub env: String,
    /// The prompt name asked for.
    pub name: String,
    /// `not_found` or `missing_variable`.
    pub error_type: &'static str,
}

/// Receives delivery telemetry. Both methods default to doing nothing. Called outside the
/// client's locks; a panic is caught and logged.
pub trait Observer: Send + Sync {
    /// After each refresh round.
    fn on_refresh(&self, _record: &RefreshRecord) {}
    /// When `render` or `render_with_meta` fails.
    fn on_render_error(&self, _error: &RenderError) {}
}

/// Identifies an observer added with `add_observer`, to remove it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ObserverId(pub(crate) u64);

/// How a mirror is read, for [`normalize_source`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorKind {
    /// Compiled into the binary.
    Embedded,
    /// A folder.
    File,
    /// The SDK's disk cache.
    Cache,
    /// HTTP(S).
    Http,
}

/// A mirror's configured name and kind to `kyp.source`.
pub fn normalize_source(name: &str, kind: MirrorKind) -> &'static str {
    match name {
        "" => "",
        "disk-cache" | "cache" => "cache",
        "embedded" => "embedded",
        "snapshot" => "snapshot",
        "cdn" => "cdn",
        "origin" => "origin",
        "git" => "git",
        _ => match kind {
            MirrorKind::Embedded => "embedded",
            MirrorKind::Cache => "cache",
            MirrorKind::File => "snapshot",
            MirrorKind::Http => "custom",
        },
    }
}

/// A failure message to a low-cardinality `error.type`.
pub fn classify_error(message: &str) -> String {
    let m = message.to_ascii_lowercase();
    let http_status = |m: &str| -> Option<String> {
        let i = m.find("http ")?;
        let code: String = m[i + 5..].chars().take_while(|c| c.is_ascii_digit()).collect();
        (code.len() == 3).then_some(code)
    };
    if m.contains("blob ") && m.contains(" unavailable") {
        return "blob_unavailable".into();
    }
    if m.contains("sha256 verification") || m.contains("hash mismatch") {
        return "hash_mismatch".into();
    }
    if m.contains("stale manifest") {
        return "stale".into();
    }
    if m.contains("bad manifest") || m.contains("invalid manifest") {
        return "bad_manifest".into();
    }
    let status = http_status(&m);
    if matches!(status.as_deref(), Some("404" | "410"))
        || m.contains("not found")
        || m.contains("no such file")
        || m.contains("not embedded")
    {
        return "not_found".into();
    }
    if let Some(code) = status {
        return format!("http_{code}");
    }
    if m.contains("timed out") || m.contains("timeout") || m.contains("deadline") {
        return "timeout".into();
    }
    if ["connect", "refused", "reset", "dns", "resolve", "unreachable", "network", "socket", "tls", "io error"]
        .iter()
        .any(|w| m.contains(w))
    {
        return "network".into();
    }
    "_OTHER".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize() {
        assert_eq!(normalize_source("disk-cache", MirrorKind::Cache), "cache");
        assert_eq!(normalize_source("cdn", MirrorKind::Http), "cdn");
        assert_eq!(normalize_source("eu", MirrorKind::Http), "custom");
        assert_eq!(normalize_source("local", MirrorKind::File), "snapshot");
        assert_eq!(normalize_source("x", MirrorKind::Embedded), "embedded");
        assert_eq!(normalize_source("", MirrorKind::Http), "");
    }

    #[test]
    fn classify() {
        let cases = [
            ("HTTP 503", "http_503"),
            ("manifest not found (HTTP 404)", "not_found"),
            ("manifest not found (no such file)", "not_found"),
            ("timed out reading response", "timeout"),
            ("Connection Failed: Connect error: Connection refused (os error 111)", "network"),
            ("stale manifest ignored (revision 11 < held 12)", "stale"),
            ("bad manifest: expected value", "bad_manifest"),
            (
                "blob 5d3d1a279222 unavailable (snapshot: blob 5d3d1a279222 failed sha256 verification)",
                "blob_unavailable",
            ),
            ("weird", "_OTHER"),
        ];
        for (msg, want) in cases {
            assert_eq!(classify_error(msg), want, "{msg}");
        }
    }
}
