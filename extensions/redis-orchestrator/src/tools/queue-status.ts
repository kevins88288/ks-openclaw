/**
 * queue_status Tool — Phase 2 Batch 2
 *
 * Look up the status of a specific job by jobId.
 * Uses the Redis job index for O(1) lookup.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { jsonResult, readStringParam } from "../../../../src/agents/tools/common.js";
import type { PluginState } from "../../index.js";
import { formatRelativeTime } from "../utils.js";

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

      try {
        // Use jobTracker.findJobByRunId which uses the Redis index
        const jobData = await state.jobTracker.findJobByRunId(jobId);

        if (!jobData) {
          return jsonResult({
            status: "not_found",
            error: `Job ${jobId} not found`,
          });
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

        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
