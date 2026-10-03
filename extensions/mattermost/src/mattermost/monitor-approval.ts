// Mattermost plugin module owns native approval-button interactions.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-handler-runtime";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import {
  decodeMattermostApprovalAction,
  MATTERMOST_APPROVAL_CONTEXT_KEY,
} from "../approval-actions.js";
import { mattermostApprovalAuth } from "../approval-auth.js";
import type { MattermostPost } from "./client.js";
import type { MattermostInteractionResponse } from "./interactions.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

export type MattermostApprovalInteractionHandler = (params: {
  payload: { channel_id: string; post_id: string; team_id?: string; user_id: string };
  userName: string;
  context: Record<string, unknown>;
  post: MattermostPost;
}) => Promise<MattermostInteractionResponse | null>;

function resolveMattermostApprovalTerminalLabel(
  approval: ApprovalResolveResult["approval"],
): string {
  if (approval.status === "allowed") {
    return approval.decision === "allow-always" ? "Allowed always" : "Allowed once";
  }
  if (approval.status === "denied") {
    return "Denied";
  }
  return approval.status === "expired" ? "Expired" : "Cancelled";
}

/**
 * Decode, authorize, and resolve typed approval button clicks. Returns null for
 * non-approval context so other handlers keep their buttons. An approval click
 * always gets a terminal response and never reaches generic dispatch, which
 * would enqueue an agent turn for a durable operator decision.
 */
export function createMattermostApprovalInteractionHandler(
  monitor: MattermostMonitorContext,
): MattermostApprovalInteractionHandler {
  const { account, cfg, runtime } = monitor;

  return async (params) => {
    const approval = decodeMattermostApprovalAction(
      params.context[MATTERMOST_APPROVAL_CONTEXT_KEY],
    );
    if (!approval) {
      return null;
    }

    const auth = mattermostApprovalAuth.authorizeActorAction({
      cfg,
      accountId: account.accountId,
      senderId: params.payload.user_id,
      action: "approve",
      approvalKind: approval.approvalKind,
    });
    if (!auth.authorized) {
      runtime.log?.(
        `mattermost:interaction drop ${approval.approvalKind} approval user=${params.payload.user_id} (not authorized)`,
      );
      return { ephemeral_text: "You are not authorized to approve this request." };
    }

    try {
      const result = await resolveApprovalOverGateway({
        cfg,
        approvalId: approval.approvalId,
        approvalKind: approval.approvalKind,
        decision: approval.decision,
        channel: "mattermost",
        accountId: account.accountId,
        senderId: params.payload.user_id,
        clientDisplayName: `Mattermost approval (${account.accountId})`,
      });
      const label = resolveMattermostApprovalTerminalLabel(result.approval);
      const prefix = result.applied ? "Resolved" : "Already resolved";
      return { update: { message: `${prefix}: ${label}`, props: { attachments: [] } } };
    } catch (error) {
      runtime.log?.(
        `mattermost:interaction approval resolve failed id=${approval.approvalId}: ${String(error)}`,
      );
      return {
        ephemeral_text: isApprovalNotFoundError(error)
          ? "This approval is no longer pending."
          : "Failed to resolve approval. It may have expired or already been resolved.",
      };
    }
  };
}
