import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FeedKind, RunSummary } from "./types.js";

const SEEN_CAPACITY = 600;
const MAX_DELIVERY_ATTEMPTS = 6;

export interface OutboxRecord {
  id: number;
  kind: FeedKind;
  runId: string;
  run: RunSummary;
  attempts: number;
}

interface ApplyFeedPage {
  accountId: string;
  feedKey: string;
  kind: FeedKind;
  runs: RunSummary[];
}

export class StateStore {
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ":memory:") mkdirSync(path.dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.database.exec("PRAGMA journal_mode = DELETE");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS feed_state (
        feed_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        primed INTEGER NOT NULL DEFAULT 0,
        high_water TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen_runs (
        feed_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (feed_key, run_id)
      );
      CREATE INDEX IF NOT EXISTS seen_runs_order ON seen_runs(feed_key, seen_at);
      CREATE TABLE IF NOT EXISTS incomplete_runs (
        feed_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (feed_key, run_id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        run_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        delivered_at INTEGER,
        failed_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_pending
        ON outbox(delivered_at, failed_at, next_attempt_at, id);
    `);
  }

  applyFeedPage(input: ApplyFeedPage): number {
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.database
        .prepare("SELECT primed, high_water FROM feed_state WHERE feed_key = ?")
        .get(input.feedKey) as { primed: number; high_water: string | null } | undefined;
      const primed = state?.primed === 1;
      const highWater = state?.high_water ?? null;
      let inserted = 0;

      const hasSeen = this.database.prepare(
        "SELECT 1 AS found FROM seen_runs WHERE feed_key = ? AND run_id = ?",
      );
      const remember = this.database.prepare(
        "INSERT OR IGNORE INTO seen_runs(feed_key, run_id, seen_at) VALUES (?, ?, ?)",
      );
      const hasIncomplete = this.database.prepare(
        "SELECT 1 AS found FROM incomplete_runs WHERE feed_key = ? AND run_id = ?",
      );
      const rememberIncomplete = this.database.prepare(
        "INSERT OR IGNORE INTO incomplete_runs(feed_key, run_id, first_seen_at) VALUES (?, ?, ?)",
      );
      const clearIncomplete = this.database.prepare(
        "DELETE FROM incomplete_runs WHERE feed_key = ? AND run_id = ?",
      );
      const addOutbox = this.database.prepare(`
        INSERT OR IGNORE INTO outbox(
          event_key, kind, run_id, payload_json, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const run of input.runs) {
        if (run.runUrl === null) {
          rememberIncomplete.run(input.feedKey, run.id, now);
          continue;
        }
        const alreadySeen = hasSeen.get(input.feedKey, run.id) !== undefined;
        const wasIncomplete = hasIncomplete.get(input.feedKey, run.id) !== undefined;
        const stamp = watermark(input.kind, run);
        const olderThanWatermark =
          !wasIncomplete &&
          input.kind !== "rejected" &&
          stamp !== null &&
          highWater !== null &&
          stamp < highWater;
        if (primed && !alreadySeen && !olderThanWatermark) {
          const result = addOutbox.run(
            `${input.accountId}:${input.kind}:${run.id}`,
            input.kind,
            run.id,
            JSON.stringify(run),
            now,
            now,
          );
          inserted += Number(result.changes);
        }
        remember.run(input.feedKey, run.id, now);
        clearIncomplete.run(input.feedKey, run.id);
      }

      const pageHigh = input.runs
        .filter((run) => run.runUrl !== null)
        .map((run) => watermark(input.kind, run))
        .filter((value): value is string => value !== null)
        .reduce<string | null>((highest, value) => (highest === null || value > highest ? value : highest), null);
      const nextHigh = [highWater, pageHigh]
        .filter((value): value is string => value !== null)
        .reduce<string | null>((highest, value) => (highest === null || value > highest ? value : highest), null);

      this.database
        .prepare(`
          INSERT INTO feed_state(feed_key, kind, primed, high_water, updated_at)
          VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(feed_key) DO UPDATE SET
            primed = 1,
            high_water = excluded.high_water,
            updated_at = excluded.updated_at
        `)
        .run(input.feedKey, input.kind, nextHigh, now);

      this.database
        .prepare(`
          DELETE FROM seen_runs
          WHERE feed_key = ?
            AND rowid NOT IN (
              SELECT rowid FROM seen_runs
              WHERE feed_key = ?
              ORDER BY seen_at DESC, rowid DESC
              LIMIT ?
            )
        `)
        .run(input.feedKey, input.feedKey, SEEN_CAPACITY);
      this.database.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  pendingOutbox(limit = 20): OutboxRecord[] {
    const rows = this.database
      .prepare(`
        SELECT id, kind, run_id, payload_json, attempts
        FROM outbox
        WHERE delivered_at IS NULL
          AND failed_at IS NULL
          AND next_attempt_at <= ?
        ORDER BY id
        LIMIT ?
      `)
      .all(Date.now(), limit) as Array<{
      id: number | bigint;
      kind: string;
      run_id: string;
      payload_json: string;
      attempts: number | bigint;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind as FeedKind,
      runId: row.run_id,
      run: JSON.parse(row.payload_json) as RunSummary,
      attempts: Number(row.attempts),
    }));
  }

  markDelivered(id: number): void {
    this.database
      .prepare("UPDATE outbox SET delivered_at = ?, last_error = NULL WHERE id = ?")
      .run(Date.now(), id);
  }

  markDeliveryFailed(id: number, attempts: number, error: string, permanent: boolean): boolean {
    const exhausted = permanent || attempts >= MAX_DELIVERY_ATTEMPTS;
    const now = Date.now();
    const delay = Math.min(15 * 60_000, 5_000 * 4 ** Math.max(0, attempts - 1));
    this.database
      .prepare(`
        UPDATE outbox SET
          attempts = ?,
          next_attempt_at = ?,
          failed_at = ?,
          last_error = ?
        WHERE id = ?
      `)
      .run(
        attempts,
        now + delay,
        exhausted ? now : null,
        error.slice(0, 500),
        id,
      );
    return exhausted;
  }

  pendingCount(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM outbox WHERE delivered_at IS NULL AND failed_at IS NULL")
      .get() as { count: number | bigint };
    return Number(row.count);
  }

  failedCount(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM outbox WHERE failed_at IS NOT NULL")
      .get() as { count: number | bigint };
    return Number(row.count);
  }

  prune(): void {
    const deliveredBefore = Date.now() - 30 * 24 * 60 * 60_000;
    const failedBefore = Date.now() - 90 * 24 * 60 * 60_000;
    this.database
      .prepare("DELETE FROM outbox WHERE delivered_at < ? OR failed_at < ?")
      .run(deliveredBefore, failedBefore);
    this.database
      .prepare("DELETE FROM incomplete_runs WHERE first_seen_at < ?")
      .run(failedBefore);
  }

  close(): void {
    this.database.close();
  }
}

function watermark(kind: FeedKind, run: RunSummary): string | null {
  if (kind === "newRun") return run.submitted;
  if (kind === "approved") return run.verifyDate;
  return null;
}
