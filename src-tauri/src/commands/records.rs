//! The local record: moderation history, audit log, statistics and export.
//!
//! Speedrun.com has no "what has this moderator done" endpoint, so everything
//! in this module is SRCTools' own log of the actions *it* performed. The UI
//! labels it accordingly — these numbers are never presented as site-wide
//! moderation statistics.

use std::fmt::Write as _;

use tauri::State;

use crate::commands::clamp_limit;
use crate::db::{AuditEntry, HistoryEntry, HistoryQuery, ModerationStats};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::now_iso8601;

/// Reads the local moderation log, newest first.
#[tauri::command]
pub async fn history_list(
    state: State<'_, AppState>,
    query: Option<HistoryQuery>,
) -> AppResult<Vec<HistoryEntry>> {
    state.db.history_list(&query.unwrap_or_default())
}

/// Total rows in the log, for pagination.
#[tauri::command]
pub async fn history_count(state: State<'_, AppState>) -> AppResult<i64> {
    state.db.history_count()
}

/// The most recent successful action on one run, if any.
///
/// Used to warn "you already rejected this" before a second action, which is
/// information rather than a block — a moderator may legitimately change their
/// mind after a resubmission.
#[tauri::command]
pub async fn history_for_run(
    state: State<'_, AppState>,
    run_id: String,
) -> AppResult<Option<HistoryEntry>> {
    let run_id = super::require_id(&run_id, "run id")?;
    state.db.history_for_run(&run_id)
}

/// Erases the local log and audit trail.
///
/// `confirm` must be `true`. This does not touch Speedrun.com — the runs stay
/// verified or rejected; only SRCTools' own record of them is removed.
#[tauri::command]
pub async fn history_clear(state: State<'_, AppState>, confirm: bool) -> AppResult<usize> {
    if !confirm {
        return Err(AppError::InvalidInput(
            "Clearing the history cannot be undone. Confirm to continue.".into(),
        ));
    }
    let removed = state.db.history_clear()?;
    // The rows are gone; reclaim the pages too, so "clear" means clear on disk.
    let _ = state.db.vacuum();
    Ok(removed)
}

/// Summary rows for bulk and destructive operations.
#[tauri::command]
pub async fn audit_list(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> AppResult<Vec<AuditEntry>> {
    let limit = clamp_limit(limit, 100, 1000);
    state.db.audit_list(limit as i64)
}

/// Aggregated activity over the last `days` days (`0` = all time).
#[tauri::command]
pub async fn moderation_stats(
    state: State<'_, AppState>,
    days: Option<i64>,
) -> AppResult<ModerationStats> {
    let days = days.unwrap_or(30).clamp(0, 3650);
    state.db.moderation_stats(days)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// A file the frontend hands to the save dialog.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    /// Suggested file name, e.g. `srctools-history-2026-08-10.csv`.
    pub filename: String,
    pub content: String,
    pub mime_type: String,
    pub row_count: usize,
}

/// Escapes one CSV field.
///
/// Also neutralises the spreadsheet formula-injection vector: a field starting
/// with `=`, `+`, `-` or `@` is prefixed with a quote, so a rejection reason
/// someone typed as `=HYPERLINK(...)` opens as text in Excel rather than
/// executing. The value itself is never altered in the JSON export.
fn csv_field(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .collect();
    let needs_guard = cleaned
        .chars()
        .next()
        .is_some_and(|c| matches!(c, '=' | '+' | '-' | '@'));
    let body = if needs_guard {
        format!("'{cleaned}")
    } else {
        cleaned
    };
    format!("\"{}\"", body.replace('"', "\"\""))
}

fn csv_row(fields: &[&str]) -> String {
    let mut line = String::new();
    for (i, field) in fields.iter().enumerate() {
        if i > 0 {
            line.push(',');
        }
        line.push_str(&csv_field(field));
    }
    line.push('\n');
    line
}

fn history_to_csv(rows: &[HistoryEntry]) -> String {
    let mut out = String::new();
    out.push_str(&csv_row(&[
        "acted_at",
        "run_id",
        "action",
        "outcome",
        "game",
        "category",
        "players",
        "time_seconds",
        "reason",
        "error",
        "batch_id",
        "run_url",
    ]));
    for row in rows {
        let seconds = row
            .run_time
            .map(|t| format!("{t:.3}"))
            .unwrap_or_default();
        out.push_str(&csv_row(&[
            &row.acted_at,
            &row.run_id,
            row.action.as_str(),
            row.outcome.as_str(),
            row.game_name.as_deref().unwrap_or(""),
            row.category_name.as_deref().unwrap_or(""),
            row.player_names.as_deref().unwrap_or(""),
            &seconds,
            row.reason.as_deref().unwrap_or(""),
            row.error_message.as_deref().unwrap_or(""),
            row.batch_id.as_deref().unwrap_or(""),
            row.run_weblink.as_deref().unwrap_or(""),
        ]));
    }
    out
}

fn stamp() -> String {
    // `2026-08-10T09:31:04.221Z` → `2026-08-10`, which is enough to distinguish
    // exports without putting a colon in a Windows filename.
    now_iso8601().chars().take(10).collect()
}

/// Exports the moderation log as CSV or JSON.
///
/// Returns the bytes rather than writing them: the frontend owns the save
/// dialog, so the backend never picks a path on the user's disk by itself.
#[tauri::command]
pub async fn export_history(
    state: State<'_, AppState>,
    format: String,
    query: Option<HistoryQuery>,
) -> AppResult<ExportPayload> {
    // An export should cover the whole log, not one screen of it.
    let mut query = query.unwrap_or_default();
    query.limit = Some(query.limit.unwrap_or(1000).clamp(1, 1000));

    let mut rows: Vec<HistoryEntry> = Vec::new();
    let mut offset = query.offset.unwrap_or(0);
    loop {
        query.offset = Some(offset);
        let page = state.db.history_list(&query)?;
        let fetched = page.len();
        rows.extend(page);
        if fetched < query.limit.unwrap_or(1000) as usize || rows.len() >= 100_000 {
            break;
        }
        offset += fetched as i64;
    }

    let date = stamp();
    match format.trim().to_ascii_lowercase().as_str() {
        "csv" => Ok(ExportPayload {
            filename: format!("srctools-history-{date}.csv"),
            content: history_to_csv(&rows),
            mime_type: "text/csv".into(),
            row_count: rows.len(),
        }),
        "json" => {
            let body = serde_json::json!({
                "exportedAt": now_iso8601(),
                "application": "SRCTools",
                "kind": "moderation-history",
                "note": "Actions performed through SRCTools on this machine.",
                "count": rows.len(),
                "entries": rows,
            });
            Ok(ExportPayload {
                filename: format!("srctools-history-{date}.json"),
                content: serde_json::to_string_pretty(&body)
                    .map_err(|e| AppError::Internal(e.to_string()))?,
                mime_type: "application/json".into(),
                row_count: rows.len(),
            })
        }
        other => Err(AppError::InvalidInput(format!(
            "Unknown export format \"{other}\". Use csv or json."
        ))),
    }
}

/// Exports an arbitrary set of queue rows, for "export selection".
///
/// The frontend passes the runs it is showing, so the export matches the table
/// exactly — including any client-side filtering the backend never saw.
#[tauri::command]
pub async fn export_runs(
    format: String,
    runs: Vec<crate::dto::RunSummary>,
) -> AppResult<ExportPayload> {
    let date = stamp();
    match format.trim().to_ascii_lowercase().as_str() {
        "csv" => {
            let mut out = String::new();
            out.push_str(&csv_row(&[
                "run_id",
                "game",
                "category",
                "level",
                "players",
                "time",
                "time_seconds",
                "status",
                "date_played",
                "submitted",
                "platform",
                "region",
                "emulated",
                "videos",
                "comment",
                "url",
            ]));
            for run in &runs {
                let seconds = run
                    .primary_seconds
                    .map(|t| format!("{t:.3}"))
                    .unwrap_or_default();
                let emulated = match run.emulated {
                    Some(true) => "yes",
                    Some(false) => "no",
                    None => "",
                };
                let videos = run.video_urls.join(" | ");
                out.push_str(&csv_row(&[
                    &run.id,
                    run.game_name.as_deref().unwrap_or(""),
                    run.category_name.as_deref().unwrap_or(""),
                    run.level_name.as_deref().unwrap_or(""),
                    &run.player_label,
                    run.primary_display.as_deref().unwrap_or(""),
                    &seconds,
                    &run.status,
                    run.date.as_deref().unwrap_or(""),
                    run.submitted.as_deref().unwrap_or(""),
                    run.platform_name.as_deref().unwrap_or(""),
                    run.region_name.as_deref().unwrap_or(""),
                    emulated,
                    &videos,
                    run.comment.as_deref().unwrap_or(""),
                    run.weblink.as_deref().unwrap_or(""),
                ]));
            }
            Ok(ExportPayload {
                filename: format!("srctools-runs-{date}.csv"),
                content: out,
                mime_type: "text/csv".into(),
                row_count: runs.len(),
            })
        }
        "json" => {
            let body = serde_json::json!({
                "exportedAt": now_iso8601(),
                "application": "SRCTools",
                "kind": "runs",
                "count": runs.len(),
                "runs": runs,
            });
            Ok(ExportPayload {
                filename: format!("srctools-runs-{date}.json"),
                content: serde_json::to_string_pretty(&body)
                    .map_err(|e| AppError::Internal(e.to_string()))?,
                mime_type: "application/json".into(),
                row_count: runs.len(),
            })
        }
        other => Err(AppError::InvalidInput(format!(
            "Unknown export format \"{other}\". Use csv or json."
        ))),
    }
}

/// Exports the statistics page as a readable text report.
#[tauri::command]
pub async fn export_stats(state: State<'_, AppState>, days: Option<i64>) -> AppResult<ExportPayload> {
    let days = days.unwrap_or(30).clamp(0, 3650);
    let stats = state.db.moderation_stats(days)?;

    let window = if days == 0 {
        "all time".to_string()
    } else {
        format!("the last {days} days")
    };

    let mut out = String::new();
    let _ = writeln!(out, "SRCTools — moderation activity ({window})");
    let _ = writeln!(out, "Generated {}", now_iso8601());
    let _ = writeln!(
        out,
        "\nThese are actions performed through SRCTools on this machine."
    );
    let _ = writeln!(out, "\nTotal actions   {}", stats.total_actions);
    let _ = writeln!(out, "Verified        {}", stats.verified);
    let _ = writeln!(out, "Rejected        {}", stats.rejected);
    let _ = writeln!(out, "Deleted         {}", stats.deleted);
    let _ = writeln!(out, "Failed attempts {}", stats.failed);
    let _ = writeln!(out, "Distinct runs   {}", stats.distinct_runs);

    if !stats.per_game.is_empty() {
        let _ = writeln!(out, "\nBy game");
        for game in &stats.per_game {
            let _ = writeln!(out, "  {:>5}  {}", game.count, game.game_name);
        }
    }
    if !stats.top_reasons.is_empty() {
        let _ = writeln!(out, "\nMost used rejection reasons");
        for reason in &stats.top_reasons {
            let _ = writeln!(out, "  {:>5}  {}", reason.count, reason.reason);
        }
    }
    if !stats.per_day.is_empty() {
        let _ = writeln!(out, "\nPer day (verified / rejected / deleted / failed)");
        for day in &stats.per_day {
            let _ = writeln!(
                out,
                "  {}  {:>4} {:>4} {:>4} {:>4}",
                day.day, day.verified, day.rejected, day.deleted, day.failed
            );
        }
    }

    Ok(ExportPayload {
        filename: format!("srctools-stats-{}.txt", stamp()),
        content: out,
        mime_type: "text/plain".into(),
        row_count: stats.total_actions as usize,
    })
}

/// Writes an already-generated export to a path the user chose.
///
/// The frontend obtains `path` from the native save dialog, so SRCTools never
/// picks a destination itself. This exists instead of the filesystem plugin so
/// the app carries one narrow write capability rather than a general one, and
/// `content` is always the output of an `export_*` command above — never
/// arbitrary data assembled in the webview.
#[tauri::command]
pub async fn write_export(path: String, content: String) -> AppResult<usize> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("No destination was chosen.".into()));
    }

    let target = std::path::Path::new(trimmed);
    if !target.is_absolute() {
        return Err(AppError::InvalidInput(
            "The destination must be a full path.".into(),
        ));
    }
    // A directory that does not exist means the dialog was bypassed; creating
    // one silently is not this command's job.
    match target.parent() {
        Some(parent) if parent.as_os_str().is_empty() || parent.is_dir() => {}
        _ => {
            return Err(AppError::InvalidInput(
                "That folder does not exist. Choose another location.".into(),
            ))
        }
    }

    let bytes = content.len();
    std::fs::write(target, content.as_bytes()).map_err(|e| {
        let name = target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("the file");
        AppError::Io(format!("Could not write {name}: {e}"))
    })?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{ActionOutcome, ModerationAction};

    fn entry(reason: Option<&str>) -> HistoryEntry {
        HistoryEntry {
            id: 1,
            run_id: "y2ge7ldq".into(),
            action: ModerationAction::Reject,
            outcome: ActionOutcome::Success,
            reason: reason.map(str::to_string),
            error_message: None,
            game_id: Some("o1y9wo6q".into()),
            game_name: Some("Super Mario 64".into()),
            category_id: None,
            category_name: Some("120 Star".into()),
            player_names: Some("Runner".into()),
            run_time: Some(5025.5),
            run_weblink: Some("https://www.speedrun.com/run/y2ge7ldq".into()),
            batch_id: None,
            acted_at: "2026-08-10T10:00:00.000Z".into(),
        }
    }

    #[test]
    fn csv_quotes_and_escapes_every_field() {
        assert_eq!(csv_field("plain"), "\"plain\"");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn newlines_never_break_a_row() {
        let field = csv_field("line one\nline two\r\nthree");
        assert!(!field.contains('\n'));
        assert!(!field.contains('\r'));
    }

    #[test]
    fn a_formula_is_exported_as_text() {
        // Excel would otherwise evaluate this on open.
        assert!(csv_field("=HYPERLINK(\"http://x\")").starts_with("\"'="));
        assert!(csv_field("+1").starts_with("\"'+"));
        assert!(csv_field("@SUM(A1)").starts_with("\"'@"));
        assert!(csv_field("-5").starts_with("\"'-"));
    }

    #[test]
    fn the_history_csv_has_a_header_and_one_row_per_entry() {
        let csv = history_to_csv(&[entry(Some("No video")), entry(None)]);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("\"acted_at\""));
        assert!(lines[1].contains("\"No video\""));
        assert!(lines[2].contains("\"\""), "a missing reason is empty");
    }

    #[test]
    fn a_missing_value_becomes_an_empty_field_not_the_word_none() {
        let csv = history_to_csv(&[entry(None)]);
        assert!(!csv.contains("None"));
        assert!(!csv.contains("null"));
    }

    #[test]
    fn the_export_stamp_is_filename_safe() {
        let s = stamp();
        assert_eq!(s.len(), 10);
        assert!(!s.contains(':'));
    }
}
