//! The moderation queue and the run detail panel.
//!
//! The queue is the screen a moderator lives in, so it is built to answer three
//! questions at a glance: what is waiting, what looks wrong, and what cannot be
//! checked. The third is never collapsed into the second.

use std::collections::{HashMap, HashSet};

use tauri::State;

use crate::analysis::{self, AnalysisContext, RunnerHistory};
use crate::commands::{clamp_limit, require_id};
use crate::dto::{
    DashboardSummary, GameInfo, Lookups, QueuePage, RunDetail, RunSummary, RunnerHistorySummary,
};
use crate::error::{AppError, AppResult};
use crate::src_api::endpoints::{self, RunOrder, RunQuery, RunStatusFilter};
use crate::src_api::models::Run;
use crate::state::AppState;
use crate::util::{format_duration, improvement_percent, now_iso8601};
use crate::video::{self, VideoCheck, VideoStatus};

/// Hard ceiling on one queue fetch. 200 is the API's own page maximum; ten
/// pages is already an unusually deep backlog and keeps a refresh bounded.
const MAX_QUEUE: usize = 2000;

/// Filter and sort options sent by the queue view.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueFilter {
    pub game_id: Option<String>,
    pub category_id: Option<String>,
    pub level_id: Option<String>,
    pub user_id: Option<String>,
    pub platform_id: Option<String>,
    pub region_id: Option<String>,
    pub emulated: Option<bool>,
    /// `new` (default), `verified` or `rejected`.
    pub status: Option<String>,
    /// `submitted` (default), `date`, `verify-date`, `game`, `category`.
    pub order_by: Option<String>,
    pub ascending: Option<bool>,
    pub limit: Option<usize>,
    /// Restrict to the games the signed-in user moderates. Ignored when
    /// `game_id` is set, since that is already a narrower filter.
    pub only_my_games: Option<bool>,
}

fn order_from(raw: Option<&str>) -> RunOrder {
    match raw.unwrap_or("submitted") {
        "date" => RunOrder::Date,
        "verify-date" => RunOrder::VerifyDate,
        "game" => RunOrder::Game,
        "category" => RunOrder::Category,
        "status" => RunOrder::Status,
        _ => RunOrder::Submitted,
    }
}

/// Fetches the moderation queue.
///
/// With `only_my_games` the fetch is issued per moderated game, because the API
/// has no "all games I moderate" run filter. Failures on individual games are
/// tolerated: one unavailable game must not blank the whole queue.
#[tauri::command]
pub async fn get_queue(state: State<'_, AppState>, filter: QueueFilter) -> AppResult<QueuePage> {
    let limit = clamp_limit(filter.limit, 200, MAX_QUEUE);
    let status = RunStatusFilter::parse(filter.status.as_deref().unwrap_or("new"))?;

    let base = RunQuery {
        category: filter.category_id.clone(),
        level: filter.level_id.clone(),
        user: filter.user_id.clone(),
        platform: filter.platform_id.clone(),
        region: filter.region_id.clone(),
        emulated: filter.emulated,
        status: Some(status),
        order_by: Some(order_from(filter.order_by.as_deref())),
        ascending: filter.ascending.unwrap_or(false),
        embed: true,
        ..Default::default()
    };

    let client = state.client();
    let api_key = state.api_key().ok();
    let mut runs: Vec<Run> = Vec::new();
    let mut truncated = false;

    if let Some(game_id) = filter.game_id.as_deref().filter(|g| !g.trim().is_empty()) {
        let query = RunQuery {
            game: Some(require_id(game_id, "game id")?),
            ..base
        };
        runs = endpoints::runs(&client, &query, api_key.as_deref(), Some(limit)).await?;
        truncated = runs.len() >= limit;
    } else if filter.only_my_games.unwrap_or(true) {
        let games = super::library::load_moderated_games(&state).await?;
        for game in &games {
            if runs.len() >= limit {
                truncated = true;
                break;
            }
            let query = RunQuery {
                game: Some(game.id.clone()),
                ..base.clone()
            };
            let remaining = limit - runs.len();
            match endpoints::runs(&client, &query, api_key.as_deref(), Some(remaining)).await {
                Ok(mut page) => runs.append(&mut page),
                Err(e) if e.retryable() => {
                    // A transient failure on one game leaves a gap, not an
                    // empty queue. The count is then a floor, so say so.
                    tracing::warn!("queue fetch failed for game {}: {e}", game.id);
                    truncated = true;
                }
                Err(e) => return Err(e),
            }
        }
    } else {
        runs = endpoints::runs(&client, &base, api_key.as_deref(), Some(limit)).await?;
        truncated = runs.len() >= limit;
    }

    let duplicates = analysis::find_duplicates(&runs);
    let summaries = summarise_runs(&state, &runs).await?;

    Ok(QueuePage {
        runs: summaries,
        duplicates,
        truncated,
        fetched_at: now_iso8601(),
    })
}

/// Flattens runs into table rows, resolving lookups once per game.
///
/// `pub(crate)` for the background watcher, which builds the same rows without
/// going through the command layer.
pub(crate) async fn summarise_runs(state: &AppState, runs: &[Run]) -> AppResult<Vec<RunSummary>> {
    // Reference data is cached for days, so this is normally free.
    let platforms = super::library::load_platforms(state).await.unwrap_or_default();
    let regions = super::library::load_regions(state).await.unwrap_or_default();

    // Variables and levels are per-game; fetch each distinct game once.
    let game_ids: HashSet<String> = runs.iter().filter_map(|r| r.game_id()).collect();
    let mut variables_by_game = HashMap::new();
    let mut levels_by_game = HashMap::new();
    for game_id in game_ids {
        if let Ok(vars) = super::library::load_variables(state, &game_id).await {
            variables_by_game.insert(game_id.clone(), vars);
        }
        if let Ok(levels) = super::library::load_levels(state, &game_id).await {
            levels_by_game.insert(game_id, levels);
        }
    }

    Ok(runs
        .iter()
        .map(|run| {
            let game_id = run.game_id();
            let lookups = Lookups {
                platforms: Some(&platforms),
                regions: Some(&regions),
                variables: game_id.as_deref().and_then(|g| variables_by_game.get(g)).map(|v| v.as_slice()),
                levels: game_id.as_deref().and_then(|g| levels_by_game.get(g)).map(|l| l.as_slice()),
            };
            RunSummary::from_run(run, &lookups)
        })
        .collect())
}

/// Loads everything the detail panel shows for one run.
///
/// Every secondary lookup (videos, leaderboard, runner history) degrades
/// independently: if the leaderboard cannot be fetched the panel still renders,
/// with an explicit "could not load" rather than an empty board.
#[tauri::command]
pub async fn get_run_detail(
    state: State<'_, AppState>,
    run_id: String,
    refresh_videos: Option<bool>,
) -> AppResult<RunDetail> {
    let run_id = require_id(&run_id, "run id")?;
    let client = state.client();
    let api_key = state.api_key().ok();
    let run = endpoints::run(&client, &run_id, api_key.as_deref()).await?;

    let game_id = run.game_id();
    let game = match game_id.as_deref() {
        Some(id) => super::library::load_game(&state, id).await.ok(),
        None => None,
    };
    let categories = match game_id.as_deref() {
        Some(id) => super::library::load_categories(&state, id).await.unwrap_or_default(),
        None => Vec::new(),
    };
    let variables = match game_id.as_deref() {
        Some(id) => super::library::load_variables(&state, id).await.unwrap_or_default(),
        None => Vec::new(),
    };
    let category = run
        .category_id()
        .and_then(|cid| categories.into_iter().find(|c| c.id == cid));

    let video_urls = run.video_urls();
    let video_checks = check_videos(&state, &video_urls, refresh_videos.unwrap_or(false)).await;

    // Leaderboard context, filtered to the run's own subcategory values.
    let mut leaderboard = None;
    let mut leaderboard_error = None;
    let mut leaderboard_times: Option<Vec<f64>> = None;
    if let (Some(gid), Some(cid)) = (game_id.as_deref(), run.category_id()) {
        let filters: Vec<(String, String)> = run
            .values
            .iter()
            .filter(|(var_id, _)| {
                variables
                    .iter()
                    .find(|v| &v.id == *var_id)
                    .is_some_and(|v| v.is_subcategory())
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        match super::library::fetch_leaderboard(&state, gid, &cid, &filters, 10).await {
            Ok(board) => {
                leaderboard_times = Some(
                    board
                        .runs
                        .iter()
                        .filter(|p| p.run.id != run.id)
                        .filter_map(|p| p.run.primary_seconds())
                        .collect(),
                );
                leaderboard = Some(super::library::leaderboard_entries(&board));
            }
            Err(e) => leaderboard_error = Some(e.to_string()),
        }
    }

    let prior_action = state
        .db
        .history_for_run(&run_id)?
        .map(|entry| entry.action.as_str().to_string());

    let duplicates = find_queue_duplicates(&state, &run).await;

    let runner_history = load_runner_history(&state, &run).await;
    let history_totals = runner_history.as_ref().map(|h| h.totals.clone());

    let platforms = super::library::load_platforms(&state).await.unwrap_or_default();
    let regions = super::library::load_regions(&state).await.unwrap_or_default();
    let levels = match game_id.as_deref() {
        Some(id) => super::library::load_levels(&state, id).await.unwrap_or_default(),
        None => Vec::new(),
    };
    let platform_name = run
        .system
        .as_ref()
        .and_then(|s| s.platform.as_deref())
        .and_then(|id| platforms.iter().find(|p| p.id == id))
        .map(|p| p.name.clone());

    let ctx = AnalysisContext {
        run: &run,
        game: game.as_ref(),
        category: category.as_ref(),
        variables: &variables,
        videos: &video_checks,
        leaderboard_times: leaderboard_times.as_deref(),
        duplicates: &duplicates,
        prior_action: prior_action.as_deref(),
        runner_history: history_totals.as_ref(),
        platform_name: platform_name.as_deref(),
    };
    let analysis = analysis::analyse(&ctx);

    let viewer = state.profile().map(|u| u.id);
    let summary = RunSummary::from_run(
        &run,
        &Lookups {
            platforms: Some(&platforms),
            regions: Some(&regions),
            variables: Some(&variables),
            levels: Some(&levels),
        },
    );

    Ok(RunDetail {
        run: summary,
        game: game.as_ref().map(|g| GameInfo::from_game(g, viewer.as_deref())),
        category: category.as_ref().map(crate::dto::CategoryInfo::from_category),
        video_checks,
        analysis,
        runner_history,
        prior_action,
        leaderboard,
        leaderboard_error,
    })
}

/// Other pending runs in the same game that share a video with this one.
async fn find_queue_duplicates(state: &AppState, run: &Run) -> Vec<String> {
    let Some(game_id) = run.game_id() else {
        return Vec::new();
    };
    let query = RunQuery {
        game: Some(game_id),
        status: Some(RunStatusFilter::New),
        embed: false,
        ..Default::default()
    };
    let client = state.client();
    let api_key = state.api_key().ok();
    let Ok(pending) = endpoints::runs(&client, &query, api_key.as_deref(), Some(200)).await else {
        // Not knowing about duplicates is silent: claiming there are none would
        // be an assertion we cannot support.
        return Vec::new();
    };
    analysis::find_duplicates(&pending)
        .remove(&run.id)
        .unwrap_or_default()
}

/// Checks a run's videos, reading the cache unless a refresh was requested.
pub(crate) async fn check_videos(
    state: &AppState,
    urls: &[String],
    force: bool,
) -> Vec<VideoCheck> {
    let probe = state.probe();
    let mut out = Vec::with_capacity(urls.len());

    for url in urls {
        // The cache is keyed by normalised URL, so the same video submitted in
        // two link formats is checked once.
        let normalized = crate::video::detect::parse(url).ok().map(|r| r.normalized);

        if !force {
            if let Some(key) = normalized.as_deref() {
                if let Ok(Some(mut hit)) = state.db.video_check_get(key) {
                    hit.url = url.clone();
                    out.push(hit);
                    continue;
                }
            }
        }

        let check = video::check_url(&probe, url).await;
        // `video_check_put` refuses to store transient verdicts, so a network
        // failure can never be replayed later as if it were an answer.
        if let Err(e) = state.db.video_check_put(&check) {
            tracing::warn!("could not cache a video check: {e}");
        }
        out.push(check);
    }

    out
}

/// Re-checks one run's videos, bypassing the cache.
#[tauri::command]
pub async fn recheck_videos(
    state: State<'_, AppState>,
    run_id: String,
) -> AppResult<Vec<VideoCheck>> {
    let run_id = require_id(&run_id, "run id")?;
    let client = state.client();
    let api_key = state.api_key().ok();
    let run = endpoints::run(&client, &run_id, api_key.as_deref()).await?;
    Ok(check_videos(&state, &run.video_urls(), true).await)
}

/// Checks an arbitrary URL, for the "validate link" tool.
#[tauri::command]
pub async fn check_video_url(state: State<'_, AppState>, url: String) -> AppResult<VideoCheck> {
    if url.trim().is_empty() {
        return Err(AppError::InvalidInput("Enter a URL to check.".into()));
    }
    Ok(check_videos(&state, &[url], true).await.remove(0))
}

/// Checks the videos of many runs, for the queue's bulk video scan.
///
/// Returns run id → checks. A run whose own lookup failed still appears, with a
/// `NETWORK_ERROR` entry, so the table shows "could not check" rather than
/// omitting the row.
#[tauri::command]
pub async fn check_videos_bulk(
    state: State<'_, AppState>,
    runs: Vec<(String, Vec<String>)>,
    force: Option<bool>,
) -> AppResult<HashMap<String, Vec<VideoCheck>>> {
    let force = force.unwrap_or(false);
    let mut out = HashMap::new();
    for (run_id, urls) in runs.into_iter().take(500) {
        let checks = check_videos(&state, &urls, force).await;
        out.insert(run_id, checks);
    }
    Ok(out)
}

/// The runner's earlier submissions in this game.
async fn load_runner_history(state: &AppState, run: &Run) -> Option<RunnerHistorySummary> {
    let players = run.players();
    let player = players.first()?;
    let user_id = player.id.clone();

    let mut summary = RunnerHistorySummary {
        user_id: user_id.clone(),
        display_name: player.name.clone(),
        weblink: player.weblink.clone(),
        avatar_url: player.avatar_url.clone(),
        country_code: player.country_code.clone(),
        signup_date: None,
        totals: RunnerHistory::default(),
        runs: Vec::new(),
        improvement_percent: None,
        previous_best_display: None,
        error: None,
    };

    let Some(user_id) = user_id else {
        // A guest has no account, so there is no history to look up. That is a
        // fact about the submission, not a failure.
        summary.error = Some("Guest submissions have no run history on Speedrun.com.".into());
        return Some(summary);
    };

    let query = RunQuery {
        game: run.game_id(),
        user: Some(user_id),
        order_by: Some(RunOrder::Date),
        ascending: false,
        embed: true,
        ..Default::default()
    };
    let client = state.client();
    let earlier = match endpoints::runs(&client, &query, state.api_key().ok().as_deref(), Some(50)).await
    {
        Ok(runs) => runs,
        Err(e) => {
            // Explicitly "unavailable" — never rendered as "no previous runs".
            summary.error = Some(format!("Their run history could not be loaded: {e}"));
            return Some(summary);
        }
    };

    let category_id = run.category_id();
    summary.totals = analysis::summarise_runner_history(&earlier, run, category_id.as_deref());

    if let (Some(best), Some(current)) = (summary.totals.best_time, run.primary_seconds()) {
        summary.previous_best_display = Some(format_duration(best));
        summary.improvement_percent = improvement_percent(best, current);
    }

    summary.runs = earlier
        .iter()
        .filter(|r| r.id != run.id)
        .take(20)
        .map(|r| RunSummary::from_run(r, &Lookups::default()))
        .collect();

    Some(summary)
}

/// Aggregates the dashboard figures.
///
/// Partial failures are collected into `warnings` and the rest of the payload
/// is still returned: a dashboard that renders nothing because one game timed
/// out would be worse than one that says so.
#[tauri::command]
pub async fn get_dashboard(state: State<'_, AppState>) -> AppResult<DashboardSummary> {
    let mut summary = DashboardSummary {
        fetched_at: now_iso8601(),
        ..Default::default()
    };

    let games = match super::library::load_moderated_games(&state).await {
        Ok(g) => g,
        Err(e) if matches!(e, AppError::MissingCredentials) => return Err(e),
        Err(e) => {
            summary.warnings.push(format!("Moderated games: {e}"));
            Vec::new()
        }
    };
    summary.games_moderated = games.len();

    let client = state.client();
    let api_key = state.api_key().ok();
    let mut pending: Vec<Run> = Vec::new();

    for game in &games {
        let query = RunQuery {
            game: Some(game.id.clone()),
            status: Some(RunStatusFilter::New),
            order_by: Some(RunOrder::Submitted),
            ascending: true,
            embed: true,
            ..Default::default()
        };
        match endpoints::runs(&client, &query, api_key.as_deref(), Some(200)).await {
            Ok(mut runs) => pending.append(&mut runs),
            Err(e) => {
                summary.warnings.push(format!("{}: {e}", game.display_name()));
                summary.pending_is_partial = true;
            }
        }
        if pending.len() >= MAX_QUEUE {
            summary.pending_is_partial = true;
            break;
        }
    }

    summary.pending_count = pending.len();

    summary.oldest_pending_days = pending
        .iter()
        .filter_map(|r| r.submitted.as_deref())
        .filter_map(|s| crate::util::days_between(s, &now_iso8601()))
        .max();

    // Video state for the newest runs only: a full scan of a large backlog
    // would spend the entire API budget on the dashboard.
    let sample: Vec<&Run> = pending.iter().rev().take(25).collect();
    for run in &sample {
        let checks = check_videos(&state, &run.video_urls(), false).await;
        if checks.iter().any(|c| c.status.is_problem()) {
            summary.runs_with_video_problems += 1;
        }
        let ctx = AnalysisContext {
            videos: &checks,
            ..AnalysisContext::minimal(run)
        };
        if analysis::analyse(&ctx).critical_count > 0 {
            summary.runs_needing_review += 1;
        }
    }

    let stats_today = state.db.moderation_stats(1)?;
    let stats_week = state.db.moderation_stats(7)?;
    summary.actions_today = stats_today.total_actions;
    summary.actions_this_week = stats_week.total_actions;

    let recent: Vec<Run> = pending.iter().rev().take(8).cloned().collect();
    summary.recent_runs = summarise_runs(&state, &recent).await.unwrap_or_default();

    Ok(summary)
}

/// Status badge for a set of runs, used by the queue's video column.
#[tauri::command]
pub async fn video_status_for(
    state: State<'_, AppState>,
    urls: Vec<String>,
) -> AppResult<Option<VideoStatus>> {
    let checks = check_videos(&state, &urls, false).await;
    Ok(video::worst_status(&checks))
}

/// What one watcher poll found.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchReport {
    /// Newest pending runs in the moderator's games, newest first.
    pub runs: Vec<RunSummary>,
    pub fetched_at: String,
    /// How many games the scope covers. Zero means nothing was watched.
    pub scoped_games: usize,
}

/// Newest pending runs across the moderator's games, in a single request.
///
/// `get_queue` issues one request per moderated game. That is right for a manual
/// refresh and ruinous for a five-second poll: ten games would be 120 requests a
/// minute before the moderator has done anything, and the rate limiter would
/// then make every other call wait behind it.
///
/// So this asks the API for the most recently submitted pending runs site-wide —
/// one request, whatever the game count — and keeps the ones the moderator owns.
/// The trade-off is a horizon: a run is visible here only while it is among the
/// `limit` newest submissions on Speedrun.com. At the intervals SRCTools offers
/// that is many minutes of headroom, and anything older is still found by the
/// next queue refresh, which remains the authoritative list.
#[tauri::command]
pub async fn watch_new_runs(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> AppResult<WatchReport> {
    let limit = clamp_limit(limit, 20, 200);

    let games = super::library::load_moderated_games(&state).await?;
    if games.is_empty() {
        return Ok(WatchReport {
            runs: Vec::new(),
            fetched_at: now_iso8601(),
            scoped_games: 0,
        });
    }
    let owned: HashSet<String> = games.iter().map(|g| g.id.clone()).collect();

    let query = RunQuery {
        status: Some(RunStatusFilter::New),
        order_by: Some(RunOrder::Submitted),
        ascending: false,
        embed: true,
        ..Default::default()
    };

    let client = state.client();
    let api_key = state.api_key().ok();
    let fetched = endpoints::runs(&client, &query, api_key.as_deref(), Some(limit)).await?;

    let mine: Vec<Run> = fetched
        .into_iter()
        .filter(|run| run.game_id().is_some_and(|id| owned.contains(&id)))
        .collect();

    Ok(WatchReport {
        runs: summarise_runs(&state, &mine).await?,
        fetched_at: now_iso8601(),
        scoped_games: games.len(),
    })
}
