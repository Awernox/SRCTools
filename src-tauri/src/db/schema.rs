//! SQLite schema and migrations.
//!
//! The database holds three unrelated kinds of data, and the difference matters
//! when the user presses "Clear cache":
//!
//! 1. **Cache** (`cache_entries`, `video_checks`) — a disposable copy of remote
//!    data. Safe to wipe at any moment; every read path can refetch.
//! 2. **Local records** (`moderation_history`, `audit_log`) — the moderator's
//!    own activity. Speedrun.com does not expose a per-moderator action log, so
//!    this is the only place it exists. Never touched by a cache clear.
//! 3. **Configuration** (`settings`, `rejection_templates`, `favorite_games`,
//!    `layouts`, `shortcuts`) — user preferences. Also never cache-cleared.
//!
//! No API key or secret is ever stored here; credentials live in the OS vault
//! (see `crate::secrets`).

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

/// Bump when the statements below change, and add a migration arm.
pub const SCHEMA_VERSION: i64 = 1;

/// Applies pragmas, creates missing tables and runs migrations.
pub fn initialize(conn: &Connection) -> AppResult<()> {
    // WAL keeps reads from blocking during a long bulk-moderation write.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| AppError::Database(format!("could not enable WAL mode: {e}")))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| AppError::Database(e.to_string()))?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| AppError::Database(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| AppError::Database(e.to_string()))?;

    conn.execute_batch(CREATE_SQL)
        .map_err(|e| AppError::Database(format!("could not create the local database: {e}")))?;

    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| AppError::Database(e.to_string()))?;

    // A brand-new file, as opposed to an existing one being re-opened. Only a
    // new file gets the built-in templates, so a moderator who deletes one does
    // not find it back on the next launch.
    let is_new_database = current == 0;

    if current < SCHEMA_VERSION {
        // Version 1 is the initial schema, fully described by CREATE_SQL, so
        // there is nothing to transform yet. Future versions add arms here.
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|e| AppError::Database(e.to_string()))?;
    }

    if is_new_database {
        seed_default_templates(conn)?;
    }
    Ok(())
}

const CREATE_SQL: &str = r#"
-- Generic keyed cache for API payloads. `kind` separates namespaces (game,
-- category, user, run, leaderboard, …) so one kind can be invalidated alone.
CREATE TABLE IF NOT EXISTS cache_entries (
    kind        TEXT NOT NULL,
    key         TEXT NOT NULL,
    payload     TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    expires_at  TEXT,
    PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_cache_expiry ON cache_entries(expires_at);

-- Video verification results, keyed by the normalised URL so every submission
-- form of the same video shares one row.
CREATE TABLE IF NOT EXISTS video_checks (
    normalized_url TEXT PRIMARY KEY,
    payload        TEXT NOT NULL,
    status         TEXT NOT NULL,
    checked_at     TEXT NOT NULL,
    expires_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_video_expiry ON video_checks(expires_at);

-- The moderator's own decisions. `outcome` is 'success' or 'failed'; a failed
-- attempt is recorded too, so a partial bulk action is auditable.
CREATE TABLE IF NOT EXISTS moderation_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL,
    action        TEXT NOT NULL,
    outcome       TEXT NOT NULL,
    reason        TEXT,
    error_message TEXT,
    game_id       TEXT,
    game_name     TEXT,
    category_id   TEXT,
    category_name TEXT,
    player_names  TEXT,
    run_time      REAL,
    run_weblink   TEXT,
    batch_id      TEXT,
    acted_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_time ON moderation_history(acted_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_run ON moderation_history(run_id);
CREATE INDEX IF NOT EXISTS idx_history_batch ON moderation_history(batch_id);

-- Destructive and bulk operations, summarised per batch.
CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      TEXT NOT NULL,
    operation     TEXT NOT NULL,
    total         INTEGER NOT NULL,
    succeeded     INTEGER NOT NULL,
    failed        INTEGER NOT NULL,
    detail        TEXT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(finished_at DESC);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Reusable rejection reasons. `sort_order` drives display; `builtin` marks the
-- seeded ones so they can be restored.
CREATE TABLE IF NOT EXISTS rejection_templates (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    body       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    builtin    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorite_games (
    game_id    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    abbrev     TEXT,
    cover_url  TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    added_at   TEXT NOT NULL
);

-- Persisted panel sizes / column visibility, one JSON blob per workspace view.
CREATE TABLE IF NOT EXISTS layouts (
    name       TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Keyboard bindings, overriding the defaults compiled into the frontend.
CREATE TABLE IF NOT EXISTS shortcuts (
    action     TEXT PRIMARY KEY,
    binding    TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"#;

/// Inserts the built-in rejection templates.
///
/// Called once when the database file is first created, and again only when the
/// moderator explicitly asks to restore the defaults. `INSERT OR IGNORE` on a
/// stable id means an edited template is never silently overwritten.
pub(crate) fn seed_default_templates(conn: &Connection) -> AppResult<()> {
    const DEFAULTS: &[(&str, &str, &str)] = &[
        (
            "builtin-video-missing",
            "No video",
            "This category requires video proof and no video was submitted. Please resubmit with a full, unedited recording of the run.",
        ),
        (
            "builtin-video-private",
            "Video not accessible",
            "The submitted video is not publicly viewable, so the run could not be verified. Please set the video to public or unlisted and resubmit.",
        ),
        (
            "builtin-video-deleted",
            "Video deleted",
            "The submitted video no longer exists. Please resubmit with a working link.",
        ),
        (
            "builtin-timing-mismatch",
            "Timing mismatch",
            "The submitted time does not match the time shown in the video. Please check the timing rules for this category and resubmit.",
        ),
        (
            "builtin-rule-break",
            "Rule violation",
            "This run does not follow the category rules. Please review the rules and resubmit if the run qualifies.",
        ),
        (
            "builtin-wrong-category",
            "Wrong category",
            "This run was submitted to the wrong category. Please resubmit it to the correct one.",
        ),
        (
            "builtin-duplicate",
            "Duplicate submission",
            "This run has already been submitted. Rejecting the duplicate entry.",
        ),
        (
            "builtin-cut-video",
            "Video incomplete",
            "The video does not show the full run without cuts. Please resubmit with a complete, uncut recording.",
        ),
    ];

    let now = crate::util::now_iso8601();
    let mut stmt = conn
        .prepare(
            "INSERT OR IGNORE INTO rejection_templates
             (id, label, body, sort_order, builtin, created_at)
             VALUES (?1, ?2, ?3, ?4, 1, ?5)",
        )
        .map_err(|e| AppError::Database(e.to_string()))?;

    for (index, (id, label, body)) in DEFAULTS.iter().enumerate() {
        stmt.execute(rusqlite::params![id, label, body, index as i64, now])
            .map_err(|e| AppError::Database(e.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database");
        initialize(&conn).expect("schema");
        conn
    }

    #[test]
    fn initialize_is_idempotent() {
        let conn = memory_db();
        initialize(&conn).expect("second run");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn builtin_templates_are_seeded_once() {
        let conn = memory_db();
        initialize(&conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM rejection_templates", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 8);
    }

    #[test]
    fn deleted_builtin_template_stays_deleted() {
        let conn = memory_db();
        conn.execute("DELETE FROM rejection_templates WHERE id = 'builtin-duplicate'", [])
            .unwrap();
        initialize(&conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rejection_templates WHERE id = 'builtin-duplicate'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn every_table_exists() {
        let conn = memory_db();
        for table in [
            "cache_entries",
            "video_checks",
            "moderation_history",
            "audit_log",
            "settings",
            "rejection_templates",
            "favorite_games",
            "layouts",
            "shortcuts",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "missing table {table}");
        }
    }
}
