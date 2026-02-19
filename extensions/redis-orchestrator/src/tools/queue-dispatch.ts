/**
 * queue_dispatch Tool — Phase 2
 *
 * Creates a BullMQ job in an agent queue and returns immediately.
 * The Worker service picks up jobs and launches child sessions.
 *
 * Phase 3 Task 3.12: When the circuit breaker is open (Redis down),
 * falls back to direct sessions_spawn via callGateway so agent work
 * continues even without Redis.
 *
 * Phase 3.6 Batch 1: Approval routing for non-orchestrator callers.
 * Non-orchestrators (or callers with requiresApproval: true) create
 * orch:approval:{id} records instead of BullMQ jobs.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext, AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, readStringParam, optionalStringEnum } from "openclaw/plugin-sdk";
// COUPLING: not in plugin-sdk — tracks src/agents/agent-scope.js. File SDK exposure request if this breaks.
import { resolveAgentConfig } from "../../../../src/agents/agent-scope.js";
// COUPLING: not in plugin-sdk — tracks src/agents/subagent-depth.js. File SDK exposure request if this breaks.
import { getSubagentDepthFromSessionStore } from "../../../../src/agents/subagent-depth.js";
// COUPLING: not in plugin-sdk — tracks src/config/config.js. File SDK exposure request if this breaks.
import { loadConfig } from "../../../../src/config/config.js";
// COUPLING: not in plugin-sdk — tracks src/discord/send.reactions.js. File SDK exposure request if this breaks.
import { reactMessageDiscord } from "../../../../src/discord/send.reactions.js";
// COUPLING: not in plugin-sdk — tracks src/gateway/call.js. File SDK exposure request if this breaks.
import { callGateway } from "../../../../src/gateway/call.js";
// COUPLING: not in plugin-sdk — tracks src/routing/session-key.js. File SDK exposure request if this breaks.
import { normalizeAgentId, parseAgentSessionKey } from "../../../../src/routing/session-key.js";
// COUPLING: not in plugin-sdk — tracks src/utils/delivery-context.js. File SDK exposure request if this breaks.
import { normalizeDeliveryContext } from "../../../../src/utils/delivery-context.js";
import type { PluginState } from "../../index.js";
import { isSystemAgent, isOrchestrator } from "../auth-helpers.js";
import type { RedisOrchestratorConfig } from "../config-schema.js";
import type { ApprovalRecord } from "../types.js";

const QueueDispatchSchema = Type.Object({
  target: Type.String({ description: "Agent ID to dispatch work to" }),
  task: Type.String({ description: "The instruction/prompt for the agent", maxLength: 50000 }),
  label: Type.Optional(Type.String({ description: "Label for this dispatch", maxLength: 500 })),
  project: Type.Optional(Type.String({ description: "Project/repo context" })),
  model: Type.Optional(Type.String({ description: "Model override (provider/model)" })),
  thinking: Type.Optional(Type.String({ description: "Thinking level override" })),
  runTimeoutSeconds: Type.Optional(
    Type.Number({ minimum: 0, description: "Timeout in seconds (0 = no timeout)" }),
  ),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "List of jobIds that must complete before this job starts (single level only, fail-fast)",
      maxItems: 20,
    }),
  ),
  systemPromptAddition: Type.Optional(
    Type.String({
      maxLength: 2000,
      description: "Additional system prompt text (system agents only)",
    }),
  ),
  depth: Type.Optional(
    Type.Number({ minimum: 0, description: "Explicit depth for the spawned agent" }),
  ),
  storeResult: Type.Optional(
    Type.Boolean({
      description: "If true, capture agent's final message in job record after completion",
    }),
  ),
  // Phase 3.6: Approval routing
  requiresApproval: Type.Optional(
    Type.Boolean({
      description:
        "If true, route through approval queue regardless of caller identity. Orchestrators use this for merge/prod gates.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      maxLength: 200,
      description:
        "Human-readable reason why approval is required (included in Discord notification)",
    }),
  ),
});

/**
 * Direct sessions_spawn fallback when Redis/orchestrator is unavailable.
 * Used by both orchestrator-not-initialized and circuit-breaker-open paths.
 */
async function directSpawnFallback(
  params: {
    target: string;
    task: string;
    label?: string;
    model?: string;
    thinking?: string;
    cleanup?: string;
    runTimeoutSeconds?: number;
    systemPromptAddition?: string;
    depth?: number;
  },
  reason: string,
): Promise<Record<string, unknown>> {
  const spawnParams: Record<string, unknown> = {
    task: params.task,
    agentId: params.target,
    runTimeoutSeconds: params.runTimeoutSeconds || undefined,
    cleanup: params.cleanup || "keep",
  };
  if (params.label) spawnParams.label = params.label;
  if (params.model) spawnParams.model = params.model;
  if (params.thinking) spawnParams.thinking = params.thinking;
  if (params.systemPromptAddition) spawnParams.systemPromptAddition = params.systemPromptAddition;
  if (params.depth !== undefined) spawnParams.depth = params.depth;

  const response = await callGateway<{ runId?: string }>({
    method: "sessions.spawn",
    params: spawnParams,
    timeoutMs: 15_000,
  });

  return {
    jobId: response?.runId ?? `fallback-${Date.now()}`,
    status: "dispatched",
    target: params.target,
    fallback: true,
    fallbackReason: reason,
  };
}

/** Lua script for atomic rate limiting: INCR + conditional EXPIRE in one round-trip */
const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], 60)
end
return current
`;

/** Simple warn logger — tool context doesn't expose logger, so use console */
function warnLog(msg: string): void {
  console.warn(`[redis-orchestrator] ${msg}`);
}

// ---------------------------------------------------------------------------
// Phase 3.6 Batch 1: Approval routing helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize task text for inclusion in Discord notifications.
 *
 * Required to prevent mention injection (@everyone), markdown injection,
 * RTL override characters, and null bytes.
 * Truncation happens AFTER sanitization, not before.
 */
function sanitizeTaskForDiscord(task: string, maxLength = 500): string {
  let result = task;

  // Replace mention patterns with safe literal text
  result = result.replace(/@everyone/g, "[at-everyone]");
  result = result.replace(/@here/g, "[at-here]");
  result = result.replace(/<@&\d+>/g, "[at-role]");
  result = result.replace(/<@!?\d+>/g, "[at-user]");

  // Strip null bytes and Unicode RTL/direction override characters
  result = result.replace(/\u0000/g, "");
  result = result.replace(/[\u202e\u200f\u200e]/g, "");

  // FIX-13: Sanitize channel mentions (prevents information disclosure via channel links)
  result = result.replace(/<#\d+>/g, "[channel]");

  // FIX-3: Escape triple backticks to prevent code block injection
  // (the notification wraps sanitizedTask in triple backtick fences)
  result = result.replace(/```/g, "` ` `");

  // Truncate AFTER sanitization
  if (result.length > maxLength) {
    result = result.substring(0, maxLength - 3) + "...";
  }

  return result;
}

/**
 * Format a human-readable expiry string for the Discord notification.
 * Uses the configured TTL or the default 7 days.
 */
function formatExpiryDate(ttlDays: number): string {
  const expiry = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  return expiry.toUTCString();
}

/**
 * Build the Discord approval notification message.
 */
function buildApprovalNotification(record: ApprovalRecord, ttlDays: number): string {
  const sanitizedTask = sanitizeTaskForDiscord(record.task, 500);
  const expiryStr = formatExpiryDate(ttlDays);

  return [
    "🔔 **Approval Request**",
    "",
    `**From:** ${record.callerAgentId} → ${record.target}`,
    `**Label:** ${record.label ?? "unlabeled"}`,
    `**Project:** ${record.project ?? "—"}`,
    `**Job ID:** \`${record.id}\``,
    record.reason ? `**Reason:** ${record.reason}` : null,
    "",
    "**Request:**",
    "```",
    sanitizedTask,
    "```",
    "",
    `**Expires:** ${expiryStr}`,
    "",
    `To approve: \`/approve ${record.id}\``,
    `To reject: \`/reject ${record.id}\``,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Send the Discord approval notification.
 *
 * Returns the Discord message ID if available, or undefined on success with no ID.
 * Throws on failure — caller must NOT create the Redis record if this throws.
 */
async function sendApprovalNotification(
  channelId: string,
  record: ApprovalRecord,
  ttlDays: number,
): Promise<string | undefined> {
  const message = buildApprovalNotification(record, ttlDays);

  const response = await callGateway<{ messageId?: string }>({
    method: "send",
    params: {
      to: channelId,
      channel: "discord",
      message,
      idempotencyKey: `approval-notify-${record.id}`,
    },
    timeoutMs: 15_000,
  });

  return response?.messageId;
}

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

      // Phase 3 Task 3.12: If Redis orchestrator never started (no connection at all),
      // fall back to direct sessions_spawn immediately
      if (!state.jobTracker || !state.circuitBreaker || !state.connection) {
        warnLog(
          `queue_dispatch: orchestrator not running — falling back to sessions_spawn for target=${normalizeAgentId(readStringParam(params, "target", { required: true }))}`,
        );

        const fallbackTarget = normalizeAgentId(
          readStringParam(params, "target", { required: true }),
        );
        const fallbackTask = readStringParam(params, "task", { required: true });

        try {
          return jsonResult(
            await directSpawnFallback(
              {
                target: fallbackTarget,
                task: fallbackTask,
                label: readStringParam(params, "label"),
                model: readStringParam(params, "model"),
                thinking: readStringParam(params, "thinking"),
                cleanup:
                  params.cleanup === "keep" || params.cleanup === "delete"
                    ? params.cleanup
                    : "keep",
                runTimeoutSeconds:
                  typeof params.runTimeoutSeconds === "number" &&
                  Number.isFinite(params.runTimeoutSeconds)
                    ? Math.max(0, Math.floor(params.runTimeoutSeconds))
                    : 0,
              },
              "orchestrator_unavailable",
            ),
          );
        } catch (fallbackErr) {
          return jsonResult({
            status: "error",
            error: `Orchestrator unavailable and fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
          });
        }
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

      // Phase 3 Task 3.10: dependsOn — single-level dependency chains
      const dependsOn = Array.isArray(params.dependsOn)
        ? (params.dependsOn as string[]).filter((id) => typeof id === "string" && id.trim())
        : undefined;

      // Phase 3.5: systemPromptAddition and depth
      const systemPromptAddition =
        typeof params.systemPromptAddition === "string" ? params.systemPromptAddition : undefined;
      const depth =
        typeof params.depth === "number" && Number.isFinite(params.depth)
          ? Math.max(0, Math.floor(params.depth))
          : undefined;

      // Phase 3.5 Batch 2: storeResult opt-in
      const storeResult = typeof params.storeResult === "boolean" ? params.storeResult : undefined;

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

      // Phase 3.5 Batch 1: Auth restriction for systemPromptAddition
      if (systemPromptAddition && !isSystemAgent(dispatcherAgentId)) {
        return jsonResult({
          status: "forbidden",
          error: "systemPromptAddition requires system agent privileges",
        });
      }

      // Phase 3.6 Batch 1: Approval routing
      // requiresApproval: true always routes through approval (e.g., merge/prod gates).
      // Non-orchestrators always require approval.
      // Orchestrators without requiresApproval: true bypass approval and dispatch normally.
      const callerAgentId = dispatcherAgentId;
      const pluginConfig = state.pluginConfig as Record<string, any> | undefined;
      const needsApproval =
        params.requiresApproval === true ||
        !isOrchestrator(callerAgentId, pluginConfig as RedisOrchestratorConfig | undefined);

      if (needsApproval) {
        const approvalConfig = pluginConfig?.approval as Record<string, unknown> | undefined;
        const discordChannelId =
          typeof approvalConfig?.discordChannelId === "string"
            ? approvalConfig.discordChannelId
            : undefined;
        const ttlDays = typeof approvalConfig?.ttlDays === "number" ? approvalConfig.ttlDays : 7;
        const ttlSeconds = ttlDays * 24 * 60 * 60;
        const reason = typeof params.reason === "string" ? (params.reason as string) : undefined;

        const approvalId = randomUUID();
        const createdAt = Date.now();

        const approvalRecord: ApprovalRecord = {
          id: approvalId,
          status: "pending",
          callerAgentId,
          callerSessionKey: dispatcherSessionKey,
          target: targetAgentId,
          task,
          label,
          project,
          model,
          thinking,
          runTimeoutSeconds: runTimeoutSeconds || undefined,
          cleanup,
          reason,
          createdAt,
          discordChannelId,
        };

        // FIX-2: Require discordChannelId — without it, Kevin will never see the approval.
        // A missing channel config creates silent orphan approvals that expire unseen.
        if (!discordChannelId) {
          return jsonResult({
            status: "error",
            error:
              "Approval channel not configured (approval.discordChannelId). Cannot route approval request.",
          });
        }

        // Send Discord notification BEFORE creating the Redis record.
        // If Discord send fails → return error, do NOT create the record.
        try {
          const messageId = await sendApprovalNotification(
            discordChannelId,
            approvalRecord,
            ttlDays,
          );
          if (messageId) {
            approvalRecord.discordMessageId = messageId;

            // Piece 2: Pre-add ✅ and ❌ reactions to the notification message.
            // Fire-and-forget — reaction failure must NOT block approval record creation.
            Promise.allSettled([
              reactMessageDiscord(discordChannelId, messageId, "✅"),
              reactMessageDiscord(discordChannelId, messageId, "❌"),
            ]).catch(() => {});
          }
        } catch (discordErr) {
          warnLog(
            `queue_dispatch: Discord notification failed for approval ${approvalId}: ${discordErr instanceof Error ? discordErr.message : String(discordErr)}`,
          );
          return jsonResult({
            status: "error",
            error: `Failed to send approval notification: ${discordErr instanceof Error ? discordErr.message : String(discordErr)}`,
          });
        }

        // FIX-4: Write approval record atomically via MULTI/EXEC pipeline.
        // Prevents partial writes where the record exists but isn't indexed (or vice versa).
        try {
          const pipeline = state.connection.multi();
          pipeline.set(
            `orch:approval:${approvalId}`,
            JSON.stringify(approvalRecord),
            "EX",
            ttlSeconds,
          );
          // Index in pending sorted set (score = createdAt for chronological ordering)
          pipeline.zadd("orch:approvals:pending", createdAt, approvalId);
          // Index by project if provided
          if (project) {
            pipeline.zadd(`orch:approvals:project:${project}`, createdAt, approvalId);
          }
          // Piece 3: Reverse index discordMessageId → approvalId for O(1) reaction lookup
          if (approvalRecord.discordMessageId) {
            pipeline.set(
              `orch:approvals:msg:${approvalRecord.discordMessageId}`,
              approvalId,
              "EX",
              ttlSeconds,
            );
          }
          await pipeline.exec();
        } catch (redisErr) {
          warnLog(
            `queue_dispatch: Redis write failed for approval ${approvalId}: ${redisErr instanceof Error ? redisErr.message : String(redisErr)}`,
          );
          return jsonResult({
            status: "error",
            error: `Failed to store approval record: ${redisErr instanceof Error ? redisErr.message : String(redisErr)}`,
          });
        }

        return jsonResult({
          jobId: approvalId,
          status: "pending_approval",
          approvalRequired: true,
          target: targetAgentId,
        });
      }

      // Non-approval path: existing BullMQ dispatch behavior below.
      // --- Rate limiting (Phase 3 Task 3.4) ---
      // Note: pluginConfig and callerAgentId are already declared above in the approval check.
      const rateLimitConfig = pluginConfig?.rateLimit as Record<string, unknown> | undefined;
      const dispatchesPerMinute = (rateLimitConfig?.dispatchesPerMinute as number) ?? 10;
      const maxQueueDepth = (rateLimitConfig?.maxQueueDepth as number) ?? 50;

      // Check per-agent rate limit (Redis-based counter with 60s TTL, atomic via Lua)
      if (dispatchesPerMinute > 0) {
        const rateLimitKey = `bull:ratelimit:dispatch:${callerAgentId}`;
        const current = (await state.connection.eval(RATE_LIMIT_LUA, 1, rateLimitKey)) as number;
        if (current > dispatchesPerMinute) {
          return jsonResult({
            status: "rate_limited",
            error: `Rate limit exceeded: ${current}/${dispatchesPerMinute} dispatches this minute`,
          });
        }
      }

      // Check per-agent queue depth cap
      if (maxQueueDepth > 0) {
        const targetQueueName = `agent-${targetAgentId}`;
        const targetQueue = state.jobTracker.getOrCreateQueue(targetQueueName);
        const counts = await targetQueue.getJobCounts("wait", "delayed", "active");
        const pendingCount = (counts.wait || 0) + (counts.delayed || 0) + (counts.active || 0);
        if (pendingCount >= maxQueueDepth) {
          return jsonResult({
            status: "queue_full",
            error: `Queue depth exceeded: ${pendingCount}/${maxQueueDepth} pending jobs for agent ${targetAgentId}`,
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

      // Create BullMQ job via circuit breaker, with sessions_spawn fallback
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
              dependsOn,
              systemPromptAddition,
              depth,
              storeResult,
            });
          },
          // Phase 3 Task 3.12: Fallback to direct sessions_spawn when circuit is open
          async () => {
            warnLog(
              `queue_dispatch: circuit breaker open — falling back to sessions_spawn for target=${targetAgentId}`,
            );

            const result = await directSpawnFallback(
              {
                target: targetAgentId,
                task,
                label,
                model,
                thinking,
                cleanup,
                runTimeoutSeconds,
              },
              "circuit_open",
            );

            // Return a sentinel value that signals fallback mode
            return `__fallback__:${result.jobId}`;
          },
        );

        // Detect fallback vs normal path
        if (typeof jobId === "string" && jobId.startsWith("__fallback__:")) {
          const fallbackRunId = jobId.slice("__fallback__:".length);
          return jsonResult({
            jobId: fallbackRunId,
            status: "dispatched",
            target: targetAgentId,
            fallback: true,
            fallbackReason: "circuit_open",
          });
        }

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
