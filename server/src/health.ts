import { createServer, type Server } from "node:http";

import type { WorkerHealth } from "./worker.js";

export async function startHealthServer(
  port: number,
  checkIntervalMs: number,
  snapshot: () => WorkerHealth,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "not_found" }));
      return;
    }

    const worker = snapshot();
    const staleAfter = Math.max(5 * 60_000, checkIntervalMs * 5);
    const stale =
      worker.lastSuccessAt === null ||
      Date.now() - Date.parse(worker.lastSuccessAt) > staleAfter;
    const degraded = stale || worker.failedWebhooks > 0;
    // A historical failed outbox row stays visible in the response body, but it
    // must not make every later Railway deployment fail its readiness check.
    response.writeHead(stale ? 503 : 200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ status: degraded ? "degraded" : "ok", worker }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(`[Health] Listening on 0.0.0.0:${port}/health`);
  return server;
}

export async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, 5_000);
    server.close((error) => {
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    });
  });
}
