//! Per-platform video probes.
//!
//! Every probe follows the same contract: return a conclusive [`VideoStatus`]
//! **only** when the provider gave an unambiguous answer. Anything else — a
//! timeout, a 5xx, a rate limit, an unparseable body, a missing credential —
//! must return [`VideoStatus::NetworkError`] or [`VideoStatus::Unknown`] with a
//! `detail` string explaining what happened.

use std::time::Duration;

use serde::Deserialize;

use super::detect::VideoRef;
use super::types::{VideoCheck, VideoMetadata, VideoPlatform, VideoStatus};

/// Shared HTTP client for provider probes.
pub struct ProbeClient {
    http: reqwest::Client,
    /// Twitch app credentials, if the user supplied them.
    twitch: Option<TwitchAuth>,
}

struct TwitchAuth {
    client_id: String,
    client_secret: String,
    token: tokio::sync::Mutex<Option<(String, std::time::Instant)>>,
}

impl ProbeClient {
    pub fn new(twitch_credentials: Option<(String, String)>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(8))
            // Providers answer differently to non-browser agents; identify honestly.
            .user_agent(concat!("SRCTools/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();

        Self {
            http,
            twitch: twitch_credentials.map(|(client_id, client_secret)| TwitchAuth {
                client_id,
                client_secret,
                token: tokio::sync::Mutex::new(None),
            }),
        }
    }

    pub fn has_twitch_credentials(&self) -> bool {
        self.twitch.is_some()
    }

    /// Dispatches to the probe for `reference`'s platform.
    pub async fn probe(&self, reference: &VideoRef) -> VideoCheck {
        let base = |status, detail: String| {
            VideoCheck::new(&reference.cleaned, reference.platform, status, detail)
                .with_normalized(&reference.normalized)
        };

        match reference.platform {
            VideoPlatform::YouTube => match &reference.id {
                Some(id) => self.probe_youtube(reference, id).await,
                None => base(
                    VideoStatus::InvalidUrl,
                    "This is a YouTube link but does not point at a specific video.".into(),
                ),
            },
            VideoPlatform::Twitch => match &reference.id {
                Some(id) => self.probe_twitch(reference, id).await,
                None => base(
                    VideoStatus::InvalidUrl,
                    "This is a Twitch link but does not point at a VOD or clip. Live channel links do not preserve the run.".into(),
                ),
            },
            VideoPlatform::Vimeo => match &reference.id {
                Some(id) => self.probe_vimeo(reference, id).await,
                None => base(
                    VideoStatus::InvalidUrl,
                    "This is a Vimeo link but does not point at a specific video.".into(),
                ),
            },
            other => base(
                VideoStatus::Unknown,
                format!(
                    "{} links cannot be checked automatically — open the link to verify manually.",
                    other.label()
                ),
            ),
        }
    }

    // -----------------------------------------------------------------------
    // YouTube
    // -----------------------------------------------------------------------

    /// Probes YouTube via the public oEmbed endpoint.
    ///
    /// Status mapping, verified against the live endpoint:
    ///   * 200 → the video exists and is embeddable/public (metadata returned)
    ///   * 401 → the video exists but is private
    ///   * 404 → the video does not exist (deleted or never existed)
    ///   * 403 → exists but embedding is restricted; not a deletion
    ///   * anything else → inconclusive
    async fn probe_youtube(&self, reference: &VideoRef, id: &str) -> VideoCheck {
        let endpoint = format!(
            "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{id}&format=json"
        );

        let make = |status, detail: String| {
            VideoCheck::new(&reference.cleaned, VideoPlatform::YouTube, status, detail)
                .with_id(id)
                .with_normalized(&reference.normalized)
        };

        let response = match self.http.get(&endpoint).send().await {
            Ok(r) => r,
            Err(e) => {
                return make(
                    VideoStatus::NetworkError,
                    format!(
                        "Could not reach YouTube to check this video ({}). This does not mean the video is missing.",
                        describe_transport_error(&e)
                    ),
                )
            }
        };

        let status_code = response.status().as_u16();
        match status_code {
            200 => {
                let body = match response.text().await {
                    Ok(b) => b,
                    Err(e) => {
                        return make(
                            VideoStatus::NetworkError,
                            format!("YouTube's response could not be read ({e})."),
                        )
                    }
                };
                match serde_json::from_str::<OEmbedResponse>(&body) {
                    Ok(oembed) => {
                        let mut metadata = oembed.into_metadata();
                        metadata.embed_url =
                            Some(format!("https://www.youtube-nocookie.com/embed/{id}"));
                        // oEmbed omits duration and upload date; the thumbnail is
                        // reliable, so fill only what we actually received.
                        make(
                            VideoStatus::Available,
                            "YouTube confirmed this video is public.".into(),
                        )
                        .with_metadata(metadata)
                    }
                    Err(e) => make(
                        VideoStatus::Unknown,
                        format!("YouTube replied, but the response could not be parsed ({e})."),
                    ),
                }
            }
            401 => make(
                VideoStatus::Private,
                "YouTube reports this video as private. A moderator cannot watch it without access."
                    .into(),
            ),
            404 => make(
                VideoStatus::Deleted,
                "YouTube reports that no video exists at this address — it was deleted, or the link is wrong."
                    .into(),
            ),
            403 => make(
                VideoStatus::Unavailable,
                "YouTube refused to describe this video. It usually means embedding is disabled or the video is age- or region-restricted; it does not mean the video was deleted."
                    .into(),
            ),
            400 => make(
                VideoStatus::InvalidUrl,
                "YouTube rejected this video ID as malformed.".into(),
            ),
            429 => make(
                VideoStatus::NetworkError,
                "YouTube is rate-limiting metadata requests. Try re-checking in a few minutes."
                    .into(),
            ),
            500..=599 => make(
                VideoStatus::NetworkError,
                format!("YouTube returned a server error (HTTP {status_code}). The video's real state is unknown."),
            ),
            other => make(
                VideoStatus::Unknown,
                format!("YouTube returned an unexpected HTTP {other}; the video's state could not be determined."),
            ),
        }
    }

    // -----------------------------------------------------------------------
    // Twitch
    // -----------------------------------------------------------------------

    /// Probes a Twitch VOD via the Helix API.
    ///
    /// Twitch exposes no unauthenticated metadata endpoint — the old v5 oEmbed
    /// is gone, and the VOD page returns HTTP 200 even for IDs that do not
    /// exist (it is a client-rendered app). Scraping it would produce false
    /// "deleted" verdicts, so without credentials we report `Unknown` and say
    /// exactly why rather than guessing.
    async fn probe_twitch(&self, reference: &VideoRef, id: &str) -> VideoCheck {
        let make = |status, detail: String| {
            VideoCheck::new(&reference.cleaned, VideoPlatform::Twitch, status, detail)
                .with_id(id)
                .with_normalized(&reference.normalized)
        };

        let Some(auth) = &self.twitch else {
            return make(
                VideoStatus::Unknown,
                "Twitch VODs cannot be checked without Twitch API credentials. Add a Client ID and Secret in Settings → Account to enable this.".into(),
            );
        };

        // Clips use a different endpoint and a slug rather than a numeric ID.
        let is_clip = !id.chars().all(|c| c.is_ascii_digit());

        let token = match self.twitch_token(auth).await {
            Ok(t) => t,
            Err(detail) => return make(VideoStatus::NetworkError, detail),
        };

        let endpoint = if is_clip {
            format!("https://api.twitch.tv/helix/clips?id={id}")
        } else {
            format!("https://api.twitch.tv/helix/videos?id={id}")
        };

        let response = match self
            .http
            .get(&endpoint)
            .header("Client-Id", &auth.client_id)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return make(
                    VideoStatus::NetworkError,
                    format!(
                        "Could not reach Twitch to check this VOD ({}). This does not mean the VOD is missing.",
                        describe_transport_error(&e)
                    ),
                )
            }
        };

        let status_code = response.status().as_u16();
        match status_code {
            200 => {
                let parsed = match response.json::<HelixResponse>().await {
                    Ok(p) => p,
                    Err(e) => {
                        return make(
                            VideoStatus::Unknown,
                            format!("Twitch replied, but the response could not be parsed ({e})."),
                        )
                    }
                };
                match parsed.data.into_iter().next() {
                    Some(video) => {
                        let metadata = video.to_metadata(id, is_clip);
                        // Twitch marks unlisted/subscriber VODs via `viewable`.
                        let (status, detail) = match video.viewable.as_deref() {
                            Some("public") | None => (
                                VideoStatus::Available,
                                "Twitch confirmed this VOD is available.".to_string(),
                            ),
                            Some(other) => (
                                VideoStatus::Private,
                                format!("Twitch reports this VOD as '{other}' rather than public."),
                            ),
                        };
                        make(status, detail).with_metadata(metadata)
                    }
                    // Helix returns 200 with an empty array for IDs that do not
                    // exist. That *is* an affirmative answer.
                    None => make(
                        VideoStatus::Deleted,
                        if is_clip {
                            "Twitch reports that this clip no longer exists.".into()
                        } else {
                            "Twitch reports that this VOD no longer exists. Twitch deletes VODs automatically after 7–60 days unless they are highlighted or exported.".into()
                        },
                    ),
                }
            }
            400 => make(
                VideoStatus::InvalidUrl,
                "Twitch rejected this VOD ID as malformed.".into(),
            ),
            401 => make(
                VideoStatus::NetworkError,
                "Twitch rejected the stored credentials. Check the Client ID and Secret in Settings → Account.".into(),
            ),
            404 => make(
                VideoStatus::Deleted,
                "Twitch reports that this VOD no longer exists.".into(),
            ),
            429 => make(
                VideoStatus::NetworkError,
                "Twitch is rate-limiting requests. Try re-checking in a few minutes.".into(),
            ),
            500..=599 => make(
                VideoStatus::NetworkError,
                format!("Twitch returned a server error (HTTP {status_code}). The VOD's real state is unknown."),
            ),
            other => make(
                VideoStatus::Unknown,
                format!("Twitch returned an unexpected HTTP {other}; the VOD's state could not be determined."),
            ),
        }
    }

    /// Fetches (and caches) a Twitch app access token.
    async fn twitch_token(&self, auth: &TwitchAuth) -> Result<String, String> {
        {
            let cached = auth.token.lock().await;
            if let Some((token, obtained)) = cached.as_ref() {
                // Tokens last ~60 days; refresh well before expiry.
                if obtained.elapsed() < Duration::from_secs(3600) {
                    return Ok(token.clone());
                }
            }
        }

        let response = self
            .http
            .post("https://id.twitch.tv/oauth2/token")
            .form(&[
                ("client_id", auth.client_id.as_str()),
                ("client_secret", auth.client_secret.as_str()),
                ("grant_type", "client_credentials"),
            ])
            .send()
            .await
            .map_err(|e| {
                format!(
                    "Could not reach Twitch to authenticate ({}).",
                    describe_transport_error(&e)
                )
            })?;

        if !response.status().is_success() {
            return Err(format!(
                "Twitch refused the stored credentials (HTTP {}). Check the Client ID and Secret in Settings → Account.",
                response.status().as_u16()
            ));
        }

        #[derive(Deserialize)]
        struct TokenResponse {
            access_token: String,
        }

        let token = response
            .json::<TokenResponse>()
            .await
            .map_err(|e| format!("Twitch's authentication response could not be read ({e})."))?
            .access_token;

        *auth.token.lock().await = Some((token.clone(), std::time::Instant::now()));
        Ok(token)
    }

    // -----------------------------------------------------------------------
    // Vimeo
    // -----------------------------------------------------------------------

    /// Probes Vimeo via its public oEmbed endpoint, which unlike YouTube's
    /// returns duration and upload date.
    async fn probe_vimeo(&self, reference: &VideoRef, id: &str) -> VideoCheck {
        let endpoint =
            format!("https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F{id}");

        let make = |status, detail: String| {
            VideoCheck::new(&reference.cleaned, VideoPlatform::Vimeo, status, detail)
                .with_id(id)
                .with_normalized(&reference.normalized)
        };

        let response = match self.http.get(&endpoint).send().await {
            Ok(r) => r,
            Err(e) => {
                return make(
                    VideoStatus::NetworkError,
                    format!(
                        "Could not reach Vimeo to check this video ({}). This does not mean the video is missing.",
                        describe_transport_error(&e)
                    ),
                )
            }
        };

        match response.status().as_u16() {
            200 => match response.json::<OEmbedResponse>().await {
                Ok(oembed) => {
                    let mut metadata = oembed.into_metadata();
                    metadata.embed_url = Some(format!("https://player.vimeo.com/video/{id}"));
                    make(
                        VideoStatus::Available,
                        "Vimeo confirmed this video is public.".into(),
                    )
                    .with_metadata(metadata)
                }
                Err(e) => make(
                    VideoStatus::Unknown,
                    format!("Vimeo replied, but the response could not be parsed ({e})."),
                ),
            },
            403 => make(
                VideoStatus::Private,
                "Vimeo reports this video as private or password-protected.".into(),
            ),
            404 => make(
                VideoStatus::Deleted,
                "Vimeo reports that no video exists at this address.".into(),
            ),
            429 => make(
                VideoStatus::NetworkError,
                "Vimeo is rate-limiting metadata requests. Try re-checking in a few minutes.".into(),
            ),
            code @ 500..=599 => make(
                VideoStatus::NetworkError,
                format!("Vimeo returned a server error (HTTP {code}). The video's real state is unknown."),
            ),
            other => make(
                VideoStatus::Unknown,
                format!("Vimeo returned an unexpected HTTP {other}; the video's state could not be determined."),
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

/// Shared oEmbed shape (YouTube and Vimeo both implement the spec).
#[derive(Debug, Deserialize)]
struct OEmbedResponse {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    author_name: Option<String>,
    #[serde(default)]
    thumbnail_url: Option<String>,
    /// Vimeo returns seconds here; YouTube omits it.
    #[serde(default)]
    duration: Option<f64>,
    /// Vimeo only.
    #[serde(default)]
    upload_date: Option<String>,
}

impl OEmbedResponse {
    fn into_metadata(self) -> VideoMetadata {
        VideoMetadata {
            title: self.title.filter(|t| !t.trim().is_empty()),
            channel: self.author_name.filter(|a| !a.trim().is_empty()),
            duration_seconds: self.duration.filter(|d| *d > 0.0),
            upload_date: self.upload_date,
            thumbnail_url: self.thumbnail_url,
            embed_url: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct HelixResponse {
    #[serde(default)]
    data: Vec<HelixVideo>,
}

#[derive(Debug, Deserialize)]
struct HelixVideo {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    user_name: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    thumbnail_url: Option<String>,
    /// `public` or `private`. Absent on clips.
    #[serde(default)]
    viewable: Option<String>,
    /// Twitch duration string, e.g. `1h2m3s`. Absent on clips.
    #[serde(default)]
    duration: Option<String>,
    /// Clips report duration as seconds instead.
    #[serde(default)]
    duration_seconds: Option<f64>,
}

impl HelixVideo {
    fn to_metadata(&self, id: &str, is_clip: bool) -> VideoMetadata {
        VideoMetadata {
            title: self.title.clone().filter(|t| !t.trim().is_empty()),
            channel: self.user_name.clone(),
            duration_seconds: self
                .duration
                .as_deref()
                .and_then(parse_twitch_duration)
                .or(self.duration_seconds),
            upload_date: self.created_at.clone(),
            // Twitch templates its thumbnails; fill in a usable size.
            thumbnail_url: self
                .thumbnail_url
                .clone()
                .map(|t| t.replace("%{width}", "480").replace("%{height}", "272")),
            embed_url: if is_clip {
                None
            } else {
                Some(format!("https://player.twitch.tv/?video={id}&parent=localhost"))
            },
        }
    }
}

/// Parses Twitch's `1h2m3s` duration format into seconds.
fn parse_twitch_duration(raw: &str) -> Option<f64> {
    let mut total = 0f64;
    let mut current = String::new();
    let mut saw_unit = false;

    for c in raw.chars() {
        if c.is_ascii_digit() {
            current.push(c);
            continue;
        }
        let value: f64 = current.parse().ok()?;
        current.clear();
        total += match c {
            'h' => value * 3600.0,
            'm' => value * 60.0,
            's' => value,
            _ => return None,
        };
        saw_unit = true;
    }

    (saw_unit && current.is_empty()).then_some(total)
}

/// Describes a transport failure without leaking the full request URL.
fn describe_transport_error(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "connection failed"
    } else if e.is_request() {
        "the request could not be sent"
    } else {
        "network error"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_twitch_durations() {
        assert_eq!(parse_twitch_duration("1h2m3s"), Some(3723.0));
        assert_eq!(parse_twitch_duration("45m"), Some(2700.0));
        assert_eq!(parse_twitch_duration("30s"), Some(30.0));
        assert_eq!(parse_twitch_duration("2h"), Some(7200.0));
    }

    #[test]
    fn rejects_malformed_durations() {
        assert_eq!(parse_twitch_duration(""), None);
        assert_eq!(parse_twitch_duration("abc"), None);
        // A trailing number with no unit is incomplete.
        assert_eq!(parse_twitch_duration("1h30"), None);
    }

    #[test]
    fn oembed_ignores_blank_strings() {
        let raw = r#"{"title":"  ","author_name":"","thumbnail_url":"https://x/y.jpg"}"#;
        let parsed: OEmbedResponse = serde_json::from_str(raw).unwrap();
        let meta = parsed.into_metadata();
        assert!(meta.title.is_none());
        assert!(meta.channel.is_none());
        assert!(meta.thumbnail_url.is_some());
    }
}
