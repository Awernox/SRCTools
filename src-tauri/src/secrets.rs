//! Secure credential storage.
//!
//! Secrets live in the OS credential vault (Windows Credential Manager, macOS
//! Keychain, Secret Service on Linux) — never in the SQLite database, never in
//! a config file, never in the frontend bundle.
//!
//! The frontend can ask *whether* a key is stored and see a masked preview, but
//! the plaintext key only ever moves between this module and the HTTP layer.

use crate::error::{AppError, AppResult};

const SERVICE: &str = "SRCTools";
const SRC_API_KEY: &str = "speedrun-api-key";
const TWITCH_CLIENT_ID: &str = "twitch-client-id";
const TWITCH_CLIENT_SECRET: &str = "twitch-client-secret";
const DISCORD_WEBHOOK: &str = "discord-webhook-url";

fn entry(name: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, name).map_err(|e| {
        AppError::Keyring(format!(
            "could not open the system credential store: {e}. On Linux, install a Secret Service provider such as gnome-keyring."
        ))
    })
}

fn store(name: &str, value: &str) -> AppResult<()> {
    let e = entry(name)?;
    if value.is_empty() {
        // Treat an empty write as a delete so "clear the field and save" works.
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(AppError::Keyring(err.to_string())),
        };
    }
    e.set_password(value).map_err(|err| AppError::Keyring(err.to_string()))
}

fn load(name: &str) -> AppResult<Option<String>> {
    match entry(name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

fn clear(name: &str) -> AppResult<()> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

/// Speedrun.com API key.
pub fn set_api_key(key: &str) -> AppResult<()> {
    let trimmed = key.trim();
    // Reject whitespace/control characters early: they cannot be sent as an
    // HTTP header value and would otherwise fail confusingly at request time.
    if !trimmed.is_empty() && trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(AppError::InvalidInput(
            "The API key contains spaces or control characters. Copy it exactly as shown on Speedrun.com.".into(),
        ));
    }
    store(SRC_API_KEY, trimmed)
}

pub fn api_key() -> AppResult<Option<String>> {
    load(SRC_API_KEY)
}

/// Returns the key, or a clear "configure it first" error.
pub fn require_api_key() -> AppResult<String> {
    api_key()?.ok_or(AppError::MissingCredentials)
}

pub fn clear_api_key() -> AppResult<()> {
    clear(SRC_API_KEY)
}

/// Optional Twitch application credentials, used only for VOD metadata.
pub fn set_twitch_credentials(client_id: &str, client_secret: &str) -> AppResult<()> {
    store(TWITCH_CLIENT_ID, client_id.trim())?;
    store(TWITCH_CLIENT_SECRET, client_secret.trim())
}

pub fn twitch_credentials() -> AppResult<Option<(String, String)>> {
    let (Some(id), Some(secret)) = (load(TWITCH_CLIENT_ID)?, load(TWITCH_CLIENT_SECRET)?) else {
        return Ok(None);
    };
    if id.is_empty() || secret.is_empty() {
        return Ok(None);
    }
    Ok(Some((id, secret)))
}

pub fn clear_twitch_credentials() -> AppResult<()> {
    clear(TWITCH_CLIENT_ID)?;
    clear(TWITCH_CLIENT_SECRET)
}

/// Discord webhook URL.
///
/// The whole URL is the credential: the token in its last path segment is all
/// anyone needs to post into that channel, so it goes in the vault beside the
/// API key rather than in the settings database, and it is never handed back to
/// the frontend. [`crate::webhook`] validates the shape before this is called.
pub fn set_discord_webhook(url: &str) -> AppResult<()> {
    store(DISCORD_WEBHOOK, url.trim())
}

pub fn discord_webhook() -> AppResult<Option<String>> {
    Ok(load(DISCORD_WEBHOOK)?.filter(|v| !v.trim().is_empty()))
}

pub fn clear_discord_webhook() -> AppResult<()> {
    clear(DISCORD_WEBHOOK)
}

/// A non-reversible preview such as `a1b2…9f8e`, safe to show in the UI.
///
/// Short secrets are masked entirely rather than half-revealed.
pub fn mask(secret: &str) -> String {
    let n = secret.chars().count();
    if n == 0 {
        return String::new();
    }
    if n <= 8 {
        return "•".repeat(n.max(4));
    }
    let head: String = secret.chars().take(4).collect();
    let tail: String = secret.chars().skip(n - 4).collect();
    format!("{head}••••{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_hides_short_secrets_entirely() {
        assert_eq!(mask("abcd"), "••••");
        assert_eq!(mask("abcdefgh"), "••••••••");
    }

    #[test]
    fn mask_shows_only_the_ends_of_long_secrets() {
        let masked = mask("0123456789abcdef");
        assert_eq!(masked, "0123••••cdef");
        assert!(!masked.contains("456789ab"));
    }

    #[test]
    fn mask_of_empty_is_empty() {
        assert_eq!(mask(""), "");
    }

    #[test]
    fn rejects_keys_with_whitespace() {
        assert!(set_api_key("has space").is_err());
    }
}
