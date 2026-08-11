//! The Tauri command surface — everything the frontend can invoke.
//!
//! Split by feature so no single file owns the whole IPC boundary:
//!
//! - [`auth`] — API key, Twitch credentials, profile, connection test.
//! - [`queue`] — the moderation queue and run detail.
//! - [`moderation`] — verify / reject / delete, single and bulk.
//! - [`library`] — games, categories, variables, leaderboards, search.
//! - [`records`] — local history, audit log, statistics, export.
//! - [`prefs`] — settings, templates, favourites, layouts, shortcuts, cache.
//! - [`sound`] — importing and reading a custom notification sound.
//!
//! Three rules hold across every command in this module:
//!
//! 1. **Errors are values.** Every command returns `AppResult<T>`, which
//!    serialises to `{kind, message, retryable, hint}`. The frontend decides how
//!    to present a failure; commands never panic and never `unwrap`.
//! 2. **No secret crosses the boundary.** The API key is read from the OS vault
//!    inside a command and attached to a request header. Nothing returned from
//!    here contains it, not even masked beyond [`crate::secrets::mask`].
//! 3. **A failure is never a verdict.** Where a command reports on external
//!    state — a video, a leaderboard, a runner's history — being unable to
//!    check is a distinct, explicit outcome, never silently folded into a
//!    negative answer.

pub mod auth;
pub mod library;
pub mod moderation;
pub mod prefs;
pub mod queue;
pub mod records;
pub mod sound;

use crate::error::{AppError, AppResult};

/// Rejects blank identifiers before they reach a URL or a SQL statement.
pub(crate) fn require_id(value: &str, what: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(format!("No {what} was provided.")));
    }
    // IDs from Speedrun.com are short alphanumeric strings. Anything with a
    // path separator or control character is a bug or an attack, not an id.
    if trimmed.len() > 100 || trimmed.chars().any(|c| c.is_control() || c == '/' || c == '?') {
        return Err(AppError::InvalidInput(format!(
            "That does not look like a valid {what}."
        )));
    }
    Ok(trimmed.to_string())
}

/// Caps a caller-supplied page size so the UI cannot ask for an unbounded fetch.
pub(crate) fn clamp_limit(limit: Option<usize>, default: usize, max: usize) -> usize {
    limit.unwrap_or(default).clamp(1, max)
}

/// Builds a batch identifier from the current time.
///
/// Only needs to be unique within one database; a millisecond timestamp plus
/// the operation name is enough, and it sorts chronologically in the audit log.
pub(crate) fn batch_id(operation: &str) -> String {
    format!(
        "{}-{}",
        operation,
        crate::util::now_iso8601().replace([':', '.', '-'], "")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_must_be_present_and_plausible() {
        assert!(require_id("  ", "run id").is_err());
        assert!(require_id("../../etc/passwd", "run id").is_err());
        assert!(require_id("y2ge7ldq", "run id").is_ok());
    }

    #[test]
    fn ids_are_trimmed() {
        assert_eq!(require_id(" abc ", "run id").unwrap(), "abc");
    }

    #[test]
    fn limits_are_clamped_in_both_directions() {
        assert_eq!(clamp_limit(None, 50, 200), 50);
        assert_eq!(clamp_limit(Some(0), 50, 200), 1);
        assert_eq!(clamp_limit(Some(10_000), 50, 200), 200);
    }

    #[test]
    fn batch_ids_carry_the_operation() {
        assert!(batch_id("verify").starts_with("verify-"));
    }
}
