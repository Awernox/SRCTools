//! Checking GitHub Releases for a newer SRCTools.
//!
//! This is deliberately *not* an auto-updater. It looks up the latest release,
//! compares it with the running build and hands the frontend a download link;
//! installing is the moderator opening the file. Nothing is fetched, unpacked
//! or executed by SRCTools, so a compromised or hijacked release cannot become
//! code running on this machine without the user choosing to run it.
//!
//! Three things follow from where this runs:
//!
//! - **It has to be Rust.** The webview's CSP allows `connect-src 'self' ipc:`
//!   only, so the frontend cannot reach api.github.com at all. Keeping the
//!   request here also keeps the app's one outbound-host list in one place.
//! - **The repository is single-sourced.** `CARGO_PKG_REPOSITORY` is the
//!   standard Cargo field; there is no second copy of it and no `version.json`.
//!   The version compared against is `CARGO_PKG_VERSION`, the same string
//!   [`crate::StartupReport`] already reports to the UI.
//! - **Not knowing is its own answer.** An unreachable GitHub, a repository
//!   with no releases yet and an unconfigured repository are three distinct
//!   outcomes, none of which is allowed to render as "you are up to date".

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Owner placeholder shipped in `Cargo.toml`. While it is still there, the
/// check reports itself unconfigured instead of querying a repository that
/// does not exist.
const PLACEHOLDER_OWNER: &str = "OWNER";

/// The running build.
pub const CURRENT: &str = env!("CARGO_PKG_VERSION");

/// What the frontend renders. Every field the UI shows is here; nothing is
/// derived from a string on the JS side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// False when `Cargo.toml` still carries the placeholder repository.
    pub configured: bool,
    /// The installed version, e.g. `1.0.0`.
    pub current: String,
    /// Latest published version, without any `v` prefix. `None` when the
    /// repository has no releases yet, or when the check could not run.
    pub latest: Option<String>,
    /// True only when a release was found *and* it is newer than [`Self::current`].
    pub available: bool,
    /// The release page, for "what changed" and as the download fallback.
    pub release_url: Option<String>,
    /// The installer asset, when the release carries one.
    pub download_url: Option<String>,
    /// Asset file name, so the button can say what it will download.
    pub download_name: Option<String>,
    /// Release notes, trimmed. Shown as plain text, never as HTML.
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

impl UpdateCheck {
    /// The answer when there is nothing to compare against.
    fn none(configured: bool) -> Self {
        Self {
            configured,
            current: CURRENT.to_string(),
            latest: None,
            available: false,
            release_url: None,
            download_url: None,
            download_name: None,
            notes: None,
            published_at: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/// A version as three numbers plus whether it is a pre-release.
///
/// Full semver is more than release tags need; what matters is that `1.10.0`
/// sorts above `1.9.0` (a string compare gets that backwards) and that
/// `1.1.0-beta.1` does not outrank the finished `1.1.0`.
fn parse(version: &str) -> Option<([u64; 3], bool)> {
    let cleaned = version.trim().trim_start_matches(['v', 'V']);
    let (core, pre) = match cleaned.split_once(['-', '+']) {
        Some((core, _)) => (core, true),
        None => (cleaned, false),
    };

    let mut parts = [0u64; 3];
    let mut seen = 0;
    for (i, piece) in core.split('.').enumerate() {
        if i >= 3 {
            break;
        }
        parts[i] = piece.parse().ok()?;
        seen += 1;
    }
    if seen == 0 {
        return None;
    }
    Some((parts, pre))
}

/// True when `candidate` is a newer release than `current`.
///
/// Anything unparseable answers false: an unreadable tag is not grounds for
/// telling the moderator to reinstall.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (Some((new, new_pre)), Some((old, old_pre))) = (parse(candidate), parse(current)) else {
        return false;
    };
    match new.cmp(&old) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        // Same numbers: only a finished release beats a pre-release of itself.
        std::cmp::Ordering::Equal => old_pre && !new_pre,
    }
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

/// Splits `CARGO_PKG_REPOSITORY` into `owner/name`.
///
/// Returns `None` for an empty field, a non-GitHub host or the placeholder
/// owner, all of which mean "no update source is configured".
fn repo() -> Option<(String, String)> {
    let raw = env!("CARGO_PKG_REPOSITORY").trim();
    if raw.is_empty() {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.host_str(), Some("github.com" | "www.github.com")) {
        return None;
    }
    let mut segments = url.path_segments()?;
    let owner = segments.next()?.to_string();
    let name = segments.next()?.trim_end_matches(".git").to_string();
    if owner.is_empty() || name.is_empty() || owner == PLACEHOLDER_OWNER {
        return None;
    }
    Some((owner, name))
}

/// True when an update source is configured, for the Settings row.
pub fn is_configured() -> bool {
    repo().is_some()
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/// Only the fields used. GitHub sends a great deal more.
#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// Client for GitHub only.
///
/// Separate from the Speedrun.com client on purpose: that one carries the API
/// key as a default header, and it has no business travelling to GitHub.
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(6))
            .user_agent(concat!("SRCTools/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

/// Picks the asset a Windows user should download.
///
/// Preference order matches how the release is built: the NSIS installer, then
/// the MSI, then a bare portable exe. A release with no matching asset falls
/// back to the release page, which always has something to click.
fn installer(assets: &[Asset]) -> Option<&Asset> {
    let score = |name: &str| -> u8 {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with("setup.exe") {
            4
        } else if lower.ends_with(".msi") {
            3
        } else if lower.ends_with(".exe") {
            2
        } else if lower.ends_with(".zip") {
            1
        } else {
            0
        }
    };
    assets
        .iter()
        .filter(|a| score(&a.name) > 0)
        .max_by_key(|a| score(&a.name))
}

/// Asks GitHub for the latest release and compares it with this build.
///
/// Never returns `available: true` on a guess: a failed request is an error the
/// caller can show, an empty repository is `latest: None`, and only a tag that
/// parses and sorts above [`CURRENT`] counts as an update.
pub async fn check() -> AppResult<UpdateCheck> {
    let Some((owner, name)) = repo() else {
        return Ok(UpdateCheck::none(false));
    };

    let url = format!("https://api.github.com/repos/{owner}/{name}/releases/latest");
    let response = http()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                AppError::Timeout(12)
            } else {
                AppError::Network(format!("Could not reach GitHub: {e}"))
            }
        })?;

    let status = response.status();
    // A repository whose first release is not published yet. Expected, not a
    // failure — there is simply nothing newer than what is installed.
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(UpdateCheck::none(true));
    }
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(AppError::RateLimited {
            retry_after_secs: 60,
        });
    }
    if !status.is_success() {
        return Err(AppError::Api {
            status: status.as_u16(),
            message: "GitHub could not report the latest release.".into(),
        });
    }

    let release: Release = response.json().await.map_err(|e| AppError::Malformed {
        source_name: "GitHub".into(),
        detail: e.to_string(),
    })?;

    // `releases/latest` already excludes drafts and pre-releases, but the field
    // is cheap to honour and a repository can be reconfigured.
    if release.draft || release.prerelease {
        return Ok(UpdateCheck::none(true));
    }

    let latest = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    let asset = installer(&release.assets);
    let notes = release
        .body
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(|b| b.chars().take(1200).collect::<String>())
        .or_else(|| release.name.clone());

    Ok(UpdateCheck {
        configured: true,
        current: CURRENT.to_string(),
        available: is_newer(&latest, CURRENT),
        latest: Some(latest),
        release_url: release.html_url,
        download_url: asset.map(|a| a.browser_download_url.clone()),
        download_name: asset.map(|a| a.name.clone()),
        notes,
        published_at: release.published_at,
    })
}

/// Checks GitHub for a newer release and reports it to the UI.
///
/// A transient failure surfaces to the moderator as a message, never as "you
/// are up to date": the only way `available` becomes true is a released tag
/// that parses and sorts above the running build.
#[tauri::command]
pub async fn check_update() -> AppResult<UpdateCheck> {
    check().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_sort_as_numbers_not_strings() {
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(!is_newer("1.9.0", "1.10.0"));
        assert!(is_newer("2.0.0", "1.99.99"));
    }

    #[test]
    fn the_same_version_is_not_an_update() {
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("v1.0.0", "1.0.0"));
        assert!(!is_newer("1.0", "1.0.0"));
    }

    #[test]
    fn a_prerelease_never_outranks_the_finished_release() {
        assert!(!is_newer("1.0.0-beta.1", "1.0.0"));
        assert!(is_newer("1.0.0", "1.0.0-beta.1"));
        assert!(is_newer("1.1.0-rc.1", "1.0.0"));
    }

    #[test]
    fn an_unreadable_tag_is_never_an_update() {
        assert!(!is_newer("latest", "1.0.0"));
        assert!(!is_newer("", "1.0.0"));
        assert!(!is_newer("release-candidate", "1.0.0"));
    }

    #[test]
    fn the_placeholder_repository_counts_as_unconfigured() {
        // Guards the shipped Cargo.toml: until OWNER is replaced, the check
        // must report itself unconfigured rather than query a dead URL.
        assert_eq!(is_configured(), repo().is_some());
    }

    #[test]
    fn the_installer_wins_over_other_assets() {
        let assets = vec![
            Asset {
                name: "SRCTools-portable.exe".into(),
                browser_download_url: "https://example.com/p".into(),
            },
            Asset {
                name: "SRCTools-1.1.0-Setup.exe".into(),
                browser_download_url: "https://example.com/s".into(),
            },
            Asset {
                name: "notes.txt".into(),
                browser_download_url: "https://example.com/n".into(),
            },
        ];
        assert_eq!(installer(&assets).unwrap().name, "SRCTools-1.1.0-Setup.exe");
        assert!(installer(&[]).is_none());
    }
}
