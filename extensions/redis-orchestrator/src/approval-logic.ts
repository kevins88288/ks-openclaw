/**
 * Approval Logic — Phase 3.7 Piece 3
 *
 * Shared approve/reject functions called by both:
 *   - Slash command handlers (/approve, /reject in approval-commands.ts)
 *   - Reaction handler (reaction-handler.ts)
 *
 * Both paths use atomic CAS Lua scripts to prevent race conditions.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../index.js";
import { spawnApprovedAgent } from "./approval-spawn.js";
import type { ApprovalRecord } from "./types.js";

// ---------------------------------------------------------------------------
// CAS Lua scripts
// ---------------------------------------------------------------------------

/**
 * Atomic CAS for pending → approved transition.
 *
 * Returns:
 *   nil          — key does not exist
 *   'malformed'  — JSON parse error
 *   'ok'         — CAS succeeded
 *   <status>     — already in that status (idempotency guard)
 *
 * Accepts both 'pending' and 'approved_spawn_failed' (retry path).
 * ARGV[1] = approvedAt timestamp (ms, string)
 */
export const CAS_APPROVE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local ok, record = pcall(cjson.decode, raw)
if not ok then return 'malformed' end
if record.status ~= 'pending' and record.status ~= 'approved_spawn_failed' then
  return record.status
end
record.status = 'approved'
if not record.approvedAt then
  record.approvedAt = tonumber(ARGV[1])
end
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return 'ok'
`;

/**
 * Atomic CAS for pending → rejected transition.
 *
 * Returns:
 *   nil          — key does not exist
 *   'malformed'  — JSON parse error
 *   'ok'         — CAS succeeded
 *   <status>     — already in that status (blocks overwriting approved/approved_spawn_failed/rejected)
 *
 * Only transitions from 'pending'. Will NOT overwrite approved, approved_spawn_failed, or rejected.
 * This prevents a TOCTOU race where ✅ and ❌ arrive near-simultaneously.
 *
 * ARGV[1] = rejecterId (string)
 * ARGV[2] = rejectedAt timestamp (ISO string)
 */
export const CAS_REJECT_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local ok, record = pcall(cjson.decode, raw)
if not ok then return 'malformed' end
if record.status ~= 'pending' then
  return record.status
end
record.status = 'rejected'
record.rejectedBy = ARGV[1]
record.rejectedAt = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return 'ok'
`;

// ---------------------------------------------------------------------------
// Short ID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a potentially-short approval ID to a full UUID.
 *
 * If input is 36 chars (full UUID), returns it directly.
 * If shorter, prefix-matches against pending sorted set members.
 *
 * Returns:
 *   { id: string, ambiguous: false }  — exactly one match or full UUID
 *   { id: null, ambiguous: false }    — no match
 *   { id: null, ambiguous: true }     — multiple matches
 */
export async function resolveApprovalId(
  connection: NonNullable<PluginState["connection"]>,
  input: string,
): Promise<{ id: string | null; ambiguous: boolean }> {
  // Full UUID — use directly (36 chars with dashes)
  if (input.length === 36 && input.includes("-")) {
    return { id: input, ambiguous: false };
  }

  // Short ID — prefix match against pending approvals
  const ids = await connection.zrange("orch:approvals:pending", 0, -1);
  const matches = ids.filter((id) => id.startsWith(input));

  if (matches.length === 0) return { id: null, ambiguous: false };
  if (matches.length === 1) return { id: matches[0], ambiguous: false };
  return { id: null, ambiguous: true };
}

// ---------------------------------------------------------------------------
// executeApprove
// ---------------------------------------------------------------------------

export type ApproveResult =
  | { success: true; spawnFailed: false; message: string }
  | { success: false; spawnFailed: true; message: string }
  | { success: false; spawnFailed: false; message: string };

/**
 * Execute the approve flow for an approval ID.
 * Shared by /approve command and reaction handler.
 *
 * Does NOT handle short ID resolution — caller must provide a full ID.
 * Does NOT check authorization — caller must validate before calling.
 * Does NOT check expiry inline — CAS handles idempotency.
 */
export async function executeApprove(
  id: string,
  approverId: string,
  state: PluginState,
  api: OpenClawPluginApi,
): Promise<ApproveResult> {
  if (!state.connection) {
    return { success: false, spawnFailed: false, message: "⚠️ Redis not connected." };
  }

  // Pre-fetch for expiry check (before CAS to avoid CAS-then-expiry reversal)
  const rawPre = await state.connection.get(`orch:approval:${id}`);
  if (!rawPre) {
    return {
      success: false,
      spawnFailed: false,
      message: `❌ No approval record found: \`${id}\``,
    };
  }

  let recordPre: ApprovalRecord;
  try {
    recordPre = JSON.parse(rawPre);
  } catch {
    return {
      success: false,
      spawnFailed: false,
      message: `❌ Malformed approval record: \`${id}\``,
    };
  }

  // Expiry check
  const ttlDays = (state.pluginConfig as any)?.approval?.ttlDays ?? 7;
  const ttlMs = ttlDays * 86400_000;
  if (Date.now() - recordPre.createdAt > ttlMs) {
    api.logger.info(
      `approval-logic: approval ${id} expired (created ${new Date(recordPre.createdAt).toISOString()})`,
    );
    recordPre.status = "expired";
    recordPre.expiredAt = Date.now();
    await state.connection.set(`orch:approval:${id}`, JSON.stringify(recordPre), "EX", 86400);
    await state.connection.zrem("orch:approvals:pending", id);
    if (recordPre.project) {
      await state.connection.zrem(`orch:approvals:project:${recordPre.project}`, id);
    }
    return {
      success: false,
      spawnFailed: false,
      message: `⏰ Approval request \`${id}\` has expired.`,
    };
  }

  // Atomic CAS: pending/approved_spawn_failed → approved
  const casResult = (await state.connection.eval(
    CAS_APPROVE_LUA,
    1,
    `orch:approval:${id}`,
    String(Date.now()),
  )) as string | null;

  if (casResult === null) {
    return {
      success: false,
      spawnFailed: false,
      message: `❌ No approval record found: \`${id}\``,
    };
  }
  if (casResult === "malformed") {
    return {
      success: false,
      spawnFailed: false,
      message: `❌ Malformed approval record: \`${id}\``,
    };
  }
  if (casResult !== "ok") {
    return {
      success: false,
      spawnFailed: false,
      message: `Job \`${id}\` is already \`${casResult}\``,
    };
  }

  // CAS succeeded — re-fetch record
  const updatedRaw = await state.connection.get(`orch:approval:${id}`);
  if (!updatedRaw) {
    return {
      success: false,
      spawnFailed: false,
      message: `❌ Approval record disappeared after CAS: \`${id}\``,
    };
  }

  const record: ApprovalRecord = JSON.parse(updatedRaw);
  if (!record.approvedAt) {
    record.approvedAt = Date.now();
  }

  api.logger.info(`approval-logic: approval ${id} approved by ${approverId}`);

  // Spawn the target agent
  try {
    const spawnResult = await spawnApprovedAgent(record, api, state);

    record.spawnRunId = spawnResult.runId;
    record.spawnSessionKey = spawnResult.sessionKey;
    await state.connection.set(`orch:approval:${id}`, JSON.stringify(record), "KEEPTTL");
    await state.connection.zrem("orch:approvals:pending", id);
    if (record.project) {
      await state.connection.zrem(`orch:approvals:project:${record.project}`, id);
    }

    api.logger.info(
      `approval-logic: spawned ${record.target} for approval ${id} (runId: ${spawnResult.runId})`,
    );

    return {
      success: true,
      spawnFailed: false,
      message: `✅ Approved — \`${record.target}\` spawned (job \`${id}\`)`,
    };
  } catch (err) {
    api.logger.warn(
      `approval-logic: spawn failed for approval ${id}: ${err instanceof Error ? err.message : String(err)}`,
    );

    record.status = "approved_spawn_failed";
    try {
      await state.connection.set(`orch:approval:${id}`, JSON.stringify(record), "KEEPTTL");
    } catch (writeErr) {
      api.logger.error?.(
        `approval-logic: failed to write approved_spawn_failed status for ${id}: ${writeErr}`,
      );
    }

    return {
      success: false,
      spawnFailed: true,
      message: `⚠️ Approved but spawn failed for \`${id}\`. Retry with \`/approve ${id}\``,
    };
  }
}

// ---------------------------------------------------------------------------
// executeReject
// ---------------------------------------------------------------------------

export type RejectResult = { success: true; message: string } | { success: false; message: string };

/**
 * Execute the reject flow for an approval ID.
 * Shared by /reject command and reaction handler.
 *
 * Uses CAS_REJECT_LUA for atomic pending → rejected transition.
 * Does NOT handle short ID resolution — caller must provide a full ID.
 * Does NOT check authorization — caller must validate before calling.
 */
export async function executeReject(
  id: string,
  rejecterId: string,
  state: PluginState,
  api: OpenClawPluginApi,
): Promise<RejectResult> {
  if (!state.connection) {
    return { success: false, message: "⚠️ Redis not connected." };
  }

  // Check record exists and expiry before CAS
  const raw = await state.connection.get(`orch:approval:${id}`);
  if (!raw) {
    return { success: false, message: `❌ No approval record found: \`${id}\`` };
  }

  let record: ApprovalRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    return { success: false, message: `❌ Malformed approval record: \`${id}\`` };
  }

  // Expiry check
  const ttlDays = (state.pluginConfig as any)?.approval?.ttlDays ?? 7;
  const ttlMs = ttlDays * 86400_000;
  if (Date.now() - record.createdAt > ttlMs) {
    api.logger.info(
      `approval-logic: approval ${id} expired during reject (created ${new Date(record.createdAt).toISOString()})`,
    );
    record.status = "expired";
    record.expiredAt = Date.now();
    await state.connection.set(`orch:approval:${id}`, JSON.stringify(record), "EX", 86400);
    await state.connection.zrem("orch:approvals:pending", id);
    if (record.project) {
      await state.connection.zrem(`orch:approvals:project:${record.project}`, id);
    }
    return { success: false, message: `⏰ Approval request \`${id}\` has expired.` };
  }

  // Atomic CAS: pending → rejected (will NOT overwrite approved/approved_spawn_failed/rejected)
  const casResult = (await state.connection.eval(
    CAS_REJECT_LUA,
    1,
    `orch:approval:${id}`,
    rejecterId,
    new Date().toISOString(),
  )) as string | null;

  if (casResult === null) {
    return { success: false, message: `❌ No approval record found: \`${id}\`` };
  }
  if (casResult === "malformed") {
    return { success: false, message: `❌ Malformed approval record: \`${id}\`` };
  }
  if (casResult !== "ok") {
    return { success: false, message: `Job \`${id}\` is already \`${casResult}\`` };
  }

  // Clean up sorted sets
  await state.connection.zrem("orch:approvals:pending", id);
  if (record.project) {
    await state.connection.zrem(`orch:approvals:project:${record.project}`, id);
  }

  api.logger.info(`approval-logic: approval ${id} rejected by ${rejecterId}`);

  return {
    success: true,
    message: `❌ Rejected — job \`${id}\` (\`${record.target}\` will not be spawned).`,
  };
}
