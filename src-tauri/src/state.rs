//! Shared application state.
//!
//! One [`AppState`] is created at startup and handed to every command. It owns
//! the HTTP client, the database and the video prober, and it caches the
//! authenticated user's identity so the queue can be filtered to the games this
//! moderator actually moderates.
//!
//! The API key is deliberately *not* stored here. It is read from the OS vault
//! at the moment of each request, so a memory dump of the state struct contains
//! no secret, and revoking the key takes effect immediately.

use std::sync::Arc;

use parking_lot::RwLock;
use tokio::sync::Mutex as AsyncMutex;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::src_api::{models::User, SrcClient};
use crate::video::ProbeClient;

/// Requests per minute allowed against the Speedrun.com API.
///
/// The public documentation states 100/minute for authenticated use; the
/// default sits at that ceiling and the settings page can lower it.
pub const DEFAULT_RATE_LIMIT: u64 = 100;

/// Settings key holding the configured request budget.
pub const RATE_LIMIT_KEY: &str = "api.requestsPerMinute";

pub struct AppState {
    pub db: Arc<Db>,
    client: RwLock<Arc<SrcClient>>,
    probe: RwLock<Arc<ProbeClient>>,
    /// The signed-in moderator, resolved from `GET /profile`.
    profile: RwLock<Option<User>>,
    /// Serialises write operations so two bulk actions cannot interleave
    /// against the same run.
    pub write_lock: AsyncMutex<()>,
}

impl AppState {
    /// Builds the state, loading tuning values from the database.
    pub fn new(db: Db) -> AppResult<Self> {
        let db = Arc::new(db);
        let rpm = db.setting_u64(RATE_LIMIT_KEY, DEFAULT_RATE_LIMIT) as usize;
        let client = SrcClient::new(rpm)?;
        let twitch = crate::secrets::twitch_credentials().unwrap_or(None);

        Ok(Self {
            db,
            client: RwLock::new(Arc::new(client)),
            probe: RwLock::new(Arc::new(ProbeClient::new(twitch))),
            profile: RwLock::new(None),
            write_lock: AsyncMutex::new(()),
        })
    }

    /// Current API client. Cloned per call so a reconfigure mid-request is safe.
    pub fn client(&self) -> Arc<SrcClient> {
        self.client.read().clone()
    }

    pub fn probe(&self) -> Arc<ProbeClient> {
        self.probe.read().clone()
    }

    /// Rebuilds the API client with a new request budget.
    pub fn set_rate_limit(&self, requests_per_minute: usize) -> AppResult<()> {
        let client = SrcClient::new(requests_per_minute)?;
        *self.client.write() = Arc::new(client);
        Ok(())
    }

    /// Rebuilds the video prober after Twitch credentials change.
    pub fn refresh_probe(&self) {
        let twitch = crate::secrets::twitch_credentials().unwrap_or(None);
        *self.probe.write() = Arc::new(ProbeClient::new(twitch));
    }

    pub fn profile(&self) -> Option<User> {
        self.profile.read().clone()
    }

    pub fn set_profile(&self, user: Option<User>) {
        *self.profile.write() = user;
    }

    /// ID of the signed-in moderator, or a "sign in first" error.
    pub fn require_user_id(&self) -> AppResult<String> {
        self.profile()
            .map(|u| u.id)
            .ok_or(AppError::MissingCredentials)
    }

    /// Reads the API key from the OS vault for a single request.
    pub fn api_key(&self) -> AppResult<String> {
        crate::secrets::require_api_key()
    }
}
