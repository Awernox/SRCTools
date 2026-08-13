/**
 * Session state: identity, connection, preferences, favourites, templates and
 * shortcut bindings.
 *
 * Everything the shell needs before any page renders lives here, so a page can
 * assume settings are loaded rather than each one re-fetching them.
 */

import { create } from 'zustand';

import { auth, errorText, library, prefs } from '../ipc';
import type {
  ConnectionStatus,
  FavoriteGame,
  GameSummary,
  Profile,
  RejectionTemplate,
  StartupReport,
} from '../types';
import { DEFAULT_BINDINGS, type ShortcutAction } from '../shortcuts';
import {
  DEFAULT_CUSTOM_ACCENT,
  applyAppearance,
  isAccentName,
  isDensity,
  isThemeName,
  type AccentName,
  type Density,
  type ThemeName,
} from '../theme';
import {
  DEFAULT_LANGUAGE,
  detectLanguage,
  isLanguage,
  setLanguage,
  type Language,
} from '../i18n';
import { isCheckInterval, type CheckInterval } from '../watcher/intervals';

export type { ThemeName, Density, AccentName };

export type SidebarPosition = 'left' | 'right';

/** Preferences with a UI effect. Stored one JSON value per key. */
export interface Settings {
  /** Interface language. `null` is never stored — `init` resolves the OS locale. */
  language: Language;

  theme: ThemeName;
  /** Accent preset, or `custom` to use `customAccent`. */
  accent: AccentName;
  /** The custom accent as `#rrggbb`. Kept even while a preset is selected. */
  customAccent: string;
  density: Density;
  /** Show icons in the sidebar. At least one of icons/labels stays on. */
  sidebarIcons: boolean;
  /** Show labels in the sidebar. */
  sidebarText: boolean;
  sidebarPosition: SidebarPosition;

  /** Ask before verifying. Rejection and deletion always confirm. */
  confirmVerify: boolean;
  /** Seconds Fast Review pauses on the result before showing the next run. */
  fastReviewDelay: number;
  /** Check videos automatically when the queue loads. */
  autoCheckVideos: boolean;
  /** Self-imposed request budget, requests per minute. */
  rateLimit: number;
  /** Runs fetched per queue refresh. */
  queueLimit: number;
  /** Restrict the queue to games the signed-in user moderates. */
  onlyMyGames: boolean;
  /** Columns hidden in the queue table, by column id. */
  hiddenColumns: string[];
  /** Show the analysis panel expanded by default. */
  expandAnalysis: boolean;

  /** Watch for new pending runs and notify. Drives the watcher itself. */
  notifyNewRuns: boolean;
  /** Notify when a newly seen run's video is unwatchable. */
  notifyVideoProblems: boolean;
  /** Notify when the API stops answering, and again when it recovers. */
  notifyApiErrors: boolean;
  /** Desktop notification when a bulk operation finishes. */
  notifyOnBulkComplete: boolean;
  /** Play a sound with notifications. */
  soundEnabled: boolean;
  /** Notification volume, 0..1. */
  soundVolume: number;
  /** Seconds between watcher polls. Honoured whatever the window is doing. */
  checkInterval: CheckInterval;

  /**
   * File name of the moderator's own notification sound, or `''` for the bundled
   * one. A label only — the sound itself is a copy in the app's data directory,
   * and that copy is what decides which sound plays.
   */
  customSoundName: string;

  /** Publish a Discord Rich Presence. */
  discordEnabled: boolean;
  /** Discord application id supplying the artwork. Empty means not configured. */
  discordAppId: string;
  discordShowPage: boolean;
  discordShowPending: boolean;
  discordShowGame: boolean;
  discordShowModerator: boolean;

  /**
   * Master switch for webhook posts. The URL itself lives in the credential
   * vault, not here — this only decides whether the saved one is used.
   */
  webhookEnabled: boolean;
  /** Post a webhook embed for each event type. */
  webhookNewRuns: boolean;
  webhookApproved: boolean;
  webhookRejected: boolean;
  webhookDeletedVideos: boolean;
  webhookVideoProblems: boolean;

  /**
   * True while the webhook posts about every moderated game.
   *
   * Kept separate from an empty [`webhookGames`] so that each game's switch
   * means exactly one thing: green posts, gray does not. Without it, "no games
   * selected" would have to mean *all* games, and a row of gray switches would
   * read as the opposite of what it does.
   */
  webhookAllGames: boolean;

  /**
   * Game ids whose runs get a webhook embed, used when [`webhookAllGames`] is
   * off. A game not in this list is a game the moderator switched off.
   */
  webhookGames: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  language: DEFAULT_LANGUAGE,

  theme: 'dark',
  accent: 'purple',
  customAccent: DEFAULT_CUSTOM_ACCENT,
  density: 'comfortable',
  sidebarIcons: true,
  sidebarText: false,
  sidebarPosition: 'left',

  confirmVerify: true,
  fastReviewDelay: 0,
  autoCheckVideos: true,
  rateLimit: 60,
  queueLimit: 200,
  onlyMyGames: true,
  hiddenColumns: [],
  expandAnalysis: true,

  notifyNewRuns: true,
  notifyVideoProblems: true,
  notifyApiErrors: true,
  notifyOnBulkComplete: true,
  soundEnabled: true,
  soundVolume: 0.6,
  checkInterval: 5,
  customSoundName: '',

  discordEnabled: false,
  discordAppId: '',
  discordShowPage: true,
  discordShowPending: true,
  discordShowGame: true,
  // Off by default: the other three describe what SRCTools is doing, this one
  // names the moderator to everyone on the Discord friends list. That is a fine
  // thing to opt into and a poor thing to be opted into.
  discordShowModerator: false,

  // The webhook is off until a URL is saved. The event toggles start on so
  // that switching it on posts something rather than nothing; narrowing them
  // afterwards is the obvious next step, guessing which one was meant is not.
  webhookEnabled: false,
  webhookNewRuns: true,
  webhookApproved: true,
  webhookRejected: true,
  webhookDeletedVideos: true,
  webhookVideoProblems: true,
  // On: an untouched install posts about every game the event toggles allow,
  // rather than silently nothing. Switching it off reveals the per-game list.
  webhookAllGames: true,
  webhookGames: [],
};

/**
 * Extra validation for the settings whose type is narrower than `typeof`.
 *
 * `readSetting` only compares `typeof` against the default, which would let a
 * stale `"comfy"` density or a removed accent name through and leave the UI
 * painting from a value no code handles.
 */
const GUARDS: { [K in keyof Settings]?: (value: unknown) => boolean } = {
  language: isLanguage,
  theme: isThemeName,
  accent: isAccentName,
  density: isDensity,
  sidebarPosition: (v) => v === 'left' || v === 'right',
  checkInterval: isCheckInterval,
  customAccent: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
  soundVolume: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
  hiddenColumns: (v) => Array.isArray(v) && v.every((c) => typeof c === 'string'),
  webhookGames: (v) => Array.isArray(v) && v.every((c) => typeof c === 'string'),
};

interface SessionState {
  ready: boolean;
  startup: StartupReport | null;

  profile: Profile | null;
  connection: ConnectionStatus | null;
  hasApiKey: boolean;
  /** True while the first identity resolution is still in flight. */
  authLoading: boolean;

  settings: Settings;
  shortcuts: Record<string, string>;
  templates: RejectionTemplate[];
  favorites: FavoriteGame[];
  games: GameSummary[];
  gamesLoading: boolean;
  gamesError: string | null;

  rateLimit: { used: number; capacity: number };

  init: () => Promise<void>;
  setStartup: (report: StartupReport) => void;
  setProfile: (profile: Profile | null) => void;
  refreshConnection: () => Promise<void>;
  refreshGames: () => Promise<void>;
  refreshRateLimit: () => Promise<void>;

  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<void>;
  binding: (action: ShortcutAction) => string;
  setShortcut: (action: string, binding: string) => Promise<void>;
  resetShortcuts: () => Promise<void>;
  refreshTemplates: () => Promise<void>;
  refreshFavorites: () => Promise<void>;
}

/** Reads one stored setting, falling back to the default on anything odd. */
function readSetting<K extends keyof Settings>(
  raw: Record<string, string>,
  key: K,
): Settings[K] {
  const stored = raw[key as string];
  if (stored === undefined) return DEFAULT_SETTINGS[key];
  try {
    const parsed: unknown = JSON.parse(stored);
    // A value written by an older build could be the wrong shape; the default
    // is always safe, so a mismatch is silently ignored rather than thrown.
    if (typeof parsed !== typeof DEFAULT_SETTINGS[key]) {
      if (!Array.isArray(parsed) || !Array.isArray(DEFAULT_SETTINGS[key])) {
        return DEFAULT_SETTINGS[key];
      }
    }
    const guard = GUARDS[key];
    if (guard && !guard(parsed)) return DEFAULT_SETTINGS[key];
    return parsed as Settings[K];
  } catch {
    return DEFAULT_SETTINGS[key];
  }
}

/** Pushes the four appearance settings at the DOM in one go. */
function applyAppearanceFrom(settings: Settings): void {
  applyAppearance({
    theme: settings.theme,
    accent: settings.accent,
    customAccent: settings.customAccent,
    density: settings.density,
  });
}

const APPEARANCE_KEYS = new Set<keyof Settings>([
  'theme',
  'accent',
  'customAccent',
  'density',
]);

export const useSession = create<SessionState>((set, get) => ({
  ready: false,
  startup: null,

  profile: null,
  connection: null,
  hasApiKey: false,
  authLoading: true,

  settings: DEFAULT_SETTINGS,
  shortcuts: {},
  templates: [],
  favorites: [],
  games: [],
  gamesLoading: false,
  gamesError: null,

  rateLimit: { used: 0, capacity: 60 },

  init: async () => {
    // Local reads first: they cannot fail on a missing network, so the shell
    // paints correctly even when Speedrun.com is unreachable.
    const [settingsRaw, shortcuts, templates, favorites] = await Promise.all([
      prefs.settingsAll().catch(() => ({}) as Record<string, string>),
      prefs.shortcuts().catch(() => ({})),
      prefs.templates().catch(() => []),
      prefs.favorites().catch(() => []),
    ]);

    const settings: Settings = {
      // Nothing stored yet means a first run: the OS locale is a better guess
      // than English, and it is written back so the choice stops being a guess.
      language: settingsRaw['language'] === undefined
        ? detectLanguage()
        : readSetting(settingsRaw, 'language'),

      theme: readSetting(settingsRaw, 'theme'),
      accent: readSetting(settingsRaw, 'accent'),
      customAccent: readSetting(settingsRaw, 'customAccent'),
      density: readSetting(settingsRaw, 'density'),
      sidebarIcons: readSetting(settingsRaw, 'sidebarIcons'),
      // Start narrow every time. The moderator can expand labels for the current
      // session from either the top bar or this preference.
      sidebarText: false,
      sidebarPosition: readSetting(settingsRaw, 'sidebarPosition'),

      confirmVerify: readSetting(settingsRaw, 'confirmVerify'),
      fastReviewDelay: readSetting(settingsRaw, 'fastReviewDelay'),
      autoCheckVideos: readSetting(settingsRaw, 'autoCheckVideos'),
      rateLimit: readSetting(settingsRaw, 'rateLimit'),
      queueLimit: readSetting(settingsRaw, 'queueLimit'),
      onlyMyGames: readSetting(settingsRaw, 'onlyMyGames'),
      hiddenColumns: readSetting(settingsRaw, 'hiddenColumns'),
      expandAnalysis: readSetting(settingsRaw, 'expandAnalysis'),

      notifyNewRuns: readSetting(settingsRaw, 'notifyNewRuns'),
      notifyVideoProblems: readSetting(settingsRaw, 'notifyVideoProblems'),
      notifyApiErrors: readSetting(settingsRaw, 'notifyApiErrors'),
      notifyOnBulkComplete: readSetting(settingsRaw, 'notifyOnBulkComplete'),
      soundEnabled: readSetting(settingsRaw, 'soundEnabled'),
      soundVolume: readSetting(settingsRaw, 'soundVolume'),
      checkInterval: readSetting(settingsRaw, 'checkInterval'),
      customSoundName: readSetting(settingsRaw, 'customSoundName'),

      discordEnabled: readSetting(settingsRaw, 'discordEnabled'),
      discordAppId: readSetting(settingsRaw, 'discordAppId'),
      discordShowPage: readSetting(settingsRaw, 'discordShowPage'),
      discordShowPending: readSetting(settingsRaw, 'discordShowPending'),
      discordShowGame: readSetting(settingsRaw, 'discordShowGame'),
      discordShowModerator: readSetting(settingsRaw, 'discordShowModerator'),

      webhookEnabled: readSetting(settingsRaw, 'webhookEnabled'),
      webhookNewRuns: readSetting(settingsRaw, 'webhookNewRuns'),
      webhookApproved: readSetting(settingsRaw, 'webhookApproved'),
      webhookRejected: readSetting(settingsRaw, 'webhookRejected'),
      webhookDeletedVideos: readSetting(settingsRaw, 'webhookDeletedVideos'),
      webhookVideoProblems: readSetting(settingsRaw, 'webhookVideoProblems'),
      webhookAllGames: readSetting(settingsRaw, 'webhookAllGames'),
      webhookGames: readSetting(settingsRaw, 'webhookGames'),
    };

    applyAppearanceFrom(settings);
    setLanguage(settings.language);
    // Both `sidebarIcons` and `sidebarText` off would leave an unusable strip of
    // empty buttons, which a hand-edited database could produce.
    if (!settings.sidebarIcons && !settings.sidebarText) settings.sidebarIcons = true;

    set({ settings, shortcuts, templates, favorites, ready: true });

    if (settingsRaw['language'] === undefined) {
      void prefs.settingSet('language', JSON.stringify(settings.language)).catch(() => {});
    }

    // Identity next. A missing key is a state, not an error.
    try {
      const profile = await auth.getProfile();
      set({ profile, hasApiKey: profile !== null, authLoading: false });
      if (profile) void get().refreshGames();
    } catch {
      set({ authLoading: false });
    }

    void get().refreshRateLimit();
  },

  setStartup: (report) => set({ startup: report, hasApiKey: report.hasApiKey }),

  setProfile: (profile) => {
    set({ profile, hasApiKey: profile !== null });
    if (profile) void get().refreshGames();
    else set({ games: [] });
  },

  refreshConnection: async () => {
    try {
      const connection = await auth.testConnection();
      set({
        connection,
        profile: connection.profile,
        hasApiKey: connection.maskedKey !== null,
        rateLimit: { used: connection.rateLimitUsed, capacity: connection.rateLimitCapacity },
      });
    } catch {
      // `test_connection` only rejects when the credential vault itself is
      // broken; the settings page shows that through `startup.warnings`.
      set({ connection: null });
    }
  },

  refreshGames: async () => {
    if (get().gamesLoading) return;
    if (!get().hasApiKey) {
      set({ games: [], gamesError: null });
      return;
    }
    set({ gamesLoading: true, gamesError: null });
    try {
      const games = await library.moderatedGames();
      set({ games, gamesLoading: false });
    } catch (err) {
      set({ gamesLoading: false, gamesError: errorText(err) });
    }
  },

  refreshRateLimit: async () => {
    try {
      const [used, capacity] = await auth.rateLimitStatus();
      set({ rateLimit: { used, capacity } });
    } catch {
      /* the status bar simply keeps its last reading */
    }
  },

  updateSetting: async (key, value) => {
    set((state) => ({ settings: { ...state.settings, [key]: value } }));

    if (APPEARANCE_KEYS.has(key)) applyAppearanceFrom(get().settings);
    if (key === 'language') setLanguage(value as Language);

    // The rate limit has a backend effect, so it goes through its own command.
    if (key === 'rateLimit') {
      const applied = await prefs.setRateLimit(value as number);
      if (applied !== value) {
        set((state) => ({ settings: { ...state.settings, rateLimit: applied } }));
      }
      void get().refreshRateLimit();
      return;
    }
    await prefs.settingSet(key as string, JSON.stringify(value));
  },

  binding: (action) => get().shortcuts[action] ?? DEFAULT_BINDINGS[action],

  setShortcut: async (action, binding) => {
    const shortcuts = await prefs.setShortcut(action, binding);
    set({ shortcuts });
  },

  resetShortcuts: async () => {
    const shortcuts = await prefs.resetShortcuts();
    set({ shortcuts });
  },

  refreshTemplates: async () => {
    try {
      set({ templates: await prefs.templates() });
    } catch {
      /* the rejection dialog falls back to free text */
    }
  },

  refreshFavorites: async () => {
    try {
      set({ favorites: await prefs.favorites() });
    } catch {
      /* the sidebar simply shows no pinned games */
    }
  },
}));
