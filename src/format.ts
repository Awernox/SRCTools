/**
 * Presentation helpers.
 *
 * The rule this file exists to enforce: *absent* and *bad* are different, and
 * *unverifiable* is neither. Formatters here return an em dash for missing data
 * and never substitute a zero, a "0:00" or an empty string that would read as a
 * real value.
 */

import { activeLanguage, pluralize, t, type PluralNoun } from './i18n';
import type { Confidence, Recommendation, Severity, VideoStatus } from './types';

/** What the UI shows when Speedrun.com did not give us a value. */
export const ABSENT = '—';

export type Tone = 'ok' | 'warn' | 'danger' | 'unknown' | 'info' | 'accent' | 'neutral';

/* -------------------------------------------------------------------- time */

/**
 * Formats seconds the way Speedrun.com does: `1:23:45.670`, dropping the hour
 * when it is zero and the milliseconds when they are.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return ABSENT;

  const whole = Math.floor(seconds);
  const millis = Math.round((seconds - whole) * 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  let out = hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  if (millis > 0) out += `.${pad(millis, 3)}`;
  return out;
}

/** Compact duration for a video length, e.g. `12:04` or `1:02:33`. */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return ABSENT;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/* -------------------------------------------------------------------- dates */

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `10 Aug 2026`, in the chosen language.
 *
 * The language is passed explicitly rather than left as `undefined`: a
 * moderator who picked Russian in Settings expects Russian dates, even on a
 * Windows install set to English.
 */
export function formatDate(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return ABSENT;
  return date.toLocaleDateString(activeLanguage(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** `10 Aug 2026, 14:32`. */
export function formatDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return ABSENT;
  return date.toLocaleString(activeLanguage(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `just now`, `4 hours ago`, `12 days ago`, in the active language. */
export function formatRelative(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return ABSENT;

  const diffMs = Date.now() - date.getTime();
  const future = diffMs < 0;
  const seconds = Math.abs(diffMs) / 1000;

  if (seconds < 45) return t(future ? 'time.inAMoment' : 'time.justNow');

  let duration: string;
  if (seconds < 3600) duration = plural(Math.round(seconds / 60), 'minute');
  else if (seconds < 86400) duration = plural(Math.round(seconds / 3600), 'hour');
  else if (seconds < 604800) duration = plural(Math.round(seconds / 86400), 'day');
  else if (seconds < 2629800) duration = plural(Math.round(seconds / 604800), 'week');
  else if (seconds < 31557600) duration = plural(Math.round(seconds / 2629800), 'month');
  else duration = plural(Math.round(seconds / 31557600), 'year');

  // Both halves come from the catalogue: Spanish puts the marker in front
  // ("hace 5 minutos") where English and Russian put it after.
  return t(future ? 'time.in' : 'time.ago', { duration });
}

/**
 * Counts a noun in the active language.
 *
 * Thin wrapper over `pluralize` so call sites keep reading `plural(n, 'day')`.
 * The noun is a closed union rather than a free string: Russian and Ukrainian
 * need three forms, so a noun has to exist in the catalogues before it can be
 * counted, and the compiler is the right place to find that out.
 */
export function plural(count: number, noun: PluralNoun): string {
  return pluralize(count, noun);
}

/** Whole days between an ISO timestamp and now, or `null` when unparseable. */
export function daysSince(value: string | null | undefined): number | null {
  const date = parseDate(value);
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

/* ------------------------------------------------------------------ numbers */

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ABSENT;
  return value.toLocaleString(activeLanguage());
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ABSENT;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return ABSENT;
  return `${value.toFixed(digits)}%`;
}

/* ------------------------------------------------------------------- video */

interface StatusPresentation {
  label: string;
  tone: Tone;
  /** One line explaining what the status does and does not assert. */
  meaning: string;
}

/**
 * Tone per video status.
 *
 * `UNKNOWN` and `NETWORK_ERROR` are neutral, never red: the app failed to
 * check, which says nothing about the run. Presenting them as problems would
 * push a moderator toward rejecting a run over SRCTools' own network trouble.
 *
 * Only the tone lives here. The words are read from the catalogue at call time
 * — a module-level table would be built once, in whatever language happened to
 * be active at import, and never change again.
 */
const VIDEO_STATUS_TONE: Record<VideoStatus, Tone> = {
  AVAILABLE: 'ok',
  PRIVATE: 'warn',
  DELETED: 'danger',
  UNAVAILABLE: 'danger',
  REGION_RESTRICTED: 'warn',
  PROCESSING: 'info',
  INVALID_URL: 'danger',
  UNKNOWN: 'unknown',
  NETWORK_ERROR: 'unknown',
};

export function videoStatusInfo(status: VideoStatus): StatusPresentation {
  return {
    label: videoStatusLabel(status),
    tone: VIDEO_STATUS_TONE[status],
    meaning: t(`video.${status}.desc`),
  };
}

export function videoStatusLabel(status: VideoStatus): string {
  return t(`video.${status}`);
}

export function videoStatusTone(status: VideoStatus): Tone {
  return VIDEO_STATUS_TONE[status];
}

/* ---------------------------------------------------------------- analysis */

export function severityTone(severity: Severity): Tone {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'warning':
      return 'warn';
    default:
      return 'info';
  }
}

export function severityLabel(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return t('severity.critical');
    case 'warning':
      return t('severity.warning');
    default:
      return t('severity.note');
  }
}

export function confidenceLabel(confidence: Confidence): string {
  return t(`confidence.${confidence}`);
}

export function confidenceMeaning(confidence: Confidence): string {
  return t(`confidence.${confidence}.desc`);
}

export function confidenceTone(confidence: Confidence): Tone {
  switch (confidence) {
    case 'confirmed':
      return 'accent';
    case 'likely':
      return 'info';
    case 'heuristic':
      return 'neutral';
    default:
      return 'unknown';
  }
}

/**
 * Wording for the analysis verdict.
 *
 * None of these tell the moderator what to do. The engine has no "approve" or
 * "reject" outcome, and this copy must not imply one.
 */
const RECOMMENDATION_TONE: Record<Recommendation, Tone> = {
  nothing_flagged: 'ok',
  needs_review: 'warn',
  cannot_verify: 'unknown',
};

export function recommendationInfo(recommendation: Recommendation): {
  label: string;
  tone: Tone;
  detail: string;
} {
  return {
    label: t(`verdict.${recommendation}`),
    tone: RECOMMENDATION_TONE[recommendation],
    detail: t(`verdict.${recommendation}.desc`),
  };
}

/* --------------------------------------------------------------- run status */

export function runStatusTone(status: string): Tone {
  switch (status) {
    case 'verified':
      return 'ok';
    case 'rejected':
      return 'danger';
    case 'new':
      return 'info';
    default:
      return 'neutral';
  }
}

export function runStatusLabel(status: string): string {
  switch (status) {
    case 'new':
      return t('runStatus.new');
    case 'verified':
      return t('runStatus.verified');
    case 'rejected':
      return t('runStatus.rejected');
    default:
      // An unrecognised status from the API is shown as it arrived rather than
      // hidden: the moderator can see what Speedrun.com actually said.
      return status ? status[0]!.toUpperCase() + status.slice(1) : t('runStatus.unknown');
  }
}

/* ------------------------------------------------------------------- misc */

/** Trims a string for display, keeping whole words where it can. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** Host of a URL, for showing where a link points before it is opened. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Whether a URL is safe to hand to the OS opener.
 *
 * Only http(s) — a `file:`, `javascript:` or custom-scheme link submitted by a
 * runner must never be launched on the moderator's machine.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Flag emoji for an ISO country code, or `null` when it is not a valid code. */
export function countryFlag(code: string | null | undefined): string | null {
  if (!code || code.length !== 2 || !/^[a-z]{2}$/i.test(code)) return null;
  const base = 0x1f1e6;
  const upper = code.toUpperCase();
  return String.fromCodePoint(
    base + (upper.charCodeAt(0) - 65),
    base + (upper.charCodeAt(1) - 65),
  );
}

/** Initials for an avatar fallback. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
