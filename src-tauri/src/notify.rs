//! Desktop notifications that can be clicked.
//!
//! `tauri-plugin-notification` is used for the plain case, but its desktop
//! implementation goes through `notify-rust` and drops the activation callback,
//! so a click leads nowhere. A moderator told about a new run has to be able to
//! click through to it, so on Windows the toast is built here against the WinRT
//! API directly and the activation callback focuses the window and emits the
//! run id to the frontend.
//!
//! The toast is deliberately silent: the sound is played by the webview so the
//! volume slider in Settings actually controls something.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Emitted when the moderator clicks a notification body.
pub const ACTIVATED_EVENT: &str = "srctools://notification-activated";

/// What clicking a notification should open. `None` just focuses the window.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    /// Page to open, matching the frontend's `PageId`.
    pub page: String,
    /// Run to select and open in the detail panel, if any.
    #[serde(default)]
    pub run_id: Option<String>,
}

/// Brings the main window forward. Called from the toast callback.
fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// True when running from `target/debug` or `target/release`.
///
/// A toast's app id must be a registered AppUserModelID or Windows silently
/// drops it. The installed build registers one through its Start Menu shortcut;
/// a `cargo run` build has not, so it borrows PowerShell's, exactly as
/// `tauri-plugin-notification` does.
#[cfg(windows)]
fn is_dev_layout() -> bool {
    use std::path::MAIN_SEPARATOR as SEP;
    let Ok(exe) = tauri::utils::platform::current_exe() else {
        return true;
    };
    let Some(dir) = exe.parent() else {
        return true;
    };
    let dir = dir.display().to_string();
    dir.ends_with(&format!("{SEP}target{SEP}debug")) || dir.ends_with(&format!("{SEP}target{SEP}release"))
}

#[cfg(windows)]
fn show_windows(
    app: &AppHandle,
    title: &str,
    body: &str,
    action: Option<NotificationAction>,
) -> Result<(), String> {
    use tauri_winrt_notification::{Duration, Sound, Toast};

    let app_id = if is_dev_layout() {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };

    let handle = app.clone();
    let toast = Toast::new(&app_id)
        .title(title)
        .text1(body)
        .duration(Duration::Short)
        // Silent: the webview plays `notification.mp3` at the chosen volume, and
        // two overlapping sounds for one event is worse than either alone.
        .sound(None::<Sound>)
        .on_activated(move |_| {
            focus_main(&handle);
            if let Some(action) = action.clone() {
                let _ = handle.emit(ACTIVATED_EVENT, action);
            }
            Ok(())
        });

    toast.show().map_err(|e| e.to_string())
}

/// Shows a notification, falling back to the plugin if the rich toast fails.
///
/// A failure here is never propagated to the caller as an error the moderator
/// has to deal with: a missing toast is a degraded convenience, and the in-app
/// toast has already delivered the same information.
pub fn show(app: &AppHandle, title: &str, body: &str, action: Option<NotificationAction>) {
    #[cfg(windows)]
    {
        match show_windows(app, title, body, action) {
            Ok(()) => return,
            Err(e) => tracing::warn!("the clickable toast failed, falling back: {e}"),
        }
    }
    #[cfg(not(windows))]
    let _ = action;

    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!("could not show a notification: {e}");
    }
}

/// Shows a desktop notification.
///
/// Permission is not requested here: on Windows the plugin's permission state is
/// always granted, and the moderator's real consent is the notification
/// preference they set in SRCTools.
#[tauri::command]
pub fn notify_desktop(
    app: AppHandle,
    title: String,
    body: String,
    action: Option<NotificationAction>,
) {
    show(&app, &title, &body, action);
}

