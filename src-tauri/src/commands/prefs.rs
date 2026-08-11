//! Settings, rejection templates, favourite games, layouts, shortcuts and the
//! local cache.
//!
//! Everything here is local-only: no command in this module talks to
//! Speedrun.com, and none of them can read or write a credential. Changing the
//! request budget is the one setting with a runtime effect, and it rebuilds the
//! API client immediately rather than waiting for a restart.

use std::collections::HashMap;

use tauri::State;

use crate::db::cache::CacheKind;
use crate::db::{CacheStats, FavoriteGame, RejectionTemplate};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DEFAULT_RATE_LIMIT, RATE_LIMIT_KEY};

/// Lowest request budget that still leaves the app usable. Below this a single
/// queue refresh would take minutes.
const MIN_RPM: u64 = 10;
/// Speedrun.com's documented ceiling for authenticated use.
const MAX_RPM: u64 = 100;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// All stored settings, as raw JSON strings keyed by name.
///
/// The frontend owns the shape of each value; Rust stores them opaquely so a
/// new preference never needs a schema change.
#[tauri::command]
pub async fn settings_all(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    state.db.settings_all()
}

#[tauri::command]
pub async fn setting_get(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    state.db.setting_get(&key)
}

/// Writes one setting. `value` must be valid JSON, so the frontend can read it
/// back with `JSON.parse` without guessing.
#[tauri::command]
pub async fn setting_set(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> AppResult<()> {
    if serde_json::from_str::<serde_json::Value>(&value).is_err() {
        return Err(AppError::InvalidInput(
            "A setting must be stored as JSON.".into(),
        ));
    }
    state.db.setting_set(&key, &value)?;

    // One setting changes backend behaviour, so it is applied here rather than
    // read opportunistically later.
    if key == RATE_LIMIT_KEY {
        let rpm = state
            .db
            .setting_u64(RATE_LIMIT_KEY, DEFAULT_RATE_LIMIT)
            .clamp(MIN_RPM, MAX_RPM);
        state.set_rate_limit(rpm as usize)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn setting_delete(state: State<'_, AppState>, key: String) -> AppResult<()> {
    state.db.setting_delete(&key)?;
    if key == RATE_LIMIT_KEY {
        state.set_rate_limit(DEFAULT_RATE_LIMIT as usize)?;
    }
    Ok(())
}

/// Sets the request budget directly, for the settings slider.
///
/// Returns the value actually applied, which may be clamped — the UI shows the
/// effective figure rather than the one that was asked for.
#[tauri::command]
pub async fn set_rate_limit(
    state: State<'_, AppState>,
    requests_per_minute: u64,
) -> AppResult<u64> {
    let rpm = requests_per_minute.clamp(MIN_RPM, MAX_RPM);
    state.set_rate_limit(rpm as usize)?;
    state.db.setting_set(RATE_LIMIT_KEY, &rpm.to_string())?;
    Ok(rpm)
}

// ---------------------------------------------------------------------------
// Rejection templates
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn templates_list(state: State<'_, AppState>) -> AppResult<Vec<RejectionTemplate>> {
    state.db.templates_list()
}

/// Creates a template, or updates the one with `id`.
#[tauri::command]
pub async fn template_save(
    state: State<'_, AppState>,
    id: Option<String>,
    label: String,
    body: String,
    sort_order: Option<i64>,
) -> AppResult<RejectionTemplate> {
    state
        .db
        .template_save(id.as_deref(), &label, &body, sort_order)
}

#[tauri::command]
pub async fn template_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let id = super::require_id(&id, "template id")?;
    state.db.template_delete(&id)
}

/// Restores the seeded templates. Custom templates are untouched.
#[tauri::command]
pub async fn templates_restore_builtins(
    state: State<'_, AppState>,
) -> AppResult<Vec<RejectionTemplate>> {
    state.db.templates_restore_builtins()
}

#[tauri::command]
pub async fn templates_reorder(
    state: State<'_, AppState>,
    ids_in_order: Vec<String>,
) -> AppResult<()> {
    state.db.templates_reorder(&ids_in_order)
}

// ---------------------------------------------------------------------------
// Favourite games
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn favorites_list(state: State<'_, AppState>) -> AppResult<Vec<FavoriteGame>> {
    state.db.favorites_list()
}

#[tauri::command]
pub async fn favorite_add(
    state: State<'_, AppState>,
    game_id: String,
    name: String,
    abbrev: Option<String>,
    cover_url: Option<String>,
) -> AppResult<Vec<FavoriteGame>> {
    let game_id = super::require_id(&game_id, "game id")?;
    state
        .db
        .favorite_add(&game_id, &name, abbrev.as_deref(), cover_url.as_deref())?;
    state.db.favorites_list()
}

#[tauri::command]
pub async fn favorite_remove(
    state: State<'_, AppState>,
    game_id: String,
) -> AppResult<Vec<FavoriteGame>> {
    let game_id = super::require_id(&game_id, "game id")?;
    state.db.favorite_remove(&game_id)?;
    state.db.favorites_list()
}

#[tauri::command]
pub async fn favorites_reorder(
    state: State<'_, AppState>,
    ids_in_order: Vec<String>,
) -> AppResult<()> {
    state.db.favorites_reorder(&ids_in_order)
}

// ---------------------------------------------------------------------------
// Panel layouts
// ---------------------------------------------------------------------------

/// Reads a saved workspace layout by name, e.g. `queue`.
#[tauri::command]
pub async fn layout_get(state: State<'_, AppState>, name: String) -> AppResult<Option<String>> {
    state.db.layout_get(&name)
}

#[tauri::command]
pub async fn layout_set(
    state: State<'_, AppState>,
    name: String,
    payload: String,
) -> AppResult<()> {
    if serde_json::from_str::<serde_json::Value>(&payload).is_err() {
        return Err(AppError::InvalidInput(
            "A layout must be stored as JSON.".into(),
        ));
    }
    state.db.layout_set(&name, &payload)
}

/// Forgets a layout, so the next open uses the default proportions.
#[tauri::command]
pub async fn layout_delete(state: State<'_, AppState>, name: String) -> AppResult<()> {
    state.db.layout_delete(&name)
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/// Customised bindings only; the frontend merges these over its defaults.
#[tauri::command]
pub async fn shortcuts_all(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    state.db.shortcuts_all()
}

/// Rebinds one action. An empty binding restores that action's default.
#[tauri::command]
pub async fn shortcut_set(
    state: State<'_, AppState>,
    action: String,
    binding: String,
) -> AppResult<HashMap<String, String>> {
    state.db.shortcut_set(&action, &binding)?;
    state.db.shortcuts_all()
}

#[tauri::command]
pub async fn shortcuts_reset(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    state.db.shortcuts_reset()?;
    state.db.shortcuts_all()
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cache_stats(state: State<'_, AppState>) -> AppResult<CacheStats> {
    state.db.cache_stats()
}

/// Drops expired rows and reclaims the space.
#[tauri::command]
pub async fn cache_prune(state: State<'_, AppState>) -> AppResult<usize> {
    let removed = state.db.cache_prune_expired()?;
    if removed > 0 {
        let _ = state.db.vacuum();
    }
    Ok(removed)
}

/// Empties the cache. History and settings are not touched.
///
/// Safe by construction: every cached value is re-fetchable from Speedrun.com,
/// so clearing costs API calls, never data.
#[tauri::command]
pub async fn cache_clear(state: State<'_, AppState>) -> AppResult<usize> {
    let removed = state.db.cache_clear()?;
    let _ = state.db.vacuum();
    Ok(removed)
}

/// Invalidates one namespace, e.g. after noticing stale category rules.
#[tauri::command]
pub async fn cache_invalidate(state: State<'_, AppState>, kind: String) -> AppResult<usize> {
    let kind = match kind.trim().to_ascii_lowercase().as_str() {
        "game" => CacheKind::Game,
        "categories" => CacheKind::Categories,
        "levels" => CacheKind::Levels,
        "variables" => CacheKind::Variables,
        "user" => CacheKind::User,
        "run" => CacheKind::Run,
        "leaderboard" => CacheKind::Leaderboard,
        "platforms" => CacheKind::Platforms,
        "regions" => CacheKind::Regions,
        "moderated_games" => CacheKind::ModeratedGames,
        "profile" => CacheKind::Profile,
        other => {
            return Err(AppError::InvalidInput(format!(
                "Unknown cache namespace \"{other}\"."
            )))
        }
    };
    state.db.cache_invalidate_kind(kind)
}

/// Forgets one video verdict so the next check re-asks the provider.
#[tauri::command]
pub async fn forget_video_check(state: State<'_, AppState>, url: String) -> AppResult<()> {
    let normalized = crate::video::detect::parse(&url)
        .map(|r| r.normalized)
        .unwrap_or_else(|_| url.trim().to_string());
    state.db.video_check_forget(&normalized)
}

/// Where the local database lives, for the "open folder" button in settings.
#[tauri::command]
pub async fn database_path(state: State<'_, AppState>) -> AppResult<String> {
    Ok(state.db.path().display().to_string())
}
