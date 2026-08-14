import path from "node:path";
import process from "node:process";

import type { FeedKind } from "./types.js";

const DISCORD_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);

export const ALLOWED_GAMES = new Map([
  ["o1yj25r1", "Run pro"],
  ["268q8o6p", "Bhop pro"],
] as const);
export type AllowedGameId = "o1yj25r1" | "268q8o6p";

export interface WorkerConfig {
  discordWebhookUrl: string;
  speedrunApiKey: string;
  checkIntervalMs: number;
  monitoredEvents: ReadonlySet<FeedKind>;
  monitoredGameIds: ReadonlySet<string>;
  stateFile: string;
  port: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  if ([...value].some((character) => character < " ")) {
    throw new Error(`${name} contains invalid control characters.`);
  }
  return value;
}

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer from ${min} to ${max}, received '${raw}'.`);
  }
  return value;
}

function discordWebhook(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DISCORD_WEBHOOK_URL is not a valid URL.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const webhookIndex = parts.indexOf("webhooks");
  const validPath =
    parts[0] === "api" && webhookIndex >= 1 && parts.length === webhookIndex + 3;
  if (
    url.protocol !== "https:" ||
    !DISCORD_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !validPath
  ) {
    throw new Error("DISCORD_WEBHOOK_URL must be an HTTPS Discord webhook URL.");
  }
  return url.toString();
}

function events(raw: string | undefined): ReadonlySet<FeedKind> {
  const aliases: Record<string, FeedKind> = {
    new: "newRun",
    newrun: "newRun",
    verified: "approved",
    approved: "approved",
    rejected: "rejected",
  };
  const values = (raw ?? "new,verified,rejected")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const parsed = new Set<FeedKind>();
  for (const value of values) {
    const kind = aliases[value];
    if (!kind) {
      throw new Error(
        `Unknown MONITORED_EVENTS value '${value}'. Use new, verified and/or rejected.`,
      );
    }
    parsed.add(kind);
  }
  if (parsed.size === 0) throw new Error("MONITORED_EVENTS must contain at least one event.");
  return parsed;
}

function gameIds(raw: string | undefined): ReadonlySet<string> {
  const ids = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) return new Set(ALLOWED_GAMES.keys());
  for (const id of ids) {
    if (!ALLOWED_GAMES.has(id as AllowedGameId)) {
      throw new Error(
        `MONITORED_GAME_IDS may only contain Run pro (o1yj25r1) and Bhop pro (268q8o6p). Received '${id}'.`,
      );
    }
  }
  return new Set(ids);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const dataDirectory =
    env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || path.resolve(process.cwd(), "data");
  return {
    discordWebhookUrl: discordWebhook(required(env, "DISCORD_WEBHOOK_URL")),
    speedrunApiKey: required(env, "SPEEDRUN_API_KEY"),
    checkIntervalMs: integer(env.CHECK_INTERVAL_SECONDS, 6, 5, 3600) * 1000,
    monitoredEvents: events(env.MONITORED_EVENTS),
    monitoredGameIds: gameIds(env.MONITORED_GAME_IDS),
    stateFile: path.join(dataDirectory, "srctools-worker.sqlite"),
    port: integer(env.PORT, 3000, 1, 65535),
  };
}
