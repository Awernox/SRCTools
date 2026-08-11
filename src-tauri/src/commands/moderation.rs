//! Verify, reject and delete — the only commands that change Speedrun.com.
//!
//! Three rules are enforced here rather than trusted to the UI:
//!
//! 1. **Every action is an explicit moderator request.** Nothing in this module
//!    reads [`crate::analysis`]. A heuristic can never reach a decision, because
//!    no code path exists from a finding to an API call.
//! 2. **Deleting requires confirmation.** `DELETE /runs/{id}` is irreversible on
//!    Speedrun.com's side, so `confirm` must be `true` before the call is made.
//! 3. **Both halves of a bulk run are recorded.** Successes *and* failures are
//!    written to [`crate::db`] history, and the audit row carries both counts —
//!    a partly-failed batch that reported only its successes would be a lie.

use std::collections::HashSet;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::{batch_id, require_id};
use crate::db::{ActionOutcome, AuditDraft, HistoryDraft, ModerationAction};
use crate::dto::{BulkItemResult, BulkProgress, BulkResult};
use crate::error::{AppError, AppResult};
use crate::src_api::endpoints;
use crate::state::AppState;
use crate::util::now_iso8601;

/// Hard ceiling on one bulk operation. Anything larger is refused rather than
/// truncated, because a silently shortened batch would misreport its counts.
const MAX_BULK: usize = 500;

/// Event carrying per-run progress during a bulk operation.
pub const BULK_PROGRESS_EVENT: &str = "srctools://bulk-progress";

/// Batches the user has asked to stop.
///
/// A bulk action over hundreds of runs must be interruptible; the loop checks
/// this between runs, so a cancel takes effect without abandoning an in-flight
/// request half-way.
static CANCELLED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Descriptive fields copied into the local log alongside an action.
///
/// The queue already holds these, so passing them avoids re-fetching every run
/// just to make history readable. They are cosmetic: nothing here is sent to
/// Speedrun.com or used to decide anything.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunContext {
    pub game_id: Option<String>,
    pub game_name: Option<String>,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub player_names: Option<String>,
    pub run_time: Option<f64>,
    pub run_weblink: Option<String>,
}

/// One run to act on.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionTarget {
    pub run_id: String,
    #[serde(default)]
    pub context: Option<RunContext>,
}

/// Checks an action's preconditions before any request is issued.
///
/// Returns the reason to send, so a rejection without one fails here rather
/// than after the API has already been called for earlier runs in a batch.
fn validate(
    action: ModerationAction,
    reason: Option<&str>,
    confirm: bool,
) -> AppResult<Option<String>> {
    if action.is_destructive() && !confirm {
        return Err(AppError::InvalidInput(
            "Deleting a run cannot be undone. Confirm the deletion to continue.".into(),
        ));
    }
    if action != ModerationAction::Reject {
        return Ok(None);
    }
    let reason = reason.map(str::trim).filter(|r| !r.is_empty());
    match reason {
        Some(r) => Ok(Some(r.to_string())),
        None => Err(AppError::InvalidInput(
            "Speedrun.com requires a reason when rejecting a run. Pick a template or type one."
                .into(),
        )),
    }
}

/// Issues the single API call behind one action.
async fn apply(
    state: &AppState,
    action: ModerationAction,
    run_id: &str,
    reason: Option<&str>,
) -> AppResult<()> {
    let client = state.client();
    let api_key = state.api_key()?;
    match action {
        ModerationAction::Verify => {
            endpoints::verify_run(&client, &api_key, run_id).await?;
        }
        ModerationAction::Reject => {
            // `validate` guarantees a reason by here; the endpoint re-checks.
            endpoints::reject_run(&client, &api_key, run_id, reason.unwrap_or_default()).await?;
        }
        ModerationAction::Delete => {
            endpoints::delete_run(&client, &api_key, run_id).await?;
        }
    }
    Ok(())
}

/// Writes one attempt to the local log. Never fails the caller: losing a log
/// row must not turn a completed action into a reported failure.
fn record(
    state: &AppState,
    action: ModerationAction,
    target: &ActionTarget,
    reason: Option<&str>,
    batch: Option<&str>,
    error: Option<&str>,
) {
    let ctx = target.context.clone().unwrap_or_default();
    let draft = HistoryDraft {
        run_id: target.run_id.clone(),
        action: Some(action),
        outcome: Some(if error.is_some() {
            ActionOutcome::Failed
        } else {
            ActionOutcome::Success
        }),
        reason: reason.map(str::to_string),
        error_message: error.map(str::to_string),
        game_id: ctx.game_id,
        game_name: ctx.game_name,
        category_id: ctx.category_id,
        category_name: ctx.category_name,
        player_names: ctx.player_names,
        run_time: ctx.run_time,
        run_weblink: ctx.run_weblink,
        batch_id: batch.map(str::to_string),
    };
    if let Err(e) = state.db.history_record(&draft) {
        tracing::error!("could not record a moderation action locally: {e}");
    }
}

// ---------------------------------------------------------------------------
// Single-run commands
// ---------------------------------------------------------------------------

/// Runs one moderation action.
///
/// `action` is `"verify"`, `"reject"` or `"delete"`. Rejecting requires a
/// reason; deleting requires `confirm = true`. The attempt is logged whether it
/// succeeds or fails, and a failure is returned as an error so the UI can offer
/// a retry for the transient kinds.
#[tauri::command]
pub async fn moderate_run(
    state: State<'_, AppState>,
    action: String,
    target: ActionTarget,
    reason: Option<String>,
    confirm: Option<bool>,
) -> AppResult<String> {
    let action = ModerationAction::parse(&action).ok_or_else(|| {
        AppError::InvalidInput(format!("Unknown moderation action \"{action}\"."))
    })?;
    let run_id = require_id(&target.run_id, "run id")?;
    let reason = validate(action, reason.as_deref(), confirm.unwrap_or(false))?;

    let mut target = target;
    target.run_id = run_id.clone();

    // Serialised so two views cannot act on the same run simultaneously.
    let _guard = state.write_lock.lock().await;

    match apply(&state, action, &run_id, reason.as_deref()).await {
        Ok(()) => {
            record(&state, action, &target, reason.as_deref(), None, None);
            if action.is_destructive() {
                // A deletion is irreversible, so it gets its own audit row even
                // when it was not part of a batch.
                let now = now_iso8601();
                let _ = state.db.audit_record(&AuditDraft {
                    batch_id: &batch_id("delete"),
                    operation: "delete_run",
                    total: 1,
                    succeeded: 1,
                    failed: 0,
                    detail: Some(&format!("Deleted run {run_id}")),
                    started_at: &now,
                });
            }
            Ok(run_id)
        }
        Err(e) => {
            record(
                &state,
                action,
                &target,
                reason.as_deref(),
                None,
                Some(&e.to_string()),
            );
            Err(e)
        }
    }
}

/// Convenience wrapper for the verify shortcut.
#[tauri::command]
pub async fn verify_run(state: State<'_, AppState>, target: ActionTarget) -> AppResult<String> {
    moderate_run(state, "verify".into(), target, None, Some(false)).await
}

/// Convenience wrapper for the reject shortcut. The reason is mandatory.
#[tauri::command]
pub async fn reject_run(
    state: State<'_, AppState>,
    target: ActionTarget,
    reason: String,
) -> AppResult<String> {
    moderate_run(state, "reject".into(), target, Some(reason), Some(false)).await
}

/// Deletes a run. `confirm` must be `true`; there is no default.
#[tauri::command]
pub async fn delete_run(
    state: State<'_, AppState>,
    target: ActionTarget,
    confirm: bool,
) -> AppResult<String> {
    moderate_run(state, "delete".into(), target, None, Some(confirm)).await
}

// ---------------------------------------------------------------------------
// Bulk commands
// ---------------------------------------------------------------------------

/// Applies one action to many runs, emitting progress as it goes.
///
/// The batch continues past a failing run: stopping at the first error would
/// leave the moderator unsure which runs were touched. Every outcome is in the
/// returned [`BulkResult`] and in the local log, and the audit row carries the
/// success and failure counts together.
///
/// Cancellation is cooperative — [`cancel_bulk`] marks the batch, and the loop
/// stops before starting the next run. Runs already processed stay processed.
#[tauri::command]
pub async fn bulk_moderate(
    app: AppHandle,
    state: State<'_, AppState>,
    action: String,
    targets: Vec<ActionTarget>,
    reason: Option<String>,
    confirm: Option<bool>,
) -> AppResult<BulkResult> {
    let action = ModerationAction::parse(&action).ok_or_else(|| {
        AppError::InvalidInput(format!("Unknown moderation action \"{action}\"."))
    })?;
    if targets.is_empty() {
        return Err(AppError::InvalidInput("No runs were selected.".into()));
    }
    if targets.len() > MAX_BULK {
        return Err(AppError::InvalidInput(format!(
            "{} runs is more than one batch can safely handle. Select at most {MAX_BULK}.",
            targets.len()
        )));
    }
    let reason = validate(action, reason.as_deref(), confirm.unwrap_or(false))?;

    // Validate every id up front: a malformed one should not surface half-way
    // through a batch that has already changed the leaderboard.
    let mut targets = targets;
    for target in &mut targets {
        target.run_id = require_id(&target.run_id, "run id")?;
    }

    let operation = format!("bulk_{}", action.as_str());
    let batch = batch_id(action.as_str());
    let started_at = now_iso8601();
    let total = targets.len();

    let _guard = state.write_lock.lock().await;

    let mut results: Vec<BulkItemResult> = Vec::with_capacity(total);
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut cancelled = false;

    for target in &targets {
        if is_cancelled(&batch) {
            cancelled = true;
            break;
        }

        let outcome = apply(&state, action, &target.run_id, reason.as_deref()).await;
        let item = match outcome {
            Ok(()) => {
                succeeded += 1;
                record(&state, action, target, reason.as_deref(), Some(&batch), None);
                BulkItemResult {
                    run_id: target.run_id.clone(),
                    success: true,
                    error: None,
                    error_kind: None,
                    retryable: false,
                }
            }
            Err(e) => {
                failed += 1;
                let message = e.to_string();
                record(
                    &state,
                    action,
                    target,
                    reason.as_deref(),
                    Some(&batch),
                    Some(&message),
                );
                BulkItemResult {
                    run_id: target.run_id.clone(),
                    success: false,
                    error: Some(message),
                    error_kind: Some(e.kind().to_string()),
                    retryable: e.retryable(),
                }
            }
        };

        // Progress is best-effort: a closed window must not abort the batch.
        let _ = app.emit(
            BULK_PROGRESS_EVENT,
            BulkProgress {
                batch_id: batch.clone(),
                operation: operation.clone(),
                completed: results.len() + 1,
                total,
                succeeded,
                failed,
                current_run_id: item.run_id.clone(),
                current_ok: item.success,
                current_error: item.error.clone(),
            },
        );
        results.push(item);
    }

    clear_cancel(&batch);

    let detail = summarise(&results, cancelled, total);
    let _ = state.db.audit_record(&AuditDraft {
        batch_id: &batch,
        operation: &operation,
        total: total as i64,
        succeeded: succeeded as i64,
        failed: failed as i64,
        detail: Some(&detail),
        started_at: &started_at,
    });

    Ok(BulkResult {
        batch_id: batch,
        operation,
        total,
        succeeded,
        failed,
        results,
        started_at,
        finished_at: now_iso8601(),
    })
}

/// Human-readable audit detail, naming the runs that failed.
fn summarise(results: &[BulkItemResult], cancelled: bool, total: usize) -> String {
    let mut parts = Vec::new();
    if cancelled {
        parts.push(format!(
            "Cancelled after {} of {total} runs.",
            results.len()
        ));
    }
    let failures: Vec<&BulkItemResult> = results.iter().filter(|r| !r.success).collect();
    if failures.is_empty() {
        parts.push(format!("{} runs succeeded.", results.len() - failures.len()));
    } else {
        parts.push(format!(
            "{} succeeded, {} failed.",
            results.len() - failures.len(),
            failures.len()
        ));
        for failure in failures.iter().take(20) {
            parts.push(format!(
                "{}: {}",
                failure.run_id,
                failure.error.as_deref().unwrap_or("unknown error")
            ));
        }
        if failures.len() > 20 {
            parts.push(format!("… and {} more.", failures.len() - 20));
        }
    }
    parts.join(" ")
}

/// Asks a running batch to stop after the current run.
#[tauri::command]
pub async fn cancel_bulk(batch_id: String) -> AppResult<()> {
    CANCELLED.lock().insert(batch_id);
    Ok(())
}

fn is_cancelled(batch: &str) -> bool {
    CANCELLED.lock().contains(batch)
}

fn clear_cancel(batch: &str) {
    CANCELLED.lock().remove(batch);
}

/// Retries only the failed items of an earlier batch.
///
/// Takes the failed run ids from the caller rather than re-reading the log, so
/// the moderator can drop the ones they no longer want to touch.
#[tauri::command]
pub async fn retry_failed(
    app: AppHandle,
    state: State<'_, AppState>,
    action: String,
    targets: Vec<ActionTarget>,
    reason: Option<String>,
    confirm: Option<bool>,
) -> AppResult<BulkResult> {
    bulk_moderate(app, state, action, targets, reason, confirm).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejecting_without_a_reason_is_refused_before_any_request() {
        let err = validate(ModerationAction::Reject, None, false).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(validate(ModerationAction::Reject, Some("   "), false).is_err());
        assert_eq!(
            validate(ModerationAction::Reject, Some(" no video "), false).unwrap(),
            Some("no video".to_string())
        );
    }

    #[test]
    fn deleting_requires_explicit_confirmation() {
        assert!(validate(ModerationAction::Delete, None, false).is_err());
        assert!(validate(ModerationAction::Delete, None, true).is_ok());
    }

    #[test]
    fn verifying_needs_neither_a_reason_nor_confirmation() {
        assert_eq!(validate(ModerationAction::Verify, None, false).unwrap(), None);
    }

    #[test]
    fn a_reason_is_only_carried_for_rejections() {
        assert_eq!(
            validate(ModerationAction::Verify, Some("ignored"), false).unwrap(),
            None
        );
    }

    fn item(run: &str, ok: bool, error: Option<&str>) -> BulkItemResult {
        BulkItemResult {
            run_id: run.into(),
            success: ok,
            error: error.map(str::to_string),
            error_kind: error.map(|_| "network".to_string()),
            retryable: error.is_some(),
        }
    }

    #[test]
    fn the_audit_detail_names_failures() {
        let results = vec![
            item("a", true, None),
            item("b", false, Some("rate limited")),
        ];
        let detail = summarise(&results, false, 2);
        assert!(detail.contains("1 succeeded, 1 failed"));
        assert!(detail.contains("b: rate limited"));
    }

    #[test]
    fn a_cancelled_batch_says_how_far_it_got() {
        let results = vec![item("a", true, None)];
        let detail = summarise(&results, true, 10);
        assert!(detail.contains("Cancelled after 1 of 10"));
    }

    #[test]
    fn cancellation_is_scoped_to_one_batch() {
        clear_cancel("batch-x");
        assert!(!is_cancelled("batch-x"));
        CANCELLED.lock().insert("batch-x".into());
        assert!(is_cancelled("batch-x"));
        assert!(!is_cancelled("batch-y"));
        clear_cancel("batch-x");
        assert!(!is_cancelled("batch-x"));
    }
}
