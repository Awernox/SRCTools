//! Typed application errors.
//!
//! Every error that can reach the UI carries three things the moderator needs:
//! a human-readable message, a machine `kind` so the frontend can react (e.g.
//! send the user to Settings when credentials are missing), and a `retryable`
//! flag that distinguishes *"this will never work"* from *"the network hiccuped"*.
//!
//! That distinction is load-bearing: a transient failure must never be
//! presented as a definitive verdict about a run or a video.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("No Speedrun.com API key is configured. Add one in Settings → Account.")]
    MissingCredentials,

    #[error("Speedrun.com rejected the API key. It may have been revoked or regenerated — check Settings → Account.")]
    Unauthorized,

    #[error("Your account is not permitted to do this. Moderating a run requires moderator rights on that game.")]
    Forbidden,

    #[error("{0}")]
    NotFound(String),

    #[error("Speedrun.com rate limit reached. Waiting {retry_after_secs}s before retrying.")]
    RateLimited { retry_after_secs: u64 },

    #[error("Speedrun.com is unavailable right now (HTTP {status}). This is a problem on their side, not with your data.")]
    ServiceUnavailable { status: u16 },

    #[error("Speedrun.com returned HTTP {status}: {message}")]
    Api { status: u16, message: String },

    #[error("Network request failed: {0}")]
    Network(String),

    #[error("Request timed out after {0}s.")]
    Timeout(u64),

    #[error("Could not understand the response from {source_name}: {detail}")]
    Malformed {
        source_name: String,
        detail: String,
    },

    #[error("{0}")]
    InvalidInput(String),

    #[error("Local database error: {0}")]
    Database(String),

    #[error("Secure credential storage unavailable: {0}")]
    Keyring(String),

    #[error("File error: {0}")]
    Io(String),

    #[error("{0}")]
    Internal(String),
}

impl AppError {
    /// Stable machine-readable discriminant for the frontend.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::MissingCredentials => "missing_credentials",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotFound(_) => "not_found",
            Self::RateLimited { .. } => "rate_limited",
            Self::ServiceUnavailable { .. } => "service_unavailable",
            Self::Api { .. } => "api",
            Self::Network(_) => "network",
            Self::Timeout(_) => "timeout",
            Self::Malformed { .. } => "malformed",
            Self::InvalidInput(_) => "invalid_input",
            Self::Database(_) => "database",
            Self::Keyring(_) => "keyring",
            Self::Io(_) => "io",
            Self::Internal(_) => "internal",
        }
    }

    /// Whether retrying the identical request could plausibly succeed later.
    ///
    /// Consumers use this to decide whether a failure is allowed to influence a
    /// verdict (it is not) or merely to be surfaced as "could not verify".
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::RateLimited { .. }
                | Self::ServiceUnavailable { .. }
                | Self::Network(_)
                | Self::Timeout(_)
        )
    }

    /// Short remediation hint shown under the error message where one exists.
    pub fn hint(&self) -> Option<&'static str> {
        match self {
            Self::MissingCredentials => {
                Some("Find your API key at speedrun.com → Settings → API key.")
            }
            Self::Unauthorized => Some("Re-enter your API key, then run Test connection."),
            Self::Forbidden => {
                Some("Ask a super-moderator of that game to grant you moderator rights.")
            }
            Self::RateLimited { .. } => {
                Some("SRCTools throttles itself automatically; no action needed.")
            }
            Self::ServiceUnavailable { .. } => Some("Try again in a few minutes."),
            Self::Network(_) | Self::Timeout(_) => Some("Check your internet connection."),
            _ => None,
        }
    }
}

/// Serialised shape consumed by the frontend's `AppError` TypeScript type.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 4)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.serialize_field("retryable", &self.retryable())?;
        s.serialize_field("hint", &self.hint())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Database(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::Malformed {
            source_name: "local data".into(),
            detail: e.to_string(),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        Self::Keyring(e.to_string())
    }
}

impl From<url::ParseError> for AppError {
    fn from(e: url::ParseError) -> Self {
        Self::InvalidInput(format!("Malformed URL: {e}"))
    }
}

/// Maps transport-level failures onto our taxonomy.
///
/// Note that a `reqwest` failure is *always* classified as retryable here —
/// connection resets, DNS failures and timeouts say nothing about whether a
/// remote resource exists.
impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            return Self::Timeout(30);
        }
        if e.is_decode() {
            return Self::Malformed {
                source_name: "HTTP response".into(),
                detail: e.to_string(),
            };
        }
        // `reqwest::Error` Display can embed the full request URL, which may
        // carry query parameters. Nothing secret travels in a query string in
        // this app (the API key is a header), but we keep the message terse.
        Self::Network(match e.status() {
            Some(status) => format!("HTTP {status}"),
            None => "connection failed".to_string(),
        })
    }
}
