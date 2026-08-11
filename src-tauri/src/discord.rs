//! Discord Rich Presence.
//!
//! Discord's local IPC is a named pipe (`\\?\pipe\discord-ipc-N` on Windows)
//! spoken with blocking file reads and writes. Every call — the handshake, each
//! presence update — parks the calling thread until Discord answers or the pipe
//! breaks. That is why this module owns a dedicated OS thread instead of a
//! `tokio` task: one unlucky write inside the async runtime would stall every
//! Speedrun.com request sharing that worker.
//!
//! The thread is the only thing that touches the client. Callers post commands
//! down a channel and never block. Discord not running is the normal state, not
//! an error: the worker keeps retrying, and the presence appears by itself when
//! Discord starts.
//!
//! Nothing here reads a credential. The Application ID is public by design —
//! it is the number printed on the app's own Developer Portal page — so it
//! lives in the settings database rather than the credential vault.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use discord_rich_presence::activity::{Activity, Assets, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::error::{AppError, AppResult};

/// Art asset key, as uploaded in the Developer Portal under Rich Presence →
/// Art Assets.
///
/// Discord resolves artwork by this name against the application the
/// Application ID belongs to; it is neither a URL nor a local file. Changing it
/// here without renaming the upload leaves the presence with no image.
const LARGE_IMAGE: &str = "srclogo";

/// Hover text on the large image.
const LARGE_TEXT: &str = "SRCTools Moderator Toolkit";

/// Overrides the application name on the presence card.
const APP_NAME: &str = "SRCTools";

/// Shown when the moderator has turned the page line off, so the card is never
/// a bare title with nothing under it.
const IDLE_DETAILS: &str = "Reviewing Speedrun.com runs";

/// Emitted whenever the connection state changes, so Settings shows the truth
/// without polling.
const DISCORD_EVENT: &str = "srctools://discord";

/// How long the worker waits for a command before re-examining the connection.
/// This is also the reconnect cadence while Discord is closed.
const RECONNECT_EVERY: Duration = Duration::from_secs(15);

/// Slept on instead when Rich Presence is switched off entirely.
const IDLE_WAIT: Duration = Duration::from_secs(3600);

/// Minimum spacing between presence updates.
///
/// Discord rate limits activity updates, and Fast Review can walk through a
/// dozen runs in a few seconds. Updates are coalesced to the newest state
/// rather than queued.
const MIN_UPDATE_GAP: Duration = Duration::from_secs(2);

/// Discord caps `details` and `state` at 128 characters and silently rejects
/// the payload beyond that.
const FIELD_LIMIT: usize = 128;

/// What the presence should say right now.
///
/// Both lines are optional: the four `discordShow*` preferences decide what the
/// frontend puts here, and a field the moderator turned off simply arrives as
/// `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    /// Discord's "Details" line — the current page, e.g. `Review Queue`.
    pub details: Option<String>,
    /// Discord's "State" line — e.g. `4 pending runs`.
    pub state: Option<String>,
}

impl Presence {
    /// Trims each line to something Discord will accept.
    ///
    /// Control characters are stripped rather than escaped: a game name pulled
    /// from the API is untrusted text, and a stray newline would either break
    /// the card's layout or get the whole payload rejected.
    fn sanitised(self) -> Self {
        Self {
            details: clean(self.details),
            state: clean(self.state),
        }
    }
}

fn clean(value: Option<String>) -> Option<String> {
    let text: String = value?
        .chars()
        .filter(|c| !c.is_control())
        .take(FIELD_LIMIT)
        .collect();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Connection state, as the settings page renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordStatus {
    /// Rich Presence is switched on and an Application ID is configured.
    pub enabled: bool,
    /// A presence is currently published.
    pub connected: bool,
    /// Why the last attempt failed, when one did. Carries no credential.
    pub last_error: Option<String>,
}

impl DiscordStatus {
    const fn off() -> Self {
        Self {
            enabled: false,
            connected: false,
            last_error: None,
        }
    }
}

enum Command {
    /// Use this Application ID. Reconnects when it differs from the current one.
    Enable(String),
    Disable,
    Publish(Box<Presence>),
    /// Drop the pipe and connect again, for the Reconnect button.
    Reconnect,
}

/// Handle to the presence worker. One is managed by Tauri for the app's life.
pub struct Discord {
    tx: Sender<Command>,
    status: Arc<RwLock<DiscordStatus>>,
}

impl Discord {
    /// Starts the worker thread. Idle until something enables it.
    pub fn spawn(app: tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::channel();
        let status = Arc::new(RwLock::new(DiscordStatus::off()));

        let worker_status = Arc::clone(&status);
        // Named so it is identifiable in a debugger or a crash dump.
        let spawned = thread::Builder::new()
            .name("srctools-discord".into())
            .spawn(move || run(&rx, &worker_status, &app));

        if let Err(e) = spawned {
            // A machine that cannot spawn a thread has larger problems, but the
            // rest of the app works without a presence, so this is a warning.
            tracing::warn!("could not start the Discord presence thread: {e}");
        }

        Self { tx, status }
    }

    pub fn status(&self) -> DiscordStatus {
        self.status.read().clone()
    }

    /// Applies the two settings that decide whether a presence is published.
    ///
    /// The returned status is what is true *now*: connecting happens on the
    /// worker thread, and the `srctools://discord` event reports the outcome.
    pub fn configure(&self, enabled: bool, app_id: &str) -> AppResult<DiscordStatus> {
        let id = app_id.trim();

        if !enabled || id.is_empty() {
            self.send(Command::Disable);
            *self.status.write() = DiscordStatus::off();
            return Ok(DiscordStatus::off());
        }

        // A Discord snowflake is a decimal integer. Catching a pasted URL or a
        // client secret here turns a silent "never connects" into a message.
        if !id.chars().all(|c| c.is_ascii_digit()) || id.len() < 17 || id.len() > 20 {
            return Err(AppError::InvalidInput(
                "That is not a Discord Application ID. It is the 18-or-so digit number shown on your application's General Information page.".into(),
            ));
        }

        let pending = DiscordStatus {
            enabled: true,
            connected: false,
            last_error: None,
        };
        *self.status.write() = pending.clone();
        self.send(Command::Enable(id.to_string()));
        Ok(pending)
    }

    /// Queues a presence update. Cheap enough to call on every navigation.
    pub fn publish(&self, presence: Presence) {
        self.send(Command::Publish(Box::new(presence.sanitised())));
    }

    pub fn reconnect(&self) -> DiscordStatus {
        self.send(Command::Reconnect);
        self.status()
    }

    /// A closed channel means the worker thread is gone; there is nothing to
    /// tell the moderator about, and the presence is simply absent.
    fn send(&self, command: Command) {
        if self.tx.send(command).is_err() {
            tracing::debug!("the Discord presence thread is not running");
        }
    }
}

/// Builds the activity Discord will render.
///
/// Borrows from `presence`, so the caller keeps it alive across the call.
fn build(presence: &Presence, started_ms: i64) -> Activity<'_> {
    let mut activity = Activity::new()
        .name(APP_NAME)
        .assets(
            Assets::new()
                .large_image(LARGE_IMAGE)
                .large_text(LARGE_TEXT),
        )
        // Elapsed time is genuine: it counts from when this process started.
        .timestamps(Timestamps::new().start(started_ms))
        .details(presence.details.as_deref().unwrap_or(IDLE_DETAILS));

    if let Some(state) = presence.state.as_deref() {
        activity = activity.state(state);
    }
    activity
}

/// Turns a transport failure into something worth showing a moderator.
fn describe(err: &discord_rich_presence::error::Error) -> String {
    use discord_rich_presence::error::Error as E;
    match err {
        E::IPCConnectionFailed | E::IPCNotFound | E::NotConnected => {
            "Discord is not running, or it is not accepting local connections.".to_string()
        }
        other => format!("The Discord connection failed: {other}"),
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Publishes a status change, and only a change.
///
/// The worker reconciles on a timer, so most passes decide nothing happened;
/// emitting each of those would wake the frontend fifteen times a minute for
/// no reason.
fn set_status(shared: &RwLock<DiscordStatus>, app: &tauri::AppHandle, next: DiscordStatus) {
    {
        let mut guard = shared.write();
        if *guard == next {
            return;
        }
        *guard = next.clone();
    }
    let _ = app.emit(DISCORD_EVENT, next);
}

/// Closes the pipe, ignoring anything that goes wrong on the way out.
fn close(client: &mut Option<DiscordIpcClient>) {
    if let Some(mut open) = client.take() {
        let _ = open.close();
    }
}

/// The worker loop.
///
/// One pass: absorb every queued command, make the connection match what was
/// asked for, then publish the newest presence if it is due.
fn run(rx: &Receiver<Command>, status: &RwLock<DiscordStatus>, app: &tauri::AppHandle) {
    let started_ms = now_millis();

    let mut client: Option<DiscordIpcClient> = None;
    let mut app_id: Option<String> = None;
    let mut presence = Presence::default();
    let mut last_error: Option<String> = None;
    let mut last_sent: Option<Instant> = None;
    // Something changed that Discord has not been told about yet.
    let mut dirty = false;
    let mut wait = IDLE_WAIT;

    loop {
        let first = match rx.recv_timeout(wait) {
            Ok(command) => Some(command),
            Err(RecvTimeoutError::Timeout) => None,
            // The handle was dropped: the app is shutting down. Discord clears
            // the presence itself once the pipe closes.
            Err(RecvTimeoutError::Disconnected) => {
                close(&mut client);
                return;
            }
        };

        // Drain the rest of the burst. Walking through five runs in Fast Review
        // has to cost one presence update, not five.
        let mut batch: Vec<Command> = first.into_iter().collect();
        while let Ok(command) = rx.try_recv() {
            batch.push(command);
        }

        for command in batch {
            match command {
                Command::Enable(id) => {
                    if app_id.as_deref() != Some(id.as_str()) {
                        // A different application means different artwork; the
                        // old pipe cannot be reused.
                        close(&mut client);
                        app_id = Some(id);
                        last_error = None;
                    }
                    dirty = true;
                }
                Command::Disable => {
                    // Clear before closing: dropping the pipe alone leaves the
                    // presence on the profile for a while afterwards.
                    if let Some(open) = client.as_mut() {
                        let _ = open.clear_activity();
                    }
                    close(&mut client);
                    app_id = None;
                    last_error = None;
                    dirty = false;
                }
                Command::Publish(next) => {
                    if *next != presence {
                        presence = *next;
                        dirty = true;
                    }
                }
                Command::Reconnect => {
                    close(&mut client);
                    last_error = None;
                    dirty = true;
                }
            }
        }

        let Some(id) = app_id.clone() else {
            set_status(status, app, DiscordStatus::off());
            wait = IDLE_WAIT;
            continue;
        };

        if client.is_none() {
            let mut fresh = DiscordIpcClient::new(&id);
            match fresh.connect() {
                Ok(()) => {
                    client = Some(fresh);
                    last_error = None;
                    // A new pipe knows nothing about the last activity.
                    dirty = true;
                    last_sent = None;
                }
                Err(e) => {
                    // Expected whenever Discord is closed, so this is not an
                    // error the moderator is interrupted about — it is a state
                    // the settings page renders, and the loop keeps trying.
                    last_error = Some(describe(&e));
                    set_status(
                        status,
                        app,
                        DiscordStatus {
                            enabled: true,
                            connected: false,
                            last_error: last_error.clone(),
                        },
                    );
                    wait = RECONNECT_EVERY;
                    continue;
                }
            }
        }

        if dirty {
            let since = last_sent.map(|t| t.elapsed());
            match since {
                // Too soon: come back when the gap has passed, still dirty.
                Some(elapsed) if elapsed < MIN_UPDATE_GAP => {
                    wait = MIN_UPDATE_GAP - elapsed;
                    continue;
                }
                _ => {}
            }

            if let Some(open) = client.as_mut() {
                match open.set_activity(build(&presence, started_ms)) {
                    Ok(()) => {
                        dirty = false;
                        last_sent = Some(Instant::now());
                        last_error = None;
                    }
                    Err(e) => {
                        // Discord quitting surfaces as a failed read or write.
                        // Drop the client so the next pass reconnects instead
                        // of writing into a dead pipe forever.
                        last_error = Some(describe(&e));
                        close(&mut client);
                    }
                }
            }
        }

        set_status(
            status,
            app,
            DiscordStatus {
                enabled: true,
                connected: client.is_some(),
                last_error: last_error.clone(),
            },
        );
        wait = RECONNECT_EVERY;
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Applies the Rich Presence settings and starts or stops publishing.
#[tauri::command]
pub fn discord_configure(
    discord: State<'_, Discord>,
    enabled: bool,
    app_id: String,
) -> AppResult<DiscordStatus> {
    discord.configure(enabled, &app_id)
}

/// Updates what the presence says. Silently ignored when it is switched off.
#[tauri::command]
pub fn discord_publish(discord: State<'_, Discord>, presence: Presence) {
    discord.publish(presence);
}

/// Drops the pipe and connects again, for the Reconnect button.
#[tauri::command]
pub fn discord_reconnect(discord: State<'_, Discord>) -> DiscordStatus {
    discord.reconnect()
}

#[tauri::command]
pub fn discord_status(discord: State<'_, Discord>) -> DiscordStatus {
    discord.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_fields_are_cut_to_what_discord_accepts() {
        let long = "a".repeat(400);
        let cleaned = Presence {
            details: Some(long),
            state: None,
        }
        .sanitised();
        assert_eq!(cleaned.details.unwrap().chars().count(), FIELD_LIMIT);
    }

    #[test]
    fn control_characters_are_stripped() {
        let cleaned = Presence {
            details: Some("Review\nQueue\u{0}".into()),
            state: None,
        }
        .sanitised();
        assert_eq!(cleaned.details.as_deref(), Some("ReviewQueue"));
    }

    #[test]
    fn blank_fields_become_none() {
        let cleaned = Presence {
            details: Some("   ".into()),
            state: Some(String::new()),
        }
        .sanitised();
        assert!(cleaned.details.is_none());
        assert!(cleaned.state.is_none());
    }

    #[test]
    fn the_details_line_is_never_empty() {
        let nothing = Presence::default();
        let activity = build(&nothing, 0);
        let json = serde_json::to_value(&activity).expect("activity serialises");
        assert_eq!(json["details"], IDLE_DETAILS);
        assert_eq!(json["assets"]["large_image"], LARGE_IMAGE);
        assert_eq!(json["assets"]["large_text"], LARGE_TEXT);
        // Nothing to say about the state, so the field is left out entirely
        // rather than sent as an empty string.
        assert!(json.get("state").is_none());
    }
}
