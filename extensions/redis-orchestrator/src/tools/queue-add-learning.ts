/**
 * queue_add_learning Tool — Phase 3.5 Batch 3
 *
 * Records a learning entry attributed to a completed BullMQ job.
 * System agents only. Learnings are stored under the `orch:` key prefix
 * with a configurable TTL (default 365 days).
 */

import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { OpenClawPluginToolContext, AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import { isSystemAgent } from "../auth-helpers.js";
import type { PluginState } from "../../index.js";
import type { LearningEntry } from "../types.js";

const QueueAddLearningSchema = Type.Object({
  projectId: Type.String({
    description: "Project identifier (e.g. 'redis-orchestrator', 'ceo-dashboard')",
  }),
  jobId: Type.String({
    description: "BullMQ job ID this learning is attributed to",
  }),
  learning: Type.String({
    maxLength: 1024,
    description: "The learning text (max 1KB)",
  }),
  tags: Type.Array(Type.String(), {
    maxItems: 10,
    description: "Tags (e.g. ['architecture', 'bullmq'])",
  }),
  previousJobId: Type.Optional(
    Type.String({
      description: "Optional explicit link to prior phase/batch job",
    }),
  ),
});

export function createQueueAddLearningTool(
  state: PluginState,
  ctx: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "queue_add_learning",
    description:
      "Record a learning from a completed job. Stored persistently in Redis under the project learning index. System agents only.",
    inputSchema: QueueAddLearningSchema,

    async execute(params: unknown) {
      const { projectId, jobId, learning, tags, previousJobId } = params as {
        projectId: string;
        jobId: string;
        learning: string;
        tags: string[];
        previousJobId?: string;
      };

      // Auth: system agents only
      if (!isSystemAgent(ctx.agentId)) {
        return jsonResult({
          status: "forbidden",
          error: "queue_add_learning requires system agent privileges",
        });
      }

      // Ensure orchestrator is initialized
      if (!state.connection || !state.jobTracker) {
        return jsonResult({ status: "error", error: "Orchestrator not initialized" });
      }

      // Validate jobId exists: look up in the job index hash
      let queueName: string | null = null;
      try {
        queueName = await state.connection.hget("bull:job-index", jobId);
      } catch (err) {
        return jsonResult({ status: "error", error: "Redis unavailable" });
      }

      if (!queueName) {
        return jsonResult({ status: "error", error: `Job not found: ${jobId}` });
      }

      // Fetch the actual job to get its label (phase)
      let jobData: { data?: { label?: string } } | null = null;
      try {
        const queue = state.jobTracker.getOrCreateQueue(queueName);
        jobData = await queue.getJob(jobId) as { data?: { label?: string } } | null;
      } catch {
        // If we can't fetch job details, continue with undefined phase
        jobData = null;
      }

      // Retrieve pluginConfig for TTL
      const pluginConfig = state.pluginConfig as {
        learnings?: { ttlDays?: number };
      } | undefined;

      const id = crypto.randomUUID();
      const entry: LearningEntry = {
        id,
        jobId,
        previousJobId,
        projectId,
        phase: jobData?.data?.label,
        agentId: ctx.agentId,
        learning,
        tags,
        timestamp: Date.now(),
      };

      const ttlSeconds = (pluginConfig?.learnings?.ttlDays ?? 365) * 86400;
      const serialized = JSON.stringify(entry);

      try {
        // Individual entry (with TTL)
        await state.connection.set(`orch:learning:${id}`, serialized, "EX", ttlSeconds);

        // Project sorted set (score = timestamp for ordering; no TTL — entries expire via individual key TTL)
        await state.connection.zadd(`orch:learnings:${projectId}`, entry.timestamp, id);

        // Job index (list)
        await state.connection.rpush(`orch:learnings:job:${jobId}`, id);
        await state.connection.expire(`orch:learnings:job:${jobId}`, ttlSeconds);
      } catch {
        return jsonResult({ status: "error", error: "Redis unavailable" });
      }

      return jsonResult({ status: "ok", id, projectId, jobId, tags });
    },
  };
}
