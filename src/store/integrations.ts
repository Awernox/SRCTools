/**
 * The two Discord integrations: Rich Presence and the channel webhook.
 *
 * They share a file because they share a shape — a little state mirrored from
 * the Rust side, and a send path the rest of the app calls without caring
 * whether it is configured. Neither is ever allowed to break a moderation
 * action: a presence that will not connect and a webhook Discord refuses are
 * both reported once and then stay out of the way.
 *
 * The webhook URL never appears here. It lives in the Windows credential vault;
 * this module only ever sees `configured` and the masked preview.
 */

import { create } from 'zustand';

import {
  discord as discordIpc,
  errorText,
  webhook as webhookIpc,
  type DiscordPresence,
  type DiscordStatus,
  type WebhookEvent,
  type WebhookEventKind,
  type WebhookStatus,
} from '../ipc';
import { videoStatusInfo, videoStatusLabel } from '../format';
import type { RunSummary, VideoStatus } from '../types';
import { useSession, type Settings } from './session';
import { ui } from './ui';

/* ------------------------------------------------------------ rich presence */

interface DiscordState {
  status: DiscordStatus;
  /** Reads the current status, for when Settings opens. */
  load: () => Promise<void>;
  /** Applies a `srctools://discord` event. */
  apply: (status: DiscordStatus) => void;
  /** Pushes the enable flag and application id at the worker. */
  configure: (enabled: boolean, appId: string) => Promise<void>;
  reconnect: () => Promise<void>;
}

const OFFLINE: DiscordStatus = { enabled: false, connected: false, lastError: null };

export const useDiscord = create<DiscordState>((set) => ({
  status: OFFLINE,

  load: async () => {
    try {
      set({ status: await discordIpc.status() });
    } catch {
      /* the badge keeps its last reading */
    }
  },

  apply: (status) => set({ status }),

  configure: async (enabled, appId) => {
    try {
      set({ status: await discordIpc.configure(enabled, appId) });
    } catch (err) {
      set((state) => ({ status: { ...state.status, lastError: errorText(err) } }));
    }
  },

  reconnect: async () => {
    try {
      set({ status: await discordIpc.reconnect() });
    } catch (err) {
      set((state) => ({ status: { ...state.status, lastError: errorText(err) } }));
    }
  },
}));

/** Sends a presence, dropping it silently when Discord is not there. */
export function publishPresence(presence: DiscordPresence): void {
  void discordIpc.publish(presence).catch(() => {
    /* the worker reports connection trouble through its own event */
  });
}

/* ------------------------------------------------------------------ webhook */

interface WebhookState {
  status: WebhookStatus;
  load: () => Promise<void>;
  /** Validates and stores a URL. Throws so the form can show why it failed. */
  save: (url: string) => Promise<void>;
  clear: () => Promise<void>;
  test: () => Promise<void>;
}

const UNSET: WebhookStatus = { configured: false, preview: null };

export const useWebhook = create<WebhookState>((set) => ({
  status: UNSET,

  load: async () => {
    try {
      set({ status: await webhookIpc.status() });
    } catch {
      /* Settings shows "not configured" until the vault answers */
    }
  },

  save: async (url) => {
    set({ status: await webhookIpc.setUrl(url) });
  },

  clear: async () => {
    set({ status: await webhookIpc.clearUrl() });
  },

  test: async () => {
    await webhookIpc.test();
  },
}));

/** Which preference governs each event kind. */
const TOGGLE: Record<WebhookEventKind, keyof Settings> = {
  newRun: 'webhookNewRuns',
  approved: 'webhookApproved',
  rejected: 'webhookRejected',
  deletedVideo: 'webhookDeletedVideos',
  videoProblem: 'webhookVideoProblems',
};

/**
 * True once a failed post has been reported, so a webhook Discord keeps
 * refusing produces one warning rather than one per new run. Cleared by the
 * next success.
 */
let posted = true;

/**
 * Posts what the moderator has turned on.
 *
 * Never throws and never awaited by a moderation action: the run has already
 * been verified on Speedrun.com by the time this runs, and a Discord outage is
 * not a reason to tell the moderator their action failed.
 */
export function postWebhook(events: WebhookEvent[]): void {
  if (events.length === 0) return;
  const { settings } = useSession.getState();
  if (!settings.webhookEnabled) return;
  if (!useWebhook.getState().status.configured) return;

  const wanted = events.filter((event) => settings[TOGGLE[event.kind]] === true);

  // An empty list means every game, so the filter only ever narrows. A run
  // whose game id is unknown is dropped when a filter is set: the moderator
  // asked for specific games, and posting an unattributable run would be the
  // one thing they said they did not want.
  const games = settings.webhookGames;
  const scoped =
    games.length === 0
      ? wanted
      : wanted.filter((event) => event.gameId != null && games.includes(event.gameId));

  if (scoped.length === 0) return;

  void webhookIpc
    .send(scoped)
    .then(() => {
      posted = true;
    })
    .catch((err: unknown) => {
      if (!posted) return;
      posted = false;
      ui.warning('Discord webhook failed', errorText(err));
    });
}

/* ------------------------------------------------------------ event builders */

/** The English status line for each kind, matching the embed's other labels. */
const STATUS: Record<WebhookEventKind, string | null> = {
  newRun: 'Pending',
  approved: 'Verified',
  rejected: 'Rejected',
  deletedVideo: null,
  videoProblem: null,
};

/**
 * A run as an embed payload.
 *
 * Nothing is invented: a field Speedrun.com did not supply is left null and the
 * Rust side omits it, rather than filling in a plausible-looking value.
 */
export function runEvent(
  kind: WebhookEventKind,
  run: RunSummary,
  detail?: string | null,
): WebhookEvent {
  const category = run.levelName
    ? `${run.categoryName ?? 'Unknown category'} — ${run.levelName}`
    : run.categoryName;

  return {
    kind,
    game: run.gameName,
    gameId: run.gameId,
    runner: run.playerLabel,
    category,
    time: run.primaryDisplay,
    status: STATUS[kind],
    videoUrl: run.videoUrls[0] ?? null,
    runUrl: run.weblink,
    detail: detail ?? null,
  };
}

/**
 * A video verdict as an embed payload.
 *
 * `DELETED` is the only status that gets the deleted-video kind, because it is
 * the only one where a provider actually said the video is gone. Everything else
 * a moderator would want to look at is a video problem, and `UNKNOWN` /
 * `NETWORK_ERROR` never reach here at all — a failed check is not a finding.
 */
export function videoEvent(run: RunSummary, status: VideoStatus): WebhookEvent {
  const kind: WebhookEventKind = status === 'DELETED' ? 'deletedVideo' : 'videoProblem';
  const event = runEvent(kind, run, videoStatusInfo(status).meaning);
  return { ...event, status: videoStatusLabel(status) };
}
