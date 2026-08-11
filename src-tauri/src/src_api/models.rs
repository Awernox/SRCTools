//! Speedrun.com API v1 resource models.
//!
//! These mirror the wire format documented at
//! <https://github.com/speedruncomorg/api/tree/master/version1>. Fields the API
//! marks as nullable are `Option` here, and nothing is invented: if the API does
//! not expose a value, it stays `None` and the UI renders it as unavailable
//! rather than guessing.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Envelope for a single-resource response.
#[derive(Debug, Deserialize)]
pub struct Envelope<T> {
    pub data: T,
}

/// Envelope for a paginated collection response.
#[derive(Debug, Deserialize)]
pub struct PagedEnvelope<T> {
    pub data: Vec<T>,
    #[serde(default)]
    pub pagination: Option<Pagination>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Pagination {
    pub offset: u32,
    pub max: u32,
    pub size: u32,
    #[serde(default)]
    pub links: Vec<Link>,
}

impl Pagination {
    /// True when the API advertises a `next` relation.
    pub fn has_next(&self) -> bool {
        self.links.iter().any(|l| l.rel.as_deref() == Some("next"))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Link {
    #[serde(default)]
    pub rel: Option<String>,
    pub uri: String,
}

/// Error body returned by the API on 4xx/5xx.
#[derive(Debug, Deserialize)]
pub struct ApiErrorBody {
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct User {
    pub id: String,
    #[serde(default)]
    pub names: Names,
    #[serde(default)]
    pub weblink: Option<String>,
    /// `user`, `guest`, `moderator`, `admin`, `banned`, `program` …
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub signup: Option<String>,
    #[serde(default)]
    pub location: Option<Location>,
    #[serde(default)]
    pub assets: Option<UserAssets>,
    #[serde(default, rename = "name-style")]
    pub name_style: Option<NameStyle>,
}

impl User {
    /// Best available display name.
    pub fn display_name(&self) -> String {
        self.names
            .international
            .clone()
            .or_else(|| self.names.japanese.clone())
            .unwrap_or_else(|| self.id.clone())
    }

    /// Avatar/image URL if the profile exposes one.
    pub fn avatar_url(&self) -> Option<String> {
        self.assets
            .as_ref()
            .and_then(|a| a.image.as_ref())
            .and_then(|i| i.uri.clone())
    }

    /// Two-letter country code when the user has set a location.
    pub fn country_code(&self) -> Option<String> {
        self.location
            .as_ref()
            .and_then(|l| l.country.as_ref())
            .and_then(|c| c.code.clone())
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Names {
    #[serde(default)]
    pub international: Option<String>,
    #[serde(default)]
    pub japanese: Option<String>,
    #[serde(default)]
    pub twitch: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NameStyle {
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub color: Option<ColorPair>,
    #[serde(default, rename = "color-from")]
    pub color_from: Option<ColorPair>,
    #[serde(default, rename = "color-to")]
    pub color_to: Option<ColorPair>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ColorPair {
    #[serde(default)]
    pub light: Option<String>,
    #[serde(default)]
    pub dark: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Location {
    #[serde(default)]
    pub country: Option<Country>,
    #[serde(default)]
    pub region: Option<Country>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Country {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub names: Names,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UserAssets {
    #[serde(default)]
    pub icon: Option<Asset>,
    #[serde(default)]
    pub image: Option<Asset>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Asset {
    #[serde(default)]
    pub uri: Option<String>,
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Run {
    pub id: String,
    #[serde(default)]
    pub weblink: Option<String>,
    /// Game ID, or an embedded `Game` when `embed=game` was requested.
    #[serde(default)]
    pub game: Option<serde_json::Value>,
    #[serde(default)]
    pub level: Option<serde_json::Value>,
    #[serde(default)]
    pub category: Option<serde_json::Value>,
    #[serde(default)]
    pub videos: Option<Videos>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub status: Option<RunStatus>,
    #[serde(default)]
    pub players: Option<serde_json::Value>,
    /// Date the run was achieved (`YYYY-MM-DD`). Null on some legacy runs.
    #[serde(default)]
    pub date: Option<String>,
    /// ISO-8601 submission timestamp. Null on runs predating the field.
    #[serde(default)]
    pub submitted: Option<String>,
    #[serde(default)]
    pub times: Option<Times>,
    #[serde(default)]
    pub system: Option<System>,
    #[serde(default)]
    pub splits: Option<Link>,
    /// Map of variable ID → value ID.
    #[serde(default)]
    pub values: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RunStatus {
    /// `new`, `verified` or `rejected`.
    pub status: String,
    /// User ID of the moderator who examined the run. Absent while `new`.
    #[serde(default)]
    pub examiner: Option<String>,
    /// Rejection reason. Present only on rejected runs.
    #[serde(default)]
    pub reason: Option<String>,
    /// Verification timestamp. Present on verified runs; may be null on legacy ones.
    #[serde(default, rename = "verify-date")]
    pub verify_date: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Videos {
    /// Free-text fallback the runner typed instead of (or alongside) links.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Times {
    #[serde(default)]
    pub primary: Option<String>,
    #[serde(default)]
    pub primary_t: Option<f64>,
    #[serde(default)]
    pub realtime: Option<String>,
    #[serde(default)]
    pub realtime_t: Option<f64>,
    #[serde(default)]
    pub realtime_noloads: Option<String>,
    #[serde(default)]
    pub realtime_noloads_t: Option<f64>,
    #[serde(default)]
    pub ingame: Option<String>,
    #[serde(default)]
    pub ingame_t: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct System {
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub emulated: Option<bool>,
    /// Frequently null — many games (e.g. PC titles) have no region concept.
    #[serde(default)]
    pub region: Option<String>,
}

/// A run player: either a registered user or a named guest.
///
/// Built by [`Run::players`] rather than parsed from the API, but it round-trips
/// through the SQLite cache inside a `RunSummary`, so it deserializes too.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPlayer {
    pub kind: PlayerKind,
    /// User ID; `None` for guests.
    pub id: Option<String>,
    pub name: String,
    pub avatar_url: Option<String>,
    pub weblink: Option<String>,
    pub country_code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerKind {
    User,
    Guest,
}

impl Run {
    /// Resolves the `players` field, which is either a list of `{rel, id|name}`
    /// references or, with `embed=players`, a `{data: [...]}` collection of
    /// full user objects.
    pub fn players(&self) -> Vec<RunPlayer> {
        let Some(value) = &self.players else {
            return Vec::new();
        };

        let items: Vec<&serde_json::Value> = match value {
            serde_json::Value::Array(a) => a.iter().collect(),
            serde_json::Value::Object(o) => o
                .get("data")
                .and_then(|d| d.as_array())
                .map(|a| a.iter().collect())
                .unwrap_or_default(),
            _ => Vec::new(),
        };

        items
            .into_iter()
            .filter_map(|item| {
                let rel = item.get("rel").and_then(|r| r.as_str());
                // A guest entry carries a literal `name` and no user profile.
                if rel == Some("guest") {
                    let name = item.get("name").and_then(|n| n.as_str())?;
                    return Some(RunPlayer {
                        kind: PlayerKind::Guest,
                        id: None,
                        name: name.to_string(),
                        avatar_url: None,
                        weblink: item
                            .get("uri")
                            .and_then(|u| u.as_str())
                            .map(str::to_string),
                        country_code: None,
                    });
                }

                // Embedded user objects have `names`; bare references do not.
                if item.get("names").is_some() {
                    let user: User = serde_json::from_value(item.clone()).ok()?;
                    return Some(RunPlayer {
                        kind: PlayerKind::User,
                        id: Some(user.id.clone()),
                        name: user.display_name(),
                        avatar_url: user.avatar_url(),
                        weblink: user.weblink.clone(),
                        country_code: user.country_code(),
                    });
                }

                // Unembedded reference: we know the ID but not the name yet.
                let id = item.get("id").and_then(|i| i.as_str())?;
                Some(RunPlayer {
                    kind: PlayerKind::User,
                    id: Some(id.to_string()),
                    name: id.to_string(),
                    avatar_url: None,
                    weblink: item.get("uri").and_then(|u| u.as_str()).map(str::to_string),
                    country_code: None,
                })
            })
            .collect()
    }

    /// Extracts an ID from a field that may be a bare string or an embedded
    /// `{data: {...}}` object.
    fn embedded_id(value: &Option<serde_json::Value>) -> Option<String> {
        match value.as_ref()? {
            serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
            serde_json::Value::Object(o) => o
                .get("data")
                .and_then(|d| d.get("id"))
                .and_then(|i| i.as_str())
                .map(str::to_string),
            _ => None,
        }
    }

    /// Deserialises an embedded resource, returning `None` when the field held
    /// only an ID reference.
    fn embedded_object<T: for<'de> Deserialize<'de>>(
        value: &Option<serde_json::Value>,
    ) -> Option<T> {
        let obj = value.as_ref()?.as_object()?;
        serde_json::from_value(obj.get("data")?.clone()).ok()
    }

    pub fn game_id(&self) -> Option<String> {
        Self::embedded_id(&self.game)
    }

    pub fn category_id(&self) -> Option<String> {
        Self::embedded_id(&self.category)
    }

    pub fn level_id(&self) -> Option<String> {
        Self::embedded_id(&self.level)
    }

    pub fn embedded_game(&self) -> Option<Game> {
        Self::embedded_object(&self.game)
    }

    pub fn embedded_category(&self) -> Option<Category> {
        Self::embedded_object(&self.category)
    }

    pub fn embedded_level(&self) -> Option<Level> {
        Self::embedded_object(&self.level)
    }

    /// Primary time in seconds, the value leaderboards are ordered by.
    pub fn primary_seconds(&self) -> Option<f64> {
        self.times.as_ref().and_then(|t| t.primary_t).filter(|v| *v > 0.0)
    }

    /// Verification state as a lowercase string, defaulting to `new`.
    pub fn status_str(&self) -> &str {
        self.status.as_ref().map_or("new", |s| s.status.as_str())
    }

    /// All video URLs attached to the run, in submission order.
    pub fn video_urls(&self) -> Vec<String> {
        self.videos
            .as_ref()
            .map(|v| v.links.iter().map(|l| l.uri.clone()).collect())
            .unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Leaderboard {
    #[serde(default)]
    pub weblink: Option<String>,
    #[serde(default)]
    pub game: Option<serde_json::Value>,
    #[serde(default)]
    pub category: Option<serde_json::Value>,
    #[serde(default)]
    pub level: Option<serde_json::Value>,
    #[serde(default)]
    pub timing: Option<String>,
    #[serde(default)]
    pub values: HashMap<String, String>,
    #[serde(default)]
    pub runs: Vec<PlacedRun>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlacedRun {
    pub place: u32,
    pub run: Run,
}

// ---------------------------------------------------------------------------
// Notifications (used to surface new submissions)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Notification {
    pub id: String,
    pub created: String,
    /// `read` or `unread`.
    pub status: String,
    pub text: String,
    #[serde(default)]
    pub item: Option<Link>,
    #[serde(default)]
    pub links: Vec<Link>,
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Game {
    pub id: String,
    #[serde(default)]
    pub names: Names,
    #[serde(default)]
    pub abbreviation: Option<String>,
    #[serde(default)]
    pub weblink: Option<String>,
    #[serde(default)]
    pub released: Option<i32>,
    #[serde(default, rename = "release-date")]
    pub release_date: Option<String>,
    #[serde(default)]
    pub ruleset: Option<Ruleset>,
    #[serde(default)]
    pub romhack: Option<bool>,
    /// Platform IDs, or embedded platform objects when `embed=platforms`.
    #[serde(default)]
    pub platforms: Option<serde_json::Value>,
    #[serde(default)]
    pub regions: Option<serde_json::Value>,
    /// Map of user ID → `moderator` | `super-moderator`.
    #[serde(default)]
    pub moderators: HashMap<String, String>,
    #[serde(default)]
    pub created: Option<String>,
    #[serde(default)]
    pub assets: Option<GameAssets>,
}

impl Game {
    pub fn display_name(&self) -> String {
        self.names
            .international
            .clone()
            .or_else(|| self.abbreviation.clone())
            .unwrap_or_else(|| self.id.clone())
    }

    pub fn cover_url(&self) -> Option<String> {
        self.assets
            .as_ref()
            .and_then(|a| a.cover_medium.as_ref().or(a.cover_small.as_ref()))
            .and_then(|c| c.uri.clone())
    }

    /// Extracts IDs from a field that may be either `["id", …]` or embedded
    /// objects, depending on whether the caller asked for `embed`.
    fn id_list(value: &Option<serde_json::Value>) -> Vec<String> {
        let Some(v) = value else { return Vec::new() };
        match v {
            serde_json::Value::Array(items) => items
                .iter()
                .filter_map(|item| match item {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Object(o) => {
                        o.get("id").and_then(|i| i.as_str()).map(str::to_string)
                    }
                    _ => None,
                })
                .collect(),
            // `embed=platforms` nests the collection under `data`.
            serde_json::Value::Object(o) => o
                .get("data")
                .and_then(|d| d.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|i| i.get("id").and_then(|x| x.as_str()).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    pub fn platform_ids(&self) -> Vec<String> {
        Self::id_list(&self.platforms)
    }

    pub fn region_ids(&self) -> Vec<String> {
        Self::id_list(&self.regions)
    }

    /// Moderator role for a user, if they moderate this game at all.
    pub fn moderator_role(&self, user_id: &str) -> Option<&str> {
        self.moderators.get(user_id).map(String::as_str)
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Ruleset {
    #[serde(default, rename = "show-milliseconds")]
    pub show_milliseconds: Option<bool>,
    #[serde(default, rename = "require-verification")]
    pub require_verification: Option<bool>,
    #[serde(default, rename = "require-video")]
    pub require_video: Option<bool>,
    #[serde(default, rename = "run-times")]
    pub run_times: Vec<String>,
    #[serde(default, rename = "default-time")]
    pub default_time: Option<String>,
    #[serde(default, rename = "emulators-allowed")]
    pub emulators_allowed: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GameAssets {
    #[serde(default, rename = "cover-tiny")]
    pub cover_tiny: Option<Asset>,
    #[serde(default, rename = "cover-small")]
    pub cover_small: Option<Asset>,
    #[serde(default, rename = "cover-medium")]
    pub cover_medium: Option<Asset>,
    #[serde(default, rename = "cover-large")]
    pub cover_large: Option<Asset>,
    #[serde(default)]
    pub icon: Option<Asset>,
}

// ---------------------------------------------------------------------------
// Categories, levels, variables
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub weblink: Option<String>,
    /// `per-game` or `per-level`.
    #[serde(default, rename = "type")]
    pub category_type: Option<String>,
    #[serde(default)]
    pub rules: Option<String>,
    #[serde(default)]
    pub players: Option<CategoryPlayers>,
    #[serde(default)]
    pub miscellaneous: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CategoryPlayers {
    /// `exactly` or `up-to`.
    #[serde(default, rename = "type")]
    pub player_type: Option<String>,
    #[serde(default)]
    pub value: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Level {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub weblink: Option<String>,
    #[serde(default)]
    pub rules: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Variable {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub scope: Option<VariableScope>,
    #[serde(default)]
    pub mandatory: Option<bool>,
    #[serde(default, rename = "user-defined")]
    pub user_defined: Option<bool>,
    #[serde(default, rename = "is-subcategory")]
    pub is_subcategory: Option<bool>,
    #[serde(default)]
    pub values: Option<VariableValues>,
}

impl Variable {
    /// Human label for a value ID within this variable.
    pub fn value_label(&self, value_id: &str) -> Option<String> {
        self.values
            .as_ref()?
            .values
            .get(value_id)
            .map(|v| v.label.clone())
    }

    pub fn is_subcategory(&self) -> bool {
        self.is_subcategory.unwrap_or(false)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VariableScope {
    /// `global`, `full-game`, `all-levels`, `single-level`.
    #[serde(default, rename = "type")]
    pub scope_type: Option<String>,
    #[serde(default)]
    pub level: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VariableValues {
    #[serde(default, rename = "_note")]
    pub note: Option<String>,
    #[serde(default)]
    pub choices: HashMap<String, String>,
    #[serde(default)]
    pub values: HashMap<String, VariableValue>,
    #[serde(default)]
    pub default: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VariableValue {
    pub label: String,
    #[serde(default)]
    pub rules: Option<String>,
    #[serde(default)]
    pub flags: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Platforms and regions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Platform {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub released: Option<i32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Region {
    pub id: String,
    pub name: String,
}

