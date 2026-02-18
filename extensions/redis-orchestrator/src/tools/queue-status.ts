/**
 * queue_status Tool — Phase 2 Batch 2
 *
 * Look up the status of a specific job by jobId.
 * Uses the Redis job index for O(1) lookup.
 *
 * Phase 3: Cross-agent authorization — agents can only see jobs they dispatched or that target them.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext, AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import type { PluginState } from "../../index.js";
import { formatRelativeTime } from "../utils.js";
import { isSystemAgent, stripSensitiveFields } from "../auth-helpers.js";

const QueueStatusSchema = Type.Object({
  jobId: Type.String({ description: "Job ID to look up" }),
});

export function createQueueStatusTool(
  state: PluginState,
  ctx: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    label: "Queue Status",
    name: "queue_status",
    description:
      "Look up the status of a specific job by jobId. Returns job details including status, timestamps, result, and error.",
    parameters: QueueStatusSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      // Validate plugin state
      if (!state.jobTracker) {
        return jsonResult({
          status: "error",
          error: "Redis orchestrator is not running.",
        });
      }

      const jobId = readStringParam(params, "jobId", { required: true });
      const callerAgentId = ctx.agentId ?? "";

      try {
        // Use jobTracker.findJobByRunId which uses the Redis index
        const jobData = await state.jobTracker.findJobByRunId(jobId);

        if (!jobData) {
          // Phase 3 Task 3.12: Detect fallback-dispatched jobs
          if (jobId.startsWith("fallback-")) {
            return jsonResult({
              jobId,
              status: "unknown",
              message: "Job tracked via fallback — no BullMQ record. Check sessions_spawn output directly.",
              fallback: true,
            });
          }

          return jsonResult({
            status: "not_found",
            error: `Job ${jobId} not found`,
          });
        }

        // Phase 3 Task 3.10: Check if job is waiting for dependencies
        let waitingForDependencies = false;
        if (jobData.dependsOn && jobData.dependsOn.length > 0) {
          // Check BullMQ job state — "waiting-children" means dependencies haven't completed
          const queueName = await state.jobTracker.findQueueForJob(jobId);
          if (queueName) {
            const queue = state.jobTracker.getOrCreateQueue(queueName);
            const bullJob = await queue.getJob(jobId);
            if (bullJob) {
              const bullState = await bullJob.getState();
              waitingForDependencies = bullState === "waiting-children";
            }
          }
        }

        // Phase 3 Task 3.3: Cross-agent authorization
        if (!isSystemAgent(callerAgentId)) {
          const isDispatcher = jobData.dispatchedBy === callerAgentId;
          const isTarget = jobData.target === callerAgentId;
          if (!isDispatcher && !isTarget) {
            return jsonResult({
              status: "unauthorized",
              error: "Unauthorized: you can only view jobs you dispatched or that target you.",
            });
          }
        }

        // Format timestamps
        const result: Record<string, unknown> = {
          jobId: jobData.jobId,
          status: jobData.status,
          target: jobData.target,
          task: jobData.task,
          dispatchedBy: jobData.dispatchedBy,
          queuedAt: {
            relative: formatRelativeTime(jobData.queuedAt),
            absolute: new Date(jobData.queuedAt).toISOString(),
          },
        };

        if (jobData.startedAt) {
          result.startedAt = {
            relative: formatRelativeTime(jobData.startedAt),
            absolute: new Date(jobData.startedAt).toISOString(),
          };
        }

        if (jobData.completedAt) {
          result.completedAt = {
            relative: formatRelativeTime(jobData.completedAt),
            absolute: new Date(jobData.completedAt).toISOString(),
          };
        }

        if (jobData.result) {
          result.result = jobData.result;
        }

        if (jobData.error) {
          result.error = jobData.error;
        }

        if (jobData.openclawRunId) {
          result.openclawRunId = jobData.openclawRunId;
        }

        if (jobData.openclawSessionKey) {
          result.openclawSessionKey = jobData.openclawSessionKey;
        }

        if (jobData.label) {
          result.label = jobData.label;
        }

        if (jobData.project) {
          result.project = jobData.project;
        }

        // Phase 3 Task 3.10: Include dependency info
        if (jobData.dependsOn && jobData.dependsOn.length > 0) {
          result.dependsOn = jobData.dependsOn;
          result.waitingForDependencies = waitingForDependencies;
        }

        // Strip sensitive fields for non-system agents
        return jsonResult(stripSensitiveFields(result, callerAgentId));
      } catch (err) {
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
