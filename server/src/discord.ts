import { compactDuration, messageOf, sleep } from "./speedrun.js";
import type { FeedKind, RunSummary } from "./types.js";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

interface DiscordField {
  name: string;
  value: string;
  inline: boolean;
}

export interface DiscordEmbed {
  title: string;
  url: string;
  description?: string;
  color: number;
  fields?: DiscordField[];
}

export class DiscordDeliveryError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = "DiscordDeliveryError";
  }
}

export class DiscordWebhook {
  constructor(private readonly url: string) {}

  async send(kind: FeedKind, run: RunSummary, signal: AbortSignal): Promise<void> {
    const payload = {
      embeds: [buildEmbed(kind, run)],
      allowed_mentions: { parse: [] as string[] },
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (signal.aborted) throw signal.reason;
      try {
        const response = await fetchWithTimeout(
          this.url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            redirect: "manual",
          },
          signal,
        );
        if (response.ok) return;

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          throw new DiscordDeliveryError(`Discord rejected the webhook (HTTP ${response.status}).`, true);
        }
        if (attempt === MAX_ATTEMPTS) {
          throw new DiscordDeliveryError(`Discord failed after retries (HTTP ${response.status}).`, false);
        }
        const wait = response.status === 429 ? await discordRetryAfter(response) : 800 * 2 ** attempt;
        await sleep(Math.min(300_000, wait), signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof DiscordDeliveryError) throw error;
        if (attempt === MAX_ATTEMPTS) {
          throw new DiscordDeliveryError(`Could not reach Discord: ${messageOf(error)}`, false);
        }
        await sleep(Math.min(8_000, 800 * 2 ** attempt), signal);
      }
    }
  }
}

export function buildEmbed(kind: FeedKind, run: RunSummary): DiscordEmbed {
  if (!run.runUrl) throw new DiscordDeliveryError("The run has no valid Speedrun.com URL.", true);
  const map = safe(run.mapName ?? run.categoryName ?? "Unknown map", 1024);
  const runner = safe(run.runner || "Unknown runner", 1024);
  const exactTime = safe(run.timeDisplay ?? "Unknown time", 1024);
  const compactTime =
    run.primarySeconds === null ? exactTime : compactDuration(run.primarySeconds);

  if (kind === "newRun") {
    return {
      title: "🏆 New Run",
      url: run.runUrl,
      description: `${map} in ${compactTime} by ${runner}`,
      color: 0x5865f2,
    };
  }

  if (kind === "approved") {
    return {
      title: "✅ Run verified",
      url: run.runUrl,
      description: `${map} in ${compactTime} by ${runner}`,
      color: 0x57f287,
    };
  }

  const rejectionReason = run.rejectionReason
    ? `\nReason: ${safe(run.rejectionReason, 1016)}`
    : "";
  return {
    title: "❌ Run rejected",
    url: run.runUrl,
    description: `${map} in ${compactTime} by ${runner}${rejectionReason}`,
    color: 0xed4245,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  parentSignal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Discord request timed out.")), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}

async function discordRetryAfter(response: Response): Promise<number> {
  try {
    const body = (await response.json()) as { retry_after?: unknown };
    if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after)) {
      return Math.max(0, body.retry_after * 1000);
    }
  } catch {
    // Fall through to the conservative default.
  }
  return 1_000;
}

function safe(value: string, max: number): string {
  return [...value]
    .filter((character) => character === "\n" || character >= " ")
    .join("")
    .trim()
    .slice(0, max);
}
