//! Video availability verification.
//!
//! Layering:
//! - [`detect`] turns a submitted string into a [`detect::VideoRef`] (platform,
//!   native ID, canonical key) without any network access.
//! - [`providers`] asks the platform itself what the state of that video is.
//! - This module joins the two and guarantees the invariant the whole feature
//!   rests on: **a failure to reach a provider is never reported as a verdict
//!   about the video.** Only providers produce `DELETED`; transport problems
//!   produce `NETWORK_ERROR`, and unsupported hosts produce `UNKNOWN`.
//!
//! Caching is deliberately *not* done here — see `db::cache` — because the
//! cache policy differs per status (a `NETWORK_ERROR` must never be cached, an
//! `AVAILABLE` can be cached for hours).

pub mod detect;
pub mod providers;
pub mod types;

pub use detect::{ParseFailure, VideoRef};
pub use providers::ProbeClient;
pub use types::{VideoCheck, VideoMetadata, VideoPlatform, VideoStatus};

/// How long a given verdict stays trustworthy in the local cache.
///
/// Conclusive-and-permanent answers last a long time; anything that can change
/// on its own — or that we are not sure about — expires quickly or immediately.
pub fn cache_ttl_seconds(status: VideoStatus) -> Option<i64> {
    match status {
        // A deleted video does not come back, and an invalid URL stays invalid.
        VideoStatus::Deleted | VideoStatus::InvalidUrl => Some(30 * 24 * 3600),
        // Real answers, but the uploader can change them at any time.
        VideoStatus::Available | VideoStatus::Private | VideoStatus::Unavailable => Some(6 * 3600),
        VideoStatus::RegionRestricted => Some(6 * 3600),
        // Expected to change shortly.
        VideoStatus::Processing => Some(15 * 60),
        // Not an answer at all — never cache, so the next check really re-checks.
        VideoStatus::Unknown | VideoStatus::NetworkError => None,
    }
}

/// Verifies one submitted URL end to end.
///
/// Never returns `Err`: an unreachable provider is a *result* (`NETWORK_ERROR`)
/// that the moderator needs to see, not an error that aborts a bulk check.
pub async fn check_url(probe: &ProbeClient, raw: &str) -> VideoCheck {
    let reference = match detect::parse(raw) {
        Ok(r) => r,
        Err(failure) => {
            return VideoCheck::new(
                raw,
                VideoPlatform::Other,
                VideoStatus::InvalidUrl,
                failure.message(),
            );
        }
    };

    let mut check = probe.probe(&reference).await;
    check.url = raw.trim().to_string();
    check.normalized_url = Some(reference.normalized);
    if check.video_id.is_none() {
        check.video_id = reference.id;
    }
    check
}

/// Verifies every URL attached to a run, preserving submission order.
///
/// Runs sequentially: the provider oEmbed endpoints are unauthenticated and
/// easily rate-limited, and a run rarely carries more than two links.
pub async fn check_all(probe: &ProbeClient, urls: &[String]) -> Vec<VideoCheck> {
    let mut out = Vec::with_capacity(urls.len());
    for url in urls {
        out.push(check_url(probe, url).await);
    }
    out
}

/// The single status that best describes a set of checks, for a run-level badge.
///
/// Picks the most alarming *conclusive* verdict first, so one broken link is
/// never hidden behind a working one. When nothing is conclusive the run is
/// reported as unverifiable rather than fine.
pub fn worst_status(checks: &[VideoCheck]) -> Option<VideoStatus> {
    if checks.is_empty() {
        return None;
    }
    let rank = |s: VideoStatus| match s {
        VideoStatus::Deleted => 0,
        VideoStatus::InvalidUrl => 1,
        VideoStatus::Private => 2,
        VideoStatus::Unavailable => 3,
        VideoStatus::RegionRestricted => 4,
        VideoStatus::Processing => 5,
        VideoStatus::NetworkError => 6,
        VideoStatus::Unknown => 7,
        VideoStatus::Available => 8,
    };
    checks.iter().map(|c| c.status).min_by_key(|s| rank(*s))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(status: VideoStatus) -> VideoCheck {
        VideoCheck::new("https://example.com", VideoPlatform::Other, status, "test")
    }

    #[test]
    fn transient_results_are_never_cached() {
        assert!(cache_ttl_seconds(VideoStatus::NetworkError).is_none());
        assert!(cache_ttl_seconds(VideoStatus::Unknown).is_none());
        assert!(cache_ttl_seconds(VideoStatus::Available).is_some());
        assert!(cache_ttl_seconds(VideoStatus::Deleted).is_some());
    }

    #[test]
    fn a_deleted_link_outranks_a_working_one() {
        let checks = vec![check(VideoStatus::Available), check(VideoStatus::Deleted)];
        assert_eq!(worst_status(&checks), Some(VideoStatus::Deleted));
    }

    #[test]
    fn network_failure_does_not_outrank_a_real_verdict() {
        let checks = vec![check(VideoStatus::NetworkError), check(VideoStatus::Private)];
        assert_eq!(worst_status(&checks), Some(VideoStatus::Private));
    }

    #[test]
    fn network_failure_outranks_available_so_it_stays_visible() {
        let checks = vec![check(VideoStatus::Available), check(VideoStatus::NetworkError)];
        assert_eq!(worst_status(&checks), Some(VideoStatus::NetworkError));
    }

    #[test]
    fn no_links_means_no_status() {
        assert_eq!(worst_status(&[]), None);
    }

    #[tokio::test]
    async fn unparseable_input_is_invalid_without_touching_the_network() {
        let probe = ProbeClient::new(None);
        let result = check_url(&probe, "not a url").await;
        assert_eq!(result.status, VideoStatus::InvalidUrl);
        assert!(!result.detail.is_empty());
    }
}
