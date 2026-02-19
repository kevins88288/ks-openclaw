/**
 * Approval Spawn — Phase 3.7 Piece 1
 *
 * Replicates the worker.ts spawn flow for Kevin-approved requests.
 * Key differences from the BullMQ worker:
 *   - No BullMQ job tracking (approval record IS the tracking mechanism)
 *   - Depth: callerDepth = 0 (Kevin-initiated), childDepth = 1
 *   - No depth limit check (Kevin explicitly approved this)
 *   - No active children check (Kevin explicitly approved this)
 *   - No allowlist check (validated at dispatch time)
 *   - Uses callerSessionKey from the approval record as the announce requester
 */

import crypto from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
// COUPLING: not in plugin-sdk — tracks src/agents/agent-scope.js. File SDK exposure request if this breaks.
import { resolveAgentConfig } from "../../../src/agents/agent-scope.js";
// COUPLING: not in plugin-sdk — tracks src/agents/lanes.js. File SDK exposure request if this breaks.
import { AGENT_LANE_SUBAGENT } from "../../../src/agents/lanes.js";
// COUPLING: not in plugin-sdk — tracks src/agents/model-selection.js. File SDK exposure request if this breaks.
import { resolveDefaultModelForAgent } from "../../../src/agents/model-selection.js";
// COUPLING: not in plugin-sdk — tracks src/agents/subagent-announce.js. File SDK exposure request if this breaks.
import { buildSubagentSystemPrompt } from "../../../src/agents/subagent-announce.js";
// COUPLING: not in plugin-sdk — tracks src/agents/subagent-registry.js. File SDK exposure request if this breaks.
import { registerSubagentRun } from "../../../src/agents/subagent-registry.js";
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
import { normalizeAgentId } from "../../../src/routing/session-key.js";
import type { PluginState } from "../index.js";
import type { ApprovalRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Model helpers (same as worker.ts)
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
// buildApprovedTaskPrompt (moved here from approval-commands.ts — canonical location)
// ---------------------------------------------------------------------------

export function buildApprovedTaskPrompt(record: ApprovalRecord): string {
  return `[Approved Request — Kevin has approved this]

Kevin explicitly approved the following request from ${record.callerAgentId}.

Original request:
${record.task}

Requested by: ${record.callerAgentId}
Approval ID: ${record.id}
Approved at: ${new Date(record.approvedAt ?? Date.now()).toISOString()}

Please execute this request.`;
}

// ---------------------------------------------------------------------------
// spawnApprovedAgent
// ---------------------------------------------------------------------------

/**
 * Spawn an agent for a Kevin-approved approval record.
 *
 * Replicates the worker.ts spawn flow but simplified:
 *   - callerDepth = 0 (Kevin-initiated top-level), childDepth = 1
 *   - No depth limit check, no active children check, no allowlist check
 *   - Uses callerSessionKey for the announce pipeline requester
 */
export async function spawnApprovedAgent(
  record: ApprovalRecord,
  api: OpenClawPluginApi,
  _state: PluginState,
): Promise<{ runId: string; sessionKey: string }> {
  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);

  const targetAgentId = normalizeAgentId(record.target);
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);

  // Resolve requester session context from approval record
  const requesterSessionKey = record.callerSessionKey ?? "";
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({ key: requesterSessionKey, alias, mainKey })
    : alias;
  const requesterDisplayKey = resolveDisplaySessionKey({
    key: requesterInternalKey,
    alias,
    mainKey,
  });

  // Depth: approval spawns are Kevin-initiated (depth 0 caller → depth 1 child)
  const callerDepth = 0;
  const childDepth = 1;
  const maxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;

  // Create child session key
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;

  // Resolve model
  const runtimeDefaultModel = resolveDefaultModelForAgent({ cfg, agentId: targetAgentId });
  const resolvedModel =
    normalizeModelSelection(record.model) ??
    normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
    normalizeModelSelection(cfg.agents?.defaults?.subagents?.model) ??
    normalizeModelSelection(cfg.agents?.defaults?.model?.primary) ??
    normalizeModelSelection(`${runtimeDefaultModel.provider}/${runtimeDefaultModel.model}`);

  // Resolve thinking
  const resolvedThinkingDefaultRaw =
    (typeof (targetAgentConfig?.subagents as { thinking?: string } | undefined)?.thinking ===
    "string"
      ? (targetAgentConfig?.subagents as { thinking?: string } | undefined)?.thinking
      : undefined) ??
    (typeof (cfg.agents?.defaults?.subagents as { thinking?: string } | undefined)?.thinking ===
    "string"
      ? (cfg.agents?.defaults?.subagents as { thinking?: string } | undefined)?.thinking
      : undefined);
  const thinkingCandidateRaw = record.thinking || resolvedThinkingDefaultRaw;
  let thinkingOverride: string | undefined;
  if (thinkingCandidateRaw) {
    const normalized = normalizeThinkLevel(thinkingCandidateRaw);
    if (!normalized) {
      throw new Error(`Invalid thinking level "${thinkingCandidateRaw}"`);
    }
    thinkingOverride = normalized;
  }

  // Patch session (key + depth + optional model + optional thinking)
  const patchParams: Record<string, unknown> = {
    key: childSessionKey,
    spawnDepth: childDepth,
  };
  if (resolvedModel) patchParams.model = resolvedModel;
  if (thinkingOverride !== undefined) {
    patchParams.thinkingLevel = thinkingOverride === "off" ? null : thinkingOverride;
  }

  try {
    await callGateway({
      method: "sessions.patch",
      params: patchParams,
      timeoutMs: 10_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const modelRecoverable =
      resolvedModel && (msg.includes("invalid model") || msg.includes("model not allowed"));
    if (modelRecoverable) {
      api.logger.warn(`approval-spawn: model patch warning for ${record.id}: ${msg}`);
      delete patchParams.model;
      await callGateway({
        method: "sessions.patch",
        params: patchParams,
        timeoutMs: 10_000,
      });
    } else {
      throw err;
    }
  }

  // Build task message with Kevin-approved framing
  const taskMessage = buildApprovedTaskPrompt(record);

  // Build system prompt (subagent context)
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey: requesterInternalKey,
    childSessionKey,
    label: record.label || undefined,
    task: record.task,
    childDepth,
    maxSpawnDepth,
  });

  // Start agent via callGateway
  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;

  const timeoutSeconds =
    typeof record.runTimeoutSeconds === "number" && Number.isFinite(record.runTimeoutSeconds)
      ? Math.max(0, Math.floor(record.runTimeoutSeconds))
      : 0;

  const response = await callGateway<{ runId: string }>({
    method: "agent",
    params: {
      message: taskMessage,
      sessionKey: childSessionKey,
      idempotencyKey: childIdem,
      deliver: false,
      lane: AGENT_LANE_SUBAGENT,
      extraSystemPrompt: childSystemPrompt,
      thinking: thinkingOverride,
      timeout: timeoutSeconds,
      label: record.label || undefined,
      spawnedBy: requesterInternalKey,
    },
    timeoutMs: 10_000,
  });

  if (typeof response?.runId === "string" && response.runId) {
    childRunId = response.runId;
  }

  // Register with announce pipeline so results are delivered back to the original caller
  const cleanup = record.cleanup === "delete" ? "delete" : "keep";
  registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    requesterSessionKey: requesterInternalKey,
    requesterDisplayKey,
    task: record.task,
    cleanup,
    label: record.label || undefined,
    model: resolvedModel,
    runTimeoutSeconds: timeoutSeconds,
  });

  api.logger.info(
    `approval-spawn: launched ${targetAgentId} session=${childSessionKey} runId=${childRunId} for approval=${record.id}`,
  );

  return { runId: childRunId, sessionKey: childSessionKey };
}
