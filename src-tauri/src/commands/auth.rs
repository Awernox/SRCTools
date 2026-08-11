//! Credentials, identity and connection testing.
//!
//! The API key never leaves this process except as an `X-API-Key` header. The
//! frontend can learn three things about it — whether one is stored, a masked
//! preview, and whether Speedrun.com accepts it — and nothing more.

use tauri::State;

use crate::commands::require_id;
use crate::db::cache::CacheKind;
use crate::dto::{ConnectionStatus, Profile};
use crate::error::{AppError, AppResult};
use crate::src_api::endpoints;
use crate::state::AppState;

/// Stores the Speedrun.com API key in the OS credential vault.
///
/// The key is validated against `GET /profile` before it is saved, so a typo is
/// reported immediately rather than surfacing later as a mysterious 403. On
/// success the resolved profile is cached in state and returned.
#[tauri::command]
pub async fn set_api_key(state: State<'_, AppState>, key: String) -> AppResult<Profile> {
    let trimmed = key.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "Paste your Speedrun.com API key. Find it at speedrun.com → Settings → API key.".into(),
        ));
    }

    // Verify before persisting: an unusable key is never written to the vault.
    let client = state.client();
    let user = endpoints::profile(&client, &trimmed).await?;

    crate::secrets::set_api_key(&trimmed)?;
    let profile = Profile::from_user(&user);
    state.set_profile(Some(user));

    // A different account means every cached per-user answer is now wrong.
    let _ = state.db.cache_invalidate_kind(CacheKind::ModeratedGames);
    let _ = state.db.cache_invalidate_kind(CacheKind::Profile);

    Ok(profile)
}

/// Removes the stored API key and forgets the signed-in identity.
#[tauri::command]
pub async fn clear_api_key(state: State<'_, AppState>) -> AppResult<()> {
    crate::secrets::clear_api_key()?;
    state.set_profile(None);
    let _ = state.db.cache_invalidate_kind(CacheKind::ModeratedGames);
    let _ = state.db.cache_invalidate_kind(CacheKind::Profile);
    Ok(())
}

/// Whether a key is stored, without revealing it.
#[tauri::command]
pub async fn has_api_key() -> AppResult<bool> {
    Ok(crate::secrets::api_key()?.is_some())
}

/// Resolves the signed-in moderator.
///
/// Returns `None` rather than an error when no key is configured — that is the
/// expected state on first launch, not a failure.
#[tauri::command]
pub async fn get_profile(state: State<'_, AppState>) -> AppResult<Option<Profile>> {
    if let Some(user) = state.profile() {
        return Ok(Some(Profile::from_user(&user)));
    }
    let Some(key) = crate::secrets::api_key()? else {
        return Ok(None);
    };

    let client = state.client();
    let user = endpoints::profile(&client, &key).await?;
    let profile = Profile::from_user(&user);
    state.set_profile(Some(user));
    Ok(Some(profile))
}

/// Full connection report for the settings page.
///
/// Never returns `Err` for a credential problem: an invalid key is a *state*
/// the settings page renders, so the message explains what is wrong instead of
/// throwing the user into an error toast.
#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>) -> AppResult<ConnectionStatus> {
    let stored = crate::secrets::api_key()?;
    let twitch_configured = crate::secrets::twitch_credentials()?.is_some();
    let client = state.client();
    let (used, capacity) = client.limiter().current_load().await;

    let Some(key) = stored else {
        return Ok(ConnectionStatus {
            connected: false,
            profile: None,
            masked_key: None,
            twitch_configured,
            message: "No API key is configured yet.".into(),
            rate_limit_used: used,
            rate_limit_capacity: capacity,
        });
    };

    let masked = Some(crate::secrets::mask(&key));

    match endpoints::profile(&client, &key).await {
        Ok(user) => {
            let profile = Profile::from_user(&user);
            let name = profile.display_name.clone();
            state.set_profile(Some(user));
            Ok(ConnectionStatus {
                connected: true,
                profile: Some(profile),
                masked_key: masked,
                twitch_configured,
                message: format!("Connected to Speedrun.com as {name}."),
                rate_limit_used: used,
                rate_limit_capacity: capacity,
            })
        }
        Err(err) => Ok(ConnectionStatus {
            connected: false,
            profile: None,
            masked_key: masked,
            twitch_configured,
            // `err` is already user-facing and carries no secret.
            message: err.to_string(),
            rate_limit_used: used,
            rate_limit_capacity: capacity,
        }),
    }
}

/// Stores Twitch application credentials, used only to read VOD metadata.
///
/// Twitch has no unauthenticated video API. Without these, Twitch links resolve
/// to `UNKNOWN` — explicitly "could not check", never "missing".
#[tauri::command]
pub async fn set_twitch_credentials(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> AppResult<bool> {
    let id = client_id.trim();
    let secret = client_secret.trim();

    if id.is_empty() != secret.is_empty() {
        return Err(AppError::InvalidInput(
            "Enter both the Twitch Client ID and Client Secret, or clear both.".into(),
        ));
    }

    crate::secrets::set_twitch_credentials(id, secret)?;
    state.refresh_probe();
    Ok(!id.is_empty())
}

#[tauri::command]
pub async fn clear_twitch_credentials(state: State<'_, AppState>) -> AppResult<()> {
    crate::secrets::clear_twitch_credentials()?;
    state.refresh_probe();
    Ok(())
}

/// Whether Twitch metadata lookups are possible. Never returns the credentials.
#[tauri::command]
pub async fn has_twitch_credentials() -> AppResult<bool> {
    Ok(crate::secrets::twitch_credentials()?.is_some())
}

/// Current usage of the self-imposed request budget, for the status bar.
#[tauri::command]
pub async fn rate_limit_status(state: State<'_, AppState>) -> AppResult<(usize, usize)> {
    Ok(state.client().limiter().current_load().await)
}

/// Looks up any Speedrun.com user by name, for the runner-history panel.
#[tauri::command]
pub async fn lookup_user(state: State<'_, AppState>, name: String) -> AppResult<Option<Profile>> {
    let name = require_id(&name, "username")?;
    let client = state.client();
    Ok(endpoints::user_by_name(&client, &name)
        .await?
        .map(|u| Profile::from_user(&u)))
}
