/**
 * Reaction Handler — Phase 3.7 Piece 3
 *
 * Registers a `reaction_add` plugin hook that lets Kevin approve or reject
 * pending approval requests by clicking ✅ or ❌ on the notification message.
 *
 * Security model:
 *   - Only fires for Discord reactions (ctx.channelType === "discord")
 *   - Only processes reactions on the configured approval channel
 *   - Bot's own reactions are ignored (prevents infinite loop)
 *   - Only ✅ and ❌ emoji are processed
 *   - Reactor must be in authorizedApprovers list (fail-secure: empty list blocks everyone)
 *   - Unauthorized reactions are silently removed (requires MANAGE_MESSAGES)
 *   - All operations use the same atomic CAS Lua scripts as the slash command path
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
// COUPLING: not in plugin-sdk — tracks src/discord/client.js. File SDK exposure request if this breaks.
import { resolveDiscordRest } from "../../../src/discord/client.js";
// COUPLING: not in plugin-sdk — tracks src/discord/send.reactions.js. File SDK exposure request if this breaks.
import { removeReactionDiscord } from "../../../src/discord/send.reactions.js";
import type { PluginState } from "../index.js";
import { executeApprove, executeReject } from "./approval-logic.js";

// ---------------------------------------------------------------------------
// Emoji constants
// These match the output of formatDiscordReactionEmoji() for standard Unicode emoji.
// formatDiscordReactionEmoji returns emoji.name for non-custom emoji.
// Discord's gateway sends the raw Unicode character as the name.
// ---------------------------------------------------------------------------
const EMOJI_APPROVE = "✅"; // U+2705
const EMOJI_REJECT = "❌"; // U+274C

// ---------------------------------------------------------------------------
// Normalize emoji for Discord REST API URL encoding
// Mirrors platform normalizeReactionEmoji() logic.
// ---------------------------------------------------------------------------
function normalizeEmojiForApi(emoji: string): string {
  const trimmed = emoji.trim();
  const customMatch = trimmed.match(/^<a?:([^:>]+):(\d+)>$/);
  const identifier = customMatch
    ? `${customMatch[1]}:${customMatch[2]}`
    : trimmed.replace(/[\uFE0E\uFE0F]/g, "");
  return encodeURIComponent(identifier);
}

// ---------------------------------------------------------------------------
// Remove a specific user's reaction from a message.
// Uses DELETE /channels/{channel_id}/messages/{message_id}/reactions/{emoji}/{user_id}
// Requires MANAGE_MESSAGES permission.
// This is fire-and-forget — caller should not await or catch.
// ---------------------------------------------------------------------------
async function removeUserReaction(
  channelId: string,
  messageId: string,
  emoji: string,
  userId: string,
): Promise<void> {
  const rest = resolveDiscordRest({});
  const encoded = normalizeEmojiForApi(emoji);
  await rest.delete(`/channels/${channelId}/messages/${messageId}/reactions/${encoded}/${userId}`);
}

// ---------------------------------------------------------------------------
// Find an approval record by the Discord message ID it was notified on.
// Scans orch:approvals:pending sorted set (N is typically < 10).
// Falls back to the msg-index key if present: orch:approvals:msg:{messageId}
// ---------------------------------------------------------------------------
async function findApprovalIdByMessageId(
  connection: NonNullable<PluginState["connection"]>,
  messageId: string,
): Promise<string | null> {
  // Try fast index first (written by queue-dispatch.ts when it creates the record)
  const indexed = await connection.get(`orch:approvals:msg:${messageId}`);
  if (indexed) return indexed;

  // Fallback: linear scan of pending sorted set
  const ids = await connection.zrange("orch:approvals:pending", 0, -1);
  for (const id of ids) {
    const raw = await connection.get(`orch:approval:${id}`);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw);
      if (record.discordMessageId === messageId) return id;
    } catch {
      // skip malformed
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// registerReactionHandler — call from index.ts register()
// ---------------------------------------------------------------------------

export function registerReactionHandler(api: OpenClawPluginApi, state: PluginState): void {
  api.on("reaction_add", async (event, ctx) => {
    // Only handle Discord reactions
    if (ctx.channelType !== "discord") return;

    // Ignore bot reactions (our own ✅/❌ additions trigger this — must not infinite-loop)
    if (event.isBot) return;

    // Redis must be connected
    if (!state.connection) return;

    // Only process reactions on the configured approval channel
    const discordChannelId = (state.pluginConfig as any)?.approval?.discordChannelId as
      | string
      | undefined;
    if (!discordChannelId || event.channelId !== discordChannelId) return;

    // Only handle ✅ and ❌
    if (event.emoji !== EMOJI_APPROVE && event.emoji !== EMOJI_REJECT) return;

    // Auth check — fail-secure: empty list blocks everyone
    const approvers: string[] = (state.pluginConfig as any)?.approval?.authorizedApprovers ?? [];
    if (approvers.length === 0 || !event.userId || !approvers.includes(event.userId)) {
      // Remove unauthorized reaction fire-and-forget (requires MANAGE_MESSAGES)
      if (event.userId) {
        removeUserReaction(event.channelId, event.messageId, event.emoji, event.userId).catch(
          () => {},
        );
      }
      api.logger.warn(
        `reaction-handler: unauthorized reaction ${event.emoji} by ${event.userId ?? "unknown"} on message ${event.messageId}`,
      );
      return;
    }

    // Find the approval record by Discord message ID
    const approvalId = await findApprovalIdByMessageId(state.connection, event.messageId).catch(
      () => null,
    );
    if (!approvalId) {
      api.logger.info(
        `reaction-handler: no approval found for message ${event.messageId} — ignoring ${event.emoji} from ${event.userId}`,
      );
      return;
    }

    api.logger.info(
      `reaction-handler: ${event.emoji} on approval ${approvalId} by ${event.userId}`,
    );

    if (event.emoji === EMOJI_APPROVE) {
      const result = await executeApprove(approvalId, event.userId, state, api);

      if (result.spawnFailed) {
        // Spawn failure UX: remove Kevin's ✅ so he can re-react to retry
        removeUserReaction(event.channelId, event.messageId, EMOJI_APPROVE, event.userId).catch(
          () => {},
        );
        // Post failure message in #approval
        callGatewayMessage(
          discordChannelId,
          `⚠️ Approved but spawn failed for \`${approvalId}\`. Re-react ✅ to retry or use \`/approve ${approvalId}\``,
          api,
        );
        // Leave bot's ✅/❌ reactions in place
      } else if (result.success) {
        // Remove bot's ❌ reaction (visual indicator: approved, no longer rejectable)
        removeReactionDiscord(event.channelId, event.messageId, EMOJI_REJECT).catch(() => {});
        // Post confirmation
        callGatewayMessage(discordChannelId, `✅ Approved \`${approvalId}\` — spawned`, api);
      }
      // If not success and not spawnFailed → already approved/rejected/expired → do nothing
    } else {
      // EMOJI_REJECT
      const result = await executeReject(approvalId, event.userId, state, api);

      if (result.success) {
        // Remove bot's ✅ reaction (visual indicator: rejected)
        removeReactionDiscord(event.channelId, event.messageId, EMOJI_APPROVE).catch(() => {});
        // Post confirmation
        callGatewayMessage(discordChannelId, `❌ Rejected \`${approvalId}\``, api);
      }
      // If not success → already approved/rejected/expired → do nothing
    }
  });
}

// ---------------------------------------------------------------------------
// Helper: post a message to a Discord channel via the gateway
// ---------------------------------------------------------------------------
// COUPLING: not in plugin-sdk — tracks src/gateway/call.js. File SDK exposure request if this breaks.
import { callGateway } from "../../../src/gateway/call.js";

function callGatewayMessage(channelId: string, text: string, api: OpenClawPluginApi): void {
  callGateway({
    method: "send",
    params: {
      to: channelId,
      channel: "discord",
      message: text,
    },
    timeoutMs: 10_000,
  }).catch((err: unknown) => {
    api.logger.warn(
      `reaction-handler: failed to send message to ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}
