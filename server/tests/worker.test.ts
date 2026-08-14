import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildEmbed } from "../src/discord.js";
import { closeServer, startHealthServer } from "../src/health.js";
import { normalizeRun } from "../src/speedrun.js";
import { StateStore } from "../src/state.js";
import type { RawRun, RunSummary } from "../src/types.js";

const rawRun: RawRun = {
  id: "run-1",
  weblink: "https://www.speedrun.com/run/abc",
  game: {
    data: {
      id: "game-1",
      names: { international: "Bhop pro" },
    },
  },
  category: { data: { id: "category-1", name: "Speedrun" } },
  level: { data: { id: "level-1", name: "Niwa" } },
  players: {
    data: [{ id: "player-1", names: { international: "337Short337" } }],
  },
  times: { primary_t: 17.879 },
  submitted: "2026-08-14T10:00:00Z",
  status: { status: "new" },
};

test("normalizes the existing Speedrun.com embed fields", () => {
  const run = normalizeRun(rawRun);
  assert.equal(run.gameName, "Bhop pro");
  assert.equal(run.mapName, "Niwa");
  assert.equal(run.runner, "337Short337");
  assert.equal(run.timeDisplay, "17.879");
  assert.equal(run.runUrl, "https://www.speedrun.com/run/abc");
});

test("builds New Run and verified embeds with clickable run URLs", () => {
  const run = normalizeRun(rawRun);
  const fresh = buildEmbed("newRun", run);
  assert.equal(fresh.title, "🏆 New Run");
  assert.equal(fresh.url, run.runUrl);
  assert.match(fresh.description ?? "", /Niwa in 0m 17s 879ms by 337Short337/);
  assert.match(fresh.description ?? "", /\[View run\]\(https:\/\/www\.speedrun\.com\/run\/abc\)/);

  const verified = buildEmbed("approved", {
    ...run,
    primarySeconds: 7342.022,
    timeDisplay: "2:02:22.022",
  });
  assert.equal(verified.title, "✅ Run verified");
  assert.equal(verified.url, run.runUrl);
  assert.deepEqual(verified.fields?.map((field) => field.name), ["Game", "Runner", "Map", "Time"]);
  assert.equal(verified.fields?.[3]?.value, "2:02:22.022");
  assert.doesNotMatch(JSON.stringify(verified), /Category|Status|Video|No video link/);
});

test("persists baselines and enqueues each event only once", () => {
  const state = new StateStore(":memory:");
  const run = normalizeRun(rawRun);
  const input = {
    accountId: "account-1",
    feedKey: "account-1:scope-1:newRun",
    kind: "newRun" as const,
  };

  assert.equal(state.applyFeedPage({ ...input, runs: [run] }), 0, "first page is a baseline");
  const later: RunSummary = {
    ...run,
    id: "run-2",
    runUrl: "https://www.speedrun.com/run/def",
    submitted: "2026-08-14T10:01:00Z",
  };
  assert.equal(state.applyFeedPage({ ...input, runs: [later, run] }), 1);
  assert.equal(state.applyFeedPage({ ...input, runs: [later, run] }), 0);
  assert.equal(state.pendingCount(), 1);
  assert.equal(state.pendingOutbox()[0]?.runId, "run-2");
  state.close();
});

test("keeps pending and verified event identities independent", () => {
  const state = new StateStore(":memory:");
  const run = normalizeRun(rawRun);
  state.applyFeedPage({
    accountId: "account-1",
    feedKey: "account-1:scope:newRun",
    kind: "newRun",
    runs: [],
  });
  state.applyFeedPage({
    accountId: "account-1",
    feedKey: "account-1:scope:approved",
    kind: "approved",
    runs: [],
  });
  assert.equal(
    state.applyFeedPage({
      accountId: "account-1",
      feedKey: "account-1:scope:newRun",
      kind: "newRun",
      runs: [run],
    }),
    1,
  );
  assert.equal(
    state.applyFeedPage({
      accountId: "account-1",
      feedKey: "account-1:scope:approved",
      kind: "approved",
      runs: [{ ...run, verifyDate: "2026-08-14T10:02:00Z" }],
    }),
    1,
  );
  assert.equal(state.pendingCount(), 2);
  state.close();
});

test("does not suppress distinct runs with the same timestamp", () => {
  const state = new StateStore(":memory:");
  const run = normalizeRun(rawRun);
  const input = {
    accountId: "account-1",
    feedKey: "account-1:scope:newRun",
    kind: "newRun" as const,
  };
  state.applyFeedPage({ ...input, runs: [run] });
  assert.equal(
    state.applyFeedPage({
      ...input,
      runs: [{ ...run, id: "run-same-time", runUrl: "https://www.speedrun.com/run/same" }],
    }),
    1,
  );
  state.close();
});

test("waits for a missing run URL instead of losing the event", () => {
  const state = new StateStore(":memory:");
  const run = normalizeRun(rawRun);
  const input = {
    accountId: "account-1",
    feedKey: "account-1:scope:newRun",
    kind: "newRun" as const,
  };
  state.applyFeedPage({ ...input, runs: [{ ...run, runUrl: null }] });
  assert.equal(state.applyFeedPage({ ...input, runs: [run] }), 1);
  assert.equal(state.pendingOutbox()[0]?.runId, run.id);
  state.close();
});

test("does not enqueue a delivered event again after reopening SQLite", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "srctools-worker-"));
  const file = path.join(directory, "state.sqlite");
  const run = normalizeRun(rawRun);
  const input = {
    accountId: "account-1",
    feedKey: "account-1:scope:newRun",
    kind: "newRun" as const,
  };
  try {
    const first = new StateStore(file);
    first.applyFeedPage({ ...input, runs: [] });
    assert.equal(first.applyFeedPage({ ...input, runs: [run] }), 1);
    const event = first.pendingOutbox()[0];
    assert.ok(event);
    first.markDelivered(event.id);
    first.close();

    const reopened = new StateStore(file);
    assert.equal(reopened.applyFeedPage({ ...input, runs: [run] }), 0);
    assert.equal(reopened.pendingCount(), 0);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("serves a live health endpoint", async () => {
  const now = new Date().toISOString();
  const server = await startHealthServer(0, 30_000, () => ({
    startedAt: now,
    lastCheckAt: now,
    lastSuccessAt: now,
    lastError: null,
    consecutiveFailures: 0,
    checking: false,
    scopedGames: 2,
    pendingWebhooks: 0,
    failedWebhooks: 0,
    lastDeliveryError: null,
    nextCheckAt: null,
  }));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; worker: { scopedGames: number } };
    assert.equal(body.status, "ok");
    assert.equal(body.worker.scopedGames, 2);
  } finally {
    await closeServer(server);
  }
});
