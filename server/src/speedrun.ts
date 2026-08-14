import type {
  ApiEnvelope,
  ApiPage,
  RawGame,
  RawRun,
  RawUser,
  RawVariable,
  RunSummary,
} from "./types.js";

const API_BASE = "https://www.speedrun.com/api/v1";
const RUN_EMBEDS = "game,category,level,players,platform,region";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 4;
const MIN_REQUEST_GAP_MS = 650;
const VARIABLES_CACHE_MS = 12 * 60 * 60_000;

type ApiRecord = Record<string, unknown>;
type RunStatus = "new" | "verified" | "rejected";

export class SpeedrunClient {
  private nextRequestAt = 0;
  private readonly variablesCache = new Map<
    string,
    { expiresAt: number; values: RawVariable[] }
  >();

  constructor(private readonly apiKey: string) {}

  async profile(signal: AbortSignal): Promise<RawUser> {
    const envelope = await this.request<ApiEnvelope<RawUser>>("/profile", signal);
    return envelope.data;
  }

  async moderatedGames(userId: string, signal: AbortSignal): Promise<RawGame[]> {
    return this.collection<RawGame>(
      `/games?moderator=${encodeURIComponent(userId)}&embed=platforms,regions`,
      500,
      signal,
    );
  }

  async runs(
    status: RunStatus,
    gameIds: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<RunSummary[]> {
    const order = status === "verified" ? "verify-date" : "submitted";
    const query = new URLSearchParams({
      status,
      orderby: order,
      direction: "desc",
      embed: RUN_EMBEDS,
      _: Date.now().toString(),
    });
    const runs = (await this.collection<RawRun>(`/runs?${query.toString()}`, 20, signal)).filter(
      (run) => resourceId(run.game) !== null && gameIds.has(resourceId(run.game) as string),
    );
    const variablesByGame = new Map<string, RawVariable[]>();
    for (const gameId of new Set(runs.map((run) => resourceId(run.game)).filter(isString))) {
      if (!runs.some((run) => resourceId(run.game) === gameId && hasValues(run.values))) continue;
      variablesByGame.set(gameId, await this.variables(gameId, signal));
    }
    return runs.map((run) => {
      const gameId = resourceId(run.game);
      return normalizeRun(run, gameId === null ? [] : (variablesByGame.get(gameId) ?? []));
    });
  }

  private async variables(gameId: string, signal: AbortSignal): Promise<RawVariable[]> {
    const cached = this.variablesCache.get(gameId);
    if (cached && cached.expiresAt > Date.now()) return cached.values;
    const envelope = await this.request<ApiEnvelope<RawVariable[]>>(
      `/games/${encodeURIComponent(gameId)}/variables`,
      signal,
    );
    this.variablesCache.set(gameId, {
      expiresAt: Date.now() + VARIABLES_CACHE_MS,
      values: envelope.data,
    });
    return envelope.data;
  }

  private async collection<T>(path: string, limit: number, signal: AbortSignal): Promise<T[]> {
    const values: T[] = [];
    let offset = 0;
    const separator = path.includes("?") ? "&" : "?";

    while (values.length < limit) {
      const pageSize = Math.min(200, limit - values.length);
      const page = await this.request<ApiPage<T>>(
        `${path}${separator}max=${pageSize}&offset=${offset}`,
        signal,
      );
      values.push(...page.data);
      const hasNext = page.pagination?.links?.some((link) => link.rel === "next") ?? false;
      if (!hasNext || page.data.length === 0) break;
      offset += page.data.length;
      if (offset > 10_000) break;
    }

    return values.slice(0, limit);
  }

  private async request<T>(path: string, signal: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (signal.aborted) throw signal.reason;
      await this.waitForGate(signal);
      try {
        const response = await fetchWithTimeout(
          `${API_BASE}${path}`,
          {
            headers: {
              Accept: "application/json",
              "User-Agent": "SRCTools-Worker/1.0.0",
              "X-API-Key": this.apiKey,
            },
            redirect: "error",
          },
          signal,
        );

        if (response.ok) return (await response.json()) as T;

        // Consume the body so undici can release/reuse the connection. It is not
        // logged: upstream error text is untrusted and may quote request data.
        await response.arrayBuffer().catch(() => undefined);
        const retryable = response.status === 420 || response.status === 429 || response.status >= 500;
        const error = new Error(`Speedrun.com returned HTTP ${response.status}.`);
        if (!retryable || attempt === MAX_ATTEMPTS) throw error;
        const retryAfter = retryAfterMs(response) ?? backoffMs(attempt);
        console.warn(`[Speedrun.com] HTTP ${response.status}; retrying in ${retryAfter}ms`);
        await sleep(retryAfter, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        lastError = error;
        if (attempt === MAX_ATTEMPTS || isNonRetryableApiError(error)) throw error;
        const delay = backoffMs(attempt);
        console.warn(`[Speedrun.com] Request failed; retrying in ${delay}ms: ${messageOf(error)}`);
        await sleep(delay, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Speedrun.com request failed.");
  }

  private async waitForGate(signal: AbortSignal): Promise<void> {
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    if (wait > 0) await sleep(wait, signal);
    this.nextRequestAt = Date.now() + MIN_REQUEST_GAP_MS;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  parentSignal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Request timed out.")), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(300_000, Math.max(1_000, seconds * 1000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(300_000, Math.max(1_000, date - Date.now())) : null;
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 400 * 2 ** attempt + Math.floor(Math.random() * 250));
}

function isNonRetryableApiError(error: unknown): boolean {
  return error instanceof Error && /^Speedrun\.com returned HTTP (4\d\d|3\d\d)/.test(error.message)
    && !error.message.includes("HTTP 420")
    && !error.message.includes("HTTP 429");
}

export function normalizeRun(run: RawRun, variables: RawVariable[] = []): RunSummary {
  const game = embeddedObject(run.game);
  const category = embeddedObject(run.category);
  const level = embeddedObject(run.level);
  const gameId = resourceId(run.game);
  const baseCategory = stringAt(category, "name");
  const subcategories = subcategoryLabels(run.values, variables);
  const categoryName = [baseCategory, ...subcategories].filter(isString).join(" ") || null;
  const secondsRaw = run.times?.primary_t;
  const primarySeconds =
    typeof secondsRaw === "number" && Number.isFinite(secondsRaw) && secondsRaw > 0
      ? secondsRaw
      : null;

  return {
    id: cleanLine(run.id, 128) || "unknown",
    runUrl: httpUrl(run.weblink),
    gameId,
    gameName:
      nestedString(game, "names", "international") ??
      stringAt(game, "abbreviation") ??
      gameId,
    categoryName,
    mapName: stringAt(level, "name") ?? (subcategories.join(" ") || baseCategory),
    runner: playerNames(run.players).join(", ") || "Unknown runner",
    primarySeconds,
    timeDisplay: primarySeconds === null ? null : formatDuration(primarySeconds),
    submitted: asString(run.submitted),
    verifyDate: asString(run.status?.["verify-date"]),
    rejectionReason: cleanOptionalText(asString(run.status?.reason), 2000),
  };
}

function subcategoryLabels(
  selected: Record<string, unknown> | undefined,
  variables: RawVariable[],
): string[] {
  const labels: string[] = [];
  if (selected) {
    for (const variable of variables) {
      if (variable["is-subcategory"] !== true) continue;
      const valueId = selected[variable.id];
      if (typeof valueId !== "string") continue;
      const label = cleanOptionalLine(
        asString(variable.values?.values?.[valueId]?.label),
        256,
      );
      if (label) labels.push(label);
    }
  }
  return labels;
}

function embeddedObject(value: unknown): ApiRecord | null {
  if (!isRecord(value)) return null;
  const data = value.data;
  return isRecord(data) ? data : value;
}

function resourceId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return cleanLine(value, 128);
  const object = embeddedObject(value);
  return stringAt(object, "id");
}

function playerNames(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : [];
  return items
    .map((item) => {
      if (!isRecord(item)) return null;
      if (item.rel === "guest") return cleanOptionalLine(asString(item.name), 128);
      return (
        nestedString(item, "names", "international") ??
        nestedString(item, "names", "japanese") ??
        cleanOptionalLine(asString(item.name), 128) ??
        cleanOptionalLine(asString(item.id), 128)
      );
    })
    .filter((name): name is string => name !== null);
}

function isRecord(value: unknown): value is ApiRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: string | null): value is string {
  return value !== null;
}

function hasValues(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringAt(value: ApiRecord | null, key: string): string | null {
  return cleanOptionalLine(value ? asString(value[key]) : null, 256);
}

function nestedString(value: ApiRecord | null, outer: string, inner: string): string | null {
  if (!value || !isRecord(value[outer])) return null;
  return cleanOptionalLine(asString(value[outer][inner]), 256);
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanLine(value: string, max: number): string {
  return [...value]
    .map((character) => (character < " " ? " " : character))
    .join("")
    .trim()
    .slice(0, max);
}

function cleanOptionalLine(value: string | null, max: number): string | null {
  if (value === null) return null;
  const clean = cleanLine(value, max);
  return clean || null;
}

function cleanOptionalText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const clean = [...value]
    .filter((character) => character === "\n" || character >= " ")
    .join("")
    .trim()
    .slice(0, max);
  return clean || null;
}

export function formatDuration(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const milliseconds = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const base =
    hours > 0
      ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`
      : minutes > 0
        ? `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
        : `${remainingSeconds}`;
  return milliseconds === 0 ? base : `${base}.${milliseconds.toString().padStart(3, "0")}`;
}

export function compactDuration(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  return `${Math.floor(totalMs / 60_000)}m ${Math.floor(totalMs / 1000) % 60}s ${(totalMs % 1000).toString().padStart(3, "0")}ms`;
}

export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
