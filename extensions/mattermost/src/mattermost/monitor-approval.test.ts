// Mattermost tests cover native approval-button interaction dispatch ownership.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-handler-runtime", () => ({
  resolveApprovalOverGateway: mocks.resolveApprovalOverGateway,
}));

import {
  encodeMattermostApprovalAction,
  MATTERMOST_APPROVAL_CONTEXT_KEY,
} from "../approval-actions.js";
import { createMattermostApprovalInteractionHandler } from "./monitor-approval.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

function buildMonitor(params: { allowFrom?: string[] }): MattermostMonitorContext {
  return {
    account: { accountId: "default" },
    cfg: {
      channels: {
        mattermost: {
          enabled: true,
          botToken: "test-token",
          baseUrl: "https://chat.example.com",
          ...(params.allowFrom ? { allowFrom: params.allowFrom } : {}),
        },
      },
    },
    runtime: { log: vi.fn() },
  } as unknown as MattermostMonitorContext;
}

const approvedUserId = "abcdefghijklmnopqrstuvwxyz";
const otherUserId = "zzzzzzzzzzzzzzzzzzzzzzzzzz";

function clickWith(userId: string, context: Record<string, unknown>) {
  return {
    payload: { channel_id: "chan-1", post_id: "post-1", user_id: userId },
    userName: "alice",
    context,
    post: { id: "post-1", channel_id: "chan-1", message: "Approve deploy?" },
  };
}

function encoded(decision: "allow-once" | "deny") {
  return {
    [MATTERMOST_APPROVAL_CONTEXT_KEY]: encodeMattermostApprovalAction({
      type: "approval",
      approvalId: "approval-1",
      approvalKind: "exec",
      decision,
    }),
  };
}

describe("Mattermost approval interaction dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for non-approval context so other handlers can run", async () => {
    const handler = createMattermostApprovalInteractionHandler(buildMonitor({}));

    expect(await handler(clickWith(approvedUserId, {}))).toBeNull();
    expect(mocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("resolves an authorized click over the gateway and retires the buttons", async () => {
    mocks.resolveApprovalOverGateway.mockResolvedValue({
      applied: true,
      approval: { id: "approval-1", status: "allowed", decision: "allow-once" },
    });
    const handler = createMattermostApprovalInteractionHandler(
      buildMonitor({ allowFrom: [approvedUserId] }),
    );

    const response = await handler(clickWith(approvedUserId, encoded("allow-once")));

    expect(mocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        approvalKind: "exec",
        decision: "allow-once",
        channel: "mattermost",
        accountId: "default",
        senderId: approvedUserId,
      }),
    );
    expect(response).toEqual({
      update: { message: "Resolved: Allowed once", props: { attachments: [] } },
    });
  });

  it("rejects an unauthorized click without resolving the approval", async () => {
    const handler = createMattermostApprovalInteractionHandler(
      buildMonitor({ allowFrom: [approvedUserId] }),
    );

    const response = await handler(clickWith(otherUserId, encoded("allow-once")));

    expect(mocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
    expect(response).toMatchObject({ ephemeral_text: expect.stringContaining("not authorized") });
  });

  it("returns a terminal ephemeral response when gateway resolution fails", async () => {
    mocks.resolveApprovalOverGateway.mockRejectedValue(new Error("gateway unreachable"));
    const handler = createMattermostApprovalInteractionHandler(
      buildMonitor({ allowFrom: [approvedUserId] }),
    );

    const response = await handler(clickWith(approvedUserId, encoded("deny")));

    expect(response).toMatchObject({ ephemeral_text: expect.any(String) });
  });
});
