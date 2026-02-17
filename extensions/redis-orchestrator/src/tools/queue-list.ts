/**
 * queue_list Tool — Phase 2 Batch 2
 *
 * List jobs across agent queues with optional filtering by agent and status.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { jsonResult, readStringParam, readNumberParam } from "../../../../src/agents/tools/common.js";
import { normalizeAgentId } from "../../../../src/routing/session-key.js";
import { loadConfig } from "../../../../src/config/config.js";
import { listAgentIds } from "../../../../src/agents/agent-scope.js";
import type { PluginState } from "../../index.js";
import type { AgentJob } from "../types.js";
import { formatRelativeTime, truncateTask } from "../utils.js";

const QueueListSchema = Type.Object({
  agent: Type.Optional(Type.String({ description: "Filter by agent ID (optional)" })),
  status: Type.Optional(
    Type.Union([
      Type.Literal("queued"),
      Type.Literal("active"),
      Type.Literal("completed"),
      Type.Literal("failed"),
    ], {
      description: "Filter by status: queued, active, completed, or failed (optional)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 100,
      default: 20,
      description: "Maximum number of jobs to return (default 20, max 100)",
    }),
  ),
});

type BullMQJobStatus = "wait" | "active" | "completed" | "failed" | "delayed" | "paused";

function mapStatusToBullMQ(status?: string): BullMQJobStatus[] {
  if (!status) return ["wait", "active", "completed", "failed"];
  
  switch (status) {
    case "queued":
      return ["wait", "delayed"];
    case "active":
      return ["active"];
    case "completed":
      return ["completed"];
    case "failed":
      return ["failed"];
    default:
      return ["wait", "active", "completed", "failed"];
  }
}

export function createQueueListTool(
  state: PluginState,
  ctx: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    label: "Queue List",
    name: "queue_list",
    description:
      "List jobs from agent queues. Optionally filter by agent and/or status. Returns job summaries with truncated task text.",
    parameters: QueueListSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      // Validate plugin state
      if (!state.jobTracker || !state.connection) {
        return jsonResult({
          status: "error",
          error: "Redis orchestrator is not running.",
        });
      }

      const agentFilter = readStringParam(params, "agent");
      const statusFilter = readStringParam(params, "status");
      const limit = readNumberParam(params, "limit") ?? 20;
      const cappedLimit = Math.min(Math.max(1, Math.floor(limit)), 100);

      const cfg = loadConfig();

      // Determine which agents to query
      const agentIds: string[] = [];
      if (agentFilter) {
        agentIds.push(normalizeAgentId(agentFilter));
      } else {
        // Query all agents from config
        const allAgents = listAgentIds(cfg).filter((id: string) => id !== "main");
        agentIds.push(...allAgents);
      }

      if (agentIds.length === 0) {
        return jsonResult({
          jobs: [],
          count: 0,
        });
      }

      // Map status filter to BullMQ job states
      const bullMQStates = mapStatusToBullMQ(statusFilter);

      try {
        const allJobs: Array<{
          jobId: string;
          target: string;
          task: string;
          status: string;
          queuedAt: string;
          queuedAtMs: number;
          startedAt?: string;
          completedAt?: string;
          label?: string;
        }> = [];

        // Query each agent queue
        for (const agentId of agentIds) {
          const queueName = `agent:${agentId}`;
          const queue = state.jobTracker.getOrCreateQueue(queueName);

          for (const bullState of bullMQStates) {
            const jobs = await queue.getJobs([bullState], 0, cappedLimit - 1);

            for (const job of jobs) {
              if (allJobs.length >= cappedLimit) break;

              const jobData = job.data as AgentJob;
              const jobSummary: any = {
                jobId: jobData.jobId || job.id,
                target: jobData.target,
                task: truncateTask(jobData.task),
                status: jobData.status,
                queuedAt: formatRelativeTime(jobData.queuedAt),
                queuedAtMs: jobData.queuedAt,
              };

              if (jobData.startedAt) {
                jobSummary.startedAt = formatRelativeTime(jobData.startedAt);
              }

              if (jobData.completedAt) {
                jobSummary.completedAt = formatRelativeTime(jobData.completedAt);
              }

              if (jobData.label) {
                jobSummary.label = jobData.label;
              }

              allJobs.push(jobSummary);
            }

            if (allJobs.length >= cappedLimit) break;
          }

          if (allJobs.length >= cappedLimit) break;
        }

        // Sort by queuedAt timestamp descending (newest first)
        allJobs.sort((a, b) => b.queuedAtMs - a.queuedAtMs);

        // Remove raw timestamp from output
        const jobs = allJobs.map(({ queuedAtMs, ...job }) => job);

        return jsonResult({
          jobs,
          count: jobs.length,
          limit: cappedLimit,
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
