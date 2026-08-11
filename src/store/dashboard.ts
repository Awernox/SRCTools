/**
 * Dashboard summary and moderation statistics.
 *
 * Both are read-only views over data the backend already aggregates. They are
 * separate slices because the dashboard is refetched whenever the moderator
 * returns to it, while the statistics window is chosen deliberately and should
 * not reset underneath them.
 */

import { create } from 'zustand';

import { errorText, queue, records } from '../ipc';
import type { DashboardSummary, ModerationStats } from '../types';

interface DashboardState {
  summary: DashboardSummary | null;
  loading: boolean;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
}

export const useDashboard = create<DashboardState>((set, get) => ({
  summary: null,
  loading: false,
  error: null,

  load: async (force = false) => {
    if (get().loading) return;
    // The summary costs several API requests, so a revisit within the minute
    // reuses what is on screen unless the moderator asked for a refresh.
    if (!force && get().summary) {
      const age = Date.now() - new Date(get().summary!.fetchedAt).getTime();
      if (Number.isFinite(age) && age < 60_000) return;
    }
    set({ loading: true, error: null });
    try {
      set({ summary: await queue.dashboard(), loading: false });
    } catch (err) {
      set({ loading: false, error: errorText(err) });
    }
  },
}));

export const DAYS_OPTIONS = [7, 14, 30, 90, 365] as const;

interface StatsState {
  stats: ModerationStats | null;
  days: number;
  loading: boolean;
  error: string | null;

  load: (days?: number) => Promise<void>;
  setDays: (days: number) => void;
}

export const useStats = create<StatsState>((set, get) => ({
  stats: null,
  days: 30,
  loading: false,
  error: null,

  load: async (days) => {
    const window = days ?? get().days;
    set({ loading: true, error: null });
    try {
      set({ stats: await records.stats(window), loading: false });
    } catch (err) {
      set({ loading: false, error: errorText(err) });
    }
  },

  setDays: (days) => {
    set({ days });
    void get().load(days);
  },
}));
