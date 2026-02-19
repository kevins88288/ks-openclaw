/**
 * Approval Commands — Phase 3.6 Batch 2 / Phase 3.7
 *
 * Registers /approve, /reject, and /pending Discord slash commands
 * that Kevin uses to action pending approval records created by queue_dispatch.
 *
 * Records live at: orch:approval:{id}  (Redis string, JSON)
 * Index lives at:  orch:approvals:pending  (sorted set, score = createdAt)
 *
 * Phase 3.7 changes:
 *   - /approve uses spawnApprovedAgent() instead of broken callGateway("sessions.spawn")
 *   - /reject uses CAS_REJECT_LUA for atomic transition
 *   - Short ID support: /approve <8chars> resolves to full UUID
 *   - Core approve/reject logic moved to approval-logic.ts (shared with reaction handler)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../index.js";
import { executeApprove, executeReject, resolveApprovalId } from "./approval-logic.js";
import { formatRelativeTime } from "./utils.js";

/**
 * Register /approve, /reject, and /pending commands.
 * Called once inside register(api) — commands re-register on every gateway restart.
 */
export function registerApprovalCommands(api: OpenClawPluginApi, state: PluginState): void {
  // ─────────────────────────────────────────────────────────────────────────
  // /approve <jobId>
  // ─────────────────────────────────────────────────────────────────────────
  api.registerCommand({
    name: "approve",
    description: "Approve a pending dispatch request. Usage: /approve <jobId>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const input = ctx.args?.trim();
      if (!input) return { text: "Usage: `/approve <jobId>`" };

      // Validate sender against authorizedApprovers (fail-secure: empty list blocks everyone)
      const approvers: string[] = (state.pluginConfig as any)?.approval?.authorizedApprovers ?? [];
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

      // Phase 3.7 Piece 4: Short ID support
      const resolved = await resolveApprovalId(state.connection, input);
      if (resolved.ambiguous) {
        return {
          text: `❌ Ambiguous: multiple approvals start with \`${input}\`. Use more characters (or the full UUID).`,
        };
      }
      if (!resolved.id) {
        return { text: `❌ No approval record found: \`${input}\`` };
      }

      const result = await executeApprove(resolved.id, ctx.senderId, state, api);
      return { text: result.message };
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
      const input = ctx.args?.trim();
      if (!input) return { text: "Usage: `/reject <jobId>`" };

      // Validate sender against authorizedApprovers (fail-secure: empty list blocks everyone)
      const approvers: string[] = (state.pluginConfig as any)?.approval?.authorizedApprovers ?? [];
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

      // Phase 3.7 Piece 4: Short ID support
      const resolved = await resolveApprovalId(state.connection, input);
      if (resolved.ambiguous) {
        return {
          text: `❌ Ambiguous: multiple approvals start with \`${input}\`. Use more characters (or the full UUID).`,
        };
      }
      if (!resolved.id) {
        return { text: `❌ No approval record found: \`${input}\`` };
      }

      const result = await executeReject(resolved.id, ctx.senderId ?? "unknown", state, api);
      return { text: result.message };
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

      // Gate /pending by authorizedApprovers
      const approvers: string[] = (state.pluginConfig as any)?.approval?.authorizedApprovers ?? [];
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
          // Key expired — prune the stale entry from the sorted set
          await state.connection.zrem("orch:approvals:pending", id);
          continue;
        }

        let record;
        try {
          record = JSON.parse(raw);
        } catch {
          continue;
        }
        if (record.status !== "pending") continue;

        count++;
        const ageStr = formatRelativeTime(record.createdAt);
        const shortId = id.substring(0, 8);
        const taskPreview =
          record.task.substring(0, 60).replace(/\n/g, " ") + (record.task.length > 60 ? "…" : "");
        // Show short ID prominently for easy copy, plus full UUID
        lines.push(
          `${count}. \`${shortId}\` (\`${id}\`) — ${record.callerAgentId} → ${record.target} | "${taskPreview}" | ${ageStr}`,
        );
      }

      if (count === 0) return { text: "📋 No pending approvals." };
      lines.push(`\nUse \`/approve <shortId>\` or \`/reject <shortId>\``);
      return { text: lines.join("\n") };
    },
  });
}
