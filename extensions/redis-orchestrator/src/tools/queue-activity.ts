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
import { listAgentIds } from "../../../../src/agents/agent-scope.js";
import type { PluginState } from "../../index.js";
import type { AgentJob } from "../types.js";
import { formatRelativeTime, truncateTask } from "../utils.js";

const QueueActivitySchema = Type.Object({});

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
      const allAgents = listAgentIds(cfg).filter((id: string) => id !== "main");

      if (allAgents.length === 0) {
        return jsonResult({
          agents: {},
          summary: {
            pending: 0,
            active: 0,
            completedTotal: 0,
            failedTotal: 0,
          },
        });
      }

      try {
        const agents: Record<string, any> = {};
        const summary = {
          pending: 0,
          active: 0,
          completedTotal: 0,
          failedTotal: 0,
        };

        // Query each agent queue
        for (const agentId of allAgents) {
          const queueName = `agent-${agentId}`;
          const queue = state.jobTracker.getOrCreateQueue(queueName);

          // Get counts using O(1) operation
          const counts = await queue.getJobCounts(
            "wait",
            "active",
            "completed",
            "failed",
            "delayed",
          );

          const pendingCount = (counts.wait || 0) + (counts.delayed || 0);
          const activeCount = counts.active || 0;
          const completedTotal = counts.completed || 0;
          const failedTotal = counts.failed || 0;

          summary.pending += pendingCount;
          summary.active += activeCount;
          summary.completedTotal += completedTotal;
          summary.failedTotal += failedTotal;

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
                task: truncateTask(jobData.task),
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

          agents[agentId] = {
            status: agentStatus,
            pending: pendingCount,
            active: activeCount,
            completedTotal,
            failedTotal,
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
