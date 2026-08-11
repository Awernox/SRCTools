/**
 * The run currently open in the inspection panel.
 *
 * Separate from the queue store because the panel can show a run the queue does
 * not hold — the dashboard opens one by id, and Fast Review walks ahead of what
 * is on screen. Everything here is a read: nothing in this file changes a run on
 * Speedrun.com.
 */

import { create } from 'zustand';

import { errorText, queue } from '../ipc';
import type { RunDetail } from '../types';
import { useModeration } from './moderation';
import { useQueue } from './queue';
import { ui } from './ui';

interface DetailState {
  /** Last run the panel was asked to show; kept when the fetch fails. */
  runId: string | null;
  detail: RunDetail | null;
  /** `true` while a detail fetch is in flight. */
  loading: boolean;
  /** `null` means the last load succeeded (even if the run has no detail). */
  error: string | null;
  /** When set, the video section is showing all checks. */
  expandedVideos: boolean;
  /** True while a manual re-check is running. */
  rechecking: boolean;

  open: (runId: string) => Promise<void>;
  refresh: () => Promise<void>;
  recheck: () => Promise<void>;
  close: () => void;
  setExpandedVideos: (expanded: boolean) => void;
  clear: () => void;
}

export const useDetail = create<DetailState>((set, get) => ({
  runId: null,
  detail: null,
  loading: false,
  error: null,
  expandedVideos: true,
  rechecking: false,

  open: async (runId) => {
    set({ runId, loading: true, error: null });
    try {
      const detail = await queue.runDetail(runId);
      set({ detail, loading: false });
      // The detail fetch re-ran the video checks for this run; make the queue
      // row show the freshest verdicts rather than whatever it had before.
      if (detail.videoChecks.length > 0) {
        useQueue.getState().applyChecks(runId, detail.videoChecks);
      }
    } catch (err) {
      set({ error: errorText(err), loading: false });
    }
  },

  refresh: async () => {
    const { runId } = get();
    if (!runId) return;
    await get().open(runId);
  },

  /**
   * Re-runs the video checks for the open run, bypassing the cache.
   *
   * Kept separate from `refresh` because it is the answer to "the check failed,
   * or the runner has just re-uploaded" — it re-asks the provider rather than
   * re-reading a cached verdict, and it leaves the rest of the detail alone.
   */
  recheck: async () => {
    const { runId, detail } = get();
    if (!runId || get().rechecking) return;
    set({ rechecking: true });
    try {
      const checks = await queue.recheckVideos(runId);
      useQueue.getState().applyChecks(runId, checks);
      // Only the checks are replaced; the analysis in `detail` was computed from
      // the previous ones, so it is refreshed rather than left inconsistent.
      if (detail) set({ detail: { ...detail, videoChecks: checks } });
      await get().refresh();
    } catch (err) {
      ui.error('Could not re-check the videos', err);
    } finally {
      set({ rechecking: false });
    }
  },

  close: () => {
    set({ runId: null, detail: null, error: null, loading: false });
    useModeration.setState({ busy: new Set() });
  },

  setExpandedVideos: (expanded) => set({ expandedVideos: expanded }),

  clear: () => set({ detail: null, error: null, loading: false }),
}));
