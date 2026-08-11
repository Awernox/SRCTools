//! Video verification result types.
//!
//! The central design rule: a *verdict about the video* and a *failure to reach
//! the provider* are different things and must never collapse into each other.
//! `Deleted` means a provider affirmatively said the video is gone. A timeout,
//! a 500, a DNS failure or a missing API credential all produce `NetworkError`
//! or `Unknown` instead — states the UI renders as "could not verify".

use serde::{Deserialize, Serialize};

/// Availability verdict for a submitted video URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VideoStatus {
    /// The provider confirmed the video exists and is publicly viewable.
    Available,
    /// The provider confirmed the video exists but is not public.
    Private,
    /// The provider affirmatively reported the video as gone.
    Deleted,
    /// Exists but cannot be watched (e.g. removed by uploader, blocked).
    Unavailable,
    /// Playback is geo-blocked, where the provider tells us so.
    RegionRestricted,
    /// Uploaded but still transcoding.
    Processing,
    /// The submitted string is not a usable video URL at all.
    InvalidUrl,
    /// Reached the provider but could not determine a state, or no provider
    /// integration is available (e.g. Twitch without credentials).
    Unknown,
    /// The check itself failed — transient and retryable. Says nothing about
    /// whether the video exists.
    NetworkError,
}

impl VideoStatus {
    /// Whether this status reflects a real answer from the provider.
    ///
    /// Analysis heuristics only treat conclusive statuses as evidence.
    pub fn is_conclusive(&self) -> bool {
        matches!(
            self,
            Self::Available
                | Self::Private
                | Self::Deleted
                | Self::Unavailable
                | Self::RegionRestricted
                | Self::Processing
                | Self::InvalidUrl
        )
    }

    /// Whether re-checking later could plausibly change the answer.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::NetworkError | Self::Unknown | Self::Processing)
    }

    /// Whether a moderator would consider this a problem worth looking at.
    pub fn is_problem(&self) -> bool {
        matches!(
            self,
            Self::Private | Self::Deleted | Self::Unavailable | Self::RegionRestricted | Self::InvalidUrl
        )
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Available => "AVAILABLE",
            Self::Private => "PRIVATE",
            Self::Deleted => "DELETED",
            Self::Unavailable => "UNAVAILABLE",
            Self::RegionRestricted => "REGION_RESTRICTED",
            Self::Processing => "PROCESSING",
            Self::InvalidUrl => "INVALID_URL",
            Self::Unknown => "UNKNOWN",
            Self::NetworkError => "NETWORK_ERROR",
        }
    }
}

/// Recognised video hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoPlatform {
    YouTube,
    Twitch,
    Vimeo,
    Streamable,
    Bilibili,
    NicoVideo,
    GoogleDrive,
    Dropbox,
    Medal,
    /// A URL we can parse but have no provider integration for.
    Other,
}

impl VideoPlatform {
    pub fn label(&self) -> &'static str {
        match self {
            Self::YouTube => "YouTube",
            Self::Twitch => "Twitch",
            Self::Vimeo => "Vimeo",
            Self::Streamable => "Streamable",
            Self::Bilibili => "Bilibili",
            Self::NicoVideo => "Niconico",
            Self::GoogleDrive => "Google Drive",
            Self::Dropbox => "Dropbox",
            Self::Medal => "Medal",
            Self::Other => "Other",
        }
    }
}

/// Metadata a provider exposed. Every field is optional: absent means the
/// provider did not tell us, which the UI shows as "—" rather than guessing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMetadata {
    pub title: Option<String>,
    /// Channel, creator or uploader name.
    pub channel: Option<String>,
    pub duration_seconds: Option<f64>,
    /// ISO-8601 upload timestamp where available.
    pub upload_date: Option<String>,
    pub thumbnail_url: Option<String>,
    /// Canonical embed URL, used for the in-app preview.
    pub embed_url: Option<String>,
}

impl VideoMetadata {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Full outcome of checking one video URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCheck {
    /// The URL exactly as submitted.
    pub url: String,
    /// Normalised form used as the cache and duplicate-detection key.
    pub normalized_url: Option<String>,
    pub platform: VideoPlatform,
    /// Provider-native ID, when we could parse one.
    pub video_id: Option<String>,
    pub status: VideoStatus,
    /// Human-readable explanation of how this status was reached. Always set,
    /// so the UI can explain any badge on hover.
    pub detail: String,
    pub metadata: VideoMetadata,
    /// When this check ran (ISO-8601 UTC).
    pub checked_at: String,
    /// True when served from the local cache rather than freshly fetched.
    pub from_cache: bool,
}

impl VideoCheck {
    pub fn new(
        url: impl Into<String>,
        platform: VideoPlatform,
        status: VideoStatus,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            url: url.into(),
            normalized_url: None,
            platform,
            video_id: None,
            status,
            detail: detail.into(),
            metadata: VideoMetadata::default(),
            checked_at: crate::util::now_iso8601(),
            from_cache: false,
        }
    }

    pub fn with_metadata(mut self, metadata: VideoMetadata) -> Self {
        self.metadata = metadata;
        self
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.video_id = Some(id.into());
        self
    }

    pub fn with_normalized(mut self, normalized: impl Into<String>) -> Self {
        self.normalized_url = Some(normalized.into());
        self
    }
}
