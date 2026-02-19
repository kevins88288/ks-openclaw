/**
 * Approval Commands — Phase 3.6 Batch 2
 *
 * Registers /approve, /reject, and /pending Discord slash commands
 * that Kevin uses to action pending approval records created by queue_dispatch.
 *
 * Records live at: orch:approval:{id}  (Redis string, JSON)
 * Index lives at:  orch:approvals:pending  (sorted set, score = createdAt)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../index.js";
import type { ApprovalRecord } from "./types.js";
import { formatRelativeTime } from "./utils.js";
import { callGateway } from "../../../src/gateway/call.js";

/**
 * Build the task prompt for the spawned agent when a request is approved.
 * Includes full original task text (not truncated) plus Kevin-approved framing.
 */
function buildApprovedTaskPrompt(record: ApprovalRecord): string {
  return `[Approved Request — Kevin has approved this]

Kevin explicitly approved the following request from ${record.callerAgentId}.

Original request:
${record.task}

Requested by: ${record.callerAgentId}
Approval ID: ${record.id}
Approved at: ${new Date(record.approvedAt!).toISOString()}

Please execute this request.`;
}

/**
 * Lua compare-and-swap for pending → approved transition.
 *
 * Returns:
 *   nil          — key does not exist
 *   'malformed'  — JSON parse error
 *   'ok'         — CAS succeeded, status written as 'approved'
 *   <status>     — already in that status (idempotency guard)
 *
 * ARGV[1] = current timestamp (ms) for approvedAt
 */
const CAS_APPROVE_LUA = `
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
 * Register /approve, /reject, and /pending commands.
 * Called once inside register(api) — commands re-register on every gateway restart.
 */
export function registerApprovalCommands(
  api: OpenClawPluginApi,
  state: PluginState,
): void {
  // ─────────────────────────────────────────────────────────────────────────
  // /approve <jobId>
  // ─────────────────────────────────────────────────────────────────────────
  api.registerCommand({
    name: "approve",
    description: "Approve a pending dispatch request. Usage: /approve <jobId>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const id = ctx.args?.trim();
      if (!id) return { text: "Usage: `/approve <jobId>`" };

      // FIX-1: Validate sender against authorizedApprovers (fail-secure: empty list blocks everyone)
      const approvers: string[] =
        (state.pluginConfig as any)?.approval?.authorizedApprovers ?? [];
      if (approvers.length === 0) {
        return { text: "⛔ No authorized approvers configured." };
      }
      if (!ctx.senderId || !approvers.includes(ctx.senderId)) {
        api.logger.warn(
          `redis-orchestrator: unauthorized /approve attempt by ${ctx.senderId ?? "unknown"}`,
        );
        return { text: "⛔ You are not authorized to approve requests." };
      }

      // Check connection
      if (!state.connection) return { text: "⚠️ Redis not connected." };

      // Pre-fetch for expiry check (before CAS to avoid CAS-then-expiry reversal)
      const rawPre = await state.connection.get(`orch:approval:${id}`);
      if (!rawPre) return { text: `❌ No approval record found: \`${id}\`` };

      let recordPre: ApprovalRecord;
      try {
        recordPre = JSON.parse(rawPre);
      } catch {
        return { text: `❌ Malformed approval record: \`${id}\`` };
      }

      // Expiry check
      const ttlDays = (state.pluginConfig as any)?.approval?.ttlDays ?? 7;
      const ttlMs = ttlDays * 86400_000;
      if (Date.now() - recordPre.createdAt > ttlMs) {
        api.logger.info(
          `redis-orchestrator: approval ${id} expired (created ${new Date(recordPre.createdAt).toISOString()})`,
        );
        recordPre.status = "expired";
        recordPre.expiredAt = Date.now();
        await state.connection.set(
          `orch:approval:${id}`,
          JSON.stringify(recordPre),
          "EX",
          86400,
        );
        await state.connection.zrem("orch:approvals:pending", id);
        // FIX-10: Also clean project sorted set
        if (recordPre.project) {
          await state.connection.zrem(`orch:approvals:project:${recordPre.project}`, id);
        }
        return { text: `⏰ Approval request \`${id}\` has expired.` };
      }

      // FIX-9: Atomic CAS — read-check-write in a single Lua script to prevent double-spawn
      const casResult = (await state.connection.eval(
        CAS_APPROVE_LUA,
        1,
        `orch:approval:${id}`,
        String(Date.now()),
      )) as string | null;

      if (casResult === null) return { text: `❌ No approval record found: \`${id}\`` };
      if (casResult === "malformed") return { text: `❌ Malformed approval record: \`${id}\`` };
      if (casResult !== "ok") return { text: `Job \`${id}\` is already \`${casResult}\`` };

      // CAS succeeded — re-fetch record to get full spawning params
      const updatedRaw = await state.connection.get(`orch:approval:${id}`);
      if (!updatedRaw) return { text: `❌ Approval record disappeared after CAS: \`${id}\`` };
      const record: ApprovalRecord = JSON.parse(updatedRaw);

      // FIX-8: Defensive guard — Lua already set approvedAt, but ensure it's set in case of edge cases
      if (!record.approvedAt) {
        record.approvedAt = Date.now();
      }

      // FIX-6: Log approval granted
      api.logger.info(
        `redis-orchestrator: approval ${id} approved by ${ctx.senderId ?? "unknown"}`,
      );

      // Spawn the original target agent
      try {
        const spawnResult = await callGateway<{
          runId?: string;
          childSessionKey?: string;
        }>({
          method: "sessions.spawn",
          params: {
            task: buildApprovedTaskPrompt(record),
            agentId: record.target,
            label: `approved: ${record.label ?? id}`,
            storeResult: true, // always capture result for approval-spawned jobs
            ...(record.model ? { model: record.model } : {}),
            ...(record.thinking ? { thinking: record.thinking } : {}),
            ...(record.runTimeoutSeconds
              ? { runTimeoutSeconds: record.runTimeoutSeconds }
              : {}),
            cleanup: record.cleanup ?? "keep",
          },
          timeoutMs: 15_000,
        });

        // FIX-6: Log spawn success
        api.logger.info(
          `redis-orchestrator: spawned ${record.target} for approval ${id} (runId: ${spawnResult?.runId})`,
        );

        record.spawnRunId = spawnResult?.runId;
        record.spawnSessionKey = spawnResult?.childSessionKey;
        await state.connection.set(
          `orch:approval:${id}`,
          JSON.stringify(record),
          "KEEPTTL",
        );
        await state.connection.zrem("orch:approvals:pending", id);
        // FIX-10: Also clean project sorted set on approve success
        if (record.project) {
          await state.connection.zrem(`orch:approvals:project:${record.project}`, id);
        }

        return {
          text: `✅ Approved — \`${record.target}\` spawned (job \`${id}\`)`,
        };
      } catch (err) {
        // FIX-6: Log spawn failure
        api.logger.warn(
          `redis-orchestrator: spawn failed for approval ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        record.status = "approved_spawn_failed";
        // FIX-7: Wrap catch-block Redis write in its own try-catch
        try {
          await state.connection.set(
            `orch:approval:${id}`,
            JSON.stringify(record),
            "KEEPTTL",
          );
        } catch (writeErr) {
          api.logger.error?.(
            `redis-orchestrator: failed to write approved_spawn_failed status for ${id}: ${writeErr}`,
          );
          // Record stuck in 'approved' — retryable via /approve <id>
        }
        return {
          text: `⚠️ Approved but spawn failed for \`${id}\`. Retry with \`/approve ${id}\``,
        };
      }
    },
  });

  // ─────────────────────────────────────────────────────────────────────────
  // /reject <jobId>
  // ─────────────────────────────────────────────────────────────────────────
  api.registerCommand({
    name: "reject",
    description: "Reject a pending dispatch request. Usage: /reject <jobId>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const id = ctx.args?.trim();
      if (!id) return { text: "Usage: `/reject <jobId>`" };

      // FIX-1: Validate sender against authorizedApprovers (fail-secure: empty list blocks everyone)
      const approvers: string[] =
        (state.pluginConfig as any)?.approval?.authorizedApprovers ?? [];
      if (approvers.length === 0) {
        return { text: "⛔ No authorized approvers configured." };
      }
      if (!ctx.senderId || !approvers.includes(ctx.senderId)) {
        api.logger.warn(
          `redis-orchestrator: unauthorized /reject attempt by ${ctx.senderId ?? "unknown"}`,
        );
        return { text: "⛔ You are not authorized to approve requests." };
      }

      // Check connection
      if (!state.connection) return { text: "⚠️ Redis not connected." };
      const raw = await state.connection.get(`orch:approval:${id}`);
      if (!raw) return { text: `❌ No approval record found: \`${id}\`` };

      let record: ApprovalRecord;
      try {
        record = JSON.parse(raw);
      } catch {
        return { text: `❌ Malformed approval record: \`${id}\`` };
      }

      // Idempotency: only transition from "pending"
      if (record.status !== "pending") {
        return { text: `Job \`${id}\` is already \`${record.status}\`` };
      }

      // Expiry check
      const ttlDays = (state.pluginConfig as any)?.approval?.ttlDays ?? 7;
      const ttlMs = ttlDays * 86400_000;
      if (Date.now() - record.createdAt > ttlMs) {
        api.logger.info(
          `redis-orchestrator: approval ${id} expired during /reject (created ${new Date(record.createdAt).toISOString()})`,
        );
        record.status = "expired";
        record.expiredAt = Date.now();
        await state.connection.set(
          `orch:approval:${id}`,
          JSON.stringify(record),
          "EX",
          86400,
        );
        await state.connection.zrem("orch:approvals:pending", id);
        // FIX-10: Also clean project sorted set on expiry
        if (record.project) {
          await state.connection.zrem(`orch:approvals:project:${record.project}`, id);
        }
        return { text: `⏰ Approval request \`${id}\` has expired.` };
      }

      // Mark rejected — no spawn, no caller notification (silent)
      record.status = "rejected";
      record.rejectedAt = Date.now();
      await state.connection.set(
        `orch:approval:${id}`,
        JSON.stringify(record),
        "KEEPTTL",
      );
      await state.connection.zrem("orch:approvals:pending", id);
      // FIX-10: Also clean project sorted set on reject
      if (record.project) {
        await state.connection.zrem(`orch:approvals:project:${record.project}`, id);
      }

      // FIX-6: Log rejection
      api.logger.info(
        `redis-orchestrator: approval ${id} rejected by ${ctx.senderId ?? "unknown"}`,
      );

      return {
        text: `❌ Rejected — job \`${id}\` (\`${record.target}\` will not be spawned).`,
      };
    },
  });

  // ─────────────────────────────────────────────────────────────────────────
  // /pending
  // ─────────────────────────────────────────────────────────────────────────
  api.registerCommand({
    name: "pending",
    description: "List pending approval requests.",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx) => {
      if (!state.connection) return { text: "⚠️ Redis not connected." };

      // FIX-11: Gate /pending by authorizedApprovers
      const approvers: string[] =
        (state.pluginConfig as any)?.approval?.authorizedApprovers ?? [];
      if (approvers.length === 0 || !ctx.senderId || !approvers.includes(ctx.senderId)) {
        return { text: "⛔ You are not authorized to view pending approvals." };
      }

      // Read newest-first (zrevrange), fetch up to 20
      const ids = await state.connection.zrevrange("orch:approvals:pending", 0, 19);
      if (ids.length === 0) return { text: "📋 No pending approvals." };

      const lines: string[] = [`📋 **Pending Approvals** (${ids.length})\n`];
      let count = 0;

      for (const id of ids) {
        const raw = await state.connection.get(`orch:approval:${id}`);
        if (!raw) {
          // FIX-5: Key expired — actually prune the stale entry from the sorted set
          await state.connection.zrem("orch:approvals:pending", id);
          continue;
        }

        let record: ApprovalRecord;
        try {
          record = JSON.parse(raw);
        } catch {
          continue;
        }
        if (record.status !== "pending") continue;

        count++;
        const ageStr = formatRelativeTime(record.createdAt);
        const taskPreview =
          record.task.substring(0, 60).replace(/\n/g, " ") +
          (record.task.length > 60 ? "…" : "");
        // FIX-12: Show full UUID (not truncated 8-char prefix)
        lines.push(
          `${count}. \`${id}\` — ${record.callerAgentId} → ${record.target} | "${taskPreview}" | ${ageStr}`,
        );
      }

      if (count === 0) return { text: "📋 No pending approvals." };
      lines.push(`\nUse \`/approve <jobId>\` or \`/reject <jobId>\``);
      return { text: lines.join("\n") };
    },
  });
}
