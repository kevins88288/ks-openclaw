/**
 * queue_activity Tool — Phase 2 Batch 2
 *
 * Get overall queue activity across all agents.
 * Shows agent status (working/idle/offline) and summary counts.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext, AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
// COUPLING: not in plugin-sdk — tracks src/config/config.js. File SDK exposure request if this breaks.
import { loadConfig } from "../../../../src/config/config.js";
// COUPLING: not in plugin-sdk — tracks src/agents/agent-scope.js. File SDK exposure request if this breaks.
import { listAgentIds } from "../../../../src/agents/agent-scope.js";
import type { PluginState } from "../../index.js";
import type { AgentJob } from "../types.js";
import { formatRelativeTime, truncateTask } from "../utils.js";
import { isSystemAgent } from "../auth-helpers.js";

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
      const callerAgentId = ctx.agentId ?? "";
      const callerIsSystem = isSystemAgent(callerAgentId);

      // Get all agents from config — non-system agents only see their own queue
      const allAgents = listAgentIds(cfg).filter((id: string) => {
        if (id === "main") return false;
        if (!callerIsSystem) return id === callerAgentId;
        return true;
      });

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

          // Determine agent status based on Worker presence and job activity
          let activeJobInfo: any = null;
          let agentStatus: "working" | "idle" | "offline" = "idle";
          let since: string | undefined;

          // Check if this agent has a running Worker
          const worker = state.workersMap?.get(agentId);
          const hasRunningWorker = worker != null && (typeof worker.isRunning === "function" ? worker.isRunning() : true);

          if (!hasRunningWorker) {
            agentStatus = "offline";
          } else if (activeCount > 0) {
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
          } else {
            agentStatus = "idle";
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
