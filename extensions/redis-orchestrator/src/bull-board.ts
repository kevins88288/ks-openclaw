/**
 * Bull Board Monitoring Dashboard — Task 3.11
 *
 * Mounts the Bull Board UI at /queue on the gateway HTTP server.
 * Read-only, bearer token authentication, timing-safe comparison.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import type { Queue } from "bullmq";
import express from "express";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { RedisOrchestratorConfig } from "./config-schema.js";

const BULL_BOARD_PATH = "/queue";

/**
 * Mount Bull Board on the gateway HTTP server.
 *
 * If no authToken is configured, the endpoint is fully disabled (404).
 * Otherwise, requires Bearer token authentication with timing-safe comparison.
 * All queue adapters are read-only.
 */
export function mountBullBoard(
  api: OpenClawPluginApi,
  queues: Queue[],
): { addQueue: (queue: Queue) => void } | undefined {
  const config = api.pluginConfig as RedisOrchestratorConfig | undefined;
  const authToken = config?.bullBoard?.authToken;

  if (!authToken) {
    api.logger.info("Bull Board disabled — no authToken configured");
    return undefined;
  }

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);

  const board = createBullBoard({
    // NOTE: readOnlyMode hides mutation UI but does NOT block Bull Board's API endpoints.
    // The Bearer token in handleAuth() is the actual security boundary.
    queues: queues.map((q) => new BullMQAdapter(q, { readOnlyMode: true })),
    serverAdapter,
    options: { uiConfig: { boardTitle: "OpenClaw Queue Monitor" } },
  });

  const app = express();
  app.use(BULL_BOARD_PATH, serverAdapter.getRouter());

  // Use registerHttpHandler (prefix-based) instead of registerHttpRoute (exact match)
  // because Bull Board serves sub-routes: /queue/api/*, /queue/static/*, etc.
  api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Only handle /queue and /queue/* paths
    if (url.pathname !== BULL_BOARD_PATH && !url.pathname.startsWith(`${BULL_BOARD_PATH}/`)) {
      return false;
    }

    // Auth check: extract and validate bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return true;
    }

    const token = authHeader.slice(7);
    const expected = Buffer.from(authToken);
    const received = Buffer.from(token);

    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return true;
    }

    // Delegate to Express app (handles /queue/*)
    return new Promise<boolean>((resolve) => {
      app(req, res, () => {
        // If Express doesn't handle it (next() called), mark as unhandled
        resolve(false);
      });
      // Express handled it if next() was never called
      // We detect completion when the response finishes
      res.once("finish", () => resolve(true));
    });
  });

  api.logger.info("Bull Board mounted at /queue (read-only, auth required)");

  return {
    addQueue: (queue: Queue) => {
      board.addQueue(new BullMQAdapter(queue, { readOnlyMode: true }));
    },
  };
}
