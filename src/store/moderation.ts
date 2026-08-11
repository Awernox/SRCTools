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
  const events = result.results
    .filter((item) => item.success)
    .map((item) => byId.get(item.runId))
    .filter((run): run is RunSummary => run !== undefined)
    .map((run) => runEvent(kind, run, detail));

  postWebhook(events);
}

export const useModeration = create<ModerationState>((set, get) => ({
  busy: new Set(),
  bulk: null,
  lastResult: null,

  verify: async (run) => {
    const { settings } = useSession.getState();
    if (settings.confirmVerify) {
      const ok = await ui.confirm({
        title: 'Verify this run?',
        message: `${run.gameName ?? 'Unknown game'} — ${run.categoryName ?? 'Unknown category'} by ${run.playerLabel}${
          run.primaryDisplay ? ` in ${run.primaryDisplay}` : ''
        }. This marks the run verified on Speedrun.com.`,
        confirmLabel: 'Verify',
      });
      if (!ok) return false;
    }

    setBusy(run.id, true);
    try {
      await ipc.verify(targetOf(run));
      ui.success('Run verified', run.gameName ?? undefined);
      afterAction([run.id]);
      // Not awaited and never allowed to fail the action: the run is already
      // verified on Speedrun.com by this point, and a Discord outage is not a
      // reason to tell the moderator their verification failed.
      postWebhook([runEvent('approved', run)]);
      return true;
    } catch (err) {
      ui.error('Could not verify the run', err);
      return false;
    } finally {
      setBusy(run.id, false);
    }
  },

  reject: async (run, reason) => {
    const trimmed = reason.trim();
    if (!trimmed) {
      ui.warning('A reason is required', 'Speedrun.com shows your reason to the runner.');
      return false;
    }

    setBusy(run.id, true);
    try {
      await ipc.reject(targetOf(run), trimmed);
      ui.success('Run rejected', run.gameName ?? undefined);
      afterAction([run.id]);
      // The reason goes with it: it is what the runner was told, so a channel
      // watching rejections is otherwise left guessing why.
      postWebhook([runEvent('rejected', run, trimmed)]);
      return true;
    } catch (err) {
      ui.error('Could not reject the run', err);
      return false;
    } finally {
      setBusy(run.id, false);
    }
  },

  remove: async (run) => {
    // Deletion is irreversible on Speedrun.com, so it always confirms and the
    // dialog says so plainly, regardless of the confirm-verify preference.
    const ok = await ui.confirm({
      title: 'Delete this run permanently?',
      message: `${run.gameName ?? 'Unknown game'} — ${run.categoryName ?? 'Unknown category'} by ${run.playerLabel}. Deleting removes the run from Speedrun.com entirely. This cannot be undone, and rejecting is usually the right action instead.`,
      danger: true,
      confirmLabel: 'Delete permanently',
      acknowledge: 'I understand this run cannot be recovered.',
    });
    if (!ok) return false;

    setBusy(run.id, true);
    try {
      await ipc.delete(targetOf(run), true);
      ui.success('Run deleted', run.gameName ?? undefined);
      afterAction([run.id]);
      return true;
    } catch (err) {
      ui.error('Could not delete the run', err);
      return false;
    } finally {
      setBusy(run.id, false);
    }
  },

  bulkAction: async (action, runs, reason) => {
    if (runs.length === 0) return null;
    if (get().bulk && !get().bulk?.finished) {
      ui.warning('A bulk operation is already running');
      return null;
    }

    const verb = action === 'verify' ? 'Verify' : action === 'reject' ? 'Reject' : 'Delete';
    const confirmed = await ui.confirm({
      title: `${verb} ${runs.length} run${runs.length === 1 ? '' : 's'}?`,
      message:
        action === 'delete'
          ? `${runs.length} run${runs.length === 1 ? '' : 's'} will be removed from Speedrun.com permanently. This cannot be undone.`
          : `${runs.length} run${runs.length === 1 ? '' : 's'} will be ${action === 'verify' ? 'verified' : 'rejected'} on Speedrun.com${
              reason ? ` with the reason: “${reason}”` : ''
            }. Runs are processed one at a time and you can stop partway.`,
      danger: action === 'delete',
      confirmLabel: `${verb} ${runs.length}`,
      ...(action === 'delete'
        ? { acknowledge: 'I understand these runs cannot be recovered.' }
        : {}),
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
          error: item.error ?? 'Failed for an unreported reason.',
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

      const summary = `${result.succeeded} succeeded, ${result.failed} failed`;
      if (result.failed === 0) ui.success(`Bulk ${action} finished`, summary);
      else if (result.succeeded === 0) ui.error(`Bulk ${action} failed`, undefined);
      else ui.warning(`Bulk ${action} finished with failures`, summary);

      if (useSession.getState().settings.notifyOnBulkComplete) {
        void notifyDesktop(`Bulk ${action} finished`, summary);
      }
      return result;
    } catch (err) {
      set((state) => ({
        bulk: state.bulk ? { ...state.bulk, finished: true, cancelling: false } : null,
      }));
      ui.error(`Bulk ${action} could not run`, err);
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
      ui.info('Stopping after the current run');
    } catch (err) {
      ui.error('Could not stop the batch', err);
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
                  error: item.error ?? 'Failed for an unreported reason.',
                  retryable: item.retryable,
                })),
              finished: true,
            }
          : null,
      }));
      afterAction(result.results.filter((item) => item.success).map((item) => item.runId));
      postBatch(bulk.action, runs, result, lastBatchReason);
      ui.info('Retry finished', `${result.succeeded} succeeded, ${result.failed} failed`);
      return result;
    } catch (err) {
      set((state) => ({ bulk: state.bulk ? { ...state.bulk, finished: true } : null }));
      ui.error('Retry could not run', err);
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
          error: progress.currentError ?? 'Failed for an unreported reason.',
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
  if (bulk.failures.length === 0) return 'No failures.';
  return bulk.failures.map((f) => `${f.runId}: ${f.error}`).join('\n');
}
