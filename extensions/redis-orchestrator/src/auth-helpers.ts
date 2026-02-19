/**
 * Authorization helpers for queue tools
 *
 * Phase 3 Task 3.3: Cross-agent authorization and field stripping.
 */

/** System agents that bypass authorization checks */
const SYSTEM_AGENTS = new Set(["lucius", "main"]);

/**
 * Check if the given agentId is a system-level agent (bypasses auth restrictions).
 */
export function isSystemAgent(agentId: string): boolean {
  return SYSTEM_AGENTS.has(agentId.toLowerCase());
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
