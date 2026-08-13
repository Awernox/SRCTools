//! Frontend-facing data transfer objects.
//!
//! The raw Speedrun.com models are shaped for the API, not for a UI: IDs
//! instead of names, embeds that may or may not be present, times split across
//! four fields. These DTOs resolve all of that once, in Rust, so the frontend
//! never has to guess.
//!
//! Every field that the API might not provide is `Option`. A `None` means
//! "Speedrun.com did not tell us", and the UI renders it as `—` — it never
//! substitutes a plausible default.

use serde::{Deserialize, Serialize};

use crate::analysis::{RunAnalysis, RunnerHistory};
use crate::src_api::models::{Category, Game, Level, Platform, Region, Run, RunPlayer, User, Variable};
use crate::util::{format_duration, sanitize_line, sanitize_text};
use crate::video::VideoCheck;

/// A run as shown in the queue table.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub weblink: Option<String>,
    pub game_id: Option<String>,
    pub game_name: Option<String>,
    pub game_cover_url: Option<String>,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub level_id: Option<String>,
    pub level_name: Option<String>,
    pub players: Vec<RunPlayer>,
    /// Comma-joined player names, for sorting and CSV export.
    pub player_label: String,
    /// Primary time in seconds, as the API reports it.
    pub primary_seconds: Option<f64>,
    /// Pre-formatted `1:23:45.670`, so every view renders it identically.
    pub primary_display: Option<String>,
    /// `new`, `verified` or `rejected`.
    pub status: String,
    pub examiner_id: Option<String>,
    pub rejection_reason: Option<String>,
    /// ISO-8601 timestamp of the verdict — when a moderator verified or rejected
    /// the run. Absent while the run is still pending, and absent on old runs
    /// the API never recorded one for.
    pub verify_date: Option<String>,
    /// Date the run was played (`YYYY-MM-DD`), when set.
    pub date: Option<String>,
    /// ISO-8601 submission timestamp, when set.
    pub submitted: Option<String>,
    pub comment: Option<String>,
    pub video_urls: Vec<String>,
    /// Free-text the runner typed instead of a link.
    pub video_text: Option<String>,
    pub platform_id: Option<String>,
    pub platform_name: Option<String>,
    pub region_id: Option<String>,
    pub region_name: Option<String>,
    pub emulated: Option<bool>,
    /// Variable ID → value ID, as submitted.
    pub variable_values: std::collections::HashMap<String, String>,
    /// Resolved `Variable name: Value label` pairs, when the variables are known.
    pub variable_labels: Vec<LabelledValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelledValue {
    pub variable_id: String,
    pub variable_name: String,
    pub value_id: String,
    pub value_label: Option<String>,
    pub is_subcategory: bool,
}

/// Lookup tables used when flattening a run.
#[derive(Debug, Default)]
pub struct Lookups<'a> {
    pub platforms: Option<&'a [Platform]>,
    pub regions: Option<&'a [Region]>,
    pub variables: Option<&'a [Variable]>,
    pub levels: Option<&'a [Level]>,
}

impl RunSummary {
    /// Flattens an API run, resolving embeds and lookups where available.
    pub fn from_run(run: &Run, lookups: &Lookups<'_>) -> Self {
        let game = run.embedded_game();
        let category = run.embedded_category();
        let level = run.embedded_level();
        let players = run.players();

        let player_label = if players.is_empty() {
            "Unknown".to_string()
        } else {
            players
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        };

        let platform_id = run.system.as_ref().and_then(|s| s.platform.clone());
        let region_id = run.system.as_ref().and_then(|s| s.region.clone());

        let platform_name = platform_id.as_deref().and_then(|id| {
            lookups
                .platforms?
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.name.clone())
        });
        let region_name = region_id.as_deref().and_then(|id| {
            lookups
                .regions?
                .iter()
                .find(|r| r.id == id)
                .map(|r| r.name.clone())
        });

        let level_name = level.as_ref().map(|l| l.name.clone()).or_else(|| {
            let id = run.level_id()?;
            lookups
                .levels?
                .iter()
                .find(|l| l.id == id)
                .map(|l| l.name.clone())
        });

        let variable_labels = lookups
            .variables
            .map(|vars| {
                run.values
                    .iter()
                    .filter_map(|(variable_id, value_id)| {
                        let variable = vars.iter().find(|v| &v.id == variable_id)?;
                        Some(LabelledValue {
                            variable_id: variable_id.clone(),
                            variable_name: variable.name.clone(),
                            value_id: value_id.clone(),
                            value_label: variable.value_label(value_id),
                            is_subcategory: variable.is_subcategory(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let primary_seconds = run.primary_seconds();

        Self {
            id: run.id.clone(),
            weblink: run.weblink.clone(),
            game_id: run.game_id(),
            game_name: game.as_ref().map(|g| g.display_name()),
            game_cover_url: game.as_ref().and_then(|g| g.cover_url()),
            category_id: run.category_id(),
            category_name: category.as_ref().map(|c| c.name.clone()),
            level_id: run.level_id(),
            level_name,
            players,
            player_label,
            primary_seconds,
            primary_display: primary_seconds.map(format_duration),
            status: run.status_str().to_string(),
            examiner_id: run.status.as_ref().and_then(|s| s.examiner.clone()),
            rejection_reason: run
                .status
                .as_ref()
                .and_then(|s| s.reason.as_deref())
                .map(|r| sanitize_text(r, 2000)),
            verify_date: run.status.as_ref().and_then(|s| s.verify_date.clone()),
            date: run.date.clone(),
            submitted: run.submitted.clone(),
            comment: run
                .comment
                .as_deref()
                .map(|c| sanitize_text(c, 4000))
                .filter(|c| !c.is_empty()),
            video_urls: run.video_urls(),
            video_text: run
                .videos
                .as_ref()
                .and_then(|v| v.text.as_deref())
                .map(|t| sanitize_text(t, 1000))
                .filter(|t| !t.is_empty()),
            platform_id,
            platform_name,
            region_id,
            region_name,
            emulated: run.system.as_ref().and_then(|s| s.emulated),
            variable_values: run.values.clone(),
            variable_labels,
        }
    }
}

/// A page of queue results plus the context the table needs to render.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePage {
    pub runs: Vec<RunSummary>,
    /// Runs sharing a video, keyed by run id. A flag, never a decision.
    pub duplicates: std::collections::HashMap<String, Vec<String>>,
    /// True when the API had more results than the requested limit.
    pub truncated: bool,
    pub fetched_at: String,
}

/// Everything the detail panel shows for one run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: RunSummary,
    pub game: Option<GameInfo>,
    pub category: Option<CategoryInfo>,
    pub video_checks: Vec<VideoCheck>,
    pub analysis: RunAnalysis,
    pub runner_history: Option<RunnerHistorySummary>,
    /// Your own earlier action on this run, from the local log.
    pub prior_action: Option<String>,
    /// Top leaderboard entries for context, when they could be fetched.
    pub leaderboard: Option<Vec<LeaderboardEntry>>,
    /// Why the leaderboard is absent, when it is.
    pub leaderboard_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub id: String,
    pub name: String,
    pub abbreviation: Option<String>,
    pub weblink: Option<String>,
    pub cover_url: Option<String>,
    pub release_date: Option<String>,
    pub romhack: Option<bool>,
    pub require_video: Option<bool>,
    pub require_verification: Option<bool>,
    pub emulators_allowed: Option<bool>,
    pub show_milliseconds: Option<bool>,
    pub default_time: Option<String>,
    pub run_times: Vec<String>,
    /// True when the signed-in user moderates this game.
    pub is_moderator: bool,
    pub moderator_role: Option<String>,
}

impl GameInfo {
    pub fn from_game(game: &Game, viewer_id: Option<&str>) -> Self {
        let ruleset = game.ruleset.clone().unwrap_or_default();
        let role = viewer_id.and_then(|id| game.moderator_role(id).map(str::to_string));
        Self {
            id: game.id.clone(),
            name: game.display_name(),
            abbreviation: game.abbreviation.clone(),
            weblink: game.weblink.clone(),
            cover_url: game.cover_url(),
            release_date: game.release_date.clone(),
            romhack: game.romhack,
            require_video: ruleset.require_video,
            require_verification: ruleset.require_verification,
            emulators_allowed: ruleset.emulators_allowed,
            show_milliseconds: ruleset.show_milliseconds,
            default_time: ruleset.default_time,
            run_times: ruleset.run_times,
            is_moderator: role.is_some(),
            moderator_role: role,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInfo {
    pub id: String,
    pub name: String,
    pub weblink: Option<String>,
    /// Category rules as written by the game's moderators. Plain text — the
    /// frontend renders it as text, never as HTML.
    pub rules: Option<String>,
    pub category_type: Option<String>,
    pub miscellaneous: Option<bool>,
    pub player_type: Option<String>,
    pub player_count: Option<u32>,
}

impl CategoryInfo {
    pub fn from_category(category: &Category) -> Self {
        Self {
            id: category.id.clone(),
            name: category.name.clone(),
            weblink: category.weblink.clone(),
            rules: category
                .rules
                .as_deref()
                .map(|r| sanitize_text(r, 20_000))
                .filter(|r| !r.is_empty()),
            category_type: category.category_type.clone(),
            miscellaneous: category.miscellaneous,
            player_type: category.players.as_ref().and_then(|p| p.player_type.clone()),
            player_count: category.players.as_ref().and_then(|p| p.value),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardEntry {
    pub place: u32,
    pub run_id: String,
    pub player_label: String,
    pub seconds: Option<f64>,
    pub display: Option<String>,
    pub weblink: Option<String>,
    pub date: Option<String>,
}

/// The runner's earlier runs, plus the raw numbers the panel charts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerHistorySummary {
    pub user_id: Option<String>,
    pub display_name: String,
    pub weblink: Option<String>,
    pub avatar_url: Option<String>,
    pub country_code: Option<String>,
    pub signup_date: Option<String>,
    #[serde(flatten)]
    pub totals: RunnerHistory,
    /// Earlier runs in this game, newest first.
    pub runs: Vec<RunSummary>,
    /// Improvement of the current run over their previous best, in percent.
    /// `None` when there is no comparable earlier run.
    pub improvement_percent: Option<f64>,
    pub previous_best_display: Option<String>,
    /// Set when the history could not be loaded, so the UI shows "unavailable"
    /// rather than "no history".
    pub error: Option<String>,
}

/// A game in search results or the sidebar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSummary {
    pub id: String,
    pub name: String,
    pub abbreviation: Option<String>,
    pub weblink: Option<String>,
    pub cover_url: Option<String>,
    pub released: Option<i32>,
    pub is_moderator: bool,
}

impl GameSummary {
    pub fn from_game(game: &Game, viewer_id: Option<&str>) -> Self {
        Self {
            id: game.id.clone(),
            name: game.display_name(),
            abbreviation: game.abbreviation.clone(),
            weblink: game.weblink.clone(),
            cover_url: game.cover_url(),
            released: game.released,
            is_moderator: viewer_id
                .map(|id| game.moderator_role(id).is_some())
                .unwrap_or(false),
        }
    }
}

/// The signed-in moderator.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub display_name: String,
    pub weblink: Option<String>,
    pub avatar_url: Option<String>,
    pub country_code: Option<String>,
    pub role: Option<String>,
    pub signup_date: Option<String>,
}

impl Profile {
    pub fn from_user(user: &User) -> Self {
        Self {
            id: user.id.clone(),
            display_name: sanitize_line(&user.display_name(), 100),
            weblink: user.weblink.clone(),
            avatar_url: user.avatar_url(),
            country_code: user.country_code(),
            role: user.role.clone(),
            signup_date: user.signup.clone(),
        }
    }
}

/// Result of one run in a bulk operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkItemResult {
    pub run_id: String,
    pub success: bool,
    /// Present when `success` is false. Already human-readable.
    pub error: Option<String>,
    /// Machine-readable error discriminant, for retry logic.
    pub error_kind: Option<String>,
    pub retryable: bool,
}

/// Summary of a completed bulk operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkResult {
    pub batch_id: String,
    pub operation: String,
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub results: Vec<BulkItemResult>,
    pub started_at: String,
    pub finished_at: String,
}

/// Progress event emitted during a bulk operation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkProgress {
    pub batch_id: String,
    pub operation: String,
    pub completed: usize,
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    /// The run just processed.
    pub current_run_id: String,
    pub current_ok: bool,
    pub current_error: Option<String>,
}

/// Connection test result for the settings page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub connected: bool,
    pub profile: Option<Profile>,
    /// Masked preview of the stored key, e.g. `a1b2••••9f8e`. Never the key.
    pub masked_key: Option<String>,
    pub twitch_configured: bool,
    pub message: String,
    /// Current API budget usage, as `(used, capacity)` in the sliding window.
    pub rate_limit_used: usize,
    pub rate_limit_capacity: usize,
}

/// Aggregated dashboard figures.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    /// Runs awaiting verification across the moderator's games.
    pub pending_count: usize,
    /// True when the count hit the fetch limit and is a floor, not a total.
    pub pending_is_partial: bool,
    pub oldest_pending_days: Option<i64>,
    pub games_moderated: usize,
    pub runs_with_video_problems: usize,
    pub runs_needing_review: usize,
    /// Local activity, from the moderation log.
    pub actions_today: i64,
    pub actions_this_week: i64,
    pub recent_runs: Vec<RunSummary>,
    pub fetched_at: String,
    /// Populated when part of the dashboard could not be loaded. The rest of
    /// the payload is still valid.
    pub warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::src_api::models::{Link, Times, Videos};

    fn bare_run() -> Run {
        Run {
            id: "abc".into(),
            weblink: Some("https://www.speedrun.com/run/abc".into()),
            game: None,
            level: None,
            category: None,
            videos: Some(Videos {
                text: Some("  ".into()),
                links: vec![Link {
                    rel: None,
                    uri: "https://youtu.be/x".into(),
                }],
            }),
            comment: Some("nice run\u{0}".into()),
            status: None,
            players: None,
            date: None,
            submitted: None,
            times: Some(Times {
                primary_t: Some(5025.67),
                ..Default::default()
            }),
            system: None,
            splits: None,
            values: Default::default(),
        }
    }

    #[test]
    fn flattening_formats_the_time_once() {
        let summary = RunSummary::from_run(&bare_run(), &Lookups::default());
        assert_eq!(summary.primary_seconds, Some(5025.67));
        assert_eq!(summary.primary_display.as_deref(), Some("1:23:45.670"));
    }

    #[test]
    fn absent_data_stays_absent() {
        let summary = RunSummary::from_run(&bare_run(), &Lookups::default());
        assert!(summary.game_name.is_none(), "no embed means no invented name");
        assert!(summary.platform_name.is_none());
        assert!(summary.date.is_none());
        assert_eq!(summary.player_label, "Unknown");
    }

    #[test]
    fn text_fields_are_sanitised_and_blank_becomes_none() {
        let summary = RunSummary::from_run(&bare_run(), &Lookups::default());
        assert_eq!(summary.comment.as_deref(), Some("nice run"));
        assert!(summary.video_text.is_none(), "whitespace-only text is dropped");
    }

    #[test]
    fn video_links_survive_flattening() {
        let summary = RunSummary::from_run(&bare_run(), &Lookups::default());
        assert_eq!(summary.video_urls, vec!["https://youtu.be/x".to_string()]);
    }

    #[test]
    fn a_run_without_a_time_has_no_display_string() {
        let mut run = bare_run();
        run.times = None;
        let summary = RunSummary::from_run(&run, &Lookups::default());
        assert!(summary.primary_seconds.is_none());
        assert!(summary.primary_display.is_none());
    }

    #[test]
    fn platform_names_resolve_from_the_lookup_table() {
        let mut run = bare_run();
        run.system = Some(crate::src_api::models::System {
            platform: Some("p1".into()),
            emulated: Some(false),
            region: None,
        });
        let platforms = vec![Platform {
            id: "p1".into(),
            name: "Nintendo 64".into(),
            released: Some(1996),
        }];
        let summary = RunSummary::from_run(
            &run,
            &Lookups {
                platforms: Some(&platforms),
                ..Default::default()
            },
        );
        assert_eq!(summary.platform_name.as_deref(), Some("Nintendo 64"));
    }
}
