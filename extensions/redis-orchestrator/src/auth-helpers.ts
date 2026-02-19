/**
 * Authorization helpers for queue tools
 *
 * Phase 3 Task 3.3: Cross-agent authorization and field stripping.
 * Phase 3.6 Batch 1: Approval routing via isOrchestrator().
 */

import type { RedisOrchestratorConfig } from "./config-schema.js";

/** System agents that bypass authorization checks */
const SYSTEM_AGENTS = new Set(["lucius", "ultron", "meta", "main"]);

/**
 * Check if the given agentId is a system-level agent (bypasses auth restrictions).
 *
 * Note: isSystemAgent() (tool access gates) and isOrchestrator() (approval routing)
 * are intentionally separate functions. They happen to have the same default members
 * today but serve different purposes and will diverge as the system grows.
 */
export function isSystemAgent(agentId: string): boolean {
  return SYSTEM_AGENTS.has(agentId.toLowerCase());
}

/**
 * Check if the given agentId is an orchestrator for approval routing purposes.
 *
 * Orchestrators bypass the approval gate by default. Any orchestrator that
 * passes requiresApproval: true still routes through approval regardless.
 *
 * Reads from config.approval.orchestrators with a hardcoded fallback.
 * Separate from isSystemAgent() — same default set today, different purpose.
 */
export function isOrchestrator(agentId: string, config?: RedisOrchestratorConfig): boolean {
  const list = config?.approval?.orchestrators ?? ["lucius", "ultron", "meta", "main"];
  return new Set(list.map((s) => s.toLowerCase())).has(agentId.toLowerCase());
}

/**
 * Strip sensitive fields from a job result for non-system agents.
 * Removes `openclawSessionKey` which is an internal routing detail.
 */
export function stripSensitiveFields(
  result: Record<string, unknown>,
  callerAgentId: string,
): Record<string, unknown> {
  if (isSystemAgent(callerAgentId)) return result;

  const cleaned = { ...result };
  delete cleaned.openclawSessionKey;
  return cleaned;
}
