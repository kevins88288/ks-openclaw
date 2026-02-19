/**
 * Redis Orchestrator Plugin for OpenClaw
 *
 * Phase 1: Durable job tracking with BullMQ
 *
 * Adds reliability around existing sessions_spawn/sessions_send by tracking
 * jobs in Redis-backed BullMQ queues. Survives gateway restarts, retries on
 * failure, alerts on DLQ.
 */

import type { Worker } from "bullmq";
import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk";
import { registerApprovalCommands } from "./src/approval-commands.js";
import type { QueueCircuitBreaker } from "./src/circuit-breaker.js";
import { registerQueueCommands } from "./src/cli-commands.js";
import { redisOrchestratorConfigSchema } from "./src/config-schema.js";
import type { DLQAlerter } from "./src/dlq-alerting.js";
import {
  createAfterToolCallHook,
  createAgentEndHook,
  createSessionsSendRetryHook,
} from "./src/hooks.js";
import type { JobTracker } from "./src/job-tracker.js";
import { registerReactionHandler } from "./src/reaction-handler.js";
import type { RedisConnection } from "./src/redis-connection.js";
import { createRedisOrchestratorService } from "./src/service.js";
import { createQueueActivityTool } from "./src/tools/queue-activity.js";
import { createQueueAddLearningTool } from "./src/tools/queue-add-learning.js";
import { createQueueDispatchTool } from "./src/tools/queue-dispatch.js";
import { createQueueLearningsTool } from "./src/tools/queue-learnings.js";
import { createQueueListTool } from "./src/tools/queue-list.js";
import { createQueueStatusTool } from "./src/tools/queue-status.js";

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

    // Phase 3.5 Batch 3: Register learning index tools
    api.registerTool((ctx) => createQueueAddLearningTool(state, ctx), {
      name: "queue_add_learning",
    });

    api.registerTool((ctx) => createQueueLearningsTool(state, ctx), {
      name: "queue_learnings",
    });

    // Phase 3.6 Batch 2: Register approval workflow commands
    registerApprovalCommands(api, state);

    // Phase 3.7 Piece 3: Register reaction-based approve/reject handler
    registerReactionHandler(api, state);

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
