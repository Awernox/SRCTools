//! Discord webhook delivery.
//!
//! The chain is: Speedrun.com → SRCTools → desktop notification and sound →
//! this module → a Discord channel.
//!
//! The URL is a credential, not a preference. Its last path segment is a token,
//! and anyone holding it can post into the channel forever, so it lives in the
//! OS vault next to the API key ([`crate::secrets`]) and is never returned to
//! the frontend — the settings page only ever sees the masked preview built by
//! [`preview`].
//!
//! Two things here are security measures rather than polish:
//!
//! - [`parse`] refuses any host that is not Discord's, and refuses http. A
//!   mistyped or malicious URL would otherwise send run data, and the token
//!   itself, to a stranger's server. Redirects are disabled for the same
//!   reason: a 302 must not be able to forward the token elsewhere.
//! - Every payload sets `allowed_mentions.parse = []`. Runner names, category
//!   names and rejection reasons are text SRCTools did not write; a runner
//!   called `@everyone` must not be able to ping a moderation channel.

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{AppError, AppResult};
use crate::secrets;

/// Hosts Discord serves webhooks from. `discordapp.com` is the legacy domain
/// and still appears in URLs copied from older clients.
const ALLOWED_HOSTS: [&str; 5] = [
    "discord.com",
    "discordapp.com",
    "ptb.discord.com",
    "canary.discord.com",
    "media.discordapp.net",
];

/// Sent by the Test webhook button, verbatim.
const TEST_MESSAGE: &str = "✅ SRCTools webhook connected";

/// Discord's own limits. Exceeding any of them fails the whole request with a
/// 400, so payloads are trimmed to fit rather than sent hopefully.
const TITLE_LIMIT: usize = 256;
const FIELD_VALUE_LIMIT: usize = 1024;
const EMBEDS_PER_MESSAGE: usize = 10;

/// Shared client for webhook traffic only.
///
/// Deliberately separate from the Speedrun.com client: that one carries the API
/// key in a default header, and those headers must never travel to Discord.
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(8))
            .user_agent(concat!("SRCTools/", env!("CARGO_PKG_VERSION")))
            // A redirect would hand the webhook token to whatever host the
            // response points at. There is no legitimate redirect here.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    })
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/// Validates a webhook URL and returns it parsed.
///
/// Rejects anything that is not an https Discord webhook endpoint.
pub fn parse(raw: &str) -> AppResult<Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("Enter a webhook URL.".into()));
    }

    let url = Url::parse(trimmed).map_err(|_| {
        AppError::InvalidInput(
            "That is not a URL. Copy it from Discord: Channel settings → Integrations → Webhooks → Copy Webhook URL.".into(),
        )
    })?;

    if url.scheme() != "https" {
        return Err(AppError::InvalidInput(
            "A webhook URL must start with https://.".into(),
        ));
    }

    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(AppError::InvalidInput(
            "That URL does not point at Discord. SRCTools only sends webhooks to discord.com.".into(),
        ));
    }

    // .../api/webhooks/{id}/{token}, optionally with an /api/v10 version segment.
    let segments: Vec<&str> = url
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();
    let shaped = segments.first() == Some(&"api")
        && segments
            .iter()
            .position(|s| *s == "webhooks")
            // An id and a token must follow it, and nothing after those.
            .is_some_and(|i| segments.len() == i + 3);
    if !shaped {
        return Err(AppError::InvalidInput(
            "That is a Discord link, but not a webhook URL. Use Copy Webhook URL in the channel's Integrations settings.".into(),
        ));
    }

    Ok(url)
}

/// A preview safe to render in Settings, e.g.
/// `discord.com/api/webhooks/…4821/••••••••`.
///
/// The token is replaced outright — never abbreviated — because any part of it
/// is still part of a live credential. The last four digits of the webhook *id*
/// are kept so two saved webhooks can be told apart; an id alone cannot post
/// anything.
pub fn preview(raw: &str) -> String {
    let Ok(url) = Url::parse(raw.trim()) else {
        return "••••••••".to_string();
    };
    let host = url.host_str().unwrap_or("discord.com");
    let segments: Vec<&str> = url
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    // The id is the second-to-last segment, the token the last.
    let tail = match segments.len().checked_sub(2).and_then(|i| segments.get(i)) {
        Some(id) if id.chars().count() > 4 => {
            let last: String = id.chars().skip(id.chars().count() - 4).collect();
            format!("…{last}")
        }
        Some(id) => (*id).to_string(),
        None => "…".to_string(),
    };

    format!("{host}/api/webhooks/{tail}/••••••••")
}

/// What Settings needs to render the webhook card, and nothing more.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookStatus {
    pub configured: bool,
    /// Masked; `None` when nothing is stored.
    pub preview: Option<String>,
}

fn status_now() -> AppResult<WebhookStatus> {
    let stored = secrets::discord_webhook()?;
    Ok(WebhookStatus {
        configured: stored.is_some(),
        preview: stored.as_deref().map(preview),
    })
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Which of the five toggles produced this message.
///
/// The toggles themselves live in the frontend settings, where the moderator
/// set them; this only decides how the message looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    NewRun,
    Approved,
    Rejected,
    DeletedVideo,
    VideoProblem,
}

impl EventKind {
    fn title(self) -> &'static str {
        match self {
            Self::NewRun => "🏆 **New Run**",
            Self::Approved => "✅ **Run verified**",
            Self::Rejected => "❌ Run rejected",
            Self::DeletedVideo => "🗑️ Video no longer available",
            Self::VideoProblem => "⚠️ Video problem",
        }
    }

    /// Left border colour of the embed, as Discord's integer RGB.
    fn colour(self) -> u32 {
        match self {
            Self::NewRun => 0x0058_65F2,       // blurple
            Self::Approved => 0x0057_F287,     // green
            Self::Rejected => 0x00ED_4245,     // red
            Self::DeletedVideo => 0x0099_2D22, // dark red
            Self::VideoProblem => 0x00FE_E75C, // yellow
        }
    }

    /// Default for the `Status` line when the caller does not supply one.
    fn status(self) -> &'static str {
        match self {
            Self::NewRun => "Pending",
            Self::Approved => "Approved",
            Self::Rejected => "Rejected",
            Self::DeletedVideo => "Video deleted",
            Self::VideoProblem => "Needs a look",
        }
    }
}

/// One run, as the frontend knows it.
///
/// Every field is optional on purpose. Speedrun.com does not always expose a
/// category, a time or a video, and a webhook must report what is actually
/// known rather than fill the gaps in — a missing field is left out of the
/// embed entirely.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub kind: Option<EventKind>,
    pub game: Option<String>,
    pub runner: Option<String>,
    pub category: Option<String>,
    /// The level/map name, when the run is on a level rather than the full game.
    pub level_name: Option<String>,
    pub time: Option<String>,
    pub duration_seconds: Option<f64>,
    pub status: Option<String>,
    pub video_url: Option<String>,
    /// Link to the run on Speedrun.com; makes the embed title clickable.
    pub run_url: Option<String>,
    /// Free text for the cases that need one: a rejection reason, or what is
    /// wrong with a video.
    pub detail: Option<String>,
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct Message {
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    embeds: Vec<Embed>,
    /// Empty `parse` disables every mention, so untrusted text cannot ping a
    /// channel. Always sent.
    allowed_mentions: AllowedMentions,
}

#[derive(Debug, Default, Serialize)]
struct AllowedMentions {
    /// Empty: no `@everyone`, role or user mention is ever honoured, whatever
    /// a runner happens to have called themselves.
    parse: [&'static str; 0],
}

#[derive(Debug, Serialize)]
struct Embed {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    color: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    fields: Vec<Field>,
}

#[derive(Debug, Serialize)]
struct Field {
    name: String,
    value: String,
    inline: bool,
}

/// Trims a value to Discord's limit and drops control characters.
fn field_text(value: Option<&String>, limit: usize) -> Option<String> {
    let text: String = value?
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .collect();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(limit).collect())
}

/// Only accepts a link Discord will render, so a malformed URL becomes an
/// absent field rather than a broken embed.
fn link(value: Option<&String>) -> Option<String> {
    let raw = value?.trim();
    let url = Url::parse(raw).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// The run's time, preferring the precise duration when it is known.
fn run_time(event: &RunEvent) -> Option<String> {
    event
        .duration_seconds
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(|seconds| {
            let total_ms = (seconds * 1000.0).round() as u64;
            format!(
                "{}m {}s {:03}ms",
                total_ms / 60_000,
                (total_ms / 1_000) % 60,
                total_ms % 1_000,
            )
        })
        .or_else(|| field_text(event.time.as_ref(), FIELD_VALUE_LIMIT))
}

/// The one-line summary for New Run, Run verified and Run rejected:
/// `Map in Time by Runner`, with no field labels. The map is the level name
/// when the run is on one; games without levels fall back to the category,
/// which for level-based games names the map.
fn run_summary(event: &RunEvent) -> String {
    let map = field_text(event.level_name.as_ref(), FIELD_VALUE_LIMIT)
        .or_else(|| field_text(event.category.as_ref(), FIELD_VALUE_LIMIT))
        .unwrap_or_else(|| "Unknown map".to_string());
    let time = run_time(event).unwrap_or_else(|| "Unknown time".to_string());
    let runner = field_text(event.runner.as_ref(), FIELD_VALUE_LIMIT)
        .unwrap_or_else(|| "Unknown runner".to_string());
    format!("{map} in {time} by {runner}")
}

fn push_field(fields: &mut Vec<Field>, name: &str, value: Option<String>, inline: bool) {
    if let Some(value) = value {
        fields.push(Field {
            name: name.to_string(),
            value,
            inline,
        });
    }
}

/// Builds the embed for one run.
///
/// New Run, Run verified and Run rejected share one compact shape: a single
/// description line `Map in Time by Runner`, with no field labels. The map is
/// the level name when the run is on one. Everything else follows the general
/// shape: Game, Runner, Category, Time, Status, Video, with the detail as the
/// description.
///
/// No footer and no timestamp. Discord renders the two together as a single
/// "Sent by SRCTools · Today at 14:02" line under the embed, and the channel
/// already stamps every message it shows with its own time.
fn embed(event: &RunEvent) -> Embed {
    let kind = event.kind.unwrap_or(EventKind::NewRun);

    // New Run, Run verified and Run rejected share one compact shape: a single
    // description line `Map in Time by Runner`, with no field labels. A
    // rejection also carries its reason as a labelled field.
    if matches!(kind, EventKind::NewRun | EventKind::Approved | EventKind::Rejected) {
        let mut fields = Vec::new();
        if kind == EventKind::Rejected {
            push_field(&mut fields, "Reason", field_text(event.detail.as_ref(), FIELD_VALUE_LIMIT), false);
        }
        return Embed {
            title: kind.title().chars().take(TITLE_LIMIT).collect(),
            url: link(event.run_url.as_ref()),
            description: Some(run_summary(event)),
            color: kind.colour(),
            fields,
        };
    }

    // The video kinds explain themselves in prose above the fields.
    let mut fields = Vec::with_capacity(7);

    push_field(&mut fields, "Game", field_text(event.game.as_ref(), FIELD_VALUE_LIMIT), true);
    push_field(&mut fields, "Runner", field_text(event.runner.as_ref(), FIELD_VALUE_LIMIT), true);
    push_field(&mut fields, "Category", field_text(event.category.as_ref(), FIELD_VALUE_LIMIT), true);
    push_field(&mut fields, "Time", field_text(event.time.as_ref(), FIELD_VALUE_LIMIT), true);

    let status = field_text(event.status.as_ref(), FIELD_VALUE_LIMIT)
        .unwrap_or_else(|| kind.status().to_string());
    push_field(&mut fields, "Status", Some(status), true);

    // No video link is a fact worth stating: a submission without one is
    // something a moderator needs to notice.
    let video = link(event.video_url.as_ref()).unwrap_or_else(|| "No video link".to_string());
    push_field(&mut fields, "Video", Some(video), false);

    Embed {
        title: kind.title().chars().take(TITLE_LIMIT).collect(),
        url: link(event.run_url.as_ref()),
        description: field_text(event.detail.as_ref(), FIELD_VALUE_LIMIT),
        color: kind.colour(),
        fields,
    }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/// POSTs one message, retrying once if Discord asks us to slow down.
///
/// Discord's failures are reported in Discord's own words: the shared
/// [`AppError`] variants for HTTP status name Speedrun.com in their messages,
/// and blaming the wrong service for a bad webhook URL sends the moderator to
/// the wrong settings tab.
async fn post(url: &str, message: &Message) -> AppResult<()> {
    for attempt in 0..2 {
        let response = http()
            .post(url)
            .json(message)
            .send()
            .await
            .map_err(|e| {
                AppError::Network(if e.is_timeout() {
                    "Discord did not answer in time.".to_string()
                } else {
                    format!("Could not reach Discord: {e}")
                })
            })?;

        let status = response.status();
        if status.is_success() {
            return Ok(());
        }

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt == 0 {
            // Discord reports the wait in seconds, as a float, in the body.
            let wait = response
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("retry_after").and_then(serde_json::Value::as_f64))
                .unwrap_or(1.0)
                .clamp(0.0, 10.0);
            tokio::time::sleep(Duration::from_secs_f64(wait)).await;
            continue;
        }

        // The response body can quote the payload back, which would put run
        // text — and in the 401 case the token — into an error message. The
        // status alone is enough to say what to do about it.
        return Err(AppError::InvalidInput(match status.as_u16() {
            401 | 403 => "Discord rejected this webhook. Its token is wrong, or the webhook was deleted — copy the URL from the channel again.".to_string(),
            404 => "Discord has no webhook at this URL. It was probably deleted in the channel's Integrations settings.".to_string(),
            429 => "Discord is rate limiting this webhook. Try again in a moment.".to_string(),
            code => format!("Discord rejected the message (HTTP {code})."),
        }));
    }

    Err(AppError::InvalidInput(
        "Discord is rate limiting this webhook. Try again in a moment.".to_string(),
    ))
}

/// Sends `events` as embeds, ten to a message.
///
/// Returns how many run messages were delivered. Nothing here decides *whether* an
/// event is worth sending — the five toggles do that, before this is called.
pub async fn send(events: &[RunEvent]) -> AppResult<usize> {
    let Some(url) = secrets::discord_webhook()? else {
        return Err(AppError::InvalidInput(
            "No webhook URL is saved. Add one in Settings → Notifications.".into(),
        ));
    };
    if events.is_empty() {
        return Ok(0);
    }
    // Re-validate on the way out: a URL saved by an older build, or edited in
    // the vault by hand, still must not send run data to a non-Discord host.
    parse(&url)?;

    let mut sent = 0usize;

    for chunk in events.chunks(EMBEDS_PER_MESSAGE) {
        let message = Message {
            content: None,
            embeds: chunk.iter().map(embed).collect(),
            allowed_mentions: AllowedMentions::default(),
        };
        post(&url, &message).await?;
        sent += chunk.len();
    }

    Ok(sent)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Validates and stores a webhook URL. The plaintext never comes back.
#[tauri::command]
pub fn webhook_set_url(url: String) -> AppResult<WebhookStatus> {
    let parsed = parse(&url)?;
    secrets::set_discord_webhook(parsed.as_str())?;
    status_now()
}

/// The Remove webhook button. Deletes the credential outright.
#[tauri::command]
pub fn webhook_clear_url() -> AppResult<WebhookStatus> {
    secrets::clear_discord_webhook()?;
    status_now()
}

#[tauri::command]
pub fn webhook_status() -> AppResult<WebhookStatus> {
    status_now()
}

/// The Test webhook button: posts the confirmation line into the channel.
#[tauri::command]
pub async fn webhook_test() -> AppResult<()> {
    let Some(url) = secrets::discord_webhook()? else {
        return Err(AppError::InvalidInput(
            "Save a webhook URL first, then test it.".into(),
        ));
    };
    parse(&url)?;

    post(
        &url,
        &Message {
            content: Some(TEST_MESSAGE.to_string()),
            embeds: Vec::new(),
            allowed_mentions: AllowedMentions::default(),
        },
    )
    .await
}

/// Posts one or more run events. Called by the watcher and by moderation
/// actions, only for the events the moderator enabled.
#[tauri::command]
pub async fn webhook_send(events: Vec<RunEvent>) -> AppResult<usize> {
    send(&events).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = "https://discord.com/api/webhooks/1234567890123456789/aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";

    #[test]
    fn accepts_a_discord_webhook_url() {
        assert!(parse(REAL).is_ok());
        assert!(parse("https://discordapp.com/api/webhooks/123456/tok3n").is_ok());
        assert!(parse("https://discord.com/api/v10/webhooks/123456/tok3n").is_ok());
    }

    #[test]
    fn refuses_a_foreign_host() {
        // The whole point of the allow-list: this would exfiltrate run data and
        // the token to someone else's server.
        assert!(parse("https://example.com/api/webhooks/123456/tok3n").is_err());
        assert!(parse("https://discord.com.evil.net/api/webhooks/1/2").is_err());
    }

    #[test]
    fn refuses_plain_http() {
        assert!(parse("http://discord.com/api/webhooks/123456/tok3n").is_err());
    }

    #[test]
    fn refuses_a_discord_link_that_is_not_a_webhook() {
        assert!(parse("https://discord.com/channels/1/2").is_err());
        assert!(parse("").is_err());
        assert!(parse("not a url").is_err());
    }

    #[test]
    fn preview_never_contains_the_token() {
        let shown = preview(REAL);
        assert!(!shown.contains("aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"));
        assert!(!shown.contains("aBcD"));
        // Enough of the id to tell two webhooks apart, and no more.
        assert_eq!(shown, "discord.com/api/webhooks/…6789/••••••••");
    }

    #[test]
    fn preview_of_rubbish_is_still_masked() {
        assert_eq!(preview("not a url"), "••••••••");
    }

    #[test]
    fn a_new_run_is_a_compact_embed() {
        let event = RunEvent {
            kind: Some(EventKind::NewRun),
            game: Some("Niwa".into()),
            level_name: Some("Niwa".into()),
            runner: Some("DuyThinhLu".into()),
            duration_seconds: Some(17.879),
            run_url: Some("https://www.speedrun.com/run/abc".into()),
            ..RunEvent::default()
        };
        let built = embed(&event);
        assert_eq!(built.title, "🏆 **New Run**");
        assert_eq!(built.url.as_deref(), Some("https://www.speedrun.com/run/abc"));
        assert_eq!(
            built.description.as_deref(),
            Some("Niwa in 0m 17s 879ms by DuyThinhLu")
        );
        assert!(built.fields.is_empty());
        assert_eq!(built.color, 0x0058_65F2);
    }

    #[test]
    fn an_approved_run_is_a_compact_verified_embed() {
        let event = RunEvent {
            kind: Some(EventKind::Approved),
            game: Some("Bhop pro".into()),
            runner: Some("337Short337".into()),
            level_name: Some("Niwa".into()),
            time: Some("2:02:22.022".into()),
            run_url: Some("https://www.speedrun.com/run/abc".into()),
            ..RunEvent::default()
        };
        let built = embed(&event);
        assert_eq!(built.title, "✅ **Run verified**");
        assert_eq!(built.url.as_deref(), Some("https://www.speedrun.com/run/abc"));
        assert_eq!(
            built.description.as_deref(),
            Some("Niwa in 2:02:22.022 by 337Short337")
        );
        assert!(built.fields.is_empty());
        assert_eq!(built.color, 0x0057_F287);
    }

    #[test]
    fn an_embed_carries_no_footer_and_no_timestamp() {
        // Discord renders the two as one "Sent by SRCTools · Today at …" line
        // under the embed. The channel already timestamps every message it
        // shows, so the line said nothing twice and was asked to go.
        let json = serde_json::to_value(embed(&RunEvent::default())).expect("serialises");
        assert!(json.get("footer").is_none(), "no footer: {json}");
        assert!(json.get("timestamp").is_none(), "no timestamp: {json}");
    }

    #[test]
    fn a_new_run_rounds_time_to_milliseconds() {
        let event = RunEvent {
            duration_seconds: Some(66.6666),
            ..RunEvent::default()
        };
        let built = embed(&event);
        assert!(built.description.as_deref().unwrap().contains("1m 6s 667ms"));
    }

    #[test]
    fn a_rejection_is_a_compact_embed_with_its_reason() {
        let event = RunEvent {
            kind: Some(EventKind::Rejected),
            game: Some("Bhop pro".into()),
            runner: Some("someone".into()),
            level_name: Some("Niwa".into()),
            time: Some("1:23.456".into()),
            detail: Some("Timer starts before the first jump.".into()),
            ..RunEvent::default()
        };
        let built = embed(&event);

        assert_eq!(
            built.description.as_deref(),
            Some("Niwa in 1:23.456 by someone")
        );
        let names: Vec<&str> = built.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["Reason"]);
        assert_eq!(built.fields[0].value, "Timer starts before the first jump.");
        assert_eq!(built.color, 0x00ED_4245);
    }

    #[test]
    fn a_rejection_with_no_reason_recorded_claims_none() {
        let event = RunEvent {
            kind: Some(EventKind::Rejected),
            runner: Some("someone".into()),
            level_name: Some("Niwa".into()),
            time: Some("1:23.456".into()),
            ..RunEvent::default()
        };
        let built = embed(&event);
        // What the runner was told is not something to invent.
        assert_eq!(
            built.description.as_deref(),
            Some("Niwa in 1:23.456 by someone")
        );
        assert!(built.fields.is_empty());
    }

    #[test]
    fn a_video_problem_keeps_its_detail_as_the_description() {
        // Only rejections move detail into a field; the video kinds explain
        // themselves in prose above the fields.
        let event = RunEvent {
            kind: Some(EventKind::VideoProblem),
            detail: Some("The provider did not answer.".into()),
            ..RunEvent::default()
        };
        let built = embed(&event);
        assert_eq!(built.description.as_deref(), Some("The provider did not answer."));
        assert!(built.fields.iter().all(|f| f.name != "Reason"));
    }

    #[test]
    fn missing_facts_are_left_out_rather_than_invented() {
        let built = embed(&RunEvent {
            kind: Some(EventKind::Rejected),
            ..RunEvent::default()
        });
        // No map, time or runner were known, so none are claimed.
        assert_eq!(
            built.description.as_deref(),
            Some("Unknown map in Unknown time by Unknown runner")
        );
        assert!(built.fields.is_empty());
    }

    #[test]
    fn a_bad_video_link_is_not_rendered_as_one() {
        let event = RunEvent {
            kind: Some(EventKind::VideoProblem),
            video_url: Some("javascript:alert(1)".into()),
            ..RunEvent::default()
        };
        let built = embed(&event);
        assert_eq!(built.fields.last().unwrap().value, "No video link");
    }

    #[test]
    fn long_values_are_trimmed_to_discords_limit() {
        let event = RunEvent {
            kind: Some(EventKind::Approved),
            level_name: Some("g".repeat(4000)),
            ..RunEvent::default()
        };
        let built = embed(&event);
        assert!(built.description.as_deref().unwrap().chars().count() <= FIELD_VALUE_LIMIT + 40);
    }

    #[test]
    fn every_message_disables_mentions() {
        let message = Message {
            content: Some("hi".into()),
            embeds: Vec::new(),
            allowed_mentions: AllowedMentions::default(),
        };
        let json = serde_json::to_value(&message).expect("serialises");
        // A runner named `@everyone` must not be able to ping the channel.
        assert_eq!(json["allowed_mentions"]["parse"], serde_json::json!([]));
    }

    #[test]
    fn the_test_message_is_exactly_what_was_asked_for() {
        assert_eq!(TEST_MESSAGE, "✅ SRCTools webhook connected");
    }
}
