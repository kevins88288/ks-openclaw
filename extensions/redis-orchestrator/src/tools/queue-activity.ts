/**
 * queue_activity Tool — Phase 2 Batch 2
 *
 * Get overall queue activity across all agents.
 * Shows agent status (working/idle/offline) and summary counts.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { jsonResult } from "../../../../src/agents/tools/common.js";
import { loadConfig } from "../../../../src/config/config.js";
import type { PluginState } from "../../index.js";
import type { AgentJob } from "../types.js";

const QueueActivitySchema = Type.Object({});

function formatRelativeTime(timestampMs: number): string {
  const now = Date.now();
  const diffMs = now - timestampMs;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${diffDay}d ago`;
}

export function createQueueActivityTool(
  state: PluginState,
  ctx: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    label: "Queue Activity",
    name: "queue_activity",
    description:
      "Get overall queue activity across all agents. Shows which agents are working/idle/offline and summary statistics.",
    parameters: QueueActivitySchema,
    execute: async (_toolCallId, _args) => {
      // Validate plugin state
      if (!state.jobTracker || !state.connection) {
        return jsonResult({
          status: "error",
          error: "Redis orchestrator is not running.",
        });
      }

      const cfg = loadConfig();

      // Get all agents from config
      const allAgents = ((cfg as any).agents?.list || [])
        .map((a: any) => a.id)
        .filter((id: string) => id !== "main");

      if (allAgents.length === 0) {
        return jsonResult({
          agents: {},
          summary: {
            pending: 0,
            active: 0,
            completedToday: 0,
            failedToday: 0,
          },
        });
      }

      try {
        const agents: Record<string, any> = {};
        const summary = {
          pending: 0,
          active: 0,
          completedToday: 0,
          failedToday: 0,
        };

        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

        // Query each agent queue
        for (const agentId of allAgents) {
          const queueName = `agent:${agentId}`;
          const queue = state.jobTracker.getOrCreateQueue(queueName);

          // Get counts
          const counts = await queue.getJobCounts(
            "wait",
            "active",
            "completed",
            "failed",
            "delayed",
          );

          const pendingCount = (counts.wait || 0) + (counts.delayed || 0);
          const activeCount = counts.active || 0;

          summary.pending += pendingCount;
          summary.active += activeCount;

          // Get active job details (if any)
          let activeJobInfo: any = null;
          let agentStatus: "working" | "idle" | "offline" = "idle";
          let since: string | undefined;

          if (activeCount > 0) {
            const activeJobs = await queue.getJobs(["active"], 0, 0);
            if (activeJobs.length > 0) {
              const job = activeJobs[0];
              const jobData = job.data as AgentJob;
              
              activeJobInfo = {
                jobId: jobData.jobId || job.id,
                task: jobData.task.substring(0, 80) + (jobData.task.length > 80 ? "..." : ""),
                label: jobData.label,
              };

              agentStatus = "working";
              if (jobData.startedAt) {
                since = formatRelativeTime(jobData.startedAt);
              }
            }
          } else if (pendingCount > 0) {
            agentStatus = "idle"; // Has pending work but not processing
          } else {
            agentStatus = "idle"; // No work at all
          }

          // Get completed and failed jobs from last 24h
          const completedJobs = await queue.getJobs(["completed"], 0, 999);
          const failedJobs = await queue.getJobs(["failed"], 0, 999);

          let completedToday = 0;
          let failedToday = 0;

          for (const job of completedJobs) {
            const jobData = job.data as AgentJob;
            if (jobData.completedAt && jobData.completedAt >= oneDayAgo) {
              completedToday++;
            }
          }

          for (const job of failedJobs) {
            const jobData = job.data as AgentJob;
            if (jobData.completedAt && jobData.completedAt >= oneDayAgo) {
              failedToday++;
            }
          }

          summary.completedToday += completedToday;
          summary.failedToday += failedToday;

          agents[agentId] = {
            status: agentStatus,
            pending: pendingCount,
            active: activeCount,
            completedToday,
            failedToday,
            ...(activeJobInfo && { job: activeJobInfo }),
            ...(since && { since }),
          };
        }

        return jsonResult({
          agents,
          summary,
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
