use std::fmt;

/// Everything the SDK returns as an error.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Error {
    /// `render`/`prompt` for a name that is not in the deployed manifest.
    NotFound {
        /// The prompt name that was asked for.
        name: String,
    },
    /// `render` was called without a value for one or more `{{variables}}`.
    MissingVariable {
        /// Every missing name, in order of first appearance.
        names: Vec<String>,
    },
    /// No mirror could deliver a manifest during start-up.
    Unavailable(String),
    /// A mirror returned something that does not follow the protocol.
    Protocol(String),
    /// Invalid options (app/env not a slug, bad delivery key, ...).
    Config(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotFound { name } => write!(f, "prompt not found: \"{name}\""),
            Error::MissingVariable { names } => {
                let s = if names.len() == 1 { "" } else { "s" };
                write!(f, "missing template variable{s}: {}", names.join(", "))
            }
            Error::Unavailable(m) => write!(f, "prompts unavailable: {m}"),
            Error::Protocol(m) => write!(f, "protocol error: {m}"),
            Error::Config(m) => write!(f, "invalid configuration: {m}"),
        }
    }
}

impl std::error::Error for Error {}

/// `Result<T, kyp::Error>`.
pub type Result<T, E = Error> = std::result::Result<T, E>;
