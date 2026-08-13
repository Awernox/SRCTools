/**
 * Navigation and shell state.
 *
 * There is no router library: the app is a single window with a fixed set of
 * pages, and a hash-based router would only add a URL nobody can see. Panel
 * sizes live here too and are persisted through the `layout_*` commands so the
 * workspace comes back the way it was left.
 */

import { create } from 'zustand';

import { prefs } from '../ipc';

export type PageId =
  | 'dashboard'
  | 'queue'
  | 'games'
  | 'history'
  | 'stats'
  | 'settings';

// Page titles are not kept here: the top bar reads them from the `nav.*` keys
// in the catalogues, so there is one translated name per page rather than a
// second English-only copy that would silently stay English.

export interface LayoutSizes {
  /** Width of the queue table pane, as a fraction of the split. */
  queueSplit: number;
  /** Height of the detail panel's video area, in pixels. */
  detailVideoHeight: number;
  sidebarCollapsed: boolean;
}

const DEFAULT_LAYOUT: LayoutSizes = {
  queueSplit: 0.58,
  detailVideoHeight: 260,
  sidebarCollapsed: false,
};

const LAYOUT_KEY = 'workspace';

interface AppState {
  page: PageId;
  /** Run shown in the detail panel, or `null` when it is closed. */
  detailRunId: string | null;
  fastReview: boolean;
  paletteOpen: boolean;
  helpOpen: boolean;
  /** Game id the Games page is showing, or `null` for the list. */
  gameId: string | null;

  layout: LayoutSizes;
  layoutLoaded: boolean;

  go: (page: PageId) => void;
  openDetail: (runId: string) => void;
  closeDetail: () => void;
  setFastReview: (on: boolean) => void;
  togglePalette: (open?: boolean) => void;
  toggleHelp: (open?: boolean) => void;
  openGame: (gameId: string | null) => void;

  loadLayout: () => Promise<void>;
  setLayout: (patch: Partial<LayoutSizes>) => void;
}

let saveTimer: number | undefined;

/**
 * Persists the layout after the user stops dragging.
 *
 * A resize fires on every animation frame; writing each one would put hundreds
 * of transactions through SQLite for a single drag.
 */
function scheduleSave(layout: LayoutSizes) {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void prefs.layoutSet(LAYOUT_KEY, JSON.stringify(layout)).catch(() => {
      /* a lost layout is not worth interrupting the moderator for */
    });
  }, 400);
}

export const useApp = create<AppState>((set, get) => ({
  page: 'dashboard',
  detailRunId: null,
  fastReview: false,
  paletteOpen: false,
  helpOpen: false,
  gameId: null,

  layout: DEFAULT_LAYOUT,
  layoutLoaded: false,

  go: (page) =>
    set((state) => ({
      page,
      // Leaving the queue closes Fast Review: it binds single keys to
      // irreversible actions, and it must not stay armed on another page.
      fastReview: page === 'queue' ? state.fastReview : false,
      paletteOpen: false,
    })),

  openDetail: (runId) => set({ detailRunId: runId }),
  closeDetail: () => set({ detailRunId: null }),
  setFastReview: (on) => set({ fastReview: on }),
  togglePalette: (open) => set((state) => ({ paletteOpen: open ?? !state.paletteOpen })),
  toggleHelp: (open) => set((state) => ({ helpOpen: open ?? !state.helpOpen })),
  openGame: (gameId) => set({ gameId, page: 'games' }),

  loadLayout: async () => {
    try {
      const stored = await prefs.layoutGet(LAYOUT_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          const raw = parsed as Partial<LayoutSizes>;
          set({
            layout: {
              queueSplit:
                typeof raw.queueSplit === 'number' && raw.queueSplit > 0.15 && raw.queueSplit < 0.9
                  ? raw.queueSplit
                  : DEFAULT_LAYOUT.queueSplit,
              detailVideoHeight:
                typeof raw.detailVideoHeight === 'number' && raw.detailVideoHeight >= 120
                  ? raw.detailVideoHeight
                  : DEFAULT_LAYOUT.detailVideoHeight,
              sidebarCollapsed: raw.sidebarCollapsed === true,
            },
          });
        }
      }
    } catch {
      /* a corrupt layout falls back to the default rather than blocking boot */
    } finally {
      set({ layoutLoaded: true });
    }
  },

  setLayout: (patch) => {
    const layout = { ...get().layout, ...patch };
    set({ layout });
    scheduleSave(layout);
  },
}));
