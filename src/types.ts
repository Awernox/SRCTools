/**
 * Types mirroring the Rust DTOs, one file so drift is visible in one place.
 *
 * Field names match `#[serde(rename_all = "camelCase")]` on the Rust side.
 * Anything the Speedrun.com API may not provide is `| null` — a null means
 * "not told us", and the UI renders it as an em dash rather than inventing a
 * plausible value.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Serialised `AppError`. Every rejected `invoke` produces this shape. */
export interface AppError {
  kind: AppErrorKind;
  message: string;
  /** True only for rate limits, timeouts and network/service failures. */
  retryable: boolean;
  hint: string | null;
}

export type AppErrorKind =
  | 'missing_credentials'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'service_unavailable'
  | 'api'
  | 'network'
  | 'timeout'
  | 'malformed'
  | 'invalid_input'
  | 'database'
  | 'keyring'
  | 'io'
  | 'internal';

// ---------------------------------------------------------------------------
// Video verification
// ---------------------------------------------------------------------------

/**
 * A verdict about a video, or an explicit statement that no verdict was
 * reached. `NETWORK_ERROR` and `UNKNOWN` are the latter and must never be
 * presented as if the video were missing.
 */
export type VideoStatus =
  | 'AVAILABLE'
  | 'PRIVATE'
  | 'DELETED'
  | 'UNAVAILABLE'
  | 'REGION_RESTRICTED'
  | 'PROCESSING'
  | 'INVALID_URL'
  | 'UNKNOWN'
  | 'NETWORK_ERROR';

export type VideoPlatform =
  | 'you_tube'
  | 'twitch'
  | 'vimeo'
  | 'streamable'
  | 'bilibili'
  | 'nico_video'
  | 'google_drive'
  | 'dropbox'
  | 'medal'
  | 'other';

export interface VideoMetadata {
  title: string | null;
  channel: string | null;
  durationSeconds: number | null;
  uploadDate: string | null;
  thumbnailUrl: string | null;
  embedUrl: string | null;
}

export interface VideoCheck {
  url: string;
  normalizedUrl: string | null;
  platform: VideoPlatform;
  videoId: string | null;
  status: VideoStatus;
  /** Always populated: explains in words how the status was reached. */
  detail: string;
  metadata: VideoMetadata;
  checkedAt: string;
  fromCache: boolean;
}

/** Statuses that reflect a real answer from the provider. */
export const CONCLUSIVE_STATUSES: readonly VideoStatus[] = [
  'AVAILABLE',
  'PRIVATE',
  'DELETED',
  'UNAVAILABLE',
  'REGION_RESTRICTED',
  'PROCESSING',
  'INVALID_URL',
];

/** Statuses a moderator would consider a problem worth opening. */
export const PROBLEM_STATUSES: readonly VideoStatus[] = [
  'PRIVATE',
  'DELETED',
  'UNAVAILABLE',
  'REGION_RESTRICTED',
  'INVALID_URL',
];

export const isConclusive = (s: VideoStatus): boolean => CONCLUSIVE_STATUSES.includes(s);
export const isProblem = (s: VideoStatus): boolean => PROBLEM_STATUSES.includes(s);
/** True when the app could not determine anything — never a negative verdict. */
export const isUnverified = (s: VideoStatus): boolean =>
  s === 'UNKNOWN' || s === 'NETWORK_ERROR';

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warning' | 'critical';
export type Confidence = 'confirmed' | 'likely' | 'heuristic' | 'unverifiable';
export type Evidence =
  | 'run_data'
  | 'game_rules'
  | 'video_provider'
  | 'leaderboard'
  | 'runner_history'
  | 'local_records'
  | 'missing';

export type CheckId =
  | 'video_missing'
  | 'video_unreachable'
  | 'video_inaccessible'
  | 'video_unsupported_host'
  | 'video_text_only'
  | 'video_shorter_than_run'
  | 'multiple_videos'
  | 'time_missing'
  | 'time_suspiciously_fast'
  | 'time_above_leaderboard'
  | 'large_improvement'
  | 'first_submission'
  | 'runner_history_clean'
  | 'duplicate_submission'
  | 'previously_actioned'
  | 'emulator_not_allowed'
  | 'platform_not_listed'
  | 'region_missing'
  | 'date_in_future'
  | 'date_before_release'
  | 'submitted_before_played'
  | 'missing_subcategory'
  | 'no_comment'
  | 'guest_submission'
  | 'rules_require_video'
  | 'long_pending';

export interface Finding {
  id: CheckId;
  severity: Severity;
  confidence: Confidence;
  evidence: Evidence;
  title: string;
  detail: string;
  suggestion: string | null;
}

/**
 * Deliberately has no `approve` or `reject` member: the analysis engine flags,
 * it never decides.
 */
export type Recommendation = 'nothing_flagged' | 'needs_review' | 'cannot_verify';

export interface RunAnalysis {
  runId: string;
  recommendation: Recommendation;
  findings: Finding[];
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  /** True when at least one check could not run for lack of data. */
  hasUnverifiable: boolean;
  analysedAt: string;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type PlayerKind = 'user' | 'guest';

export interface RunPlayer {
  kind: PlayerKind;
  /** Null for guests, who have no Speedrun.com account. */
  id: string | null;
  name: string;
  avatarUrl: string | null;
  weblink: string | null;
  countryCode: string | null;
}

export interface LabelledValue {
  variableId: string;
  variableName: string;
  valueId: string;
  valueLabel: string | null;
  isSubcategory: boolean;
}

export type RunStatus = 'new' | 'verified' | 'rejected' | string;

export interface RunSummary {
  id: string;
  weblink: string | null;
  gameId: string | null;
  gameName: string | null;
  gameCoverUrl: string | null;
  categoryId: string | null;
  categoryName: string | null;
  levelId: string | null;
  levelName: string | null;
  players: RunPlayer[];
  playerLabel: string;
  primarySeconds: number | null;
  /** Pre-formatted by Rust so every view renders a time identically. */
  primaryDisplay: string | null;
  status: RunStatus;
  examinerId: string | null;
  rejectionReason: string | null;
  date: string | null;
  submitted: string | null;
  comment: string | null;
  videoUrls: string[];
  videoText: string | null;
  platformId: string | null;
  platformName: string | null;
  regionId: string | null;
  regionName: string | null;
  emulated: boolean | null;
  variableValues: Record<string, string>;
  variableLabels: LabelledValue[];
}

export interface QueuePage {
  runs: RunSummary[];
  /** Run id → other run ids sharing a video. A flag, never a decision. */
  duplicates: Record<string, string[]>;
  truncated: boolean;
  fetchedAt: string;
}

/** One watcher poll. Cheap by design: a single request, newest runs first. */
export interface WatchReport {
  runs: RunSummary[];
  fetchedAt: string;
  /** Games the poll covered. Zero means there was nothing to watch. */
  scopedGames: number;
}

export interface GameInfo {
  id: string;
  name: string;
  abbreviation: string | null;
  weblink: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  romhack: boolean | null;
  requireVideo: boolean | null;
  requireVerification: boolean | null;
  emulatorsAllowed: boolean | null;
  showMilliseconds: boolean | null;
  defaultTime: string | null;
  runTimes: string[];
  isModerator: boolean;
  moderatorRole: string | null;
}

export interface CategoryInfo {
  id: string;
  name: string;
  weblink: string | null;
  /** Plain text. Rendered as text, never as HTML. */
  rules: string | null;
  categoryType: string | null;
  miscellaneous: boolean | null;
  playerType: string | null;
  playerCount: number | null;
}

export interface LeaderboardEntry {
  place: number;
  runId: string;
  playerLabel: string;
  seconds: number | null;
  display: string | null;
  weblink: string | null;
  date: string | null;
}

export interface RunnerHistorySummary {
  userId: string | null;
  displayName: string;
  weblink: string | null;
  avatarUrl: string | null;
  countryCode: string | null;
  signupDate: string | null;
  // Flattened from `RunnerHistory` on the Rust side.
  totalRuns: number;
  verifiedRuns: number;
  rejectedRuns: number;
  bestTime: number | null;
  runs: RunSummary[];
  improvementPercent: number | null;
  previousBestDisplay: string | null;
  /** Set when the history could not be loaded — distinct from "no history". */
  error: string | null;
}

export interface RunDetail {
  run: RunSummary;
  game: GameInfo | null;
  category: CategoryInfo | null;
  videoChecks: VideoCheck[];
  analysis: RunAnalysis;
  runnerHistory: RunnerHistorySummary | null;
  priorAction: string | null;
  leaderboard: LeaderboardEntry[] | null;
  /** Why the leaderboard is absent, when it is. */
  leaderboardError: string | null;
}

export interface GameSummary {
  id: string;
  name: string;
  abbreviation: string | null;
  weblink: string | null;
  coverUrl: string | null;
  released: number | null;
  isModerator: boolean;
}

export interface Profile {
  id: string;
  displayName: string;
  weblink: string | null;
  avatarUrl: string | null;
  countryCode: string | null;
  role: string | null;
  signupDate: string | null;
}

export interface ConnectionStatus {
  connected: boolean;
  profile: Profile | null;
  /** Masked preview such as `a1b2••••9f8e`. Never the key itself. */
  maskedKey: string | null;
  twitchConfigured: boolean;
  message: string;
  rateLimitUsed: number;
  rateLimitCapacity: number;
}

export interface DashboardSummary {
  pendingCount: number;
  /** True when the count is a floor rather than a total. */
  pendingIsPartial: boolean;
  oldestPendingDays: number | null;
  gamesModerated: number;
  runsWithVideoProblems: number;
  runsNeedingReview: number;
  actionsToday: number;
  actionsThisWeek: number;
  recentRuns: RunSummary[];
  fetchedAt: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

export type ModerationActionName = 'verify' | 'reject' | 'delete';
export type ActionOutcome = 'success' | 'failed';

/** Descriptive fields copied into the local log alongside an action. */
export interface RunContext {
  gameId?: string | null;
  gameName?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  playerNames?: string | null;
  runTime?: number | null;
  runWeblink?: string | null;
}

export interface ActionTarget {
  runId: string;
  context?: RunContext;
}

export interface BulkItemResult {
  runId: string;
  success: boolean;
  error: string | null;
  errorKind: AppErrorKind | null;
  retryable: boolean;
}

export interface BulkResult {
  batchId: string;
  operation: string;
  total: number;
  succeeded: number;
  failed: number;
  results: BulkItemResult[];
  startedAt: string;
  finishedAt: string;
}

export interface BulkProgress {
  batchId: string;
  operation: string;
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  currentRunId: string;
  currentOk: boolean;
  currentError: string | null;
}

// ---------------------------------------------------------------------------
// Local records
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: number;
  runId: string;
  action: ModerationActionName;
  outcome: ActionOutcome;
  reason: string | null;
  errorMessage: string | null;
  gameId: string | null;
  gameName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  playerNames: string | null;
  runTime: number | null;
  runWeblink: string | null;
  batchId: string | null;
  actedAt: string;
}

export interface HistoryQuery {
  action?: ModerationActionName | null;
  outcome?: ActionOutcome | null;
  gameId?: string | null;
  runId?: string | null;
  search?: string | null;
  since?: string | null;
  until?: string | null;
  limit?: number | null;
  offset?: number | null;
}

export interface AuditEntry {
  id: number;
  batchId: string;
  operation: string;
  total: number;
  succeeded: number;
  failed: number;
  detail: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface DailyCount {
  day: string;
  verified: number;
  rejected: number;
  deleted: number;
  failed: number;
}

export interface GameCount {
  gameId: string | null;
  gameName: string;
  count: number;
}

export interface ReasonCount {
  reason: string;
  count: number;
}

export interface ModerationStats {
  totalActions: number;
  verified: number;
  rejected: number;
  deleted: number;
  failed: number;
  distinctRuns: number;
  firstActionAt: string | null;
  lastActionAt: string | null;
  perDay: DailyCount[];
  perGame: GameCount[];
  topReasons: ReasonCount[];
}

export interface ExportPayload {
  filename: string;
  content: string;
  mimeType: string;
  rowCount: number;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export interface RejectionTemplate {
  id: string;
  label: string;
  body: string;
  sortOrder: number;
  builtin: boolean;
  createdAt: string;
}

export interface FavoriteGame {
  gameId: string;
  name: string;
  abbrev: string | null;
  coverUrl: string | null;
  sortOrder: number;
  addedAt: string;
}

export interface CacheStats {
  cacheEntries: number;
  expiredEntries: number;
  videoChecks: number;
  historyEntries: number;
  auditEntries: number;
  databaseBytes: number | null;
  databasePath: string;
  oldestEntryAt: string | null;
}

// ---------------------------------------------------------------------------
// Speedrun.com raw models the frontend still needs
// ---------------------------------------------------------------------------

export interface VariableValue {
  id: string;
  label: string;
  rules: string | null;
}

export interface Variable {
  id: string;
  name: string;
  category: string | null;
  scope: string | null;
  mandatory: boolean | null;
  userDefined: boolean | null;
  isSubcategory: boolean | null;
  values: VariableValue[];
}

export interface Level {
  id: string;
  name: string;
  weblink: string | null;
  rules: string | null;
}

export interface Platform {
  id: string;
  name: string;
  released: number | null;
}

export interface Region {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Queue filter
// ---------------------------------------------------------------------------

export type QueueOrderBy = 'submitted' | 'date' | 'verify-date' | 'game' | 'category' | 'status';

export interface QueueFilter {
  gameId?: string | null;
  categoryId?: string | null;
  levelId?: string | null;
  userId?: string | null;
  platformId?: string | null;
  regionId?: string | null;
  emulated?: boolean | null;
  status?: 'new' | 'verified' | 'rejected' | null;
  orderBy?: QueueOrderBy | null;
  ascending?: boolean | null;
  limit?: number | null;
  onlyMyGames?: boolean | null;
}

/** Payload of the `srctools://ready` event, emitted once at startup. */
export interface StartupReport {
  version: string;
  databasePath: string;
  hasApiKey: boolean;
  warnings: string[];
}
