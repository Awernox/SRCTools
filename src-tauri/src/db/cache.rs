//! Expiring cache for API payloads and video verdicts.
//!
//! Two rules govern this module:
//!
//! - **Expiry is checked on read, not by a background sweep.** A stale row is
//!   simply not returned, so a cache that has not been swept is never wrong.
//! - **Only conclusive answers are cached.** `put_video_check` refuses to store
//!   a `NETWORK_ERROR` or `UNKNOWN` verdict, because caching "we could not
//!   reach the provider" would turn one transient failure into a persistent
//!   wrong answer.

use chrono::{Duration, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use super::{sql_err, CacheStats, Db};
use crate::error::{AppError, AppResult};
use crate::video::{cache_ttl_seconds, VideoCheck};

/// Cache namespaces. Each can be invalidated independently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheKind {
    Game,
    Categories,
    Levels,
    Variables,
    User,
    Run,
    Leaderboard,
    Platforms,
    Regions,
    ModeratedGames,
    Profile,
}

impl CacheKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Game => "game",
            Self::Categories => "categories",
            Self::Levels => "levels",
            Self::Variables => "variables",
            Self::User => "user",
            Self::Run => "run",
            Self::Leaderboard => "leaderboard",
            Self::Platforms => "platforms",
            Self::Regions => "regions",
            Self::ModeratedGames => "moderated_games",
            Self::Profile => "profile",
        }
    }

    /// Default lifetime, chosen by how often the underlying data really moves.
    ///
    /// Rules and categories change rarely; a run's own record can change the
    /// moment another moderator touches it, so it is cached only briefly.
    pub fn default_ttl(&self) -> Duration {
        match self {
            // Effectively static reference data.
            Self::Platforms | Self::Regions => Duration::days(7),
            // Game metadata, rules and category lists.
            Self::Game | Self::Categories | Self::Levels | Self::Variables => Duration::hours(12),
            Self::ModeratedGames => Duration::hours(6),
            Self::User | Self::Profile => Duration::hours(6),
            // Leaderboards move whenever a run is verified.
            Self::Leaderboard => Duration::minutes(30),
            // Another moderator may already be acting on this run.
            Self::Run => Duration::minutes(5),
        }
    }
}

impl Db {
    /// Reads a cached payload, or `None` when absent or expired.
    ///
    /// A row whose JSON no longer deserialises (schema changed between
    /// versions) is treated as a miss rather than an error.
    pub fn cache_get<T: DeserializeOwned>(&self, kind: CacheKind, key: &str) -> AppResult<Option<T>> {
        let now = crate::util::now_iso8601();
        let raw: Option<String> = self.with_conn(|conn| {
            conn.query_row(
                "SELECT payload FROM cache_entries
                 WHERE kind = ?1 AND key = ?2
                   AND (expires_at IS NULL OR expires_at > ?3)",
                params![kind.as_str(), key, now],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_err)
        })?;

        Ok(raw.and_then(|json| serde_json::from_str(&json).ok()))
    }

    /// Stores a payload with the namespace's default lifetime.
    pub fn cache_put<T: Serialize>(&self, kind: CacheKind, key: &str, value: &T) -> AppResult<()> {
        self.cache_put_with_ttl(kind, key, value, kind.default_ttl())
    }

    pub fn cache_put_with_ttl<T: Serialize>(
        &self,
        kind: CacheKind,
        key: &str,
        value: &T,
        ttl: Duration,
    ) -> AppResult<()> {
        let payload = serde_json::to_string(value)
            .map_err(|e| AppError::Internal(format!("could not encode a cache entry: {e}")))?;
        let now = Utc::now();
        let expires = now + ttl;

        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO cache_entries (kind, key, payload, fetched_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(kind, key) DO UPDATE SET
                     payload = excluded.payload,
                     fetched_at = excluded.fetched_at,
                     expires_at = excluded.expires_at",
                params![
                    kind.as_str(),
                    key,
                    payload,
                    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ],
            )
            .map_err(sql_err)?;
            Ok(())
        })
    }

    /// Drops one entry, e.g. after moderating a run so the next read is fresh.
    pub fn cache_invalidate(&self, kind: CacheKind, key: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM cache_entries WHERE kind = ?1 AND key = ?2",
                params![kind.as_str(), key],
            )
            .map_err(sql_err)?;
            Ok(())
        })
    }

    /// Drops a whole namespace.
    pub fn cache_invalidate_kind(&self, kind: CacheKind) -> AppResult<usize> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM cache_entries WHERE kind = ?1",
                params![kind.as_str()],
            )
            .map_err(sql_err)
        })
    }

    /// Reads a stored video verdict, or `None` when absent or expired.
    ///
    /// The returned check is marked `from_cache` so the UI can show when it was
    /// originally verified instead of implying a fresh check.
    pub fn video_check_get(&self, normalized_url: &str) -> AppResult<Option<VideoCheck>> {
        let now = crate::util::now_iso8601();
        let raw: Option<String> = self.with_conn(|conn| {
            conn.query_row(
                "SELECT payload FROM video_checks
                 WHERE normalized_url = ?1
                   AND (expires_at IS NULL OR expires_at > ?2)",
                params![normalized_url, now],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_err)
        })?;

        Ok(raw
            .and_then(|json| serde_json::from_str::<VideoCheck>(&json).ok())
            .map(|mut check| {
                check.from_cache = true;
                check
            }))
    }

    /// Stores a verdict, if it is one worth storing.
    ///
    /// Returns `false` when the verdict was deliberately not cached.
    pub fn video_check_put(&self, check: &VideoCheck) -> AppResult<bool> {
        let Some(key) = check.normalized_url.as_deref() else {
            return Ok(false);
        };
        let Some(ttl) = cache_ttl_seconds(check.status) else {
            // Transient or unknown: never persisted. A later check must retry.
            return Ok(false);
        };

        let payload = serde_json::to_string(check)
            .map_err(|e| AppError::Internal(format!("could not encode a video check: {e}")))?;
        let expires = (Utc::now() + Duration::seconds(ttl))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO video_checks (normalized_url, payload, status, checked_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(normalized_url) DO UPDATE SET
                     payload = excluded.payload,
                     status = excluded.status,
                     checked_at = excluded.checked_at,
                     expires_at = excluded.expires_at",
                params![
                    key,
                    payload,
                    check.status.as_str(),
                    check.checked_at,
                    expires
                ],
            )
            .map_err(sql_err)?;
            Ok(true)
        })?;
        Ok(true)
    }

    /// Forgets one video verdict, for the UI's "re-check" action.
    pub fn video_check_forget(&self, normalized_url: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM video_checks WHERE normalized_url = ?1",
                params![normalized_url],
            )
            .map_err(sql_err)?;
            Ok(())
        })
    }

    /// Removes expired rows only. Cheap, safe to call on startup.
    pub fn cache_prune_expired(&self) -> AppResult<usize> {
        let now = crate::util::now_iso8601();
        self.with_tx(|tx| {
            let a = tx
                .execute(
                    "DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?1",
                    params![now],
                )
                .map_err(sql_err)?;
            let b = tx
                .execute(
                    "DELETE FROM video_checks WHERE expires_at IS NOT NULL AND expires_at <= ?1",
                    params![now],
                )
                .map_err(sql_err)?;
            Ok(a + b)
        })
    }

    /// Empties the cache entirely.
    ///
    /// Deliberately leaves moderation history, audit log and settings intact —
    /// those are the moderator's own records, not a copy of remote data.
    pub fn cache_clear(&self) -> AppResult<usize> {
        let removed = self.with_tx(|tx| {
            let a = tx.execute("DELETE FROM cache_entries", []).map_err(sql_err)?;
            let b = tx.execute("DELETE FROM video_checks", []).map_err(sql_err)?;
            Ok(a + b)
        })?;
        // Best-effort: reclaiming space is not worth failing the operation over.
        let _ = self.vacuum();
        Ok(removed)
    }

    /// Counts and disk usage for the settings page.
    pub fn cache_stats(&self) -> AppResult<CacheStats> {
        let now = crate::util::now_iso8601();
        let mut stats = self.with_conn(|conn| {
            let one = |sql: &str| -> AppResult<i64> {
                conn.query_row(sql, [], |r| r.get(0)).map_err(sql_err)
            };
            let expired: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM cache_entries
                     WHERE expires_at IS NOT NULL AND expires_at <= ?1",
                    params![now],
                    |r| r.get(0),
                )
                .map_err(sql_err)?;
            let oldest: Option<String> = conn
                .query_row("SELECT MIN(fetched_at) FROM cache_entries", [], |r| r.get(0))
                .optional()
                .map_err(sql_err)?
                .flatten();

            Ok(CacheStats {
                cache_entries: one("SELECT COUNT(*) FROM cache_entries")?,
                expired_entries: expired,
                video_checks: one("SELECT COUNT(*) FROM video_checks")?,
                history_entries: one("SELECT COUNT(*) FROM moderation_history")?,
                audit_entries: one("SELECT COUNT(*) FROM audit_log")?,
                database_bytes: None,
                database_path: String::new(),
                oldest_entry_at: oldest,
            })
        })?;

        stats.database_bytes = self.size_bytes();
        stats.database_path = self.path().display().to_string();
        Ok(stats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::{VideoPlatform, VideoStatus};

    fn check(status: VideoStatus, key: &str) -> VideoCheck {
        VideoCheck::new("https://youtu.be/x", VideoPlatform::YouTube, status, "test")
            .with_normalized(key)
    }

    #[test]
    fn payloads_round_trip() {
        let db = Db::open_in_memory().unwrap();
        db.cache_put(CacheKind::Game, "sm64", &vec!["a", "b"]).unwrap();
        let got: Option<Vec<String>> = db.cache_get(CacheKind::Game, "sm64").unwrap();
        assert_eq!(got, Some(vec!["a".to_string(), "b".to_string()]));
    }

    #[test]
    fn namespaces_do_not_collide() {
        let db = Db::open_in_memory().unwrap();
        db.cache_put(CacheKind::Game, "x", &1u8).unwrap();
        db.cache_put(CacheKind::User, "x", &2u8).unwrap();
        assert_eq!(db.cache_get::<u8>(CacheKind::Game, "x").unwrap(), Some(1));
        assert_eq!(db.cache_get::<u8>(CacheKind::User, "x").unwrap(), Some(2));
    }

    #[test]
    fn expired_entries_read_as_a_miss() {
        let db = Db::open_in_memory().unwrap();
        db.cache_put_with_ttl(CacheKind::Run, "r1", &"payload", Duration::seconds(-10))
            .unwrap();
        assert_eq!(db.cache_get::<String>(CacheKind::Run, "r1").unwrap(), None);
    }

    #[test]
    fn writing_twice_overwrites() {
        let db = Db::open_in_memory().unwrap();
        db.cache_put(CacheKind::Run, "r1", &"first").unwrap();
        db.cache_put(CacheKind::Run, "r1", &"second").unwrap();
        assert_eq!(
            db.cache_get::<String>(CacheKind::Run, "r1").unwrap(),
            Some("second".to_string())
        );
    }

    #[test]
    fn transient_video_verdicts_are_refused() {
        let db = Db::open_in_memory().unwrap();
        assert!(!db
            .video_check_put(&check(VideoStatus::NetworkError, "youtube:a"))
            .unwrap());
        assert!(!db
            .video_check_put(&check(VideoStatus::Unknown, "youtube:b"))
            .unwrap());
        assert!(db.video_check_get("youtube:a").unwrap().is_none());
    }

    #[test]
    fn conclusive_video_verdicts_are_stored_and_flagged() {
        let db = Db::open_in_memory().unwrap();
        assert!(db
            .video_check_put(&check(VideoStatus::Deleted, "youtube:gone"))
            .unwrap());
        let got = db.video_check_get("youtube:gone").unwrap().expect("cached");
        assert_eq!(got.status, VideoStatus::Deleted);
        assert!(got.from_cache, "cached reads must be marked as such");
    }

    #[test]
    fn clearing_the_cache_keeps_local_records() {
        let db = Db::open_in_memory().unwrap();
        db.cache_put(CacheKind::Game, "g", &"v").unwrap();
        db.video_check_put(&check(VideoStatus::Available, "youtube:ok"))
            .unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO moderation_history (run_id, action, outcome, acted_at)
                 VALUES ('r', 'verify', 'success', '2026-01-01T00:00:00Z')",
                [],
            )
            .map_err(sql_err)?;
            Ok(())
        })
        .unwrap();

        let removed = db.cache_clear().unwrap();
        assert_eq!(removed, 2);

        let stats = db.cache_stats().unwrap();
        assert_eq!(stats.cache_entries, 0);
        assert_eq!(stats.video_checks, 0);
        assert_eq!(stats.history_entries, 1, "history must survive a cache clear");
    }

    #[test]
    fn pruning_removes_only_expired_rows() {
        let db = Db::open_in_memory().unwrap();
        db.cache_put_with_ttl(CacheKind::Run, "old", &"x", Duration::seconds(-10))
            .unwrap();
        db.cache_put_with_ttl(CacheKind::Run, "new", &"x", Duration::hours(1))
            .unwrap();
        assert_eq!(db.cache_prune_expired().unwrap(), 1);
        assert!(db.cache_get::<String>(CacheKind::Run, "new").unwrap().is_some());
    }

    #[test]
    fn invalidation_targets_one_entry_then_one_kind() {
        let db = Db::open_in_memory().unwrap();
        db.cache_put(CacheKind::Run, "a", &"x").unwrap();
        db.cache_put(CacheKind::Run, "b", &"x").unwrap();
        db.cache_invalidate(CacheKind::Run, "a").unwrap();
        assert!(db.cache_get::<String>(CacheKind::Run, "a").unwrap().is_none());
        assert!(db.cache_get::<String>(CacheKind::Run, "b").unwrap().is_some());
        assert_eq!(db.cache_invalidate_kind(CacheKind::Run).unwrap(), 1);
    }
}
