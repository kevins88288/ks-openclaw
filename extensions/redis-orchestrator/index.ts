/**
 * Redis Orchestrator Plugin for OpenClaw
 *
 * Phase 1: Durable job tracking with BullMQ
 *
 * Adds reliability around existing sessions_spawn/sessions_send by tracking
 * jobs in Redis-backed BullMQ queues. Survives gateway restarts, retries on
 * failure, alerts on DLQ.
 */

import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk";
import type { Worker } from "bullmq";
import type { QueueCircuitBreaker } from "./src/circuit-breaker.js";
import type { DLQAlerter } from "./src/dlq-alerting.js";
import type { JobTracker } from "./src/job-tracker.js";
import type { RedisConnection } from "./src/redis-connection.js";
import { redisOrchestratorConfigSchema } from "./src/config-schema.js";
import { registerQueueCommands } from "./src/cli-commands.js";
import {
  createAfterToolCallHook,
  createAgentEndHook,
  createSessionsSendRetryHook,
} from "./src/hooks.js";
import { createRedisOrchestratorService } from "./src/service.js";
import { createQueueDispatchTool } from "./src/tools/queue-dispatch.js";
import { createQueueStatusTool } from "./src/tools/queue-status.js";
import { createQueueListTool } from "./src/tools/queue-list.js";
import { createQueueActivityTool } from "./src/tools/queue-activity.js";

/**
 * Shared mutable state container.
 * Service.start() populates these; hooks read at call time (not registration time).
 * This avoids the null-capture bug where JS closures capture null by value.
 */
export interface PluginState {
  connection: RedisConnection | null;
  circuitBreaker: QueueCircuitBreaker | null;
  jobTracker: JobTracker | null;
  dlqAlerter: DLQAlerter | null;
  pluginConfig: Record<string, unknown> | undefined;
  workersMap: Map<string, Worker> | null;
  pluginApi: OpenClawPluginApi | null;
}

const state: PluginState = {
  connection: null,
  circuitBreaker: null,
  jobTracker: null,
  dlqAlerter: null,
  pluginConfig: undefined,
  workersMap: null,
  pluginApi: null,
};

const plugin: OpenClawPluginDefinition = {
  id: "redis-orchestrator",
  name: "Redis Orchestrator",
  description: "BullMQ-based orchestration layer for durable agent job tracking",
  version: "1.0.0",

  configSchema: redisOrchestratorConfigSchema,

  register(api: OpenClawPluginApi) {
    api.logger.info("redis-orchestrator: registering plugin");

    // Capture pluginConfig and api reference for deferred Bull Board mount
    state.pluginConfig = api.pluginConfig;
    state.pluginApi = api;

    // Register the background service — it owns init/teardown of shared state
    api.registerService(createRedisOrchestratorService(state));

    // Register after_tool_call hook to track sessions_spawn
    // Hooks receive the state *object reference* and read .jobTracker at call time
    api.on("after_tool_call", createAfterToolCallHook(state, api.logger));

    // Register agent_end hook to update job status
    api.on("agent_end", createAgentEndHook(state, api.logger));

    // Register sessions_send retry hook
    api.on("after_tool_call", createSessionsSendRetryHook(state, api.logger));

    // Phase 2: Register queue_dispatch tool
    api.registerTool((ctx) => createQueueDispatchTool(state, ctx), {
      name: "queue_dispatch",
    });

    // Phase 2 Batch 2: Register queue management tools
    api.registerTool((ctx) => createQueueStatusTool(state, ctx), {
      name: "queue_status",
    });

    api.registerTool((ctx) => createQueueListTool(state, ctx), {
      name: "queue_list",
    });

    api.registerTool((ctx) => createQueueActivityTool(state, ctx), {
      name: "queue_activity",
    });

    // Register CLI commands — connection created lazily inside each command
    api.registerCli(
      (ctx) => {
        registerQueueCommands(ctx.program, state, ctx);
      },
      {
        commands: ["queue"],
      },
    );

    api.logger.info("redis-orchestrator: plugin registered");
  },
};

export default plugin;
