/**
 * The new-run watcher, frontend half.
 *
 * The loop itself is in Rust (`src-tauri/src/watcher.rs`). This store owns only
 * what happens *after* a run is found: the toast, the sound, the queue merge and
 * the Discord webhook. That split is the fix for the delay the watcher used to
 * have — a `setTimeout` chain in the webview is throttled to about once a minute
 * once the window is hidden, and reporting work used to be inside the interval,
 * so the real period was "interval plus everything else".
 *
 * Nothing here is timed. It reacts to `srctools://new-runs`, which arrives on
 * the cadence the moderator chose whatever the window is doing.
 *
 * Two rules still shape it:
 *
 * 1. **The first cycle never notifies.** Rust holds that baseline, so a restart
 *    does not announce the backlog.
 * 2. **A failed poll is a failed poll.** It is never reported as "no new runs",
 *    and a video whose check failed is never reported as a video problem.
 */

import { create } from 'zustand';

import {
  errorText,
  notifications,
  queue as queueIpc,
  watcher as watcherIpc,
  type NewRunsEvent,
  type WatcherStatus,
} from '../ipc';
import { t } from '../i18n';
import { claimBlockWarning, playNotificationSound } from '../sound';
import type { RunSummary, VideoStatus } from '../types';
import { isProblem } from '../types';
import { FAILURES_BEFORE_ALERT } from '../watcher/intervals';
import { useApp } from './app';
import { postWebhook, runEvent, useWebhook, videoEvent } from './integrations';
import { wasOwnVerdict } from './moderation';
import { useQueue, worstStatus } from './queue';
import { useSession, type Settings } from './session';
import { ui } from './ui';

interface WatcherState {
  /** True while the Rust loop is polling. */
  running: boolean;
  /** True until the baseline cycle has completed. */
  priming: boolean;
  lastCheck: string | null;
  lastError: string | null;
  /** Consecutive failed cycles, as Rust counts them. */
  failures: number;
  /** True once the API-down notification has been sent, so it is sent once. */
  alerted: boolean;
  /** Seconds between cycles, as actually applied. */
  delay: number;
  /** Runs seen since the moderator last looked at the queue. */
  unread: string[];

  /** Applies the current settings to the Rust loop. */
  sync: () => Promise<void>;
  stop: () => Promise<void>;
  /** Asks for a cycle now. Used by the Dashboard's refresh. */
  poll: () => Promise<void>;
  /** Handles `srctools://watcher`. */
  onStatus: (status: WatcherStatus) => void;
  /** Handles `srctools://new-runs`. */
  onRuns: (event: NewRunsEvent) => void;
  /** Handles `srctools://approved-runs`. */
  onApproved: (event: NewRunsEvent) => void;
  /** Handles `srctools://rejected-runs`. */
  onRejected: (event: NewRunsEvent) => void;
  clearUnread: () => void;
}

/**
 * Whether anything the moderator switched on needs the loop to be polling.
 *
 * The loop feeds every announcement surface there is, so gating it on the
 * desktop-notification setting alone meant a moderator who wanted their Discord
 * channel told but their own desktop left quiet got neither: the poll that finds
 * the run never happened, so nothing downstream of it could.
 *
 * Exported because Settings says which of these is the reason the watcher is
 * stopped, and two copies of this rule would disagree.
 */
export function watcherWanted(settings: Settings, webhookReady: boolean): boolean {
  return (
    settings.notifyNewRuns ||
    settings.notifyVideoProblems ||
    (settings.webhookEnabled && webhookReady)
  );
}

export const useWatcher = create<WatcherState>((set, get) => ({
  running: false,
  priming: true,
  lastCheck: null,
  lastError: null,
  failures: 0,
  alerted: false,
  delay: 0,
  unread: [],

  sync: async () => {
    const { settings, hasApiKey } = useSession.getState();
    const enabled =
      hasApiKey && watcherWanted(settings, useWebhook.getState().status.configured);
    try {
      const status = await watcherIpc.configure(enabled, settings.checkInterval);
      get().onStatus(status);
    } catch (err) {
      // Never silent. If this fails the watcher is not running, which means no
      // notifications, no sound and no webhook — the moderator would otherwise
      // see a working-looking app that has simply stopped telling them anything.
      set({ running: false, lastError: errorText(err) });
      ui.error(t('toast.watcherFailed'), err);
    }
  },

  stop: async () => {
    try {
      const status = await watcherIpc.configure(false, useSession.getState().settings.checkInterval);
      get().onStatus(status);
    } catch {
      set({ running: false, delay: 0 });
    }
  },

  poll: async () => {
    try {
      get().onStatus(await watcherIpc.pollNow());
    } catch {
      /* the status event reports the outcome */
    }
  },

  onStatus: (status) => {
    const previous = get();
    const recovered =
      previous.failures >= FAILURES_BEFORE_ALERT && previous.alerted && status.failures === 0;

    set({
      running: status.enabled,
      priming: !status.primed,
      lastCheck: status.lastCheck,
      lastError: status.lastError,
      failures: status.failures,
      delay: status.intervalSecs,
      alerted: status.failures === 0 ? false : previous.alerted,
    });

    const { settings } = useSession.getState();

    if (recovered && settings.notifyApiErrors) {
      void announce(t('notify.apiRecovered.title'), t('notify.apiRecovered.body'), null, 'info');
    }

    if (
      status.failures >= FAILURES_BEFORE_ALERT &&
      !previous.alerted &&
      settings.notifyApiErrors
    ) {
      set({ alerted: true });
      void announce(
        t('notify.apiError.title'),
        t('notify.apiError.body', { count: status.failures }),
        null,
        'warning',
      );
    }

    // The rate-limit gauge is driven by the poll that just happened, so this is
    // where it is refreshed rather than on a timer of its own.
    void useSession.getState().refreshRateLimit();
  },

  onRuns: (event) => {
    const fresh = event.runs;
    if (fresh.length === 0) return;

    set({ unread: [...get().unread, ...fresh.map((run) => run.id)] });

    // Land the run in the loaded queue so a moderator looking at it sees it
    // arrive instead of only hearing about it. Only when the queue has actually
    // been fetched: seeding an empty list would present a handful of runs as
    // though they were the whole backlog.
    if (useQueue.getState().fetchedAt !== null) {
      useQueue.getState().mergeRuns(fresh);
    }

    // Not awaited. Everything below — the sound, the video check, the webhook —
    // is downstream of a poll that has already been timed, and awaiting it here
    // would only delay the store's own return.
    void report_(fresh);
  },

  onApproved: (event) => {
    // A verdict reached in this window was posted the moment it succeeded, so the
    // feed's copy of it is a duplicate rather than news.
    const approved = event.runs.filter((run) => !wasOwnVerdict(run.id));
    if (approved.length === 0) return;

    // An approval asks nothing of this moderator, so it gets no Windows
    // notification and no sound — those are for a queue that needs attention. It
    // gets the channel, which is what an approval log is for, one in-app toast so
    // the app is not silent about something it noticed, and it leaves the pending
    // queue, because it is no longer pending.
    postWebhook(approved.map((run) => runEvent('approved', run)));
    useQueue.getState().removeRuns(approved.map((run) => run.id));

    const newest = approved[0];
    if (!newest) return;
    const single = approved.length === 1;
    ui.notify({
      kind: 'info',
      title: single
        ? t('notify.approved.title')
        : t('notify.approved.titleMany', { count: approved.length }),
      message: single
        ? t('notify.approved.body', {
            game: newest.gameName ?? t('common.unknown'),
            player: newest.playerLabel,
          })
        : t('notify.approved.bodyMany', { count: approved.length }),
      action: {
        label: t('action.openDetail'),
        run: () => {
          useApp.getState().go('queue');
          useApp.getState().openDetail(newest.id);
        },
      },
    });
  },

  onRejected: (event) => {
    const rejected = event.runs.filter((run) => !wasOwnVerdict(run.id));
    if (rejected.length === 0) return;

    // Same reasoning as an approval, and the same two consequences: the channel
    // and one toast. The reason comes from the feed here rather than from a
    // dialog in this window, so it may be absent — `runEvent` leaves the field
    // out rather than inventing one.
    postWebhook(
      rejected.map((run) => runEvent('rejected', run, run.rejectionReason)),
    );
    useQueue.getState().removeRuns(rejected.map((run) => run.id));

    const newest = rejected[0];
    if (!newest) return;
    const single = rejected.length === 1;
    ui.notify({
      kind: 'info',
      title: single ? t('notify.rejected.title') : t('notify.rejected.titleMany', { count: rejected.length }),
      message: single
        ? t('notify.rejected.body', {
            game: newest.gameName ?? t('common.unknown'),
            player: newest.playerLabel,
          })
        : t('notify.rejected.bodyMany', { count: rejected.length }),
      action: {
        label: t('action.openDetail'),
        run: () => {
          useApp.getState().go('queue');
          useApp.getState().openDetail(newest.id);
        },
      },
    });
  },

  clearUnread: () => set({ unread: [] }),
}));

/**
 * Shows one event on every surface the moderator has enabled.
 *
 * The in-app toast is not conditional on the notification settings: those govern
 * whether Windows is told, and an app that stayed silent in its own window while
 * a toast appeared outside it would be stranger than the reverse.
 */
async function announce(
  title: string,
  body: string,
  action: { page: string; runId?: string | null } | null,
  kind: 'info' | 'warning' = 'info',
  onClick?: () => void,
): Promise<void> {
  ui.notify({
    kind,
    title,
    message: body,
    ...(onClick ? { action: { label: t('action.openDetail'), run: onClick } } : {}),
  });

  void notifications.show(title, body, action).catch(() => {
    /* a missing toast is a degraded convenience, not a failure to report */
  });

  const { settings } = useSession.getState();
  if (settings.soundEnabled) {
    const played = await playNotificationSound(settings.soundVolume);
    if (!played && claimBlockWarning()) {
      ui.warning(t('toast.soundBlocked'), t('toast.soundBlockedHint'));
    }
  }
}

/**
 * Video verdicts for the runs a cycle just found.
 *
 * Bounded on purpose: a burst of submissions must not turn one poll into a
 * stream of provider requests. Runs beyond the cap keep whatever the queue's own
 * check finds later.
 *
 * Failures are dropped rather than defaulted. A check that did not complete says
 * nothing about the video, and reporting it as a problem would be a lie the
 * moderator might act on.
 */
async function checkFreshVideos(fresh: RunSummary[]): Promise<Record<string, VideoStatus>> {
  const CAP = 5;
  const targets = fresh.filter((run) => run.videoUrls.length > 0).slice(0, CAP);
  if (targets.length === 0) return {};

  try {
    const payload: Array<[string, string[]]> = targets.map((run) => [run.id, run.videoUrls]);
    const checks = await queueIpc.checkBulk(payload, false);

    const out: Record<string, VideoStatus> = {};
    for (const [runId, results] of Object.entries(checks)) {
      // Feed the queue's cache too, so its badges match what was announced.
      useQueue.getState().applyChecks(runId, results);
      const status = worstStatus(results);
      if (status !== null) out[runId] = status;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Reports newly seen runs.
 *
 * Several arriving in one cycle are collapsed into a single notification: a
 * moderator who steps away for a minute should come back to one toast naming the
 * newest run, not eleven stacked ones. The Discord webhook is the exception — it
 * posts one embed per run, because a channel is a log rather than a moment's
 * attention, and "3 new runs" scrolling past names none of them.
 */
async function report_(fresh: RunSummary[]): Promise<void> {
  const { settings } = useSession.getState();
  const newest = fresh[0];
  if (!newest) return;

  const open = (runId: string) => () => {
    useApp.getState().go('queue');
    useApp.getState().openDetail(runId);
  };

  if (settings.notifyNewRuns) {
    const vars = {
      game: newest.gameName ?? t('common.unknown'),
      category: newest.categoryName ?? t('common.unknown'),
      player: newest.playerLabel,
      count: fresh.length,
    };
    const single = fresh.length === 1;
    await announce(
      single ? t('notify.newRun.title') : t('notify.newRuns.title', vars),
      single ? t('notify.newRun.body', vars) : t('notify.newRuns.body', vars),
      { page: 'queue', runId: newest.id },
      'info',
      open(newest.id),
    );
  }

  // Not awaited and not conditional on the Windows notification: the channel is
  // a separate audience with its own switch, and a moderator who wants Discord
  // told but their own desktop left alone is a reasonable thing to want.
  postWebhook(fresh.map((run) => runEvent('newRun', run)));

  // The check costs provider requests, so it only runs when something is
  // actually listening for the answer.
  const webhookWantsVideo =
    settings.webhookEnabled &&
    useWebhook.getState().status.configured &&
    (settings.webhookDeletedVideos || settings.webhookVideoProblems);
  if (!settings.notifyVideoProblems && !webhookWantsVideo) return;

  const statuses = await checkFreshVideos(fresh);
  const problems: Array<{ run: RunSummary; status: VideoStatus }> = [];
  for (const run of fresh) {
    const status = statuses[run.id];
    // `isProblem` is false for UNKNOWN and NETWORK_ERROR, which is the whole
    // point: a check that failed is not a missing video.
    if (status === undefined || !isProblem(status)) continue;
    problems.push({ run, status });
    if (!settings.notifyVideoProblems) continue;
    await announce(
      t('notify.videoProblem.title'),
      t('notify.videoProblem.body', {
        game: run.gameName ?? t('common.unknown'),
        player: run.playerLabel,
        status: t(`video.${status}`),
      }),
      { page: 'queue', runId: run.id },
      'warning',
      open(run.id),
    );
  }

  postWebhook(problems.map(({ run, status }) => videoEvent(run, status)));
}
