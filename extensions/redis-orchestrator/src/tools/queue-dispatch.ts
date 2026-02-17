/**
 * queue_dispatch Tool — Phase 2
 *
 * Creates a BullMQ job in an agent queue and returns immediately.
 * The Worker service picks up jobs and launches child sessions.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { jsonResult, readStringParam } from "../../../../src/agents/tools/common.js";
import { loadConfig } from "../../../../src/config/config.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../../../src/routing/session-key.js";
import { resolveAgentConfig } from "../../../../src/agents/agent-scope.js";
import { getSubagentDepthFromSessionStore } from "../../../../src/agents/subagent-depth.js";
import { normalizeDeliveryContext } from "../../../../src/utils/delivery-context.js";
import { optionalStringEnum } from "../../../../src/agents/schema/typebox.js";
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
});

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

      // Validate plugin state
      if (!state.jobTracker || !state.circuitBreaker) {
        return jsonResult({
          status: "error",
          error: "Redis orchestrator is not running. Use sessions_spawn as fallback.",
        });
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

      // Get dispatcher depth for the Worker to validate later
      const dispatcherDepth = getSubagentDepthFromSessionStore(dispatcherSessionKey, { cfg });

      // Build dispatcher origin from tool context
      const dispatcherOrigin = normalizeDeliveryContext({
        channel: ctx.messageChannel,
        accountId: ctx.agentAccountId,
      });

      // Create BullMQ job via circuit breaker
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
            });
          },
          async () => {
            throw new Error(
              "Redis circuit breaker is open. Use sessions_spawn as fallback.",
            );
          },
        );

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
