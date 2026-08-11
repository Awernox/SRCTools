//! Video URL parsing, platform detection and normalisation.
//!
//! Normalisation matters beyond tidiness: duplicate detection compares
//! normalised URLs, so `youtu.be/X`, `youtube.com/watch?v=X&t=90` and
//! `m.youtube.com/watch?v=X` must all collapse to the same key — while
//! genuinely different videos must never collide.

use url::Url;

use super::types::VideoPlatform;

/// A parsed video reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoRef {
    pub platform: VideoPlatform,
    /// Provider-native ID, when extractable.
    pub id: Option<String>,
    /// Canonical URL used as the cache / duplicate key.
    pub normalized: String,
    /// Original URL with whitespace trimmed and scheme repaired.
    pub cleaned: String,
}

/// Reason a string could not be treated as a video URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseFailure {
    Empty,
    NotAUrl(String),
    UnsupportedScheme(String),
    NoHost,
}

impl ParseFailure {
    /// Explanation shown to the moderator.
    pub fn message(&self) -> String {
        match self {
            Self::Empty => "No video URL was submitted.".into(),
            Self::NotAUrl(s) => format!("'{s}' is not a valid URL."),
            Self::UnsupportedScheme(s) => {
                format!("'{s}' is not a web link — only http and https can be checked.")
            }
            Self::NoHost => "The URL has no host, so it cannot point at a video.".into(),
        }
    }
}

/// Parses a submitted string into a [`VideoRef`].
pub fn parse(raw: &str) -> Result<VideoRef, ParseFailure> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ParseFailure::Empty);
    }

    // Runners frequently omit the scheme. Repair rather than reject, but only
    // when the remainder looks host-like.
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else if looks_like_host(trimmed) {
        format!("https://{trimmed}")
    } else {
        return Err(ParseFailure::NotAUrl(truncate(trimmed, 80)));
    };

    let url = Url::parse(&candidate).map_err(|_| ParseFailure::NotAUrl(truncate(trimmed, 80)))?;

    match url.scheme() {
        "http" | "https" => {}
        other => return Err(ParseFailure::UnsupportedScheme(other.to_string())),
    }

    let host = url
        .host_str()
        .ok_or(ParseFailure::NoHost)?
        .trim_start_matches("www.")
        .to_ascii_lowercase();

    if host.is_empty() || !host.contains('.') {
        return Err(ParseFailure::NoHost);
    }

    let (platform, id) = classify(&host, &url);
    let normalized = normalize(platform, id.as_deref(), &url, &host);

    Ok(VideoRef {
        platform,
        id,
        normalized,
        cleaned: url.to_string(),
    })
}

/// Heuristic for "this looks like `host/path` and just lost its scheme".
fn looks_like_host(s: &str) -> bool {
    let head = s.split(['/', '?', '#']).next().unwrap_or_default();
    !head.is_empty()
        && head.contains('.')
        && !head.contains(' ')
        && !head.starts_with('.')
        && !head.ends_with('.')
        && head
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_'))
}

/// Maps host + path onto a platform and extracts the native video ID.
fn classify(host: &str, url: &Url) -> (VideoPlatform, Option<String>) {
    let segments: Vec<&str> = url
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();
    let query = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.to_string())
    };

    // --- YouTube ------------------------------------------------------------
    if host == "youtu.be" {
        return (VideoPlatform::YouTube, segments.first().map(sanitize_id));
    }
    if host.ends_with("youtube.com") || host.ends_with("youtube-nocookie.com") {
        // /watch?v=ID
        if let Some(v) = query("v") {
            return (VideoPlatform::YouTube, Some(sanitize_id(&v.as_str())));
        }
        // /embed/ID, /v/ID, /shorts/ID, /live/ID
        if let (Some(first), Some(second)) = (segments.first(), segments.get(1)) {
            if matches!(*first, "embed" | "v" | "shorts" | "live") {
                return (VideoPlatform::YouTube, Some(sanitize_id(second)));
            }
        }
        return (VideoPlatform::YouTube, None);
    }

    // --- Twitch -------------------------------------------------------------
    if host.ends_with("twitch.tv") {
        // /videos/123456789 — a VOD
        if let Some(pos) = segments.iter().position(|s| *s == "videos") {
            if let Some(id) = segments.get(pos + 1) {
                return (VideoPlatform::Twitch, Some(sanitize_id(id)));
            }
        }
        // /channel/v/123456789 — legacy VOD form
        if segments.len() >= 3 && segments[1] == "v" {
            return (VideoPlatform::Twitch, Some(sanitize_id(&segments[2])));
        }
        // /channel/clip/SlugName or clips.twitch.tv/SlugName
        if let Some(pos) = segments.iter().position(|s| *s == "clip") {
            if let Some(slug) = segments.get(pos + 1) {
                return (VideoPlatform::Twitch, Some(sanitize_id(slug)));
            }
        }
        if host.starts_with("clips.") {
            return (VideoPlatform::Twitch, segments.first().map(sanitize_id));
        }
        return (VideoPlatform::Twitch, None);
    }

    // --- Vimeo --------------------------------------------------------------
    if host.ends_with("vimeo.com") {
        let id = segments
            .iter()
            .find(|s| s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty())
            .map(|s| s.to_string());
        return (VideoPlatform::Vimeo, id);
    }

    // --- Others -------------------------------------------------------------
    if host.ends_with("streamable.com") {
        return (VideoPlatform::Streamable, segments.first().map(sanitize_id));
    }
    if host.ends_with("bilibili.com") || host.ends_with("b23.tv") {
        return (VideoPlatform::Bilibili, segments.last().map(sanitize_id));
    }
    if host.ends_with("nicovideo.jp") || host.ends_with("nico.ms") {
        return (VideoPlatform::NicoVideo, segments.last().map(sanitize_id));
    }
    if host.ends_with("drive.google.com") {
        // /file/d/FILE_ID/view
        if let Some(pos) = segments.iter().position(|s| *s == "d") {
            if let Some(id) = segments.get(pos + 1) {
                return (VideoPlatform::GoogleDrive, Some(sanitize_id(id)));
            }
        }
        return (VideoPlatform::GoogleDrive, query("id").map(|v| sanitize_id(&v.as_str())));
    }
    if host.ends_with("dropbox.com") {
        return (VideoPlatform::Dropbox, None);
    }
    if host.ends_with("medal.tv") {
        return (VideoPlatform::Medal, segments.last().map(sanitize_id));
    }

    (VideoPlatform::Other, None)
}

/// Builds the canonical key for a video reference.
fn normalize(platform: VideoPlatform, id: Option<&str>, url: &Url, host: &str) -> String {
    match (platform, id) {
        (VideoPlatform::YouTube, Some(id)) => format!("youtube:{id}"),
        (VideoPlatform::Twitch, Some(id)) => format!("twitch:{}", id.to_ascii_lowercase()),
        (VideoPlatform::Vimeo, Some(id)) => format!("vimeo:{id}"),
        (VideoPlatform::Streamable, Some(id)) => format!("streamable:{id}"),
        (VideoPlatform::Bilibili, Some(id)) => format!("bilibili:{}", id.to_ascii_lowercase()),
        (VideoPlatform::NicoVideo, Some(id)) => format!("nicovideo:{}", id.to_ascii_lowercase()),
        (VideoPlatform::GoogleDrive, Some(id)) => format!("gdrive:{id}"),
        (VideoPlatform::Medal, Some(id)) => format!("medal:{}", id.to_ascii_lowercase()),
        // Without an ID we fall back to host+path, dropping the query string and
        // fragment (which usually only carry timestamps and tracking).
        _ => {
            let path = url.path().trim_end_matches('/').to_ascii_lowercase();
            format!("{host}{path}")
        }
    }
}

/// Strips characters that cannot appear in a provider ID, defending against
/// trailing punctuation pasted along with a link.
fn sanitize_id(raw: &impl AsRef<str>) -> String {
    raw.as_ref()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(64)
        .collect()
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ref_of(s: &str) -> VideoRef {
        parse(s).expect("should parse")
    }

    #[test]
    fn youtube_forms_share_one_key() {
        let expected = "youtube:dQw4w9WgXcQ";
        for url in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?t=90",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "youtube.com/watch?v=dQw4w9WgXcQ",
        ] {
            let r = ref_of(url);
            assert_eq!(r.platform, VideoPlatform::YouTube, "{url}");
            assert_eq!(r.normalized, expected, "{url}");
        }
    }

    #[test]
    fn distinct_videos_do_not_collide() {
        assert_ne!(
            ref_of("https://youtu.be/aaaaaaaaaaa").normalized,
            ref_of("https://youtu.be/bbbbbbbbbbb").normalized
        );
    }

    #[test]
    fn twitch_vod_and_clip_forms() {
        assert_eq!(ref_of("https://www.twitch.tv/videos/123456789").id.unwrap(), "123456789");
        assert_eq!(ref_of("https://twitch.tv/someone/v/987654321").id.unwrap(), "987654321");
        let clip = ref_of("https://clips.twitch.tv/SomeFunnySlug");
        assert_eq!(clip.platform, VideoPlatform::Twitch);
        assert_eq!(clip.normalized, "twitch:somefunnyslug");
    }

    #[test]
    fn vimeo_extracts_numeric_id() {
        assert_eq!(ref_of("https://vimeo.com/123456789").normalized, "vimeo:123456789");
        assert_eq!(
            ref_of("https://player.vimeo.com/video/123456789").normalized,
            "vimeo:123456789"
        );
    }

    #[test]
    fn google_drive_file_id() {
        assert_eq!(
            ref_of("https://drive.google.com/file/d/1AbC_dEf-123/view?usp=sharing").normalized,
            "gdrive:1AbC_dEf-123"
        );
    }

    #[test]
    fn unknown_hosts_normalise_by_path() {
        let r = ref_of("https://example.com/Videos/My%20Run/");
        assert_eq!(r.platform, VideoPlatform::Other);
        assert!(r.normalized.starts_with("example.com/"));
    }

    #[test]
    fn rejects_non_urls() {
        assert_eq!(parse(""), Err(ParseFailure::Empty));
        assert_eq!(parse("   "), Err(ParseFailure::Empty));
        assert!(matches!(parse("not a url at all"), Err(ParseFailure::NotAUrl(_))));
        assert!(matches!(
            parse("ftp://files.example.com/run.mp4"),
            Err(ParseFailure::UnsupportedScheme(_))
        ));
        // A bare word is not a host.
        assert!(matches!(parse("localhost"), Err(ParseFailure::NotAUrl(_))));
    }

    #[test]
    fn strips_trailing_punctuation_from_ids() {
        // A link pasted at the end of a sentence.
        assert_eq!(ref_of("https://youtu.be/abc123XYZ_-").normalized, "youtube:abc123XYZ_-");
    }

    #[test]
    fn youtube_without_id_is_still_youtube() {
        let r = ref_of("https://www.youtube.com/@somechannel");
        assert_eq!(r.platform, VideoPlatform::YouTube);
        assert!(r.id.is_none());
    }
}
