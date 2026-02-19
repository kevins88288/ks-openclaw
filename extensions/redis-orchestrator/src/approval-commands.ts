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

      // 1. Validate sender against authorizedApprovers
      const approvers: string[] =
        (state.pluginConfig as any)?.approval?.authorizedApprovers ?? [];
      if (approvers.length > 0 && ctx.senderId && !approvers.includes(ctx.senderId)) {
        return { text: "⛔ You are not authorized to approve requests." };
      }

      // 2. Fetch approval record
      if (!state.connection) return { text: "⚠️ Redis not connected." };
      const raw = await state.connection.get(`orch:approval:${id}`);
      if (!raw) return { text: `❌ No approval record found: \`${id}\`` };

      let record: ApprovalRecord;
      try {
        record = JSON.parse(raw);
      } catch {
        return { text: `❌ Malformed approval record: \`${id}\`` };
      }

      // 3. Idempotency: only transition from "pending" or retryable "approved_spawn_failed"
      if (record.status !== "pending" && record.status !== "approved_spawn_failed") {
        return { text: `Job \`${id}\` is already \`${record.status}\`` };
      }

      // 4. Expiry check
      const ttlDays = (state.pluginConfig as any)?.approval?.ttlDays ?? 7;
      const ttlMs = ttlDays * 86400_000;
      if (Date.now() - record.createdAt > ttlMs) {
        record.status = "expired";
        record.expiredAt = Date.now();
        await state.connection.set(
          `orch:approval:${id}`,
          JSON.stringify(record),
          "EX",
          86400,
        );
        await state.connection.zrem("orch:approvals:pending", id);
        return { text: `⏰ Approval request \`${id}\` has expired.` };
      }

      // 5. Mark approved BEFORE spawning (fail-safe: prevents double-spawn on retry)
      record.status = "approved";
      record.approvedAt = Date.now();
      await state.connection.set(
        `orch:approval:${id}`,
        JSON.stringify(record),
        "KEEPTTL",
      );

      // 6. Spawn the original target agent
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

        record.spawnRunId = spawnResult?.runId;
        record.spawnSessionKey = spawnResult?.childSessionKey;
        await state.connection.set(
          `orch:approval:${id}`,
          JSON.stringify(record),
          "KEEPTTL",
        );
        await state.connection.zrem("orch:approvals:pending", id);

        return {
          text: `✅ Approved — \`${record.target}\` spawned (job \`${id}\`)`,
        };
      } catch (err) {
        record.status = "approved_spawn_failed";
        await state.connection.set(
          `orch:approval:${id}`,
          JSON.stringify(record),
          "KEEPTTL",
        );
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

      // 1. Validate sender against authorizedApprovers
      const approvers: string[] =
        (state.pluginConfig as any)?.approval?.authorizedApprovers ?? [];
      if (approvers.length > 0 && ctx.senderId && !approvers.includes(ctx.senderId)) {
        return { text: "⛔ You are not authorized to reject requests." };
      }

      // 2. Fetch approval record
      if (!state.connection) return { text: "⚠️ Redis not connected." };
      const raw = await state.connection.get(`orch:approval:${id}`);
      if (!raw) return { text: `❌ No approval record found: \`${id}\`` };

      let record: ApprovalRecord;
      try {
        record = JSON.parse(raw);
      } catch {
        return { text: `❌ Malformed approval record: \`${id}\`` };
      }

      // 3. Idempotency: only transition from "pending"
      if (record.status !== "pending") {
        return { text: `Job \`${id}\` is already \`${record.status}\`` };
      }

      // 4. Expiry check
      const ttlDays = (state.pluginConfig as any)?.approval?.ttlDays ?? 7;
      const ttlMs = ttlDays * 86400_000;
      if (Date.now() - record.createdAt > ttlMs) {
        record.status = "expired";
        record.expiredAt = Date.now();
        await state.connection.set(
          `orch:approval:${id}`,
          JSON.stringify(record),
          "EX",
          86400,
        );
        await state.connection.zrem("orch:approvals:pending", id);
        return { text: `⏰ Approval request \`${id}\` has expired.` };
      }

      // 5. Mark rejected — no spawn, no caller notification (silent)
      record.status = "rejected";
      record.rejectedAt = Date.now();
      await state.connection.set(
        `orch:approval:${id}`,
        JSON.stringify(record),
        "KEEPTTL",
      );
      await state.connection.zrem("orch:approvals:pending", id);

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
    handler: async (_ctx) => {
      if (!state.connection) return { text: "⚠️ Redis not connected." };

      // Read newest-first (zrevrange), fetch up to 20
      const ids = await state.connection.zrevrange("orch:approvals:pending", 0, 19);
      if (ids.length === 0) return { text: "📋 No pending approvals." };

      const lines: string[] = [`📋 **Pending Approvals** (${ids.length})\n`];
      let count = 0;

      for (const id of ids) {
        const raw = await state.connection.get(`orch:approval:${id}`);
        if (!raw) continue; // expired — lazy prune

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
        lines.push(
          `${count}. \`${id.substring(0, 8)}…\` — ${record.callerAgentId} → ${record.target} | "${taskPreview}" | ${ageStr}`,
        );
      }

      if (count === 0) return { text: "📋 No pending approvals." };
      lines.push(`\nUse \`/approve <jobId>\` or \`/reject <jobId>\``);
      return { text: lines.join("\n") };
    },
  });
}
