// Mattermost plugin module owns native approval-button interactions.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-handler-runtime";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { decodeMattermostApprovalAction } from "../approval-actions.js";
import { mattermostApprovalAuth } from "../approval-auth.js";
import type { MattermostPost } from "./client.js";
import {
  MATTERMOST_APPROVAL_CONTEXT_KEY,
  type MattermostInteractionResponse,
} from "./interactions.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

export type MattermostApprovalInteractionHandler = (params: {
  payload: {
    channel_id: string;
    post_id: string;
    team_id?: string;
    user_id: string;
  };
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
 * Decode+authorize+resolve typed approval button clicks. Returns null for
 * non-approval context so the generic interaction dispatch (which enqueues an
 * agent turn) keeps handling every other button. Approval clicks must never
 * fall through to that generic path: this always returns a terminal
 * update/ephemeral response, resolved or rejected, and never dispatches.
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
      return { ephemeral_text: auth.reason ?? "You are not authorized to approve this request." };
    }

    try {
      const result = await resolveApprovalOverGateway({
        cfg,
        approvalId: approval.approvalId,
        approvalKind: approval.approvalKind,
        decision: approval.decision,
        senderId: params.payload.user_id,
        clientDisplayName: `Mattermost approval (${account.accountId})`,
      });
      const label = resolveMattermostApprovalTerminalLabel(result.approval);
      const prefix = result.applied ? "Resolved" : "Already resolved";
      return {
        update: {
          message: `${prefix}: ${label}`,
          props: { attachments: [] },
        },
      };
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
