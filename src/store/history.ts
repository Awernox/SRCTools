/**
 * Local moderation history and the bulk audit log.
 *
 * This is SRCTools' own record of what the moderator did from this machine. It
 * is not a mirror of Speedrun.com: clearing it changes nothing upstream, and the
 * UI says so wherever clearing is offered.
 */

import { create } from 'zustand';

import { errorText, records } from '../ipc';
import type { AuditEntry, HistoryEntry, HistoryQuery, ModerationActionName } from '../types';

const PAGE_SIZE = 100;

export interface HistoryFilters {
  action: ModerationActionName | 'all';
  outcome: 'all' | 'success' | 'failed';
  search: string;
}

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  action: 'all',
  outcome: 'all',
  search: '',
};

interface HistoryState {
  entries: HistoryEntry[];
  audit: AuditEntry[];
  total: number;
  filters: HistoryFilters;
  offset: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** False once a page comes back short, so the list stops asking for more. */
  hasMore: boolean;

  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  setFilters: (patch: Partial<HistoryFilters>) => void;
  clear: (confirm: boolean) => Promise<number>;
  loadAudit: () => Promise<void>;
}

function toQuery(filters: HistoryFilters, offset: number): HistoryQuery {
  return {
    action: filters.action === 'all' ? null : filters.action,
    outcome: filters.outcome === 'all' ? null : filters.outcome,
    search: filters.search.trim() || null,
    limit: PAGE_SIZE,
    offset,
  };
}

let searchTimer: number | undefined;

export const useHistory = create<HistoryState>((set, get) => ({
  entries: [],
  audit: [],
  total: 0,
  filters: DEFAULT_HISTORY_FILTERS,
  offset: 0,
  loading: false,
  loadingMore: false,
  error: null,
  hasMore: true,

  load: async () => {
    set({ loading: true, error: null, offset: 0 });
    try {
      const [entries, total] = await Promise.all([
        records.history(toQuery(get().filters, 0)),
        records.historyCount(),
      ]);
      set({
        entries,
        total,
        loading: false,
        offset: entries.length,
        hasMore: entries.length === PAGE_SIZE,
      });
    } catch (err) {
      set({ loading: false, error: errorText(err) });
    }
  },

  loadMore: async () => {
    const state = get();
    if (state.loadingMore || state.loading || !state.hasMore) return;
    set({ loadingMore: true });
    try {
      const more = await records.history(toQuery(state.filters, state.offset));
      set((prev) => ({
        entries: [...prev.entries, ...more],
        offset: prev.offset + more.length,
        hasMore: more.length === PAGE_SIZE,
        loadingMore: false,
      }));
    } catch (err) {
      set({ loadingMore: false, error: errorText(err) });
    }
  },

  setFilters: (patch) => {
    set((state) => ({ filters: { ...state.filters, ...patch } }));
    // Filtering runs in SQL, so it needs a round trip; debounce so a typed word
    // is one query rather than one per letter.
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void get().load(), 220);
  },

  clear: async (confirm) => {
    const removed = await records.clearHistory(confirm);
    set({ entries: [], total: 0, offset: 0, hasMore: false });
    void get().loadAudit();
    return removed;
  },

  loadAudit: async () => {
    try {
      set({ audit: await records.audit(50) });
    } catch {
      /* the audit strip is supplementary; history itself already reported */
    }
  },
}));
