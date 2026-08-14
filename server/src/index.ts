import process from "node:process";

import { loadConfig } from "./config.js";
import { closeServer, startHealthServer } from "./health.js";
import { StateStore } from "./state.js";
import { Worker } from "./worker.js";

const config = loadConfig();
const state = new StateStore(config.stateFile);
const worker = new Worker(config, state);
const healthServer = await startHealthServer(
  config.port,
  config.checkIntervalMs,
  () => worker.snapshot(),
);
const controller = new AbortController();

function requestShutdown(signal: string): void {
  if (controller.signal.aborted) return;
  console.log(`[Worker] ${signal} received; shutting down...`);
  controller.abort(new Error(signal));
}

process.once("SIGTERM", () => requestShutdown("SIGTERM"));
process.once("SIGINT", () => requestShutdown("SIGINT"));

try {
  await worker.run(controller.signal);
} finally {
  await closeServer(healthServer).catch((error: unknown) => {
    console.error(`[Health] Could not close cleanly: ${String(error)}`);
  });
  state.close();
}
