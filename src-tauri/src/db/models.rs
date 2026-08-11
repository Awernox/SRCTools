//! Row types shared between the database layer and the Tauri command surface.
//!
//! These are serialised straight to the frontend, so field names are camelCase
//! and every optional column is a real `Option` — the UI renders "—" for absent
//! data rather than inventing a value.

use serde::{Deserialize, Serialize};

/// What a moderator did to a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModerationAction {
    Verify,
    Reject,
    Delete,
}

impl ModerationAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Verify => "verify",
            Self::Reject => "reject",
            Self::Delete => "delete",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "verify" | "verified" | "approve" => Some(Self::Verify),
            "reject" | "rejected" => Some(Self::Reject),
            "delete" | "deleted" => Some(Self::Delete),
            _ => None,
        }
    }

    /// Whether the action cannot be undone from inside the app.
    pub fn is_destructive(&self) -> bool {
        matches!(self, Self::Delete)
    }
}

/// Whether the API call behind a recorded action actually succeeded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionOutcome {
    Success,
    Failed,
}

impl ActionOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failed => "failed",
        }
    }
}

/// One row of the local moderation log.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub run_id: String,
    pub action: ModerationAction,
    pub outcome: ActionOutcome,
    /// Rejection reason as sent to Speedrun.com.
    pub reason: Option<String>,
    /// Why the call failed, when `outcome` is `Failed`.
    pub error_message: Option<String>,
    pub game_id: Option<String>,
    pub game_name: Option<String>,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    /// Comma-joined player names, as resolved at the time of the action.
    pub player_names: Option<String>,
    pub run_time: Option<f64>,
    pub run_weblink: Option<String>,
    /// Groups the rows produced by a single bulk operation.
    pub batch_id: Option<String>,
    pub acted_at: String,
}

/// What to write when recording an action. Separate from [`HistoryEntry`]
/// because the id and timestamp are assigned by the database.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDraft {
    pub run_id: String,
    pub action: Option<ModerationAction>,
    pub outcome: Option<ActionOutcome>,
    pub reason: Option<String>,
    pub error_message: Option<String>,
    pub game_id: Option<String>,
    pub game_name: Option<String>,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub player_names: Option<String>,
    pub run_time: Option<f64>,
    pub run_weblink: Option<String>,
    pub batch_id: Option<String>,
}

/// Summary row for a bulk or destructive operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub batch_id: String,
    pub operation: String,
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub detail: Option<String>,
    pub started_at: String,
    pub finished_at: String,
}

/// What to write when auditing an operation. Separate from [`AuditEntry`]
/// because the id and finish time are assigned by the database — and because
/// three bare `i64` counts in a row are easy to transpose at a call site.
#[derive(Debug, Clone, Default)]
pub struct AuditDraft<'a> {
    pub batch_id: &'a str,
    pub operation: &'a str,
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub detail: Option<&'a str>,
    pub started_at: &'a str,
}

/// A reusable rejection reason.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectionTemplate {
    pub id: String,
    pub label: String,
    pub body: String,
    pub sort_order: i64,
    /// True for the seeded defaults, so the UI can offer "restore defaults".
    pub builtin: bool,
    pub created_at: String,
}

/// A pinned game workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteGame {
    pub game_id: String,
    pub name: String,
    pub abbrev: Option<String>,
    pub cover_url: Option<String>,
    pub sort_order: i64,
    pub added_at: String,
}

/// Aggregate moderator activity over a window, derived from the local log.
///
/// Every number here counts *local* actions only. Speedrun.com exposes no
/// per-moderator statistics endpoint, so the UI labels this "your activity in
/// SRCTools" rather than implying a global figure.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModerationStats {
    pub total_actions: i64,
    pub verified: i64,
    pub rejected: i64,
    pub deleted: i64,
    pub failed: i64,
    /// Distinct runs acted on, which is lower than `total_actions` when a run
    /// was retried after a failure.
    pub distinct_runs: i64,
    pub first_action_at: Option<String>,
    pub last_action_at: Option<String>,
    pub per_day: Vec<DailyCount>,
    pub per_game: Vec<GameCount>,
    /// Rejection reasons, most used first.
    pub top_reasons: Vec<ReasonCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyCount {
    /// `YYYY-MM-DD` in UTC.
    pub day: String,
    pub verified: i64,
    pub rejected: i64,
    pub deleted: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCount {
    pub game_id: Option<String>,
    pub game_name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasonCount {
    pub reason: String,
    pub count: i64,
}

/// Size of the local database, shown on the settings page.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub cache_entries: i64,
    pub expired_entries: i64,
    pub video_checks: i64,
    pub history_entries: i64,
    pub audit_entries: i64,
    /// Bytes on disk, when the file can be measured.
    pub database_bytes: Option<u64>,
    pub database_path: String,
    pub oldest_entry_at: Option<String>,
}

/// Filter for a moderation-history query.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub action: Option<ModerationAction>,
    pub outcome: Option<ActionOutcome>,
    pub game_id: Option<String>,
    pub run_id: Option<String>,
    /// Free-text match against game, category, player and reason.
    pub search: Option<String>,
    /// Inclusive ISO-8601 lower bound.
    pub since: Option<String>,
    /// Inclusive ISO-8601 upper bound.
    pub until: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_round_trip_through_strings() {
        for action in [
            ModerationAction::Verify,
            ModerationAction::Reject,
            ModerationAction::Delete,
        ] {
            assert_eq!(ModerationAction::parse(action.as_str()), Some(action));
        }
    }

    #[test]
    fn action_parsing_accepts_api_synonyms() {
        assert_eq!(ModerationAction::parse("approve"), Some(ModerationAction::Verify));
        assert_eq!(ModerationAction::parse("VERIFIED"), Some(ModerationAction::Verify));
        assert_eq!(ModerationAction::parse("rejected"), Some(ModerationAction::Reject));
        assert_eq!(ModerationAction::parse("nonsense"), None);
    }

    #[test]
    fn only_delete_is_destructive() {
        assert!(ModerationAction::Delete.is_destructive());
        assert!(!ModerationAction::Verify.is_destructive());
        assert!(!ModerationAction::Reject.is_destructive());
    }
}
