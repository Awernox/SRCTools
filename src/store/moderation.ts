/**
 * Moderation actions — the only code in the frontend that changes anything on
 * Speedrun.com.
 *
 * Every path through this module is explicitly initiated by the moderator.
 * Nothing here reacts to the analysis engine, a video status or a heuristic:
 * those inform the person, and the person decides.
 */

import { create } from 'zustand';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

import { plural } from '../format';
import { t, type TranslationKey } from '../i18n';
import { moderation as ipc } from '../ipc';
import type { ActionTarget, BulkProgress, BulkResult, ModerationActionName, RunSummary } from '../types';
import { postWebhook, runEvent } from './integrations';
import { useQueue } from './queue';
import { useSession } from './session';
import { ui } from './ui';

/** Copies the descriptive fields worth keeping in the local log. */
export function targetOf(run: RunSummary): ActionTarget {
  return {
    runId: run.id,
    context: {
      gameId: run.gameId,
      gameName: run.gameName,
      categoryId: run.categoryId,
      categoryName: run.categoryName,
      playerNames: run.playerLabel,
      runTime: run.primarySeconds,
      runWeblink: run.weblink,
    },
  };
}

/**
 * "Half-Life — Any% by pilotwave in 21:02", for a confirmation dialog.
 *
 * Exported because the rejection dialog names the run the same way; two copies of
 * this would drift.
 *
 * Two whole sentences rather than one with an optional tail, because a run with
 * no time must not leave a dangling preposition in any of the four languages.
 */
export function runLine(run: RunSummary): string {
  const vars = {
    game: run.gameName ?? t('common.unknownGame'),
    category: run.categoryName ?? t('common.unknownCategory'),
    runner: run.playerLabel,
  };
  return run.primaryDisplay
    ? t('mod.runLineWithTime', { ...vars, time: run.primaryDisplay })
    : t('mod.runLine', vars);
}

/**
 * What a batch is called — the same name the history log gives it, so a toast
 * and the log entry it produced do not read as two different operations.
 */
const BULK_OPERATION: Record<ModerationActionName, TranslationKey> = {
  verify: 'history.op.bulkVerify',
  reject: 'history.op.bulkReject',
  delete: 'history.op.bulkDelete',
};

/**
 * The confirmation wording for each bulk action.
 *
 * Whole sentences per action rather than a verb interpolated into a shared
 * template: "Verify 3 runs?" and "Подтвердить 3 рана?" do not share a shape, and
 * the count needs [`plural`] anyway.
 */
const BULK_CONFIRM: Record<
  ModerationActionName,
  { title: TranslationKey; body: TranslationKey; confirm: TranslationKey }
> = {
  verify: {
    title: 'dialog.verifyMany.title',
    body: 'dialog.verifyMany.message',
    confirm: 'action.verifySelected',
  },
  reject: {
    title: 'dialog.rejectMany.title',
    body: 'dialog.rejectMany.message',
    confirm: 'action.rejectSelected',
  },
  delete: {
    title: 'dialog.deleteMany.title',
    body: 'dialog.deleteMany.message',
    confirm: 'action.deleteSelected',
  },
};

export interface BulkRun {
  batchId: string | null;
  action: ModerationActionName;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentRunId: string | null;
  /** Failures kept so the moderator can retry only what actually failed. */
  failures: Array<{ runId: string; error: string; retryable: boolean }>;
  finished: boolean;
  cancelling: boolean;
}

interface ModerationState {
  /** Run ids with an action in flight, so rows can show a spinner. */
  busy: Set<string>;
  bulk: BulkRun | null;
  lastResult: BulkResult | null;

  verify: (run: RunSummary) => Promise<boolean>;
  reject: (run: RunSummary, reason: string) => Promise<boolean>;
  remove: (run: RunSummary) => Promise<boolean>;

  bulkAction: (
    action: ModerationActionName,
    runs: RunSummary[],
    reason?: string,
  ) => Promise<BulkResult | null>;
  cancelBulk: () => Promise<void>;
  retryFailures: () => Promise<BulkResult | null>;
  dismissBulk: () => void;

  onProgress: (progress: BulkProgress) => void;
}

/** The retry needs the original runs, not just their ids. */
let lastBatchRuns: RunSummary[] = [];
let lastBatchReason: string | undefined;

function setBusy(runId: string, busy: boolean) {
  useModeration.setState((state) => {
    const next = new Set(state.busy);
    if (busy) next.add(runId);
    else next.delete(runId);
    return { busy: next };
  });
}

/** Refreshes the queue's view of the world after runs leave it. */
function afterAction(runIds: string[]) {
  useQueue.getState().removeRuns(runIds);
  void useSession.getState().refreshRateLimit();
}

/**
 * Verdicts this app produced itself, so the watcher's verdict feeds do not
 * announce the same decision twice.
 *
 * Those feeds exist to catch a verdict made elsewhere — on the Speedrun.com site,
 * or by another moderator — and the API does not say who reached it. Without this
 * ledger every approval and rejection made in this window would post to Discord
 * twice: once the moment it succeeded, and again when the feed noticed it.
 *
 * Entries expire. A run can only be judged once, so a permanent set would only
 * grow; the window has to outlast the feed's own lag and nothing more.
 */
const OWN_VERDICT_TTL = 10 * 60 * 1000;
const ownVerdicts = new Map<string, number>();

/** Records that this app judged these runs, and has already reported it. */
function noteOwnVerdict(runIds: string[]): void {
  const now = Date.now();
  for (const [id, at] of ownVerdicts) {
    if (now - at > OWN_VERDICT_TTL) ownVerdicts.delete(id);
  }
  for (const id of runIds) ownVerdicts.set(id, now);
}

/** True when the verdict on this run came from this window. */
export function wasOwnVerdict(runId: string): boolean {
  const at = ownVerdicts.get(runId);
  if (at === undefined) return false;
  if (Date.now() - at > OWN_VERDICT_TTL) {
    ownVerdicts.delete(runId);
    return false;
  }
  return true;
}

/**
 * Posts the half of a batch that actually succeeded.
 *
 * Deletions produce nothing: the five webhook events the moderator can turn on
 * cover approvals, rejections and video trouble, and inventing a sixth here
 * would post something no setting governs.
 */
function postBatch(
  action: ModerationActionName,
  runs: RunSummary[],
  result: BulkResult,
  reason?: string,
): void {
  if (action === 'delete') return;
  const kind = action === 'verify' ? 'approved' : 'rejected';
  const detail = action === 'reject' ? (reason?.trim() ?? null) : null;

  const byId = new Map(runs.map((run) => [run.id, run]));
  const judged = result.results
    .filter((item) => item.success)
    .map((item) => byId.get(item.runId))
    .filter((run): run is RunSummary => run !== undefined);

  noteOwnVerdict(judged.map((run) => run.id));
  postWebhook(judged.map((run) => runEvent(kind, run, detail)));
}

export const useModeration = create<ModerationState>((set, get) => ({
  busy: new Set(),
  bulk: null,
  lastResult: null,

  verify: async (run) => {
    const { settings } = useSession.getState();
    if (settings.confirmVerify) {
      const ok = await ui.confirm({
        title: t('dialog.verify.title'),
        message: t('dialog.verify.message', { run: runLine(run) }),
        confirmLabel: t('action.verify'),
      });
      if (!ok) return false;
    }

    setBusy(run.id, true);
    try {
      await ipc.verify(targetOf(run));
      ui.success(t('toast.verified'), run.gameName ?? undefined);
      afterAction([run.id]);
      // Not awaited and never allowed to fail the action: the run is already
      // verified on Speedrun.com by this point, and a Discord outage is not a
      // reason to tell the moderator their verification failed.
      //
      // Noted first, so the verified feed recognises this verdict as ours and
      // does not post a second embed for it a few seconds from now.
      noteOwnVerdict([run.id]);
      postWebhook([runEvent('approved', run)]);
      return true;
    } catch (err) {
      ui.error(t('mod.verifyFailed'), err);
      return false;
    } finally {
      setBusy(run.id, false);
    }
  },

  reject: async (run, reason) => {
    const trimmed = reason.trim();
    if (!trimmed) {
      ui.warning(t('mod.reasonRequired'), t('mod.reasonRequiredHint'));
      return false;
    }

    setBusy(run.id, true);
    try {
      await ipc.reject(targetOf(run), trimmed);
      ui.success(t('toast.rejected'), run.gameName ?? undefined);
      afterAction([run.id]);
      // The reason goes with it: it is what the runner was told, so a channel
      // watching rejections is otherwise left guessing why. Noted as ours so the
      // rejected feed does not repeat it — and the feed has no reason text, so
      // this copy is also the better one.
      noteOwnVerdict([run.id]);
      postWebhook([runEvent('rejected', run, trimmed)]);
      return true;
    } catch (err) {
      ui.error(t('mod.rejectFailed'), err);
      return false;
    } finally {
      setBusy(run.id, false);
    }
  },

  remove: async (run) => {
    // Deletion is irreversible on Speedrun.com, so it always confirms and the
    // dialog says so plainly, regardless of the confirm-verify preference.
    const ok = await ui.confirm({
      title: t('dialog.delete.title'),
      message: t('dialog.delete.message', { run: runLine(run) }),
      danger: true,
      confirmLabel: t('dialog.delete.confirm'),
      acknowledge: t('dialog.delete.acknowledge'),
    });
    if (!ok) return false;

    setBusy(run.id, true);
    try {
      await ipc.delete(targetOf(run), true);
      ui.success(t('toast.deleted'), run.gameName ?? undefined);
      afterAction([run.id]);
      return true;
    } catch (err) {
      ui.error(t('mod.deleteFailed'), err);
      return false;
    } finally {
      setBusy(run.id, false);
    }
  },

  bulkAction: async (action, runs, reason) => {
    if (runs.length === 0) return null;
    if (get().bulk && !get().bulk?.finished) {
      ui.warning(t('mod.bulkRunning'));
      return null;
    }

    const copy = BULK_CONFIRM[action];
    const counted = plural(runs.length, 'run');
    const trimmedReason = reason?.trim() ?? '';
    const confirmed = await ui.confirm({
      title: t(copy.title, { runs: counted }),
      message:
        action === 'reject' && trimmedReason !== ''
          ? t('dialog.rejectMany.messageWithReason', {
              runs: counted,
              reason: trimmedReason,
            })
          : t(copy.body, { runs: counted }),
      danger: action === 'delete',
      confirmLabel: t(copy.confirm, { count: runs.length }),
      ...(action === 'delete' ? { acknowledge: t('dialog.deleteMany.acknowledge') } : {}),
    });
    if (!confirmed) return null;

    lastBatchRuns = runs;
    lastBatchReason = reason;

    set({
      bulk: {
        batchId: null,
        action,
        total: runs.length,
        completed: 0,
        succeeded: 0,
        failed: 0,
        currentRunId: null,
        failures: [],
        finished: false,
        cancelling: false,
      },
      lastResult: null,
    });

    try {
      const result = await ipc.bulk(action, runs.map(targetOf), reason ?? null, true);
      const failures = result.results
        .filter((item) => !item.success)
        .map((item) => ({
          runId: item.runId,
          error: item.error ?? t('mod.unreportedFailure'),
          retryable: item.retryable,
        }));

      set((state) => ({
        lastResult: result,
        bulk: state.bulk
          ? {
              ...state.bulk,
              batchId: result.batchId,
              completed: result.total,
              succeeded: result.succeeded,
              failed: result.failed,
              currentRunId: null,
              failures,
              finished: true,
              cancelling: false,
            }
          : null,
      }));

      afterAction(result.results.filter((item) => item.success).map((item) => item.runId));
      postBatch(action, runs, result, reason);

      const operation = t(BULK_OPERATION[action]);
      const summary = t('bulk.counts', {
        succeeded: result.succeeded,
        failed: result.failed,
      });
      if (result.failed === 0) ui.success(t('mod.bulk.finished', { operation }), summary);
      else if (result.succeeded === 0) ui.error(t('mod.bulk.failed', { operation }), undefined);
      else ui.warning(t('mod.bulk.partly', { operation }), summary);

      if (useSession.getState().settings.notifyOnBulkComplete) {
        void notifyDesktop(t('mod.bulk.finished', { operation }), summary);
      }
      return result;
    } catch (err) {
      set((state) => ({
        bulk: state.bulk ? { ...state.bulk, finished: true, cancelling: false } : null,
      }));
      ui.error(t('mod.bulk.couldNotRun', { operation: t(BULK_OPERATION[action]) }), err);
      return null;
    }
  },

  cancelBulk: async () => {
    const bulk = get().bulk;
    if (!bulk?.batchId || bulk.finished) {
      // The batch id only arrives with the first progress event; before that
      // there is nothing the backend can be asked to stop.
      set((state) => (state.bulk ? { bulk: { ...state.bulk, cancelling: true } } : {}));
      return;
    }
    set({ bulk: { ...bulk, cancelling: true } });
    try {
      await ipc.cancelBulk(bulk.batchId);
      ui.info(t('mod.stopping'));
    } catch (err) {
      ui.error(t('mod.stopFailed'), err);
    }
  },

  retryFailures: async () => {
    const bulk = get().bulk;
    if (!bulk || bulk.failures.length === 0) return null;

    const failed = new Set(bulk.failures.map((f) => f.runId));
    const runs = lastBatchRuns.filter((run) => failed.has(run.id));
    if (runs.length === 0) return null;

    set({
      bulk: {
        ...bulk,
        total: runs.length,
        completed: 0,
        succeeded: 0,
        failed: 0,
        failures: [],
        finished: false,
        cancelling: false,
      },
    });

    try {
      const result = await ipc.retryFailed(
        bulk.action,
        runs.map(targetOf),
        lastBatchReason ?? null,
        true,
      );
      set((state) => ({
        lastResult: result,
        bulk: state.bulk
          ? {
              ...state.bulk,
              batchId: result.batchId,
              completed: result.total,
              succeeded: result.succeeded,
              failed: result.failed,
              currentRunId: null,
              failures: result.results
                .filter((item) => !item.success)
                .map((item) => ({
                  runId: item.runId,
                  error: item.error ?? t('mod.unreportedFailure'),
                  retryable: item.retryable,
                })),
              finished: true,
            }
          : null,
      }));
      afterAction(result.results.filter((item) => item.success).map((item) => item.runId));
      postBatch(bulk.action, runs, result, lastBatchReason);
      ui.info(
        t('mod.retryFinished'),
        t('bulk.counts', { succeeded: result.succeeded, failed: result.failed }),
      );
      return result;
    } catch (err) {
      set((state) => ({ bulk: state.bulk ? { ...state.bulk, finished: true } : null }));
      ui.error(t('mod.retryFailed'), err);
      return null;
    }
  },

  dismissBulk: () => set({ bulk: null }),

  onProgress: (progress) =>
    set((state) => {
      if (!state.bulk) return {};
      const failures = [...state.bulk.failures];
      if (!progress.currentOk) {
        failures.push({
          runId: progress.currentRunId,
          error: progress.currentError ?? t('mod.unreportedFailure'),
          retryable: false,
        });
      }
      return {
        bulk: {
          ...state.bulk,
          batchId: progress.batchId,
          completed: progress.completed,
          total: progress.total,
          succeeded: progress.succeeded,
          failed: progress.failed,
          currentRunId: progress.currentRunId,
          failures,
        },
      };
    }),
}));

/**
 * Desktop notification for a finished batch.
 *
 * Goes through the Tauri plugin rather than the Web Notification API: the
 * webview's own notifications are not granted by the app's capabilities, and the
 * plugin is what produces a real Windows toast. Permission is requested only
 * when the user has asked for these, and a refusal is simply respected — the
 * in-app toast already carried the same information.
 */
async function notifyDesktop(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (!granted) return;
    sendNotification({ title, body });
  } catch {
    /* notifications are a convenience, never a requirement */
  }
}

/** Formats a bulk failure list for the report panel. */
export function failureSummary(bulk: BulkRun): string {
  if (bulk.failures.length === 0) return t('mod.noFailures');
  return bulk.failures.map((f) => `${f.runId}: ${f.error}`).join('\n');
}
