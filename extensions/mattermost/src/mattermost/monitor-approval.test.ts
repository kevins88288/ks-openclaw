// Mattermost tests cover native approval-button interaction dispatch ownership.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-handler-runtime", () => ({
  resolveApprovalOverGateway: mocks.resolveApprovalOverGateway,
}));

import { encodeMattermostApprovalAction } from "../approval-actions.js";
import { MATTERMOST_APPROVAL_CONTEXT_KEY } from "./interactions.js";
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

function buildPayload(userId: string) {
  return { channel_id: "chan-1", post_id: "post-1", user_id: userId };
}

describe("Mattermost approval interaction dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for non-approval context so other handlers can run", async () => {
    const handler = createMattermostApprovalInteractionHandler(buildMonitor({}));

    const response = await handler({
      payload: buildPayload(approvedUserId),
      userName: "alice",
      context: {},
      post: { id: "post-1", channel_id: "chan-1", message: "Pick" },
    });

    expect(response).toBeNull();
    expect(mocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("resolves an authorized approval click over the gateway and returns a terminal response", async () => {
    mocks.resolveApprovalOverGateway.mockResolvedValue({
      applied: true,
      approval: { id: "approval-1", status: "allowed", decision: "allow-once" },
    });
    const handler = createMattermostApprovalInteractionHandler(
      buildMonitor({ allowFrom: [approvedUserId] }),
    );
    const encoded = encodeMattermostApprovalAction({
      type: "approval",
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-once",
    });

    const response = await handler({
      payload: buildPayload(approvedUserId),
      userName: "alice",
      context: { [MATTERMOST_APPROVAL_CONTEXT_KEY]: encoded },
      post: { id: "post-1", channel_id: "chan-1", message: "Approve deploy?" },
    });

    expect(mocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        approvalKind: "exec",
        decision: "allow-once",
        senderId: approvedUserId,
      }),
    );
    expect(response).toEqual({
      update: {
        message: "Resolved: Allowed once",
        props: { attachments: [] },
      },
    });
  });

  it("rejects an unauthorized click without resolving the approval", async () => {
    const handler = createMattermostApprovalInteractionHandler(
      buildMonitor({ allowFrom: [approvedUserId] }),
    );
    const encoded = encodeMattermostApprovalAction({
      type: "approval",
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-once",
    });

    const response = await handler({
      payload: buildPayload(otherUserId),
      userName: "mallory",
      context: { [MATTERMOST_APPROVAL_CONTEXT_KEY]: encoded },
      post: { id: "post-1", channel_id: "chan-1", message: "Approve deploy?" },
    });

    expect(mocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      ephemeral_text: expect.stringContaining("not authorized"),
    });
  });

  it("returns a terminal ephemeral response when gateway resolution fails", async () => {
    mocks.resolveApprovalOverGateway.mockRejectedValue(new Error("gateway unreachable"));
    const handler = createMattermostApprovalInteractionHandler(
      buildMonitor({ allowFrom: [approvedUserId] }),
    );
    const encoded = encodeMattermostApprovalAction({
      type: "approval",
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "deny",
    });

    const response = await handler({
      payload: buildPayload(approvedUserId),
      userName: "alice",
      context: { [MATTERMOST_APPROVAL_CONTEXT_KEY]: encoded },
      post: { id: "post-1", channel_id: "chan-1", message: "Approve deploy?" },
    });

    expect(response).toMatchObject({ ephemeral_text: expect.any(String) });
  });
});
