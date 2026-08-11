//! SRCTools — advanced Speedrun.com moderator toolkit.
//!
//! Module map:
//! - [`error`] — one error type, with a machine-readable kind and a human hint.
//! - [`secrets`] — OS credential vault; the only place an API key exists.
//! - [`src_api`] — Speedrun.com API v1 client, models and endpoints.
//! - [`video`] — video availability verification.
//! - [`analysis`] — heuristics that flag runs for review (never decide).
//! - [`db`] — SQLite cache, moderation log and preferences.
//! - [`dto`] — the flattened shapes the frontend consumes.
//! - [`state`] — shared application state.
//! - [`notify`] — clickable desktop notifications.
//! - [`watcher`] — background poll for newly submitted runs.
//! - [`discord`] — Discord Rich Presence, on its own thread.
//! - [`webhook`] — Discord webhook delivery for moderation events.
//! - [`update`] — checking GitHub Releases for a newer build.
//! - [`commands`] — the Tauri IPC surface.

pub mod analysis;
pub mod commands;
pub mod db;
pub mod discord;
pub mod dto;
pub mod error;
pub mod notify;
pub mod secrets;
pub mod src_api;
pub mod state;
pub mod update;
pub mod util;
pub mod video;
pub mod watcher;
pub mod webhook;

use std::path::PathBuf;

use tauri::{Emitter, Manager};

use crate::db::Db;
use crate::state::AppState;

/// Emitted once the backend is ready, carrying anything that went wrong during
/// startup. A failure here is shown in the UI, never printed to a console the
/// user cannot see.
const READY_EVENT: &str = "srctools://ready";

/// Startup report handed to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupReport {
    pub version: String,
    pub database_path: String,
    /// True when a Speedrun.com key was found in the OS vault.
    pub has_api_key: bool,
    /// Non-fatal problems, e.g. the credential vault being unavailable.
    pub warnings: Vec<String>,
}

/// Where the local database lives: `%APPDATA%/com.srctools.app/srctools.db` on
/// Windows, the platform equivalent elsewhere.
fn database_path(app: &tauri::AppHandle) -> PathBuf {
    match app.path().app_data_dir() {
        Ok(dir) => {
            if let Err(e) = std::fs::create_dir_all(&dir) {
                tracing::warn!("could not create the data directory: {e}");
            }
            dir.join("srctools.db")
        }
        // Falling back to the working directory keeps the app usable on a
        // locked-down machine rather than refusing to start.
        Err(e) => {
            tracing::warn!("no app data directory: {e}");
            PathBuf::from("srctools.db")
        }
    }
}

/// Installs tracing. Logs go to a rolling file next to the database and, in
/// debug builds, to stderr.
///
/// The API key is never passed to a formatter anywhere in this crate, and
/// `reqwest`'s own header logging is off, so no log line can contain it.
fn init_logging(dir: &std::path::Path) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    let filter = EnvFilter::try_from_env("SRCTOOLS_LOG")
        .unwrap_or_else(|_| EnvFilter::new("srctools_lib=info,warn"));

    let appender = tracing_appender::rolling::daily(dir, "srctools.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let file_layer = fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(true);

    let registry = tracing_subscriber::registry().with(filter).with(file_layer);

    #[cfg(debug_assertions)]
    let registry = registry.with(fmt::layer().with_writer(std::io::stderr));

    if registry.try_init().is_err() {
        // Already installed (e.g. a second call in tests); not worth failing for.
        return None;
    }
    Some(guard)
}

/// Builds and runs the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let db_path = database_path(&handle);

            let log_dir = db_path.parent().map(PathBuf::from).unwrap_or_default();
            let guard = init_logging(&log_dir);
            if let Some(guard) = guard {
                // Held for the process lifetime so buffered lines are flushed.
                app.manage(guard);
            }

            let mut warnings: Vec<String> = Vec::new();

            let db = Db::open(&db_path).map_err(|e| {
                tracing::error!("could not open the database: {e}");
                e
            })?;

            // Housekeeping on boot: expired rows are dead weight and expired
            // *video* verdicts must never be served.
            match db.cache_prune_expired() {
                Ok(n) if n > 0 => tracing::info!("pruned {n} expired cache entries"),
                Err(e) => warnings.push(format!("Could not tidy the local cache: {e}")),
                _ => {}
            }

            let state = AppState::new(db)?;
            app.manage(state);

            // The presence worker parks on a channel until the frontend sends
            // it the saved settings, so starting it here costs one idle thread
            // and nothing else.
            app.manage(crate::discord::Discord::spawn(handle.clone()));

            // The run watcher parks on a notify until the frontend sends it the
            // saved interval. Owning the loop here rather than in the webview is
            // what keeps its cadence real: a background page's timers are
            // throttled to about once a minute, which is precisely when a
            // moderator is waiting to be told about a run.
            app.manage(crate::watcher::Watcher::spawn(handle.clone()));

            let has_api_key = match crate::secrets::api_key() {
                Ok(key) => key.is_some(),
                Err(e) => {
                    // The vault being unreachable is a real problem, but not a
                    // reason to refuse to start: everything local still works.
                    warnings.push(format!(
                        "Secure credential storage is unavailable, so your API key cannot be read: {e}"
                    ));
                    false
                }
            };

            let report = StartupReport {
                version: env!("CARGO_PKG_VERSION").to_string(),
                database_path: db_path.display().to_string(),
                has_api_key,
                warnings,
            };

            // Resolve the signed-in identity in the background: a slow network
            // must not delay the window appearing.
            if has_api_key {
                let bg = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let state = bg.state::<AppState>();
                    let client = state.client();
                    match crate::secrets::api_key() {
                        Ok(Some(key)) => match crate::src_api::endpoints::profile(&client, &key).await {
                            Ok(user) => {
                                let profile = crate::dto::Profile::from_user(&user);
                                state.set_profile(Some(user));
                                let _ = bg.emit("srctools://profile", profile);
                            }
                            Err(e) => tracing::warn!("could not resolve the profile at startup: {e}"),
                        },
                        Ok(None) => {}
                        Err(e) => tracing::warn!("could not read the stored key: {e}"),
                    }
                });
            }

            // The window is created hidden so the first frame the moderator sees
            // is the finished dark UI rather than a white flash. The frontend
            // shows it once it has painted; this fallback exists so a webview
            // that fails to boot still leaves a visible, closable window.
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(debug_assertions)]
                window.open_devtools();

                let fallback = window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    if !fallback.is_visible().unwrap_or(false) {
                        tracing::warn!("the frontend never reported ready; showing the window");
                        let _ = fallback.show();
                    }
                });
            }

            let _ = handle.emit(READY_EVENT, report);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // auth
            commands::auth::set_api_key,
            commands::auth::clear_api_key,
            commands::auth::has_api_key,
            commands::auth::get_profile,
            commands::auth::test_connection,
            commands::auth::set_twitch_credentials,
            commands::auth::clear_twitch_credentials,
            commands::auth::has_twitch_credentials,
            commands::auth::rate_limit_status,
            commands::auth::lookup_user,
            // queue and detail
            commands::queue::get_queue,
            commands::queue::get_run_detail,
            commands::queue::recheck_videos,
            commands::queue::check_video_url,
            commands::queue::check_videos_bulk,
            commands::queue::video_status_for,
            commands::queue::watch_new_runs,
            commands::queue::get_dashboard,
            // moderation
            commands::moderation::moderate_run,
            commands::moderation::verify_run,
            commands::moderation::reject_run,
            commands::moderation::delete_run,
            commands::moderation::bulk_moderate,
            commands::moderation::cancel_bulk,
            commands::moderation::retry_failed,
            // library
            commands::library::list_moderated_games,
            commands::library::get_game,
            commands::library::get_categories,
            commands::library::get_variables,
            commands::library::get_levels,
            commands::library::search_games,
            commands::library::get_leaderboard,
            commands::library::get_platforms,
            commands::library::get_regions,
            // records
            commands::records::history_list,
            commands::records::history_count,
            commands::records::history_for_run,
            commands::records::history_clear,
            commands::records::audit_list,
            commands::records::moderation_stats,
            commands::records::export_history,
            commands::records::export_runs,
            commands::records::export_stats,
            commands::records::write_export,
            // preferences
            commands::prefs::settings_all,
            commands::prefs::setting_get,
            commands::prefs::setting_set,
            commands::prefs::setting_delete,
            commands::prefs::set_rate_limit,
            commands::prefs::templates_list,
            commands::prefs::template_save,
            commands::prefs::template_delete,
            commands::prefs::templates_restore_builtins,
            commands::prefs::templates_reorder,
            commands::prefs::favorites_list,
            commands::prefs::favorite_add,
            commands::prefs::favorite_remove,
            commands::prefs::favorites_reorder,
            commands::prefs::layout_get,
            commands::prefs::layout_set,
            commands::prefs::layout_delete,
            commands::prefs::shortcuts_all,
            commands::prefs::shortcut_set,
            commands::prefs::shortcuts_reset,
            commands::prefs::cache_stats,
            commands::prefs::cache_prune,
            commands::prefs::cache_clear,
            commands::prefs::cache_invalidate,
            commands::prefs::forget_video_check,
            commands::prefs::database_path,
            // custom notification sound
            commands::sound::sound_import,
            commands::sound::sound_load,
            commands::sound::sound_clear,
            // notifications
            notify::notify_desktop,
            // run watcher
            watcher::watcher_configure,
            watcher::watcher_status,
            watcher::watcher_poll_now,
            watcher::watcher_reprime,
            // discord rich presence
            discord::discord_configure,
            discord::discord_publish,
            discord::discord_reconnect,
            discord::discord_status,
            // discord webhook
            webhook::webhook_set_url,
            webhook::webhook_clear_url,
            webhook::webhook_status,
            webhook::webhook_test,
            webhook::webhook_send,
            // update check
            update::check_update,
        ])
        .run(tauri::generate_context!())
        .expect("SRCTools failed to start");
}
