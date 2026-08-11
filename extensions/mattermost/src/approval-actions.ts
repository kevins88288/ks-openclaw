// Mattermost plugin module owns its transport-private approval callback envelope.
import type { MessagePresentationAction } from "openclaw/plugin-sdk/interactive-runtime";

const MATTERMOST_APPROVAL_VALUE_PREFIX = "openclaw:approval:v1:";

export type MattermostApprovalAction = Extract<MessagePresentationAction, { type: "approval" }>;

function isApprovalDecision(value: unknown): value is MattermostApprovalAction["decision"] {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

/** Encode portable approval facts into the button's signed integration context, not its id. */
export function encodeMattermostApprovalAction(action: MattermostApprovalAction): string {
  return `${MATTERMOST_APPROVAL_VALUE_PREFIX}${JSON.stringify({
    approvalId: action.approvalId,
    approvalKind: action.approvalKind,
    decision: action.decision,
  })}`;
}

/** Decode only the exact Mattermost-owned approval envelope. Malformed callbacks fail closed. */
export function decodeMattermostApprovalAction(value: unknown): MattermostApprovalAction | null {
  if (typeof value !== "string" || !value.startsWith(MATTERMOST_APPROVAL_VALUE_PREFIX)) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(value.slice(MATTERMOST_APPROVAL_VALUE_PREFIX.length));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return null;
    }
    const record = decoded as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      typeof record.approvalId !== "string" ||
      record.approvalId.length === 0 ||
      (record.approvalKind !== "exec" && record.approvalKind !== "plugin") ||
      !isApprovalDecision(record.decision)
    ) {
      return null;
    }
    return {
      type: "approval",
      approvalId: record.approvalId,
      approvalKind: record.approvalKind,
      decision: record.decision,
    };
  } catch {
    return null;
  }
}
