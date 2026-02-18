/**
 * BullMQ Worker — Phase 2
 *
 * Processes queue_dispatch jobs by replicating the sessions_spawn flow:
 *   validate → create session → patch → build prompt → callGateway → register
 *
 * One Worker per agent queue. Concurrency: 1.
 * "Completed" in BullMQ = child session successfully launched.
 * The announce pipeline handles delivery independently.
 */

/**
 * ARCHITECTURE: Dispatch Queue Model (Option B)
 * 
 * BullMQ job lifecycle represents DISPATCH, not agent work:
 * - BullMQ "completed" = child session successfully launched
 * - BullMQ "failed" = child session failed to launch (will retry)
 * 
 * Actual agent lifecycle is tracked in job.data.status:
 * - "queued" → "active" (Worker launched child) → "completed"/"failed" (agent_end hook)
 * 
 * The existing announce pipeline handles result delivery back to the
 * dispatcher's session. The agent_end hook updates job.data.status as the ack.
 */

import type { PluginLogger } from "openclaw/plugin-sdk";
import { Worker, UnrecoverableError, type Job } from "bullmq";
import crypto from "node:crypto";
import type { AgentJob } from "./types.js";
// COUPLING: not in plugin-sdk — tracks src/agents/agent-scope.js. File SDK exposure request if this breaks.
import { resolveAgentConfig } from "../../../src/agents/agent-scope.js";
// COUPLING: not in plugin-sdk — tracks src/agents/lanes.js. File SDK exposure request if this breaks.
import { AGENT_LANE_SUBAGENT } from "../../../src/agents/lanes.js";
// COUPLING: not in plugin-sdk — tracks src/agents/model-selection.js. File SDK exposure request if this breaks.
import { resolveDefaultModelForAgent } from "../../../src/agents/model-selection.js";
// COUPLING: not in plugin-sdk — tracks src/agents/subagent-announce.js. File SDK exposure request if this breaks.
import { buildSubagentSystemPrompt } from "../../../src/agents/subagent-announce.js";
// COUPLING: not in plugin-sdk — tracks src/agents/subagent-depth.js. File SDK exposure request if this breaks.
import { getSubagentDepthFromSessionStore } from "../../../src/agents/subagent-depth.js";
// COUPLING: not in plugin-sdk — tracks src/agents/subagent-registry.js. File SDK exposure request if this breaks.
import {
  registerSubagentRun,
  countActiveRunsForSession,
} from "../../../src/agents/subagent-registry.js";
// COUPLING: not in plugin-sdk — tracks src/agents/tools/sessions-helpers.js. File SDK exposure request if this breaks.
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../../src/agents/tools/sessions-helpers.js";
// COUPLING: not in plugin-sdk — tracks src/auto-reply/thinking.js. File SDK exposure request if this breaks.
import { normalizeThinkLevel } from "../../../src/auto-reply/thinking.js";
// COUPLING: not in plugin-sdk — tracks src/config/config.js. File SDK exposure request if this breaks.
import { loadConfig } from "../../../src/config/config.js";
// COUPLING: not in plugin-sdk — tracks src/gateway/call.js. File SDK exposure request if this breaks.
import { callGateway } from "../../../src/gateway/call.js";
// COUPLING: not in plugin-sdk — tracks src/routing/session-key.js. File SDK exposure request if this breaks.
import { normalizeAgentId, parseAgentSessionKey } from "../../../src/routing/session-key.js";
// COUPLING: not in plugin-sdk — tracks src/utils/delivery-context.js. File SDK exposure request if this breaks.
import { normalizeDeliveryContext } from "../../../src/utils/delivery-context.js";
import { createWorkerOptions } from "./queue-config.js";
import { asBullMQConnection, type RedisConnection } from "./redis-connection.js";
import type { JobTracker } from "./job-tracker.js";

// ---------------------------------------------------------------------------
// Model helpers (replicated from sessions-spawn-tool.ts)
// ---------------------------------------------------------------------------

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) return primary.trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

async function processJob(
  job: Job<AgentJob>,
  logger: PluginLogger,
  jobTracker: JobTracker | null,
): Promise<string> {
  const {
    target,
    task,
    label,
    model: modelOverride,
    thinking: thinkingOverrideRaw,
    runTimeoutSeconds,
    cleanup: rawCleanup,
    dispatcherSessionKey,
    dispatcherAgentId,
    dispatcherDepth,
    dispatcherOrigin: rawDispatcherOrigin,
    project,
  } = job.data;

  const cleanup = rawCleanup === "delete" ? "delete" : "keep";
  const timeoutSeconds =
    typeof runTimeoutSeconds === "number" && Number.isFinite(runTimeoutSeconds)
      ? Math.max(0, Math.floor(runTimeoutSeconds))
      : 0;

  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);

  // Resolve dispatcher session context
  const requesterSessionKey = dispatcherSessionKey ?? "";
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({ key: requesterSessionKey, alias, mainKey })
    : alias;
  const requesterDisplayKey = resolveDisplaySessionKey({
    key: requesterInternalKey,
    alias,
    mainKey,
  });

  const requesterOrigin = normalizeDeliveryContext(rawDispatcherOrigin);

  // 1. Validate depth
  const callerDepth =
    typeof dispatcherDepth === "number"
      ? dispatcherDepth
      : getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
  const maxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;

  if (callerDepth >= maxSpawnDepth) {
    throw new UnrecoverableError(
      `Depth limit exceeded (current: ${callerDepth}, max: ${maxSpawnDepth})`,
    );
  }

  // 2. Validate active children
  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  if (activeChildren >= maxChildren) {
    throw new Error(
      `Active children limit reached (${activeChildren}/${maxChildren}). Job will retry.`,
    );
  }

  // 3. Validate allowlists
  const requesterAgentId = normalizeAgentId(
    dispatcherAgentId ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  const targetAgentId = normalizeAgentId(target);

  if (targetAgentId !== requesterAgentId) {
    const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
    const allowAny = allowAgents.some((v) => v.trim() === "*");
    const normalizedTargetId = targetAgentId.toLowerCase();
    const allowSet = new Set(
      allowAgents
        .filter((v) => v.trim() && v.trim() !== "*")
        .map((v) => normalizeAgentId(v).toLowerCase()),
    );
    if (!allowAny && !allowSet.has(normalizedTargetId)) {
      throw new UnrecoverableError(
        `Target agent "${targetAgentId}" not in allowAgents for ${requesterAgentId}`,
      );
    }
  }

  // 4. Create child session key
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const childDepth = callerDepth + 1;

  // 5. Resolve model
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
  const runtimeDefaultModel = resolveDefaultModelForAgent({ cfg, agentId: targetAgentId });
  const resolvedModel =
    normalizeModelSelection(modelOverride) ??
    normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
    normalizeModelSelection(cfg.agents?.defaults?.subagents?.model) ??
    normalizeModelSelection(cfg.agents?.defaults?.model?.primary) ??
    normalizeModelSelection(`${runtimeDefaultModel.provider}/${runtimeDefaultModel.model}`);

  // 6. Resolve thinking
  const resolvedThinkingDefaultRaw =
    (typeof (targetAgentConfig?.subagents as { thinking?: string } | undefined)?.thinking ===
    "string"
      ? (targetAgentConfig?.subagents as { thinking?: string } | undefined)?.thinking
      : undefined) ??
    (typeof (cfg.agents?.defaults?.subagents as { thinking?: string } | undefined)?.thinking ===
    "string"
      ? (cfg.agents?.defaults?.subagents as { thinking?: string } | undefined)?.thinking
      : undefined);
  const thinkingCandidateRaw = thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  let thinkingOverride: string | undefined;
  if (thinkingCandidateRaw) {
    const normalized = normalizeThinkLevel(thinkingCandidateRaw);
    if (!normalized) {
      throw new Error(`Invalid thinking level "${thinkingCandidateRaw}".`);
    }
    thinkingOverride = normalized;
  }

  // 7. Patch session depth
  await callGateway({
    method: "sessions.patch",
    params: { key: childSessionKey, spawnDepth: childDepth },
    timeoutMs: 10_000,
  });

  // 8. Patch model
  if (resolvedModel) {
    try {
      await callGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, model: resolvedModel },
        timeoutMs: 10_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const recoverable = msg.includes("invalid model") || msg.includes("model not allowed");
      if (!recoverable) throw err;
      logger.warn(`worker: model patch warning for job ${job.id}: ${msg}`);
    }
  }

  // 9. Patch thinking
  if (thinkingOverride !== undefined) {
    await callGateway({
      method: "sessions.patch",
      params: {
        key: childSessionKey,
        thinkingLevel: thinkingOverride === "off" ? null : thinkingOverride,
      },
      timeoutMs: 10_000,
    });
  }

  // 10. Build system prompt
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey: requesterInternalKey,
    requesterOrigin,
    childSessionKey,
    label: label || undefined,
    task,
    childDepth,
    maxSpawnDepth,
  });

  // 11. Start child agent via callGateway
  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;

  const response = await callGateway<{ runId: string }>({
    method: "agent",
    params: {
      message: task,
      sessionKey: childSessionKey,
      channel: requesterOrigin?.channel ?? undefined,
      to: requesterOrigin?.to ?? undefined,
      accountId: requesterOrigin?.accountId ?? undefined,
      threadId: requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
      idempotencyKey: childIdem,
      deliver: false,
      lane: AGENT_LANE_SUBAGENT,
      extraSystemPrompt: childSystemPrompt,
      thinking: thinkingOverride,
      timeout: timeoutSeconds,
      label: label || undefined,
      spawnedBy: requesterInternalKey,
    },
    timeoutMs: 10_000,
  });

  if (typeof response?.runId === "string" && response.runId) {
    childRunId = response.runId;
  }

  // 12. Register with announce pipeline
  registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    requesterSessionKey: requesterInternalKey,
    requesterOrigin,
    requesterDisplayKey,
    task,
    cleanup,
    label: label || undefined,
    model: resolvedModel,
    runTimeoutSeconds: timeoutSeconds,
  });

  // 13. Update BullMQ job data with runtime info
  await job.updateData({
    ...job.data,
    status: "active",
    openclawRunId: childRunId,
    openclawSessionKey: childSessionKey,
    startedAt: Date.now(),
  });

  // 14. Index by session key so agent_end hook can find this job
  if (jobTracker && job.id) {
    await jobTracker.indexJobBySessionKey(childSessionKey, job.id, `agent-${targetAgentId}`);
  }

  logger.info(
    `worker: launched child session ${childSessionKey} (runId: ${childRunId}) for job ${job.id}`,
  );

  // Return childRunId — BullMQ marks job as "completed" (= child launched successfully).
  // The announce pipeline handles delivery independently. The agent_end hook
  // updates the BullMQ job data with actual completion time.
  return childRunId;
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

export function createWorkers(
  connection: RedisConnection,
  agentIds: string[],
  logger: PluginLogger,
  jobTracker: JobTracker | null,
): Map<string, Worker> {
  const workers = new Map<string, Worker>();
  const workerOpts = createWorkerOptions();

  for (const agentId of agentIds) {
    const queueName = `agent-${agentId}`;

    const worker = new Worker<AgentJob, string>(queueName, async (job) => processJob(job, logger, jobTracker), {
      connection: asBullMQConnection(connection),
      ...workerOpts,
      prefix: "bull",
    });

    worker.on("error", (err) => {
      logger.warn(`worker[${agentId}]: error: ${err.message}`);
    });

    worker.on("failed", (job, err) => {
      logger.warn(`worker[${agentId}]: job ${job?.id} failed: ${err.message}`);
    });

    worker.on("completed", (job) => {
      logger.info(`worker[${agentId}]: job ${job.id} completed (child launched)`);
    });

    workers.set(agentId, worker);
    logger.info(`worker: created worker for queue ${queueName}`);
  }

  return workers;
}

export async function closeWorkers(
  workers: Map<string, Worker>,
  logger: PluginLogger,
): Promise<void> {
  for (const [agentId, worker] of workers) {
    try {
      await worker.close();
      logger.info(`worker: closed worker for ${agentId}`);
    } catch (err) {
      logger.warn(
        `worker: error closing worker for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  workers.clear();
}
