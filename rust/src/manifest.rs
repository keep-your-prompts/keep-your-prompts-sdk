//! Manifest parsing: `envs/<app>/<env>.json`.

use std::collections::BTreeMap;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// Lowercase hex SHA-256 of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push(char::from(b"0123456789abcdef"[(b >> 4) as usize]));
        s.push(char::from(b"0123456789abcdef"[(b & 15) as usize]));
    }
    s
}

/// One entry of a manifest's `prompts` object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestPrompt {
    /// Lowercase hex SHA-256 of the body.
    pub sha256: String,
    /// The prompt's version number (0 when absent).
    pub version: i64,
    /// Declared variables (`[]` when absent).
    pub variables: Vec<String>,
}

/// A parsed, validated manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    /// Workspace slug.
    pub workspace: String,
    /// App slug.
    pub app: String,
    /// Environment slug.
    pub env: String,
    /// Increases by one on every deploy or rollback.
    pub revision: i64,
    /// RFC 3339 timestamp of the deploy (may be empty).
    pub deployed_at: String,
    /// Prompts by name, sorted.
    pub prompts: BTreeMap<String, ManifestPrompt>,
}

/// `[a-z0-9][a-z0-9-]{0,62}`.
pub(crate) fn is_slug(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b.iter().enumerate().all(|(i, &c)| c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && c == b'-'))
}

pub(crate) fn is_workspace_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s != "."
        && s != ".."
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c == b'.')
}

pub(crate) fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn perr(m: impl Into<String>) -> Error {
    Error::Protocol(m.into())
}

/// Parses and validates a manifest for `app`/`env`. Unknown fields are ignored.
pub fn parse_manifest(text: &[u8], app: &str, env: &str) -> Result<Manifest> {
    let j: Value = serde_json::from_slice(text).map_err(|_| perr("manifest is not valid JSON"))?;
    let o = j.as_object().ok_or_else(|| perr("manifest is not a JSON object"))?;
    if let Some(s) = o.get("schema") {
        if s.as_i64() != Some(1) {
            return Err(perr("unsupported manifest schema (this SDK reads schema 1)"));
        }
    }
    let string = |k: &str, required: bool| -> Result<String> {
        match o.get(k) {
            None | Some(Value::Null) if required => Err(perr(format!("manifest is missing \"{k}\""))),
            None | Some(Value::Null) => Ok(String::new()),
            Some(Value::String(s)) => Ok(s.clone()),
            Some(_) => Err(perr(format!("manifest \"{k}\" must be a string"))),
        }
    };
    let workspace = string("workspace", true)?;
    let m_app = string("app", true)?;
    let m_env = string("env", true)?;
    let deployed_at = string("deployed_at", false)?;
    if !is_workspace_slug(&workspace) {
        return Err(perr("manifest workspace is not a valid slug"));
    }
    if m_app != app || m_env != env {
        return Err(perr(format!("manifest is for {m_app}/{m_env}, expected {app}/{env}")));
    }
    let revision = o
        .get("revision")
        .and_then(Value::as_i64)
        .filter(|r| *r >= 0)
        .ok_or_else(|| perr("manifest \"revision\" must be a non-negative integer"))?;
    let prompts_json =
        o.get("prompts").and_then(Value::as_object).ok_or_else(|| perr("manifest \"prompts\" must be an object"))?;
    let mut prompts = BTreeMap::new();
    for (name, p) in prompts_json {
        if name.is_empty() || name.starts_with('/') || name.ends_with('/') || name.contains("//") {
            return Err(perr(format!("invalid prompt name \"{name}\"")));
        }
        let p = p.as_object().ok_or_else(|| perr(format!("prompt \"{name}\" must be an object")))?;
        let sha = p
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| perr(format!("prompt \"{name}\" has no sha256")))?
            .to_ascii_lowercase();
        if !is_sha256_hex(&sha) {
            return Err(perr(format!("prompt \"{name}\" has an invalid sha256")));
        }
        let version = p.get("version").and_then(Value::as_i64).unwrap_or(0);
        let variables = p
            .get("variables")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        prompts.insert(name.clone(), ManifestPrompt { sha256: sha, version, variables });
    }
    Ok(Manifest { workspace, app: m_app, env: m_env, revision, deployed_at, prompts })
}
