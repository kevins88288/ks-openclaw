/**
 * queue_learnings Tool — Phase 3.5 Batch 3
 *
 * Query learning entries by project, job, and/or tags.
 * Open to all agents (read-only). Results ordered by timestamp descending.
 * Degrades gracefully when Redis is unavailable.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext, AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type { PluginState } from "../../index.js";
import type { LearningEntry } from "../types.js";

const QueueLearningsSchema = Type.Object({
  projectId: Type.Optional(Type.String({ description: "Filter by project" })),
  jobId: Type.Optional(
    Type.String({ description: "Filter to learnings from a specific job" }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: "Filter by tags (OR match)" }),
  ),
  limit: Type.Optional(
    Type.Number({ minimum: 1, maximum: 100, description: "Max results (default 20)" }),
  ),
});

/**
 * Returns true if the entry matches any of the provided tags (OR logic).
 * If no tags filter provided, always returns true.
 */
function matchesTags(entry: LearningEntry, tags?: string[]): boolean {
  if (!tags || tags.length === 0) return true;
  return tags.some((tag) => entry.tags.includes(tag));
}

export function createQueueLearningsTool(
  state: PluginState,
  ctx: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "queue_learnings",
    description:
      "Query learning entries by project, job, and/or tags. Returns entries ordered by timestamp descending.",
    inputSchema: QueueLearningsSchema,

    async execute(params: unknown) {
      const { projectId, jobId, tags, limit = 20 } = params as {
        projectId?: string;
        jobId?: string;
        tags?: string[];
        limit?: number;
      };

      // Require at least one filter
      if (!projectId && !jobId) {
        return jsonResult({ status: "error", error: "Provide projectId or jobId" });
      }

      if (!state.connection) {
        return jsonResult({ status: "error", error: "Orchestrator not initialized" });
      }

      try {
        let ids: string[] = [];

        if (jobId) {
          // Fetch from job-specific list
          const raw = await state.connection.lrange(`orch:learnings:job:${jobId}`, 0, -1);
          ids = raw ?? [];
        } else if (projectId) {
          // Fetch from project sorted set, newest first, paginate to limit
          // We fetch more IDs than needed since some may be expired
          const fetchCount = Math.min(limit * 5, 500);
          const raw = await state.connection.zrevrange(
            `orch:learnings:${projectId}`,
            0,
            fetchCount - 1,
          );
          ids = raw ?? [];
        }

        if (ids.length === 0) {
          return jsonResult([]);
        }

        // Fetch individual entries in parallel
        const entryStrings = await Promise.all(
          ids.map((id) => state.connection!.get(`orch:learning:${id}`)),
        );

        // Parse, skip missing/expired entries, apply tags filter
        const entries: LearningEntry[] = [];
        for (const raw of entryStrings) {
          if (!raw) continue; // expired or missing — skip silently
          let entry: LearningEntry;
          try {
            entry = JSON.parse(raw) as LearningEntry;
          } catch {
            continue; // malformed — skip silently
          }
          if (!matchesTags(entry, tags)) continue;
          entries.push(entry);
          if (entries.length >= limit) break;
        }

        // Sort by timestamp descending (already in order from ZREVRANGE, but jobId path may not be)
        entries.sort((a, b) => b.timestamp - a.timestamp);

        // Enforce limit after sort
        const result = entries.slice(0, limit);

        return jsonResult(result);
      } catch {
        return jsonResult({ status: "error", error: "Redis unavailable" });
      }
    },
  };
}
