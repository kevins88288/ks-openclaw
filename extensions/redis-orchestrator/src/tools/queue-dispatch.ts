/**
 * queue_dispatch Tool — Phase 2
 *
 * Creates a BullMQ job in an agent queue and returns immediately.
 * The Worker service picks up jobs and launches child sessions.
 *
 * Phase 3 Task 3.12: When the circuit breaker is open (Redis down),
 * falls back to direct sessions_spawn via callGateway so agent work
 * continues even without Redis.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext, AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, readStringParam, optionalStringEnum } from "openclaw/plugin-sdk";
// COUPLING: not in plugin-sdk — tracks src/config/config.js. File SDK exposure request if this breaks.
import { loadConfig } from "../../../../src/config/config.js";
// COUPLING: not in plugin-sdk — tracks src/routing/session-key.js. File SDK exposure request if this breaks.
import { normalizeAgentId, parseAgentSessionKey } from "../../../../src/routing/session-key.js";
// COUPLING: not in plugin-sdk — tracks src/agents/agent-scope.js. File SDK exposure request if this breaks.
import { resolveAgentConfig } from "../../../../src/agents/agent-scope.js";
// COUPLING: not in plugin-sdk — tracks src/agents/subagent-depth.js. File SDK exposure request if this breaks.
import { getSubagentDepthFromSessionStore } from "../../../../src/agents/subagent-depth.js";
// COUPLING: not in plugin-sdk — tracks src/utils/delivery-context.js. File SDK exposure request if this breaks.
import { normalizeDeliveryContext } from "../../../../src/utils/delivery-context.js";
// COUPLING: not in plugin-sdk — tracks src/gateway/call.js. File SDK exposure request if this breaks.
import { callGateway } from "../../../../src/gateway/call.js";
import type { PluginState } from "../../index.js";

const QueueDispatchSchema = Type.Object({
  target: Type.String({ description: "Agent ID to dispatch work to" }),
  task: Type.String({ description: "The instruction/prompt for the agent", maxLength: 50000 }),
  label: Type.Optional(Type.String({ description: "Label for this dispatch" })),
  project: Type.Optional(Type.String({ description: "Project/repo context" })),
  model: Type.Optional(Type.String({ description: "Model override (provider/model)" })),
  thinking: Type.Optional(Type.String({ description: "Thinking level override" })),
  runTimeoutSeconds: Type.Optional(
    Type.Number({ minimum: 0, description: "Timeout in seconds (0 = no timeout)" }),
  ),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), {
      description: "List of jobIds that must complete before this job starts (single level only, fail-fast)",
      maxItems: 20,
    }),
  ),
});

/** Simple warn logger — tool context doesn't expose logger, so use console */
function warnLog(msg: string): void {
  console.warn(`[redis-orchestrator] ${msg}`);
}

export function createQueueDispatchTool(
  state: PluginState,
  ctx: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    label: "Queue",
    name: "queue_dispatch",
    description:
      "Dispatch a task to an agent queue for durable, tracked execution. Returns immediately with a jobId. The Worker service processes the job and the announce pipeline delivers results.",
    parameters: QueueDispatchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      // Phase 3 Task 3.12: If Redis orchestrator never started (no connection at all),
      // fall back to direct sessions_spawn immediately
      if (!state.jobTracker || !state.circuitBreaker || !state.connection) {
        warnLog(
          `queue_dispatch: orchestrator not running — falling back to sessions_spawn for target=${normalizeAgentId(readStringParam(params, "target", { required: true }))}`,
        );

        // We still need to parse params and validate target before fallback
        // Parse happens below, but we need target now for the fallback
        const fallbackTarget = normalizeAgentId(readStringParam(params, "target", { required: true }));
        const fallbackTask = readStringParam(params, "task", { required: true });
        const fallbackLabel = readStringParam(params, "label");
        const fallbackModel = readStringParam(params, "model");
        const fallbackThinking = readStringParam(params, "thinking");
        const fallbackCleanup =
          params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
        const fallbackTimeout =
          typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
            ? Math.max(0, Math.floor(params.runTimeoutSeconds))
            : 0;

        try {
          const spawnParams: Record<string, unknown> = {
            task: fallbackTask,
            agentId: fallbackTarget,
            runTimeoutSeconds: fallbackTimeout || undefined,
            cleanup: fallbackCleanup,
          };
          if (fallbackLabel) spawnParams.label = fallbackLabel;
          if (fallbackModel) spawnParams.model = fallbackModel;
          if (fallbackThinking) spawnParams.thinking = fallbackThinking;

          const response = await callGateway<{ runId?: string }>({
            method: "sessions.spawn",
            params: spawnParams,
            timeoutMs: 15_000,
          });

          return jsonResult({
            jobId: response?.runId ?? `fallback-${Date.now()}`,
            status: "dispatched",
            target: fallbackTarget,
            fallback: true,
            fallbackReason: "orchestrator_unavailable",
          });
        } catch (fallbackErr) {
          return jsonResult({
            status: "error",
            error: `Orchestrator unavailable and fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
          });
        }
      }

      // Parse parameters
      const target = readStringParam(params, "target", { required: true });
      const task = readStringParam(params, "task", { required: true });
      
      // Validate task length
      if (task.length > 50000) {
        return jsonResult({ status: "error", error: "Task exceeds 50KB limit" });
      }
      
      const label = readStringParam(params, "label");
      const project = readStringParam(params, "project");
      const model = readStringParam(params, "model");
      const thinking = readStringParam(params, "thinking");
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const runTimeoutSeconds =
        typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
          ? Math.max(0, Math.floor(params.runTimeoutSeconds))
          : 0;

      // Phase 3 Task 3.10: dependsOn — single-level dependency chains
      const dependsOn = Array.isArray(params.dependsOn)
        ? (params.dependsOn as string[]).filter((id) => typeof id === "string" && id.trim())
        : undefined;

      const cfg = loadConfig();

      // Resolve dispatcher identity
      const dispatcherSessionKey = ctx.sessionKey ?? "";
      const dispatcherAgentId = normalizeAgentId(
        ctx.agentId ?? parseAgentSessionKey(dispatcherSessionKey)?.agentId,
      );
      const targetAgentId = normalizeAgentId(target);

      // Validate target agent exists
      const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
      if (!targetAgentConfig) {
        return jsonResult({
          status: "error",
          error: `Unknown target agent: ${targetAgentId}`,
        });
      }

      // Validate allowlist — dispatcher must be allowed to spawn target
      if (targetAgentId !== dispatcherAgentId) {
        const allowAgents =
          resolveAgentConfig(cfg, dispatcherAgentId)?.subagents?.allowAgents ?? [];
        const allowAny = allowAgents.some((v) => v.trim() === "*");
        const normalizedTargetId = targetAgentId.toLowerCase();
        const allowSet = new Set(
          allowAgents
            .filter((v) => v.trim() && v.trim() !== "*")
            .map((v) => normalizeAgentId(v).toLowerCase()),
        );
        if (!allowAny && !allowSet.has(normalizedTargetId)) {
          const allowedText = allowAny
            ? "*"
            : allowSet.size > 0
              ? Array.from(allowSet).join(", ")
              : "none";
          return jsonResult({
            status: "forbidden",
            error: `Target agent "${targetAgentId}" is not in allowAgents (allowed: ${allowedText})`,
          });
        }
      }

      // --- Rate limiting (Phase 3 Task 3.4) ---
      const callerAgentId = dispatcherAgentId;
      const pluginConfig = state.pluginConfig as Record<string, any> | undefined;
      const rateLimitConfig = pluginConfig?.rateLimit as Record<string, unknown> | undefined;
      const dispatchesPerMinute = (rateLimitConfig?.dispatchesPerMinute as number) ?? 10;
      const maxQueueDepth = (rateLimitConfig?.maxQueueDepth as number) ?? 50;

      // Check per-agent rate limit (Redis-based counter with 60s TTL)
      if (dispatchesPerMinute > 0) {
        const rateLimitKey = `ratelimit:dispatch:${callerAgentId}`;
        const current = await state.connection.incr(rateLimitKey);
        if (current === 1) {
          // First dispatch in this window — set TTL
          await state.connection.expire(rateLimitKey, 60);
        }
        if (current > dispatchesPerMinute) {
          return jsonResult({
            status: "rate_limited",
            error: `Rate limit exceeded: ${current}/${dispatchesPerMinute} dispatches this minute`,
          });
        }
      }

      // Check per-agent queue depth cap
      if (maxQueueDepth > 0) {
        const targetQueueName = `agent-${targetAgentId}`;
        const targetQueue = state.jobTracker.getOrCreateQueue(targetQueueName);
        const counts = await targetQueue.getJobCounts("wait", "delayed", "active");
        const pendingCount = (counts.wait || 0) + (counts.delayed || 0) + (counts.active || 0);
        if (pendingCount >= maxQueueDepth) {
          return jsonResult({
            status: "queue_full",
            error: `Queue depth exceeded: ${pendingCount}/${maxQueueDepth} pending jobs for agent ${targetAgentId}`,
          });
        }
      }

      // Get dispatcher depth for the Worker to validate later
      const dispatcherDepth = getSubagentDepthFromSessionStore(dispatcherSessionKey, { cfg });

      // Build dispatcher origin from tool context
      const dispatcherOrigin = normalizeDeliveryContext({
        channel: ctx.messageChannel,
        accountId: ctx.agentAccountId,
      });

      // Create BullMQ job via circuit breaker, with sessions_spawn fallback
      try {
        const jobId = await state.circuitBreaker.dispatch(
          async () => {
            return await state.jobTracker!.createJob({
              target: targetAgentId,
              task,
              dispatchedBy: dispatcherAgentId,
              project,
              timeoutMs: runTimeoutSeconds ? runTimeoutSeconds * 1000 : undefined,
              // Phase 2 dispatcher context
              dispatcherSessionKey,
              dispatcherAgentId,
              dispatcherDepth,
              dispatcherOrigin,
              label,
              model,
              thinking,
              cleanup,
              dependsOn,
            });
          },
          // Phase 3 Task 3.12: Fallback to direct sessions_spawn when circuit is open
          async () => {
            warnLog(
              `queue_dispatch: circuit breaker open — falling back to sessions_spawn for target=${targetAgentId}`,
            );

            const spawnParams: Record<string, unknown> = {
              task,
              agentId: targetAgentId,
              runTimeoutSeconds: runTimeoutSeconds || undefined,
              cleanup,
            };
            if (label) spawnParams.label = label;
            if (model) spawnParams.model = model;
            if (thinking) spawnParams.thinking = thinking;

            const response = await callGateway<{ runId?: string; sessionKey?: string }>({
              method: "sessions.spawn",
              params: spawnParams,
              timeoutMs: 15_000,
            });

            const fallbackRunId = response?.runId ?? `fallback-${Date.now()}`;

            // Return a sentinel value that signals fallback mode
            return `__fallback__:${fallbackRunId}`;
          },
        );

        // Detect fallback vs normal path
        if (typeof jobId === "string" && jobId.startsWith("__fallback__:")) {
          const fallbackRunId = jobId.slice("__fallback__:".length);
          return jsonResult({
            jobId: fallbackRunId,
            status: "dispatched",
            target: targetAgentId,
            fallback: true,
            fallbackReason: "circuit_open",
          });
        }

        return jsonResult({
          jobId,
          status: "queued",
          target: targetAgentId,
        });
      } catch (err) {
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
