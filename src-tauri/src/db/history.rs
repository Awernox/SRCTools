//! Moderation history, audit log and derived statistics.
//!
//! Speedrun.com does not expose "what has this moderator done" as an endpoint,
//! so this table is the only record of it. Two consequences shape the code:
//!
//! - **Failures are recorded too.** A bulk action that half-succeeds must leave
//!   evidence of both halves, otherwise the counts shown to the user are a lie.
//! - **Nothing here is derived from the cache.** Game and player names are
//!   copied in at write time, so history stays readable after a cache clear.

use rusqlite::{params, params_from_iter, OptionalExtension, Row};

use super::{
    sql_err, ActionOutcome, AuditDraft, AuditEntry, DailyCount, Db, GameCount, HistoryDraft,
    HistoryEntry, HistoryQuery, ModerationAction, ModerationStats, ReasonCount,
};
use crate::error::{AppError, AppResult};
use crate::util::{now_iso8601, sanitize_line, sanitize_text};

/// Hard ceiling on a single history page, so a malformed request cannot pull
/// the whole table into memory.
const MAX_PAGE: i64 = 1000;

fn row_to_entry(row: &Row<'_>) -> rusqlite::Result<HistoryEntry> {
    let action: String = row.get("action")?;
    let outcome: String = row.get("outcome")?;
    Ok(HistoryEntry {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        action: ModerationAction::parse(&action).unwrap_or(ModerationAction::Verify),
        outcome: if outcome == "failed" {
            ActionOutcome::Failed
        } else {
            ActionOutcome::Success
        },
        reason: row.get("reason")?,
        error_message: row.get("error_message")?,
        game_id: row.get("game_id")?,
        game_name: row.get("game_name")?,
        category_id: row.get("category_id")?,
        category_name: row.get("category_name")?,
        player_names: row.get("player_names")?,
        run_time: row.get("run_time")?,
        run_weblink: row.get("run_weblink")?,
        batch_id: row.get("batch_id")?,
        acted_at: row.get("acted_at")?,
    })
}

impl Db {
    /// Appends one action to the log and returns its row id.
    pub fn history_record(&self, draft: &HistoryDraft) -> AppResult<i64> {
        let run_id = draft.run_id.trim();
        if run_id.is_empty() {
            return Err(AppError::InvalidInput(
                "cannot record a moderation action without a run id".into(),
            ));
        }
        let action = draft.action.unwrap_or(ModerationAction::Verify);
        let outcome = draft.outcome.unwrap_or(ActionOutcome::Success);
        let now = now_iso8601();

        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO moderation_history
                 (run_id, action, outcome, reason, error_message, game_id, game_name,
                  category_id, category_name, player_names, run_time, run_weblink,
                  batch_id, acted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    run_id,
                    action.as_str(),
                    outcome.as_str(),
                    draft.reason.as_deref().map(|s| sanitize_text(s, 2000)),
                    draft.error_message.as_deref().map(|s| sanitize_text(s, 1000)),
                    draft.game_id,
                    draft.game_name.as_deref().map(|s| sanitize_line(s, 200)),
                    draft.category_id,
                    draft.category_name.as_deref().map(|s| sanitize_line(s, 200)),
                    draft.player_names.as_deref().map(|s| sanitize_line(s, 400)),
                    draft.run_time,
                    draft.run_weblink,
                    draft.batch_id,
                    now,
                ],
            )
            .map_err(sql_err)?;
            Ok(conn.last_insert_rowid())
        })
    }

    /// Reads the log, newest first.
    pub fn history_list(&self, query: &HistoryQuery) -> AppResult<Vec<HistoryEntry>> {
        let mut sql = String::from("SELECT * FROM moderation_history WHERE 1 = 1");
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(action) = query.action {
            args.push(Box::new(action.as_str().to_string()));
            sql.push_str(&format!(" AND action = ?{}", args.len()));
        }
        if let Some(outcome) = query.outcome {
            args.push(Box::new(outcome.as_str().to_string()));
            sql.push_str(&format!(" AND outcome = ?{}", args.len()));
        }
        if let Some(game) = query.game_id.as_deref().filter(|s| !s.trim().is_empty()) {
            args.push(Box::new(game.to_string()));
            sql.push_str(&format!(" AND game_id = ?{}", args.len()));
        }
        if let Some(run) = query.run_id.as_deref().filter(|s| !s.trim().is_empty()) {
            args.push(Box::new(run.to_string()));
            sql.push_str(&format!(" AND run_id = ?{}", args.len()));
        }
        if let Some(since) = query.since.as_deref().filter(|s| !s.trim().is_empty()) {
            args.push(Box::new(since.to_string()));
            sql.push_str(&format!(" AND acted_at >= ?{}", args.len()));
        }
        if let Some(until) = query.until.as_deref().filter(|s| !s.trim().is_empty()) {
            args.push(Box::new(until.to_string()));
            sql.push_str(&format!(" AND acted_at <= ?{}", args.len()));
        }
        if let Some(text) = query.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            // Bound as a parameter, so a search string can never alter the SQL.
            let needle = format!("%{}%", text.replace('%', "\\%").replace('_', "\\_"));
            args.push(Box::new(needle));
            let i = args.len();
            sql.push_str(&format!(
                " AND (COALESCE(game_name,'') LIKE ?{i} ESCAPE '\\'
                    OR COALESCE(category_name,'') LIKE ?{i} ESCAPE '\\'
                    OR COALESCE(player_names,'') LIKE ?{i} ESCAPE '\\'
                    OR COALESCE(reason,'') LIKE ?{i} ESCAPE '\\'
                    OR run_id LIKE ?{i} ESCAPE '\\')"
            ));
        }

        let limit = query.limit.unwrap_or(200).clamp(1, MAX_PAGE);
        let offset = query.offset.unwrap_or(0).max(0);
        args.push(Box::new(limit));
        let limit_i = args.len();
        args.push(Box::new(offset));
        let offset_i = args.len();
        sql.push_str(&format!(" ORDER BY acted_at DESC, id DESC LIMIT ?{limit_i} OFFSET ?{offset_i}"));

        self.with_conn(|conn| {
            let mut stmt = conn.prepare(&sql).map_err(sql_err)?;
            let rows = stmt
                .query_map(params_from_iter(args.iter().map(|b| b.as_ref())), row_to_entry)
                .map_err(sql_err)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(sql_err)?);
            }
            Ok(out)
        })
    }

    /// Most recent action for one run, used to warn "you already rejected this".
    pub fn history_for_run(&self, run_id: &str) -> AppResult<Option<HistoryEntry>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT * FROM moderation_history
                 WHERE run_id = ?1 AND outcome = 'success'
                 ORDER BY acted_at DESC, id DESC LIMIT 1",
                params![run_id],
                row_to_entry,
            )
            .optional()
            .map_err(sql_err)
        })
    }

    /// Total rows, for pagination.
    pub fn history_count(&self) -> AppResult<i64> {
        self.with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM moderation_history", [], |r| r.get(0))
                .map_err(sql_err)
        })
    }

    /// Wipes the local log. Only ever called from an explicit, confirmed action.
    pub fn history_clear(&self) -> AppResult<usize> {
        self.with_tx(|tx| {
            let n = tx
                .execute("DELETE FROM moderation_history", [])
                .map_err(sql_err)?;
            tx.execute("DELETE FROM audit_log", []).map_err(sql_err)?;
            Ok(n)
        })
    }

    /// Records the summary of a bulk or destructive operation.
    pub fn audit_record(&self, draft: &AuditDraft<'_>) -> AppResult<i64> {
        let now = now_iso8601();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO audit_log
                 (batch_id, operation, total, succeeded, failed, detail, started_at, finished_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    draft.batch_id,
                    draft.operation,
                    draft.total,
                    draft.succeeded,
                    draft.failed,
                    draft.detail.map(|d| sanitize_text(d, 4000)),
                    draft.started_at,
                    now
                ],
            )
            .map_err(sql_err)?;
            Ok(conn.last_insert_rowid())
        })
    }

    pub fn audit_list(&self, limit: i64) -> AppResult<Vec<AuditEntry>> {
        let limit = limit.clamp(1, MAX_PAGE);
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, batch_id, operation, total, succeeded, failed, detail,
                            started_at, finished_at
                     FROM audit_log ORDER BY finished_at DESC, id DESC LIMIT ?1",
                )
                .map_err(sql_err)?;
            let rows = stmt
                .query_map(params![limit], |row| {
                    Ok(AuditEntry {
                        id: row.get(0)?,
                        batch_id: row.get(1)?,
                        operation: row.get(2)?,
                        total: row.get(3)?,
                        succeeded: row.get(4)?,
                        failed: row.get(5)?,
                        detail: row.get(6)?,
                        started_at: row.get(7)?,
                        finished_at: row.get(8)?,
                    })
                })
                .map_err(sql_err)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(sql_err)?);
            }
            Ok(out)
        })
    }

    /// Aggregates the log over the last `days` days (0 = all time).
    pub fn moderation_stats(&self, days: i64) -> AppResult<ModerationStats> {
        // An empty lower bound matches every row, since all timestamps sort above it.
        let since = if days > 0 {
            (chrono::Utc::now() - chrono::Duration::days(days))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        } else {
            String::new()
        };

        self.with_conn(|conn| {
            let mut stats = conn
                .query_row(
                    "SELECT
                        COUNT(*),
                        SUM(CASE WHEN action='verify' AND outcome='success' THEN 1 ELSE 0 END),
                        SUM(CASE WHEN action='reject' AND outcome='success' THEN 1 ELSE 0 END),
                        SUM(CASE WHEN action='delete' AND outcome='success' THEN 1 ELSE 0 END),
                        SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END),
                        COUNT(DISTINCT run_id),
                        MIN(acted_at),
                        MAX(acted_at)
                     FROM moderation_history WHERE acted_at >= ?1",
                    params![since],
                    |row| {
                        Ok(ModerationStats {
                            total_actions: row.get(0)?,
                            verified: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                            rejected: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                            deleted: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                            failed: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                            distinct_runs: row.get(5)?,
                            first_action_at: row.get(6)?,
                            last_action_at: row.get(7)?,
                            per_day: Vec::new(),
                            per_game: Vec::new(),
                            top_reasons: Vec::new(),
                        })
                    },
                )
                .map_err(sql_err)?;

            let mut stmt = conn
                .prepare(
                    "SELECT substr(acted_at, 1, 10) AS day,
                            SUM(CASE WHEN action='verify' AND outcome='success' THEN 1 ELSE 0 END),
                            SUM(CASE WHEN action='reject' AND outcome='success' THEN 1 ELSE 0 END),
                            SUM(CASE WHEN action='delete' AND outcome='success' THEN 1 ELSE 0 END),
                            SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END)
                     FROM moderation_history WHERE acted_at >= ?1
                     GROUP BY day ORDER BY day ASC",
                )
                .map_err(sql_err)?;
            stats.per_day = stmt
                .query_map(params![since], |row| {
                    Ok(DailyCount {
                        day: row.get(0)?,
                        verified: row.get(1)?,
                        rejected: row.get(2)?,
                        deleted: row.get(3)?,
                        failed: row.get(4)?,
                    })
                })
                .map_err(sql_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_err)?;

            let mut stmt = conn
                .prepare(
                    "SELECT game_id, COALESCE(NULLIF(game_name, ''), 'Unknown game') AS name,
                            COUNT(*) AS n
                     FROM moderation_history WHERE acted_at >= ?1 AND outcome = 'success'
                     GROUP BY game_id, name ORDER BY n DESC LIMIT 25",
                )
                .map_err(sql_err)?;
            stats.per_game = stmt
                .query_map(params![since], |row| {
                    Ok(GameCount {
                        game_id: row.get(0)?,
                        game_name: row.get(1)?,
                        count: row.get(2)?,
                    })
                })
                .map_err(sql_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_err)?;

            let mut stmt = conn
                .prepare(
                    "SELECT reason, COUNT(*) AS n FROM moderation_history
                     WHERE acted_at >= ?1 AND action = 'reject' AND outcome = 'success'
                       AND reason IS NOT NULL AND TRIM(reason) <> ''
                     GROUP BY reason ORDER BY n DESC LIMIT 10",
                )
                .map_err(sql_err)?;
            stats.top_reasons = stmt
                .query_map(params![since], |row| {
                    Ok(ReasonCount {
                        reason: row.get(0)?,
                        count: row.get(1)?,
                    })
                })
                .map_err(sql_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_err)?;

            Ok(stats)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(run: &str, action: ModerationAction, outcome: ActionOutcome) -> HistoryDraft {
        HistoryDraft {
            run_id: run.to_string(),
            action: Some(action),
            outcome: Some(outcome),
            game_name: Some("Super Mario 64".into()),
            game_id: Some("o1y9wo6q".into()),
            category_name: Some("120 Star".into()),
            player_names: Some("Runner".into()),
            reason: if action == ModerationAction::Reject {
                Some("No video".into())
            } else {
                None
            },
            ..Default::default()
        }
    }

    #[test]
    fn actions_are_recorded_and_read_back_newest_first() {
        let db = Db::open_in_memory().unwrap();
        db.history_record(&draft("r1", ModerationAction::Verify, ActionOutcome::Success))
            .unwrap();
        db.history_record(&draft("r2", ModerationAction::Reject, ActionOutcome::Success))
            .unwrap();

        let rows = db.history_list(&HistoryQuery::default()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].run_id, "r2", "newest first");
        assert_eq!(rows[0].reason.as_deref(), Some("No video"));
    }

    #[test]
    fn a_run_id_is_required() {
        let db = Db::open_in_memory().unwrap();
        let mut d = draft("", ModerationAction::Verify, ActionOutcome::Success);
        d.run_id = "   ".into();
        assert!(db.history_record(&d).is_err());
    }

    #[test]
    fn failures_are_recorded_and_filterable() {
        let db = Db::open_in_memory().unwrap();
        db.history_record(&draft("ok", ModerationAction::Verify, ActionOutcome::Success))
            .unwrap();
        let mut bad = draft("bad", ModerationAction::Verify, ActionOutcome::Failed);
        bad.error_message = Some("rate limited".into());
        db.history_record(&bad).unwrap();

        let failed = db
            .history_list(&HistoryQuery {
                outcome: Some(ActionOutcome::Failed),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].run_id, "bad");
        assert_eq!(failed[0].error_message.as_deref(), Some("rate limited"));
    }

    #[test]
    fn search_matches_names_and_cannot_inject_sql() {
        let db = Db::open_in_memory().unwrap();
        db.history_record(&draft("r1", ModerationAction::Verify, ActionOutcome::Success))
            .unwrap();

        let hits = db
            .history_list(&HistoryQuery {
                search: Some("mario".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);

        let injected = db
            .history_list(&HistoryQuery {
                search: Some("'; DROP TABLE moderation_history; --".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(injected.is_empty());
        assert_eq!(db.history_count().unwrap(), 1, "table must still exist");
    }

    #[test]
    fn only_successful_actions_count_as_the_last_decision() {
        let db = Db::open_in_memory().unwrap();
        db.history_record(&draft("r1", ModerationAction::Verify, ActionOutcome::Failed))
            .unwrap();
        assert!(db.history_for_run("r1").unwrap().is_none());

        db.history_record(&draft("r1", ModerationAction::Reject, ActionOutcome::Success))
            .unwrap();
        let last = db.history_for_run("r1").unwrap().expect("a decision");
        assert_eq!(last.action, ModerationAction::Reject);
    }

    #[test]
    fn statistics_separate_successes_from_failures() {
        let db = Db::open_in_memory().unwrap();
        db.history_record(&draft("a", ModerationAction::Verify, ActionOutcome::Success))
            .unwrap();
        db.history_record(&draft("b", ModerationAction::Verify, ActionOutcome::Success))
            .unwrap();
        db.history_record(&draft("c", ModerationAction::Reject, ActionOutcome::Success))
            .unwrap();
        db.history_record(&draft("d", ModerationAction::Verify, ActionOutcome::Failed))
            .unwrap();

        let stats = db.moderation_stats(0).unwrap();
        assert_eq!(stats.total_actions, 4);
        assert_eq!(stats.verified, 2);
        assert_eq!(stats.rejected, 1);
        assert_eq!(stats.failed, 1);
        assert_eq!(stats.distinct_runs, 4);
        assert_eq!(stats.per_day.len(), 1);
        assert_eq!(stats.per_game.first().map(|g| g.count), Some(3));
        assert_eq!(stats.top_reasons.first().map(|r| r.count), Some(1));
    }

    #[test]
    fn empty_statistics_are_all_zero() {
        let db = Db::open_in_memory().unwrap();
        let stats = db.moderation_stats(30).unwrap();
        assert_eq!(stats.total_actions, 0);
        assert_eq!(stats.verified, 0);
        assert!(stats.first_action_at.is_none());
    }

    #[test]
    fn bulk_operations_are_audited_with_both_counts() {
        let db = Db::open_in_memory().unwrap();
        db.audit_record(&AuditDraft {
            batch_id: "batch-1",
            operation: "bulk_reject",
            total: 10,
            succeeded: 7,
            failed: 3,
            detail: Some("3 runs failed: rate limited"),
            started_at: "2026-08-10T10:00:00Z",
        })
        .unwrap();
        let rows = db.audit_list(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].succeeded, 7);
        assert_eq!(rows[0].failed, 3);
    }

    #[test]
    fn paging_is_bounded() {
        let db = Db::open_in_memory().unwrap();
        for i in 0..5 {
            db.history_record(&draft(
                &format!("r{i}"),
                ModerationAction::Verify,
                ActionOutcome::Success,
            ))
            .unwrap();
        }
        let page = db
            .history_list(&HistoryQuery {
                limit: Some(2),
                offset: Some(1),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.len(), 2);

        // An absurd limit is clamped rather than honoured.
        let all = db
            .history_list(&HistoryQuery {
                limit: Some(i64::MAX),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(all.len(), 5);
    }
}
