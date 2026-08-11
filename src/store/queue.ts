/**
 * Queue state: the fetched page, the client-side view over it, video check
 * results, the bulk selection and the keyboard focus.
 *
 * Two layers of filtering exist on purpose. `filter` is sent to Speedrun.com and
 * costs a request; `search`, `videoFilter` and `onlyDuplicates` narrow what is
 * already loaded and cost nothing. Typing in the filter box must never trigger
 * network traffic.
 */

import { create } from 'zustand';

import { errorText, queue as queueIpc } from '../ipc';
import type { QueueFilter, RunSummary, VideoCheck, VideoStatus } from '../types';
import { isProblem, isUnverified } from '../types';
import { useSession } from './session';

export type VideoFilter = 'any' | 'ok' | 'problem' | 'unverified' | 'none';

export type SortKey = 'game' | 'category' | 'player' | 'time' | 'submitted' | 'status' | 'video';

export interface QueueColumn {
  id: SortKey;
  label: string;
  /** Grid track for this column. */
  width: string;
  align?: 'right';
}

/**
 * Column order and sizing. The select checkbox is not listed: it is structural
 * and cannot be hidden, because bulk moderation depends on it.
 */
export const QUEUE_COLUMNS: readonly QueueColumn[] = [
  { id: 'video', label: 'Video', width: '104px' },
  { id: 'game', label: 'Game', width: 'minmax(150px, 1.5fr)' },
  { id: 'category', label: 'Category', width: 'minmax(120px, 1.1fr)' },
  { id: 'player', label: 'Runner', width: 'minmax(110px, 1fr)' },
  { id: 'time', label: 'Time', width: '108px', align: 'right' },
  { id: 'submitted', label: 'Submitted', width: '124px' },
  { id: 'status', label: 'Status', width: '96px' },
];

/**
 * Severity order for collapsing several videos into one badge.
 *
 * The unverified statuses sit at the bottom: a run whose check merely failed
 * must not sort or display as though its video were gone.
 */
const STATUS_RANK: Record<VideoStatus, number> = {
  DELETED: 0,
  UNAVAILABLE: 1,
  INVALID_URL: 2,
  PRIVATE: 3,
  REGION_RESTRICTED: 4,
  PROCESSING: 5,
  AVAILABLE: 6,
  NETWORK_ERROR: 7,
  UNKNOWN: 8,
};

/** Worst status across a run's checks, or `null` when nothing is known yet. */
export function worstStatus(checks: VideoCheck[] | undefined): VideoStatus | null {
  if (!checks || checks.length === 0) return null;
  return checks.reduce<VideoStatus>(
    (worst, check) => (STATUS_RANK[check.status] < STATUS_RANK[worst] ? check.status : worst),
    checks[0]!.status,
  );
}

export const DEFAULT_FILTER: QueueFilter = {
  status: 'new',
  orderBy: 'submitted',
  ascending: true,
  onlyMyGames: true,
  limit: 200,
};

interface QueueState {
  filter: QueueFilter;
  runs: RunSummary[];
  duplicates: Record<string, string[]>;
  truncated: boolean;
  fetchedAt: string | null;
  loading: boolean;
  error: string | null;

  search: string;
  videoFilter: VideoFilter;
  onlyDuplicates: boolean;
  sortKey: SortKey | null;
  sortAsc: boolean;

  checks: Record<string, VideoCheck[]>;
  checking: boolean;
  checkProgress: { done: number; total: number };

  selected: Set<string>;
  focusIndex: number;

  load: (force?: boolean) => Promise<void>;
  setFilter: (patch: Partial<QueueFilter>) => Promise<void>;
  resetFilter: () => Promise<void>;
  setSearch: (value: string) => void;
  setVideoFilter: (value: VideoFilter) => void;
  setOnlyDuplicates: (value: boolean) => void;
  sortBy: (key: SortKey) => void;

  visible: () => RunSummary[];
  statusOf: (runId: string) => VideoStatus | null;
  checksOf: (runId: string) => VideoCheck[];
  duplicatesOf: (runId: string) => string[];
  runById: (runId: string) => RunSummary | undefined;

  checkVideos: (force?: boolean) => Promise<void>;
  applyChecks: (runId: string, checks: VideoCheck[]) => void;
  mergeRuns: (incoming: RunSummary[]) => number;

  toggleSelect: (runId: string) => void;
  selectRange: (runId: string) => void;
  selectAllVisible: () => void;
  clearSelection: () => void;
  selectedRuns: () => RunSummary[];

  focus: (index: number) => void;
  focusRun: (runId: string) => void;
  move: (delta: number) => RunSummary | null;
  focused: () => RunSummary | null;
  removeRuns: (ids: string[]) => void;
}

/** Text a run is matched against by the filter box. */
function haystack(run: RunSummary): string {
  return [
    run.gameName,
    run.categoryName,
    run.levelName,
    run.playerLabel,
    run.primaryDisplay,
    run.comment,
    run.platformName,
    run.regionName,
    run.id,
    ...run.variableLabels.map((v) => v.valueLabel),
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();
}

function matchesVideoFilter(
  run: RunSummary,
  status: VideoStatus | null,
  want: VideoFilter,
): boolean {
  switch (want) {
    case 'any':
      return true;
    case 'none':
      return run.videoUrls.length === 0;
    case 'problem':
      return status !== null && isProblem(status);
    case 'unverified':
      // A run with no check yet is unverified in exactly the sense meant here.
      return run.videoUrls.length > 0 && (status === null || isUnverified(status));
    case 'ok':
      return status === 'AVAILABLE';
  }
}

/** `null`s sort last regardless of direction: absent is not "smallest". */
function compareNullable<T>(
  a: T | null | undefined,
  b: T | null | undefined,
  compare: (x: T, y: T) => number,
): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return compare(a, b);
}

const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

function comparator(
  key: SortKey,
  statusOf: (runId: string) => VideoStatus | null,
): (a: RunSummary, b: RunSummary) => number {
  switch (key) {
    case 'game':
      return (a, b) => compareNullable(a.gameName, b.gameName, text);
    case 'category':
      return (a, b) => compareNullable(a.categoryName, b.categoryName, text);
    case 'player':
      return (a, b) => text(a.playerLabel, b.playerLabel);
    case 'time':
      return (a, b) => compareNullable(a.primarySeconds, b.primarySeconds, (x, y) => x - y);
    case 'submitted':
      return (a, b) => compareNullable(a.submitted, b.submitted, text);
    case 'status':
      return (a, b) => text(a.status, b.status);
    case 'video':
      return (a, b) => {
        const rank = (run: RunSummary) => {
          const status = statusOf(run.id);
          return status === null ? Number.MAX_SAFE_INTEGER : STATUS_RANK[status];
        };
        return rank(a) - rank(b);
      };
  }
}

/**
 * Memo for the derived list.
 *
 * `visible()` is read during render by a virtualised table, so it must not
 * re-filter and re-sort several hundred runs on every scroll frame. The cache is
 * keyed on identity of the inputs, so any real change still invalidates it.
 */
let memoKey: unknown[] = [];
let memoValue: RunSummary[] = [];

function memoise(key: unknown[], compute: () => RunSummary[]): RunSummary[] {
  if (key.length === memoKey.length && key.every((part, i) => part === memoKey[i])) {
    return memoValue;
  }
  memoKey = key;
  memoValue = compute();
  return memoValue;
}

export const useQueue = create<QueueState>((set, get) => ({
  filter: DEFAULT_FILTER,
  runs: [],
  duplicates: {},
  truncated: false,
  fetchedAt: null,
  loading: false,
  error: null,

  search: '',
  videoFilter: 'any',
  onlyDuplicates: false,
  sortKey: null,
  sortAsc: true,

  checks: {},
  checking: false,
  checkProgress: { done: 0, total: 0 },

  selected: new Set(),
  focusIndex: -1,

  load: async (force = false) => {
    if (get().loading && !force) return;
    const { settings, hasApiKey } = useSession.getState();
    if (!hasApiKey) {
      set({ runs: [], error: null, loading: false, fetchedAt: null });
      return;
    }

    const filter: QueueFilter = {
      ...get().filter,
      limit: get().filter.limit ?? settings.queueLimit,
      onlyMyGames: get().filter.onlyMyGames ?? settings.onlyMyGames,
    };

    set({ loading: true, error: null });
    try {
      const page = await queueIpc.get(filter);
      set({
        runs: page.runs,
        duplicates: page.duplicates,
        truncated: page.truncated,
        fetchedAt: page.fetchedAt,
        loading: false,
        // A run that is no longer in the page cannot stay selected or focused.
        selected: new Set([...get().selected].filter((id) => page.runs.some((r) => r.id === id))),
        focusIndex: page.runs.length > 0 ? 0 : -1,
      });
      if (settings.autoCheckVideos) void get().checkVideos(false);
    } catch (err) {
      set({ loading: false, error: errorText(err) });
    }
  },

  setFilter: async (patch) => {
    set((state) => ({ filter: { ...state.filter, ...patch } }));
    await get().load(true);
  },

  resetFilter: async () => {
    const { settings } = useSession.getState();
    set({
      filter: { ...DEFAULT_FILTER, limit: settings.queueLimit, onlyMyGames: settings.onlyMyGames },
      search: '',
      videoFilter: 'any',
      onlyDuplicates: false,
    });
    await get().load(true);
  },

  setSearch: (value) => set({ search: value }),
  setVideoFilter: (value) => set({ videoFilter: value }),
  setOnlyDuplicates: (value) => set({ onlyDuplicates: value }),

  sortBy: (key) =>
    set((state) =>
      state.sortKey === key
        ? state.sortAsc
          ? { sortAsc: false }
          : // Third click clears the sort and restores the server's order.
            { sortKey: null, sortAsc: true }
        : { sortKey: key, sortAsc: true },
    ),

  visible: () => {
    const state = get();
    return memoise(
      [
        state.runs,
        state.checks,
        state.duplicates,
        state.search,
        state.videoFilter,
        state.onlyDuplicates,
        state.sortKey,
        state.sortAsc,
      ],
      () => {
        const needle = state.search.trim().toLowerCase();
        const statusOf = (runId: string) => worstStatus(state.checks[runId]);

        let out = state.runs.filter((run) => {
          if (needle && !haystack(run).includes(needle)) return false;
          if (!matchesVideoFilter(run, statusOf(run.id), state.videoFilter)) return false;
          if (state.onlyDuplicates && (state.duplicates[run.id] ?? []).length === 0) return false;
          return true;
        });

        if (state.sortKey) {
          const compare = comparator(state.sortKey, statusOf);
          out = [...out].sort((a, b) => (state.sortAsc ? compare(a, b) : compare(b, a)));
        }
        return out;
      },
    );
  },

  statusOf: (runId) => worstStatus(get().checks[runId]),
  checksOf: (runId) => get().checks[runId] ?? [],
  duplicatesOf: (runId) => get().duplicates[runId] ?? [],
  runById: (runId) => get().runs.find((run) => run.id === runId),

  checkVideos: async (force = false) => {
    const state = get();
    if (state.checking) return;

    const pending = state.runs
      .filter((run) => run.videoUrls.length > 0)
      .filter((run) => force || state.checks[run.id] === undefined);
    if (pending.length === 0) return;

    set({ checking: true, checkProgress: { done: 0, total: pending.length } });

    // Batched rather than one request per run: the backend paces the provider
    // calls, and small batches let results appear while the rest are in flight.
    const BATCH = 25;
    try {
      for (let i = 0; i < pending.length; i += BATCH) {
        const slice = pending.slice(i, i + BATCH);
        const payload: Array<[string, string[]]> = slice.map((run) => [run.id, run.videoUrls]);
        try {
          const result = await queueIpc.checkBulk(payload, force);
          set((prev) => ({ checks: { ...prev.checks, ...result } }));
        } catch {
          // A failed batch leaves those runs unchecked, which the UI shows as
          // "Not checked". It must not be recorded as a video problem.
        }
        set({ checkProgress: { done: Math.min(i + BATCH, pending.length), total: pending.length } });
      }
    } finally {
      set({ checking: false, checkProgress: { done: 0, total: 0 } });
      void useSession.getState().refreshRateLimit();
    }
  },

  applyChecks: (runId, checks) =>
    set((state) => ({ checks: { ...state.checks, [runId]: checks } })),

  /**
   * Folds runs the watcher found into the loaded page, returning how many were
   * added.
   *
   * Without this a moderator watching the queue would be told about a run and
   * then have to refresh to see it, which defeats the point of polling every few
   * seconds. Runs that the current filter excludes are dropped rather than
   * inserted, so the list never contradicts the filter above it.
   */
  mergeRuns: (incoming) => {
    const state = get();
    const filter = state.filter;
    // The watcher only ever reports pending runs, so a queue showing verified or
    // rejected runs must not receive them.
    if ((filter.status ?? 'new') !== 'new') return 0;

    const known = new Set(state.runs.map((run) => run.id));
    const fresh = incoming.filter((run) => {
      if (known.has(run.id)) return false;
      if (filter.gameId && run.gameId !== filter.gameId) return false;
      if (filter.categoryId && run.categoryId !== filter.categoryId) return false;
      if (filter.levelId && run.levelId !== filter.levelId) return false;
      if (filter.platformId && run.platformId !== filter.platformId) return false;
      if (filter.regionId && run.regionId !== filter.regionId) return false;
      if (typeof filter.emulated === 'boolean' && run.emulated !== filter.emulated) return false;
      if (filter.userId && !run.players.some((p) => p.id === filter.userId)) return false;
      return true;
    });
    if (fresh.length === 0) return 0;

    // Appended, not prepended: the server order is by submission date ascending
    // by default, and `visible()` re-sorts anyway when a sort is active.
    const runs = filter.ascending === false ? [...fresh, ...state.runs] : [...state.runs, ...fresh];
    set({ runs });
    if (state.focusIndex < 0) set({ focusIndex: 0 });
    return fresh.length;
  },

  toggleSelect: (runId) =>
    set((state) => {
      const next = new Set(state.selected);
      if (!next.delete(runId)) next.add(runId);
      return { selected: next };
    }),

  selectRange: (runId) => {
    const state = get();
    const list = state.visible();
    const to = list.findIndex((run) => run.id === runId);
    if (to < 0) return;
    const from = state.focusIndex >= 0 && state.focusIndex < list.length ? state.focusIndex : to;
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    const next = new Set(state.selected);
    for (let i = lo; i <= hi; i += 1) {
      const run = list[i];
      if (run) next.add(run.id);
    }
    set({ selected: next, focusIndex: to });
  },

  selectAllVisible: () => set({ selected: new Set(get().visible().map((run) => run.id)) }),

  clearSelection: () => set({ selected: new Set() }),

  selectedRuns: () => {
    const state = get();
    // Ordered as displayed, so a bulk operation processes runs in the order the
    // moderator sees them.
    return state.visible().filter((run) => state.selected.has(run.id));
  },

  focus: (index) => {
    const list = get().visible();
    if (list.length === 0) {
      set({ focusIndex: -1 });
      return;
    }
    set({ focusIndex: Math.max(0, Math.min(index, list.length - 1)) });
  },

  focusRun: (runId) => {
    const index = get().visible().findIndex((run) => run.id === runId);
    if (index >= 0) set({ focusIndex: index });
  },

  move: (delta) => {
    const state = get();
    const list = state.visible();
    if (list.length === 0) {
      set({ focusIndex: -1 });
      return null;
    }
    const next = Math.max(0, Math.min(state.focusIndex + delta, list.length - 1));
    set({ focusIndex: next });
    return list[next] ?? null;
  },

  focused: () => {
    const state = get();
    const list = state.visible();
    if (state.focusIndex < 0 || state.focusIndex >= list.length) return null;
    return list[state.focusIndex] ?? null;
  },

  /**
   * Drops runs that have just been actioned.
   *
   * Removing them locally rather than refetching keeps the moderator's place in
   * a long queue; the next explicit refresh reconciles with the server.
   */
  removeRuns: (ids) =>
    set((state) => {
      const gone = new Set(ids);
      const runs = state.runs.filter((run) => !gone.has(run.id));
      const selected = new Set([...state.selected].filter((id) => !gone.has(id)));
      const duplicates = { ...state.duplicates };
      for (const id of gone) delete duplicates[id];
      const visibleCount = runs.length;
      return {
        runs,
        selected,
        duplicates,
        focusIndex: visibleCount === 0 ? -1 : Math.min(state.focusIndex, visibleCount - 1),
      };
    }),
}));
