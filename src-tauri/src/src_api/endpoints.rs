//! Typed wrappers over the Speedrun.com endpoints SRCTools uses.
//!
//! Each function maps to exactly one documented endpoint. Where the API offers
//! `embed`, we use it to collapse what would otherwise be N+1 request storms
//! (a queue of 200 runs would otherwise need 800 follow-up lookups).

use super::client::SrcClient;
use super::models::*;
use crate::error::{AppError, AppResult};

/// Embeds that make a run self-describing in a single request.
const RUN_EMBEDS: &str = "game,category,level,players,platform,region";

/// Verification state filter for the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatusFilter {
    New,
    Verified,
    Rejected,
}

impl RunStatusFilter {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Verified => "verified",
            Self::Rejected => "rejected",
        }
    }

    pub fn parse(s: &str) -> AppResult<Self> {
        match s {
            "new" | "pending" => Ok(Self::New),
            "verified" | "approved" => Ok(Self::Verified),
            "rejected" => Ok(Self::Rejected),
            other => Err(AppError::InvalidInput(format!(
                "Unknown run status '{other}'. Expected new, verified or rejected."
            ))),
        }
    }
}

/// Sort key accepted by `GET /runs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOrder {
    Submitted,
    Date,
    VerifyDate,
    Game,
    Category,
    Status,
}

impl RunOrder {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::Date => "date",
            Self::VerifyDate => "verify-date",
            Self::Game => "game",
            Self::Category => "category",
            Self::Status => "status",
        }
    }
}

/// Query builder for `GET /runs`.
#[derive(Debug, Default, Clone)]
pub struct RunQuery {
    pub game: Option<String>,
    pub category: Option<String>,
    pub level: Option<String>,
    pub user: Option<String>,
    pub guest: Option<String>,
    pub examiner: Option<String>,
    pub platform: Option<String>,
    pub region: Option<String>,
    pub emulated: Option<bool>,
    pub status: Option<RunStatusFilter>,
    pub order_by: Option<RunOrder>,
    /// `true` for ascending.
    pub ascending: bool,
    pub embed: bool,
    /// Defeats the CDN cache for polling queries.
    ///
    /// Speedrun.com serves `/runs` with `Cache-Control: public, max-age=300`, so
    /// a repeated identical URL can be answered from an edge copy up to five
    /// minutes old — measured directly: the same request returned a run list
    /// with an `Age` header climbing past two minutes while a fresh submission
    /// was already live. That, not the poll cadence, was the delay between a run
    /// appearing on the site and the notification firing.
    ///
    /// Set to a value that changes each cycle so the URL is unique and the edge
    /// has to ask the origin. Only the watcher sets it: everything else *wants*
    /// the cache, and busting it everywhere would multiply real API load.
    pub cache_buster: Option<u64>,
}

impl RunQuery {
    pub fn to_path(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        let push = |parts: &mut Vec<String>, k: &str, v: &str| {
            parts.push(format!("{k}={}", urlencode(v)));
        };

        if let Some(v) = &self.game {
            push(&mut parts, "game", v);
        }
        if let Some(v) = &self.category {
            push(&mut parts, "category", v);
        }
        if let Some(v) = &self.level {
            push(&mut parts, "level", v);
        }
        if let Some(v) = &self.user {
            push(&mut parts, "user", v);
        }
        if let Some(v) = &self.guest {
            push(&mut parts, "guest", v);
        }
        if let Some(v) = &self.examiner {
            push(&mut parts, "examiner", v);
        }
        if let Some(v) = &self.platform {
            push(&mut parts, "platform", v);
        }
        if let Some(v) = &self.region {
            push(&mut parts, "region", v);
        }
        if let Some(v) = self.emulated {
            push(&mut parts, "emulated", if v { "yes" } else { "no" });
        }
        if let Some(s) = self.status {
            push(&mut parts, "status", s.as_str());
        }
        if let Some(o) = self.order_by {
            push(&mut parts, "orderby", o.as_str());
            push(
                &mut parts,
                "direction",
                if self.ascending { "asc" } else { "desc" },
            );
        }
        if self.embed {
            push(&mut parts, "embed", RUN_EMBEDS);
        }
        if let Some(n) = self.cache_buster {
            // Ignored by the API, which is the point: it only has to make the
            // URL differ from the last one so the CDN cannot answer from its
            // five-minute copy.
            push(&mut parts, "_", &n.to_string());
        }

        if parts.is_empty() {
            "/runs".to_string()
        } else {
            format!("/runs?{}", parts.join("&"))
        }
    }
}

/// Percent-encodes a query parameter value.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b',' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/// `GET /profile` — the authenticated user. Requires a valid key.
pub async fn profile(client: &SrcClient, api_key: &str) -> AppResult<User> {
    client.get::<User>("/profile", Some(api_key)).await
}

/// `GET /users/{id}`
pub async fn user(client: &SrcClient, id: &str) -> AppResult<User> {
    client.get::<User>(&format!("/users/{}", urlencode(id)), None).await
}

/// `GET /users?lookup={name}` — resolves a username to a profile.
pub async fn user_by_name(client: &SrcClient, name: &str) -> AppResult<Option<User>> {
    let users: Vec<User> = client
        .get_all(&format!("/users?lookup={}", urlencode(name)), None, Some(5))
        .await?;
    Ok(users.into_iter().next())
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

/// `GET /games/{id}` with platforms and regions embedded.
pub async fn game(client: &SrcClient, id: &str) -> AppResult<Game> {
    client
        .get::<Game>(
            &format!("/games/{}?embed=platforms,regions", urlencode(id)),
            None,
        )
        .await
}

/// `GET /games?name={q}` — game search by name.
pub async fn search_games(client: &SrcClient, query: &str, limit: usize) -> AppResult<Vec<Game>> {
    client
        .get_all(&format!("/games?name={}", urlencode(query)), None, Some(limit))
        .await
}

/// Games where `user_id` appears in the moderator map.
///
/// `GET /games?moderator={id}` is the documented filter for this.
pub async fn games_moderated_by(
    client: &SrcClient,
    user_id: &str,
    api_key: Option<&str>,
) -> AppResult<Vec<Game>> {
    client
        .get_all(
            &format!("/games?moderator={}&embed=platforms,regions", urlencode(user_id)),
            api_key,
            Some(500),
        )
        .await
}

/// `GET /games/{id}/categories`
pub async fn categories(client: &SrcClient, game_id: &str) -> AppResult<Vec<Category>> {
    client
        .get::<Vec<Category>>(&format!("/games/{}/categories", urlencode(game_id)), None)
        .await
}

/// `GET /games/{id}/levels`
pub async fn levels(client: &SrcClient, game_id: &str) -> AppResult<Vec<Level>> {
    client
        .get::<Vec<Level>>(&format!("/games/{}/levels", urlencode(game_id)), None)
        .await
}

/// `GET /games/{id}/variables`
pub async fn variables(client: &SrcClient, game_id: &str) -> AppResult<Vec<Variable>> {
    client
        .get::<Vec<Variable>>(&format!("/games/{}/variables", urlencode(game_id)), None)
        .await
}

/// `GET /platforms` — the full platform list (cached aggressively; it rarely changes).
pub async fn platforms(client: &SrcClient) -> AppResult<Vec<Platform>> {
    client.get_all("/platforms", None, None).await
}

/// `GET /regions`
pub async fn regions(client: &SrcClient) -> AppResult<Vec<Region>> {
    client.get_all("/regions", None, None).await
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/// `GET /runs/{id}` with embeds resolved.
pub async fn run(client: &SrcClient, id: &str, api_key: Option<&str>) -> AppResult<Run> {
    client
        .get::<Run>(
            &format!("/runs/{}?embed={RUN_EMBEDS}", urlencode(id)),
            api_key,
        )
        .await
}

/// Fetches runs matching `query`, up to `limit`.
pub async fn runs(
    client: &SrcClient,
    query: &RunQuery,
    api_key: Option<&str>,
    limit: Option<usize>,
) -> AppResult<Vec<Run>> {
    client.get_all(&query.to_path(), api_key, limit).await
}

/// `PUT /runs/{id}/status` with `{"status":{"status":"verified"}}`.
///
/// Requires moderator rights on the run's game; the API enforces this and
/// returns 403 otherwise.
pub async fn verify_run(client: &SrcClient, api_key: &str, run_id: &str) -> AppResult<Run> {
    let body = serde_json::json!({ "status": { "status": "verified" } });
    client
        .put::<Run>(&format!("/runs/{}/status", urlencode(run_id)), api_key, body)
        .await
}

/// `DELETE /runs/{id}` — removes the run entirely.
///
/// Irreversible on Speedrun.com's side, so the command layer requires an
/// explicit confirmation before calling this.
pub async fn delete_run(client: &SrcClient, api_key: &str, run_id: &str) -> AppResult<Run> {
    client
        .delete::<Run>(&format!("/runs/{}", urlencode(run_id)), api_key)
        .await
}

/// `PUT /runs/{id}/status` with `{"status":{"status":"rejected","reason":…}}`.
///
/// The API requires a non-empty reason when rejecting.
pub async fn reject_run(
    client: &SrcClient,
    api_key: &str,
    run_id: &str,
    reason: &str,
) -> AppResult<Run> {
    let trimmed = reason.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "Speedrun.com requires a reason when rejecting a run.".into(),
        ));
    }
    let body = serde_json::json!({
        "status": { "status": "rejected", "reason": trimmed }
    });
    client
        .put::<Run>(&format!("/runs/{}/status", urlencode(run_id)), api_key, body)
        .await
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

/// `GET /leaderboards/{game}/category/{category}`.
///
/// `variable_filters` are `(variable_id, value_id)` pairs sent as `var-…`
/// parameters, which is how subcategories are addressed.
pub async fn leaderboard(
    client: &SrcClient,
    game_id: &str,
    category_id: &str,
    variable_filters: &[(String, String)],
    top: Option<u32>,
) -> AppResult<Leaderboard> {
    let mut path = format!(
        "/leaderboards/{}/category/{}?embed=players",
        urlencode(game_id),
        urlencode(category_id)
    );
    if let Some(t) = top {
        path.push_str(&format!("&top={t}"));
    }
    for (var, val) in variable_filters {
        path.push_str(&format!("&var-{}={}", urlencode(var), urlencode(val)));
    }
    client.get::<Leaderboard>(&path, None).await
}

/// `GET /leaderboards/{game}/level/{level}/{category}`
pub async fn level_leaderboard(
    client: &SrcClient,
    game_id: &str,
    level_id: &str,
    category_id: &str,
    top: Option<u32>,
) -> AppResult<Leaderboard> {
    let mut path = format!(
        "/leaderboards/{}/level/{}/{}?embed=players",
        urlencode(game_id),
        urlencode(level_id),
        urlencode(category_id)
    );
    if let Some(t) = top {
        path.push_str(&format!("&top={t}"));
    }
    client.get::<Leaderboard>(&path, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_queue_query() {
        let q = RunQuery {
            game: Some("om1m3625".into()),
            status: Some(RunStatusFilter::New),
            order_by: Some(RunOrder::Submitted),
            ascending: false,
            embed: true,
            ..Default::default()
        };
        let path = q.to_path();
        assert!(path.starts_with("/runs?"));
        assert!(path.contains("game=om1m3625"));
        assert!(path.contains("status=new"));
        assert!(path.contains("orderby=submitted"));
        assert!(path.contains("direction=desc"));
        assert!(path.contains("embed=game,category,level,players,platform,region"));
    }

    #[test]
    fn empty_query_has_no_question_mark() {
        assert_eq!(RunQuery::default().to_path(), "/runs");
    }

    #[test]
    fn urlencodes_specials() {
        assert_eq!(urlencode("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(urlencode("Super Mario 64"), "Super%20Mario%2064");
        // Commas survive because embed lists rely on them.
        assert_eq!(urlencode("game,category"), "game,category");
    }

    #[test]
    fn status_filter_accepts_ui_synonyms() {
        assert_eq!(RunStatusFilter::parse("pending").unwrap(), RunStatusFilter::New);
        assert_eq!(
            RunStatusFilter::parse("approved").unwrap(),
            RunStatusFilter::Verified
        );
        assert!(RunStatusFilter::parse("bogus").is_err());
    }
}
