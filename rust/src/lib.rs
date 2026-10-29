//! # Keep Your Prompts: Rust SDK
//!
//! Read deployed prompts from memory in nanoseconds, keep them fresh in the
//! background, and keep serving when the network does not.
//!
//! ```no_run
//! let prompts = kyp::Client::from_env()?; // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
//! let text = prompts.render("triage", &[("company", "Acme"), ("billing_queue", "refunds")])?;
//! # Ok::<(), kyp::Error>(())
//! ```
//!
//! Implements the prompt delivery protocol v1: interchangeable mirrors with one
//! layout (`envs/<app>/<env>.json` + `blobs/<sha256>`), tried in the order
//! embedded snapshot → snapshot folder → disk cache → CDN → origin → git.
//! Every blob is verified with SHA-256, the manifest is revalidated with
//! `If-None-Match`, and a new revision is swapped in atomically
//! ([`arc_swap`]). Failures never evict what is held.
//!
//! The blocking [`Client`] (feature `blocking`, default) refreshes on a
//! background thread with `ureq`; `AsyncClient` (feature `tokio`) does it in a
//! tokio task with `reqwest`. Both use rustls.
#![warn(missing_docs)]
#![forbid(unsafe_code)]

#[cfg(feature = "tokio")]
mod async_client;
mod client;
mod engine;
mod error;
mod fetch;
mod manifest;
#[cfg(feature = "otel")]
pub mod otel;
mod telemetry;
mod template;

#[cfg(feature = "tokio")]
pub use async_client::AsyncClient;
pub use client::{embed_module_source, pull_snapshot, Builder, Client, SnapshotInfo};
pub use engine::{EmbeddedFiles, LogLevel, Mirror, MirrorStatus, Prompt, Status, Update};
pub use error::{Error, Result};
pub use manifest::{parse_manifest, sha256_hex, Manifest, ManifestPrompt};
pub use telemetry::{
    classify_error, normalize_source, AttrValue, Attributes, MirrorKind, Observer, ObserverId, PromptMeta,
    RefreshRecord, RefreshResult, RefreshTrigger, RenderError, Rendered, TelemetryEvent,
};
pub use template::{render, variables_in, OnMissing, Vars};

/// SDK version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Compiles a snapshot folder into the binary, for [`Builder::embedded`].
///
/// The folder path is relative to the file that invokes the macro; list every
/// file of the layout (the `kyp-snapshot --rust-module` tool writes this call
/// for you).
///
/// ```ignore
/// static PROMPTS: kyp::EmbeddedFiles = kyp::include_snapshot!("../prompts", [
///     "envs/support-bot/prod.json",
///     "blobs/5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d",
/// ]);
/// let client = kyp::Client::builder().app("support-bot").embedded(PROMPTS).build()?;
/// ```
#[macro_export]
macro_rules! include_snapshot {
    ($dir:literal, [$($file:literal),* $(,)?]) => {
        &[$(($file, include_bytes!(concat!($dir, "/", $file)) as &'static [u8])),*] as $crate::EmbeddedFiles
    };
}
