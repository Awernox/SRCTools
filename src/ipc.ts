/**
 * The only place `invoke` is called.
 *
 * Two things happen here that the rest of the app then never has to think about:
 *
 * 1. **Errors arrive typed.** Rust serialises every failure as
 *    `{kind, message, retryable, hint}`; a rejected promise from Tauri carries
 *    that object, not an `Error`. `call` normalises anything else into the same
 *    shape so `catch` blocks can rely on it.
 * 2. **Argument names are checked at compile time.** Tauri 2 converts a command's
 *    snake_case Rust parameters to camelCase on the JS side, so the wrappers
 *    below are the single record of what each command actually expects.
 */

import { invoke } from '@tauri-apps/api/core';

import { t } from './i18n';

import type {
  AppError,
  AuditEntry,
  CacheStats,
  CategoryInfo,
  ConnectionStatus,
  DashboardSummary,
  ExportPayload,
  FavoriteGame,
  GameInfo,
  GameSummary,
  HistoryEntry,
  HistoryQuery,
  LeaderboardEntry,
  Level,
  ModerationStats,
  Platform,
  Profile,
  QueueFilter,
  QueuePage,
  RejectionTemplate,
  Region,
  RunDetail,
  RunSummary,
  ActionTarget,
  BulkResult,
  VideoCheck,
  VideoStatus,
  Variable,
  WatchReport,
} from './types';

/** True when `value` is the error shape Rust produces. */
export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'message' in value &&
    typeof (value as AppError).message === 'string'
  );
}

/**
 * Coerces anything thrown into an `AppError`.
 *
 * A thrown string or DOM exception would otherwise reach a toast as
 * "[object Object]"; this keeps every failure presentable.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    return { kind: 'internal', message: value.message, retryable: false, hint: null };
  }
  if (typeof value === 'string' && value.trim()) {
    return { kind: 'internal', message: value, retryable: false, hint: null };
  }
  return {
    kind: 'internal',
    message: t('error.unreported'),
    retryable: false,
    hint: null,
  };
}

/** Convenience for rendering: message plus hint, when there is one. */
export function errorText(value: unknown): string {
  const err = toAppError(value);
  return err.hint ? `${err.message} ${err.hint}` : err.message;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    throw toAppError(raw);
  }
}

// ---------------------------------------------------------------------------
// Credentials and identity
// ---------------------------------------------------------------------------

export const auth = {
  /** Validates the key against `GET /profile` before storing it. */
  setApiKey: (key: string) => call<Profile>('set_api_key', { key }),
  clearApiKey: () => call<void>('clear_api_key'),
  hasApiKey: () => call<boolean>('has_api_key'),
  /** `null` when no key is configured — the expected first-launch state. */
  getProfile: () => call<Profile | null>('get_profile'),
  testConnection: () => call<ConnectionStatus>('test_connection'),
  setTwitchCredentials: (clientId: string, clientSecret: string) =>
    call<boolean>('set_twitch_credentials', { clientId, clientSecret }),
  clearTwitchCredentials: () => call<void>('clear_twitch_credentials'),
  hasTwitchCredentials: () => call<boolean>('has_twitch_credentials'),
  /** `[used, capacity]` in the current sliding window. */
  rateLimitStatus: () => call<[number, number]>('rate_limit_status'),
  lookupUser: (name: string) => call<Profile | null>('lookup_user', { name }),
};

// ---------------------------------------------------------------------------
// Queue, run detail and video verification
// ---------------------------------------------------------------------------

export const queue = {
  get: (filter: QueueFilter) => call<QueuePage>('get_queue', { filter }),
  runDetail: (runId: string, refreshVideos = false) =>
    call<RunDetail>('get_run_detail', { runId, refreshVideos }),
  recheckVideos: (runId: string) => call<VideoCheck[]>('recheck_videos', { runId }),
  checkUrl: (url: string) => call<VideoCheck>('check_video_url', { url }),
  /** `runs` is `[runId, urls][]`; the result maps run id → checks. */
  checkBulk: (runs: Array<[string, string[]]>, force = false) =>
    call<Record<string, VideoCheck[]>>('check_videos_bulk', { runs, force }),
  /** Worst status across a run's videos, or `null` when it has none. */
  statusFor: (urls: string[]) => call<VideoStatus | null>('video_status_for', { urls }),
  /**
   * One watcher poll: the newest pending runs in the moderator's games.
   *
   * Deliberately not `get`: that issues a request per moderated game, which a
   * five-second poll cannot afford. This is always a single request.
   */
  watch: (limit = 100) => call<WatchReport>('watch_new_runs', { limit }),
  dashboard: () => call<DashboardSummary>('get_dashboard'),
};

// ---------------------------------------------------------------------------
// Moderation — the only calls that change Speedrun.com
// ---------------------------------------------------------------------------

export const moderation = {
  verify: (target: ActionTarget) => call<string>('verify_run', { target }),
  /** The reason is mandatory and validated before any request is issued. */
  reject: (target: ActionTarget, reason: string) =>
    call<string>('reject_run', { target, reason }),
  /** `confirm` must be true; there is no default on either side of the bridge. */
  delete: (target: ActionTarget, confirm: boolean) =>
    call<string>('delete_run', { target, confirm }),
  bulk: (
    action: 'verify' | 'reject' | 'delete',
    targets: ActionTarget[],
    reason?: string | null,
    confirm = false,
  ) => call<BulkResult>('bulk_moderate', { action, targets, reason: reason ?? null, confirm }),
  /** Asks a running batch to stop after the run in flight. */
  cancelBulk: (batchId: string) => call<void>('cancel_bulk', { batchId }),
  retryFailed: (
    action: 'verify' | 'reject' | 'delete',
    targets: ActionTarget[],
    reason?: string | null,
    confirm = false,
  ) => call<BulkResult>('retry_failed', { action, targets, reason: reason ?? null, confirm }),
};

// ---------------------------------------------------------------------------
// Game library
// ---------------------------------------------------------------------------

export const library = {
  moderatedGames: () => call<GameSummary[]>('list_moderated_games'),
  game: (gameId: string) => call<GameInfo>('get_game', { gameId }),
  categories: (gameId: string) => call<CategoryInfo[]>('get_categories', { gameId }),
  variables: (gameId: string) => call<Variable[]>('get_variables', { gameId }),
  levels: (gameId: string) => call<Level[]>('get_levels', { gameId }),
  searchGames: (query: string, limit = 20) =>
    call<GameSummary[]>('search_games', { query, limit }),
  leaderboard: (
    gameId: string,
    categoryId: string,
    variableFilters: Array<[string, string]> = [],
    top = 10,
  ) => call<LeaderboardEntry[]>('get_leaderboard', { gameId, categoryId, variableFilters, top }),
  platforms: () => call<Platform[]>('get_platforms'),
  regions: () => call<Region[]>('get_regions'),
};

// ---------------------------------------------------------------------------
// Local records
// ---------------------------------------------------------------------------

export const records = {
  history: (query?: HistoryQuery) => call<HistoryEntry[]>('history_list', { query: query ?? null }),
  historyCount: () => call<number>('history_count'),
  historyForRun: (runId: string) => call<HistoryEntry | null>('history_for_run', { runId }),
  /** Local only: the runs stay verified or rejected on Speedrun.com. */
  clearHistory: (confirm: boolean) => call<number>('history_clear', { confirm }),
  audit: (limit = 100) => call<AuditEntry[]>('audit_list', { limit }),
  stats: (days = 30) => call<ModerationStats>('moderation_stats', { days }),
  exportHistory: (format: 'csv' | 'json', query?: HistoryQuery) =>
    call<ExportPayload>('export_history', { format, query: query ?? null }),
  exportRuns: (format: 'csv' | 'json', runs: RunSummary[]) =>
    call<ExportPayload>('export_runs', { format, runs }),
  exportStats: (days = 30) => call<ExportPayload>('export_stats', { days }),
  /** `path` must come from the save dialog; returns bytes written. */
  writeExport: (path: string, content: string) =>
    call<number>('write_export', { path, content }),
};

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export const prefs = {
  settingsAll: () => call<Record<string, string>>('settings_all'),
  settingGet: (key: string) => call<string | null>('setting_get', { key }),
  /** `value` must be JSON; the backend rejects anything else. */
  settingSet: (key: string, value: string) => call<void>('setting_set', { key, value }),
  settingDelete: (key: string) => call<void>('setting_delete', { key }),
  /** Returns the value actually applied, which may have been clamped. */
  setRateLimit: (requestsPerMinute: number) =>
    call<number>('set_rate_limit', { requestsPerMinute }),

  templates: () => call<RejectionTemplate[]>('templates_list'),
  saveTemplate: (label: string, body: string, id?: string | null, sortOrder?: number | null) =>
    call<RejectionTemplate>('template_save', {
      id: id ?? null,
      label,
      body,
      sortOrder: sortOrder ?? null,
    }),
  deleteTemplate: (id: string) => call<void>('template_delete', { id }),
  restoreTemplates: () => call<RejectionTemplate[]>('templates_restore_builtins'),
  reorderTemplates: (idsInOrder: string[]) => call<void>('templates_reorder', { idsInOrder }),

  favorites: () => call<FavoriteGame[]>('favorites_list'),
  addFavorite: (gameId: string, name: string, abbrev?: string | null, coverUrl?: string | null) =>
    call<FavoriteGame[]>('favorite_add', {
      gameId,
      name,
      abbrev: abbrev ?? null,
      coverUrl: coverUrl ?? null,
    }),
  removeFavorite: (gameId: string) => call<FavoriteGame[]>('favorite_remove', { gameId }),
  reorderFavorites: (idsInOrder: string[]) => call<void>('favorites_reorder', { idsInOrder }),

  layoutGet: (name: string) => call<string | null>('layout_get', { name }),
  layoutSet: (name: string, payload: string) => call<void>('layout_set', { name, payload }),
  layoutDelete: (name: string) => call<void>('layout_delete', { name }),

  /** Customised bindings only; the frontend merges these over its defaults. */
  shortcuts: () => call<Record<string, string>>('shortcuts_all'),
  setShortcut: (action: string, binding: string) =>
    call<Record<string, string>>('shortcut_set', { action, binding }),
  resetShortcuts: () => call<Record<string, string>>('shortcuts_reset'),

  cacheStats: () => call<CacheStats>('cache_stats'),
  cachePrune: () => call<number>('cache_prune'),
  cacheClear: () => call<number>('cache_clear'),
  cacheInvalidate: (kind: string) => call<number>('cache_invalidate', { kind }),
  forgetVideoCheck: (url: string) => call<void>('forget_video_check', { url }),
  databasePath: () => call<string>('database_path'),
};

// ---------------------------------------------------------------------------
// Desktop notifications
// ---------------------------------------------------------------------------

/** Where clicking a notification should take the moderator. */
export interface NotificationAction {
  page: string;
  runId?: string | null;
}

export const notifications = {
  /**
   * Shows a Windows toast. `action` makes it clickable.
   *
   * This does not go through `@tauri-apps/plugin-notification`: that plugin's
   * desktop path discards the activation callback, so its notifications cannot
   * report a click. The Rust side builds the toast itself and emits
   * `srctools://notification-activated` when it is clicked.
   */
  show: (title: string, body: string, action?: NotificationAction | null) =>
    call<void>('notify_desktop', { title, body, action: action ?? null }),
};

// ---------------------------------------------------------------------------
// The custom notification sound
// ---------------------------------------------------------------------------

/** A sound file the moderator supplied, after it has been copied into the profile. */
export interface CustomSound {
  /** Absolute path of SRCTools' own copy. Shown nowhere; used to tell "set" from "not set". */
  path: string;
  /** The original file name, for the "using X" line. */
  name: string;
  bytes: number;
}

export const sound = {
  /**
   * Copies a chosen file into the app's data directory and returns what was
   * stored. `source` must come from the file dialog.
   *
   * The copy is deliberate: referencing the file where it sits would break as
   * soon as it moved, and would mean storing a machine-specific absolute path.
   */
  import: (source: string) => call<CustomSound>('sound_import', { source }),
  /** The stored sound as base64, or `null` when the bundled one is in use. */
  load: () => call<string | null>('sound_load'),
  clear: () => call<void>('sound_clear'),
};

// ---------------------------------------------------------------------------
// The new-run watcher
// ---------------------------------------------------------------------------

/** State of the background poll loop, as the status bar renders it. */
export interface WatcherStatus {
  enabled: boolean;
  /** True once a cycle has established what "already known" means. */
  primed: boolean;
  /** ISO-8601 timestamp of the last completed cycle. */
  lastCheck: string | null;
  /** Why the last cycle failed; `null` when nothing has gone wrong. */
  lastError: string | null;
  failures: number;
  /** The cadence actually in use, after clamping. */
  intervalSecs: number;
  scopedGames: number;
}

/** Payload of `srctools://new-runs`. */
export interface NewRunsEvent {
  runs: RunSummary[];
  fetchedAt: string;
  scopedGames: number;
}

export const watcher = {
  /**
   * Applies the watcher settings.
   *
   * The loop lives on the Rust side on purpose: a webview timer is throttled to
   * roughly once a minute once the window is hidden, which is exactly when a
   * moderator is waiting to hear about a run. Here the interval is the interval.
   */
  configure: (enabled: boolean, intervalSecs: number) =>
    call<WatcherStatus>('watcher_configure', { config: { enabled, intervalSecs } }),
  status: () => call<WatcherStatus>('watcher_status'),
  /** Runs a cycle now, without disturbing the cadence. */
  pollNow: () => call<WatcherStatus>('watcher_poll_now'),
  /** Forgets the baseline, so a changed account does not inherit the old one. */
  reprime: () => call<void>('watcher_reprime'),
};

// ---------------------------------------------------------------------------
// Discord Rich Presence
// ---------------------------------------------------------------------------

/** Connection state of the presence worker. */
export interface DiscordStatus {
  enabled: boolean;
  connected: boolean;
  /** Why the last attempt failed; `null` when nothing has gone wrong. */
  lastError: string | null;
}

/** The two lines Discord renders under the app name. */
export interface DiscordPresence {
  /** "Details" — the current page, e.g. `Review Queue`. */
  details?: string | null;
  /** "State" — e.g. `4 pending runs`. */
  state?: string | null;
}

export const discord = {
  /**
   * Applies the presence settings. Connecting happens on a background thread,
   * so the returned status is what is true right now; the outcome arrives as a
   * `srctools://discord` event.
   */
  configure: (enabled: boolean, appId: string) =>
    call<DiscordStatus>('discord_configure', { enabled, appId }),
  /** Cheap: updates are coalesced and rate-limited on the Rust side. */
  publish: (presence: DiscordPresence) =>
    call<void>('discord_publish', {
      presence: { details: presence.details ?? null, state: presence.state ?? null },
    }),
  reconnect: () => call<DiscordStatus>('discord_reconnect'),
  status: () => call<DiscordStatus>('discord_status'),
};

// ---------------------------------------------------------------------------
// Discord webhook
// ---------------------------------------------------------------------------

/** What Settings may know about the saved webhook — never the URL itself. */
export interface WebhookStatus {
  configured: boolean;
  /** Masked, e.g. `discord.com/api/webhooks/…4821/••••••••`. */
  preview: string | null;
}

/** Which toggle produced a webhook message. */
export type WebhookEventKind =
  | 'newRun'
  | 'approved'
  | 'rejected'
  | 'deletedVideo'
  | 'videoProblem';

/**
 * One run, as an embed.
 *
 * Every field is optional because Speedrun.com does not always expose one. A
 * field left out is omitted from the embed rather than guessed at.
 */
export interface WebhookEvent {
  kind: WebhookEventKind;
  game?: string | null;
  runner?: string | null;
  category?: string | null;
  /** The level/map name, when the run is on a level rather than the full game. */
  levelName?: string | null;
  time?: string | null;
  durationSeconds?: number | null;
  status?: string | null;
  videoUrl?: string | null;
  runUrl?: string | null;
  /** A rejection reason, or what is wrong with a video. */
  detail?: string | null;
  /**
   * Which game this run belongs to. Carried for the game filter and never sent
   * to Discord — the embed shows `game`, the readable name.
   */
  gameId?: string | null;
}

export const webhook = {
  /**
   * Validates and stores the URL in the OS credential vault. The plaintext is
   * never returned — only the masked preview.
   */
  setUrl: (url: string) => call<WebhookStatus>('webhook_set_url', { url }),
  clearUrl: () => call<WebhookStatus>('webhook_clear_url'),
  status: () => call<WebhookStatus>('webhook_status'),
  /** Posts the confirmation line into the channel. */
  test: () => call<void>('webhook_test'),
  /** Returns how many run messages were delivered. */
  send: (events: WebhookEvent[]) => call<number>('webhook_send', { events }),
};

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------

/**
 * What GitHub says about the latest release.
 *
 * `available` is the only field that decides whether the dialog appears, and it
 * is computed in Rust from a parsed version comparison — never here from a
 * string. A check that failed throws instead of returning a reassuring result.
 */
export interface UpdateCheck {
  /** False while no GitHub repository is configured in `Cargo.toml`. */
  configured: boolean;
  /** The running build, e.g. `1.0.0`. */
  current: string;
  /** Latest released version, or `null` when there are no releases yet. */
  latest: string | null;
  available: boolean;
  releaseUrl: string | null;
  /** The installer asset, when the release has one. */
  downloadUrl: string | null;
  downloadName: string | null;
  /** Release notes as plain text. Rendered as text, never as HTML. */
  notes: string | null;
  publishedAt: string | null;
}

export const updates = {
  /**
   * Asks GitHub for the latest release.
   *
   * Runs in Rust because the webview's CSP allows `ipc:` only — the frontend
   * cannot reach api.github.com at all.
   */
  check: () => call<UpdateCheck>('check_update'),
};
