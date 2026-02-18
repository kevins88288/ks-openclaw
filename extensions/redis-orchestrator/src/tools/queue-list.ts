/**
 * queue_list Tool — Phase 2 Batch 2
 *
 * List jobs across agent queues with optional filtering by agent and status.
 *
 * Phase 3: Cross-agent authorization — agents only see jobs they dispatched or that target them.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext, AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
// COUPLING: not in plugin-sdk — tracks src/routing/session-key.js. File SDK exposure request if this breaks.
import { normalizeAgentId } from "../../../../src/routing/session-key.js";
// COUPLING: not in plugin-sdk — tracks src/config/config.js. File SDK exposure request if this breaks.
import { loadConfig } from "../../../../src/config/config.js";
// COUPLING: not in plugin-sdk — tracks src/agents/agent-scope.js. File SDK exposure request if this breaks.
import { listAgentIds } from "../../../../src/agents/agent-scope.js";
import type { PluginState } from "../../index.js";
import type { AgentJob } from "../types.js";
import { formatRelativeTime, truncateTask } from "../utils.js";
import { isSystemAgent, stripSensitiveFields } from "../auth-helpers.js";

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
  project: Type.Optional(Type.String({ description: "Filter by project" })),
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
      const projectFilter = readStringParam(params, "project");
      const limit = readNumberParam(params, "limit") ?? 20;
      const cappedLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
      const callerAgentId = ctx.agentId ?? "";
      const callerIsSystem = isSystemAgent(callerAgentId);

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
          dispatchedBy: string;
          queuedAt: string;
          queuedAtMs: number;
          startedAt?: string;
          completedAt?: string;
          label?: string;
          openclawSessionKey?: string;
        }> = [];

        // Query each agent queue — fetch more than limit to allow for auth filtering
        const fetchMultiplier = callerIsSystem ? 1 : 3;

        for (const agentId of agentIds) {
          const queueName = `agent-${agentId}`;
          const queue = state.jobTracker.getOrCreateQueue(queueName);

          for (const bullState of bullMQStates) {
            const jobs = await queue.getJobs([bullState], 0, (cappedLimit * fetchMultiplier) - 1);

            for (const job of jobs) {
              if (allJobs.length >= cappedLimit) break;

              const jobData = job.data as AgentJob;

              // Phase 3 Task 3.3: Cross-agent authorization — filter to only visible jobs
              if (!callerIsSystem) {
                const isDispatcher = jobData.dispatchedBy === callerAgentId;
                const isTarget = jobData.target === callerAgentId;
                if (!isDispatcher && !isTarget) continue;
              }

              // Phase 3.5 Batch 2: project filter
              if (projectFilter && jobData.project !== projectFilter) continue;

              const jobSummary: any = {
                jobId: jobData.jobId || job.id,
                target: jobData.target,
                task: truncateTask(jobData.task),
                status: jobData.status,
                dispatchedBy: jobData.dispatchedBy,
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

              if (jobData.openclawSessionKey) {
                jobSummary.openclawSessionKey = jobData.openclawSessionKey;
              }

              // Phase 3 Task 3.10: Include dependency info
              if (jobData.dependsOn && jobData.dependsOn.length > 0) {
                jobSummary.dependsOn = jobData.dependsOn;
              }

              allJobs.push(jobSummary);
            }

            if (allJobs.length >= cappedLimit) break;
          }

          if (allJobs.length >= cappedLimit) break;
        }

        // Sort by queuedAt timestamp descending (newest first)
        allJobs.sort((a, b) => b.queuedAtMs - a.queuedAtMs);

        // Remove raw timestamp + strip sensitive fields for non-system agents
        const jobs = allJobs.map(({ queuedAtMs, ...job }) =>
          stripSensitiveFields(job, callerAgentId),
        );

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
