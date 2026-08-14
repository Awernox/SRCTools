import { createHash } from "node:crypto";

import type { WorkerConfig } from "./config.js";
import { DiscordDeliveryError, DiscordWebhook } from "./discord.js";
import { messageOf, sleep, SpeedrunClient } from "./speedrun.js";
import { StateStore } from "./state.js";
import type { FeedKind } from "./types.js";

const SCOPE_REFRESH_MS = 6 * 60 * 60_000;

const FEEDS: ReadonlyArray<{
  kind: FeedKind;
  status: "new" | "verified" | "rejected";
}> = [
  { kind: "newRun", status: "new" },
  { kind: "approved", status: "verified" },
  { kind: "rejected", status: "rejected" },
];

interface Scope {
  accountId: string;
  gameIds: ReadonlySet<string>;
  fingerprint: string;
  refreshedAt: number;
}

export interface WorkerHealth {
  startedAt: string;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  checking: boolean;
  scopedGames: number;
  pendingWebhooks: number;
  failedWebhooks: number;
  lastDeliveryError: string | null;
  nextCheckAt: string | null;
}

export class Worker {
  private readonly speedrun: SpeedrunClient;
  private readonly discord: DiscordWebhook;
  private scope: Scope | null = null;
  private readonly health: WorkerHealth = {
    startedAt: new Date().toISOString(),
    lastCheckAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    checking: false,
    scopedGames: 0,
    pendingWebhooks: 0,
    failedWebhooks: 0,
    lastDeliveryError: null,
    nextCheckAt: null,
  };

  constructor(
    private readonly config: WorkerConfig,
    private readonly state: StateStore,
  ) {
    this.speedrun = new SpeedrunClient(config.speedrunApiKey);
    this.discord = new DiscordWebhook(config.discordWebhookUrl);
  }

  snapshot(): WorkerHealth {
    return { ...this.health };
  }

  async run(signal: AbortSignal): Promise<void> {
    console.log(`[Worker] Started; polling every ${this.config.checkIntervalMs / 1000}s`);
    while (!signal.aborted) {
      const started = Date.now();
      this.health.checking = true;
      this.health.lastCheckAt = new Date(started).toISOString();
      this.health.nextCheckAt = null;
      try {
        await this.check(signal);
        this.health.lastSuccessAt = new Date().toISOString();
        this.health.lastError = null;
        this.health.consecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted) break;
        this.health.lastError = messageOf(error);
        this.health.consecutiveFailures += 1;
        console.error(
          `[Worker] Check failed (${this.health.consecutiveFailures} in a row): ${this.health.lastError}`,
        );
      } finally {
        this.health.checking = false;
        this.health.pendingWebhooks = this.state.pendingCount();
        this.health.failedWebhooks = this.state.failedCount();
      }

      const delay = failureDelay(this.config.checkIntervalMs, this.health.consecutiveFailures);
      const wait = Math.max(250, delay - (Date.now() - started));
      this.health.nextCheckAt = new Date(Date.now() + wait).toISOString();
      console.log(`[Worker] Next check in ${Math.ceil(wait / 1000)}s`);
      try {
        await sleep(wait, signal);
      } catch {
        break;
      }
    }
    console.log("[Worker] Stopped");
  }

  private async check(signal: AbortSignal): Promise<void> {
    console.log("[Worker] Checking Speedrun.com...");
    await this.drainOutbox(signal);
    const scope = await this.currentScope(signal);
    this.health.scopedGames = scope.gameIds.size;
    if (scope.gameIds.size === 0) {
      console.warn("[Worker] The account moderates no selected games; no run feeds were polled.");
      return;
    }

    let found = 0;
    const errors: string[] = [];
    for (const feed of FEEDS) {
      if (!this.config.monitoredEvents.has(feed.kind)) continue;
      try {
        const page = (await this.speedrun.runs(feed.status, signal)).filter(
          (run) => run.gameId !== null && scope.gameIds.has(run.gameId),
        );
        found += this.state.applyFeedPage({
          accountId: scope.accountId,
          feedKey: `${scope.accountId}:${scope.fingerprint}:${feed.kind}`,
          kind: feed.kind,
          runs: page,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const text = `${feed.status}: ${messageOf(error)}`;
        errors.push(text);
        console.error(`[Worker] Feed failed: ${text}`);
      }
    }

    console.log(`[Worker] Found ${found} new event(s)`);
    await this.drainOutbox(signal);
    this.state.prune();
    if (errors.length > 0) throw new Error(errors.join("; "));
  }

  private async currentScope(signal: AbortSignal): Promise<Scope> {
    if (this.scope && Date.now() - this.scope.refreshedAt < SCOPE_REFRESH_MS) return this.scope;

    const profile = await this.speedrun.profile(signal);
    const games = await this.speedrun.moderatedGames(profile.id, signal);
    const moderated = new Set(games.map((game) => game.id));
    const selected = this.config.monitoredGameIds;
    const gameIds = selected === null
      ? moderated
      : new Set([...selected].filter((id) => moderated.has(id)));
    const sorted = [...gameIds].sort();
    const fingerprint = createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
    this.scope = {
      accountId: profile.id,
      gameIds,
      fingerprint,
      refreshedAt: Date.now(),
    };
    console.log(`[Worker] Scope refreshed: ${gameIds.size} moderated game(s)`);
    if (selected !== null && selected.size !== gameIds.size) {
      console.warn("[Worker] Some MONITORED_GAME_IDS are not moderated by this account and were ignored.");
    }
    return this.scope;
  }

  private async drainOutbox(signal: AbortSignal): Promise<void> {
    for (const event of this.state.pendingOutbox()) {
      try {
        await this.discord.send(event.kind, event.run, signal);
        this.state.markDelivered(event.id);
        this.health.lastDeliveryError = null;
        console.log(`[Discord] Webhook sent: ${event.kind} ${event.runId}`);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const attempts = event.attempts + 1;
        const permanent = error instanceof DiscordDeliveryError && error.permanent;
        const exhausted = this.state.markDeliveryFailed(
          event.id,
          attempts,
          messageOf(error),
          permanent,
        );
        this.health.lastDeliveryError = messageOf(error);
        this.health.failedWebhooks = this.state.failedCount();
        console.error(
          `[Discord] Webhook failed${exhausted ? " permanently" : " and was scheduled for retry"}: ${messageOf(error)}`,
        );
        // One outage causes one bounded delivery attempt per cycle, not a burst
        // across every queued event.
        break;
      }
    }
  }
}

function failureDelay(interval: number, failures: number): number {
  if (failures < 3) return interval;
  return Math.min(5 * 60_000, interval * 2 ** Math.min(3, failures - 2));
}
