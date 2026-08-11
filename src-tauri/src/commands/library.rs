//! Game library: metadata, rules, categories, variables and leaderboards.
//!
//! Every read here goes through the SQLite cache first. That is not only a
//! speed optimisation — the queue needs game rules for hundreds of runs, and
//! without caching a single refresh would exhaust the API budget.

use std::sync::Arc;

use tauri::State;

use crate::commands::{clamp_limit, require_id};
use crate::db::cache::CacheKind;
use crate::dto::{CategoryInfo, GameInfo, GameSummary, LeaderboardEntry};
use crate::error::AppResult;
use crate::src_api::models::{Category, Game, Level, Platform, Region, Variable};
use crate::src_api::{endpoints, SrcClient};
use crate::state::AppState;
use crate::util::format_duration;

/// Fetches a value from the cache, or from the API and then caches it.
///
/// A failed API call propagates: a stale-but-present cache entry is used only
/// when it has not expired, never as a fallback that would silently show old
/// rules as if they were current.
pub(crate) async fn cached<T, F, Fut>(
    state: &AppState,
    kind: CacheKind,
    key: &str,
    fetch: F,
) -> AppResult<T>
where
    T: serde::Serialize + serde::de::DeserializeOwned,
    F: FnOnce(Arc<SrcClient>) -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    if let Some(hit) = state.db.cache_get::<T>(kind, key)? {
        return Ok(hit);
    }
    let value = fetch(state.client()).await?;
    // A cache write failure must not fail the read that succeeded.
    if let Err(e) = state.db.cache_put(kind, key, &value) {
        tracing::warn!("could not cache {}/{key}: {e}", kind.as_str());
    }
    Ok(value)
}

pub(crate) async fn load_game(state: &AppState, game_id: &str) -> AppResult<Game> {
    cached(state, CacheKind::Game, game_id, |client| {
        let id = game_id.to_string();
        async move { endpoints::game(&client, &id).await }
    })
    .await
}

pub(crate) async fn load_categories(state: &AppState, game_id: &str) -> AppResult<Vec<Category>> {
    cached(state, CacheKind::Categories, game_id, |client| {
        let id = game_id.to_string();
        async move { endpoints::categories(&client, &id).await }
    })
    .await
}

pub(crate) async fn load_levels(state: &AppState, game_id: &str) -> AppResult<Vec<Level>> {
    cached(state, CacheKind::Levels, game_id, |client| {
        let id = game_id.to_string();
        async move { endpoints::levels(&client, &id).await }
    })
    .await
}

pub(crate) async fn load_variables(state: &AppState, game_id: &str) -> AppResult<Vec<Variable>> {
    cached(state, CacheKind::Variables, game_id, |client| {
        let id = game_id.to_string();
        async move { endpoints::variables(&client, &id).await }
    })
    .await
}

pub(crate) async fn load_platforms(state: &AppState) -> AppResult<Vec<Platform>> {
    cached(state, CacheKind::Platforms, "all", |client| async move {
        endpoints::platforms(&client).await
    })
    .await
}

pub(crate) async fn load_regions(state: &AppState) -> AppResult<Vec<Region>> {
    cached(state, CacheKind::Regions, "all", |client| async move {
        endpoints::regions(&client).await
    })
    .await
}

/// Games the signed-in moderator has rights on.
pub(crate) async fn load_moderated_games(state: &AppState) -> AppResult<Vec<Game>> {
    let user_id = state.require_user_id()?;
    let key = user_id.clone();
    cached(state, CacheKind::ModeratedGames, &key, |client| {
        let api_key = state.api_key().ok();
        async move {
            endpoints::games_moderated_by(&client, &user_id, api_key.as_deref()).await
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Games the signed-in user moderates, for the sidebar and queue filter.
#[tauri::command]
pub async fn list_moderated_games(state: State<'_, AppState>) -> AppResult<Vec<GameSummary>> {
    let viewer = state.profile().map(|u| u.id);
    let mut games: Vec<GameSummary> = load_moderated_games(&state)
        .await?
        .iter()
        .map(|g| GameSummary::from_game(g, viewer.as_deref()))
        .collect();
    games.sort_by_key(|g| g.name.to_lowercase());
    Ok(games)
}

/// Full game metadata, including the ruleset the analysis engine reads.
#[tauri::command]
pub async fn get_game(state: State<'_, AppState>, game_id: String) -> AppResult<GameInfo> {
    let game_id = require_id(&game_id, "game id")?;
    let game = load_game(&state, &game_id).await?;
    let viewer = state.profile().map(|u| u.id);
    Ok(GameInfo::from_game(&game, viewer.as_deref()))
}

/// Categories for a game, with their rules text.
#[tauri::command]
pub async fn get_categories(
    state: State<'_, AppState>,
    game_id: String,
) -> AppResult<Vec<CategoryInfo>> {
    let game_id = require_id(&game_id, "game id")?;
    Ok(load_categories(&state, &game_id)
        .await?
        .iter()
        .map(CategoryInfo::from_category)
        .collect())
}

/// Variables (including subcategories) defined for a game.
#[tauri::command]
pub async fn get_variables(
    state: State<'_, AppState>,
    game_id: String,
) -> AppResult<Vec<Variable>> {
    let game_id = require_id(&game_id, "game id")?;
    load_variables(&state, &game_id).await
}

/// Individual levels of a game, for level-based categories.
#[tauri::command]
pub async fn get_levels(state: State<'_, AppState>, game_id: String) -> AppResult<Vec<Level>> {
    let game_id = require_id(&game_id, "game id")?;
    load_levels(&state, &game_id).await
}

/// Game search for the command palette and global search.
#[tauri::command]
pub async fn search_games(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> AppResult<Vec<GameSummary>> {
    let query = query.trim();
    if query.len() < 2 {
        // Speedrun.com matches almost everything on one character; requiring
        // two keeps the palette responsive and the API budget intact.
        return Ok(Vec::new());
    }
    let limit = clamp_limit(limit, 20, 100);
    let viewer = state.profile().map(|u| u.id);
    let client = state.client();
    Ok(endpoints::search_games(&client, query, limit)
        .await?
        .iter()
        .map(|g| GameSummary::from_game(g, viewer.as_deref()))
        .collect())
}

/// Top leaderboard entries for a category, used as context in the detail panel.
///
/// `variable_filters` carries `(variable_id, value_id)` pairs so a subcategory
/// board is fetched rather than the combined one — comparing a run against the
/// wrong board would be worse than showing nothing.
#[tauri::command]
pub async fn get_leaderboard(
    state: State<'_, AppState>,
    game_id: String,
    category_id: String,
    variable_filters: Option<Vec<(String, String)>>,
    top: Option<u32>,
) -> AppResult<Vec<LeaderboardEntry>> {
    let game_id = require_id(&game_id, "game id")?;
    let category_id = require_id(&category_id, "category id")?;
    let filters = variable_filters.unwrap_or_default();
    let top = top.unwrap_or(10).clamp(1, 100);

    let board = fetch_leaderboard(&state, &game_id, &category_id, &filters, top).await?;
    Ok(leaderboard_entries(&board))
}

pub(crate) async fn fetch_leaderboard(
    state: &AppState,
    game_id: &str,
    category_id: &str,
    filters: &[(String, String)],
    top: u32,
) -> AppResult<crate::src_api::models::Leaderboard> {
    // The filters are part of the identity of the board, so they are part of
    // the cache key — otherwise two subcategories would share one entry.
    let mut key = format!("{game_id}/{category_id}/top{top}");
    let mut sorted: Vec<&(String, String)> = filters.iter().collect();
    sorted.sort();
    for (var, val) in sorted {
        key.push_str(&format!("/{var}={val}"));
    }

    cached(state, CacheKind::Leaderboard, &key, |client| {
        let game = game_id.to_string();
        let category = category_id.to_string();
        let filters = filters.to_vec();
        async move {
            endpoints::leaderboard(&client, &game, &category, &filters, Some(top)).await
        }
    })
    .await
}

pub(crate) fn leaderboard_entries(
    board: &crate::src_api::models::Leaderboard,
) -> Vec<LeaderboardEntry> {
    board
        .runs
        .iter()
        .map(|placed| {
            let players = placed.run.players();
            let player_label = if players.is_empty() {
                "Unknown".to_string()
            } else {
                players
                    .iter()
                    .map(|p| p.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let seconds = placed.run.primary_seconds();
            LeaderboardEntry {
                place: placed.place,
                run_id: placed.run.id.clone(),
                player_label,
                seconds,
                display: seconds.map(format_duration),
                weblink: placed.run.weblink.clone(),
                date: placed.run.date.clone(),
            }
        })
        .collect()
}

/// The platform list, cached for a week. Used to name a run's platform.
#[tauri::command]
pub async fn get_platforms(state: State<'_, AppState>) -> AppResult<Vec<Platform>> {
    load_platforms(&state).await
}

#[tauri::command]
pub async fn get_regions(state: State<'_, AppState>) -> AppResult<Vec<Region>> {
    load_regions(&state).await
}
