// Mattermost tests cover approval-button wiring through registerMattermostInteractions:
// approval clicks must decode/authorize/resolve and terminate without ever
// reaching the generic dispatch path that enqueues an agent turn.
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(),
  registerPluginHttpRoute: vi.fn(),
  authorizeMattermostCommandInvocation: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-handler-runtime", () => ({
  resolveApprovalOverGateway: mocks.resolveApprovalOverGateway,
}));

vi.mock("openclaw/plugin-sdk/webhook-targets", () => ({
  registerPluginHttpRoute: mocks.registerPluginHttpRoute,
}));

vi.mock("./monitor-auth.js", () => ({
  authorizeMattermostCommandInvocation: mocks.authorizeMattermostCommandInvocation,
}));

import type { PluginRuntime } from "../../runtime-api.js";
import { encodeMattermostApprovalAction } from "../approval-actions.js";
import { setMattermostRuntime } from "../runtime.js";
import {
  buildButtonProps,
  MATTERMOST_APPROVAL_CONTEXT_KEY,
  setInteractionSecret,
} from "./interactions.js";
import { registerMattermostInteractions } from "./monitor-interactions.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

const approvedUserId = "abcdefghijklmnopqrstuvwxyz";
const otherUserId = "zzzzzzzzzzzzzzzzzzzzzzzzzz";

function buildSignedApprovalButton(approvalId: string) {
  const encoded = encodeMattermostApprovalAction({
    type: "approval",
    approvalId,
    approvalKind: "exec",
    decision: "allow-once",
  });
  const props = buildButtonProps({
    callbackUrl: "https://gateway.example.com/mattermost/interactions/acct",
    accountId: "acct",
    channelId: "chan-1",
    buttons: [
      {
        id: `approval:${approvalId}`,
        name: "Allow",
        context: { [MATTERMOST_APPROVAL_CONTEXT_KEY]: encoded },
      },
    ],
  });
  const attachments = props?.attachments as
    | Array<{
        actions?: Array<{
          id: string;
          name: string;
          integration: { context: Record<string, unknown> };
        }>;
      }>
    | undefined;
  const action = attachments?.[0]?.actions?.[0];
  if (!action) {
    throw new Error("expected signed approval button fixture");
  }
  return action;
}

function createReq(body: unknown): IncomingMessage {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const req = {
    method: "POST",
    headers: {},
    socket: { remoteAddress: "203.0.113.10" },
    on(event: string, handler: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
      return this;
    },
    removeListener() {
      return this;
    },
    destroy() {},
  } as unknown as IncomingMessage & { emitTest: (event: string, ...args: unknown[]) => void };
  const raw = JSON.stringify(body);
  queueMicrotask(() => {
    (req as unknown as { emitTest: (event: string, ...args: unknown[]) => void }).emitTest?.(
      "data",
      Buffer.from(raw),
    );
    (req as unknown as { emitTest: (event: string, ...args: unknown[]) => void }).emitTest?.("end");
  });
  (req as unknown as { emitTest: (event: string, ...args: unknown[]) => void }).emitTest = (
    event,
    ...args
  ) => {
    for (const handler of listeners.get(event) ?? []) {
      handler(...args);
    }
  };
  return req;
}

function createRes(): ServerResponse & { body: string } {
  const res = {
    statusCode: 200,
    setHeader() {
      return res;
    },
    end(chunk?: string | Buffer) {
      res.body = chunk ? String(chunk) : "";
    },
    body: "",
  } as unknown as ServerResponse & { body: string };
  return res;
}

function buildMonitor(params: {
  allowFrom?: string[];
  actionId: string;
}): MattermostMonitorContext {
  const dispatch = vi.fn();
  return {
    account: { accountId: "acct" },
    botUserId: "bot",
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
    client: {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "bot-token",
      request: async <T>(path: string, init?: { method?: string }) => {
        if (init?.method === "PUT") {
          return { id: "post-1" } as T;
        }
        return {
          id: "post-1",
          channel_id: "chan-1",
          message: "Approve deploy?",
          props: { attachments: [{ actions: [{ id: params.actionId, name: "Allow" }] }] },
        } as T;
      },
      fetchImpl: vi.fn(),
    },
    core: {
      channel: {
        commands: { shouldHandleTextCommands: vi.fn(() => true) },
        inbound: { dispatch },
      },
    },
    pairing: { readAllowFromStore: vi.fn(async () => []) },
    resources: { resolveChannelInfo: vi.fn(async () => ({ id: "chan-1", type: "O" })) },
    runtime: { log: vi.fn(), error: vi.fn() },
    dispatchMock: dispatch,
  } as unknown as MattermostMonitorContext & { dispatchMock: ReturnType<typeof vi.fn> };
}

describe("registerMattermostInteractions approval wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMattermostRuntime({
      system: { enqueueSystemEvent: () => true },
    } as unknown as PluginRuntime);
    setInteractionSecret("acct", "bot-token");
    mocks.authorizeMattermostCommandInvocation.mockResolvedValue({ ok: true });
  });

  function captureHandler(monitor: MattermostMonitorContext) {
    registerMattermostInteractions({
      monitor,
      interactionPath: "/mattermost/interactions/acct",
      allowedSourceIps: [],
      handleModelPickerInteraction: async () => null,
    });
    const call = mocks.registerPluginHttpRoute.mock.calls[0]?.[0] as
      | { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }
      | undefined;
    if (!call) {
      throw new Error("expected registerPluginHttpRoute call");
    }
    return call.handler;
  }

  it("resolves an authorized approval click over the gateway and never dispatches an agent turn", async () => {
    mocks.resolveApprovalOverGateway.mockResolvedValue({
      applied: true,
      approval: { id: "approval-1", status: "allowed", decision: "allow-once" },
    });
    const action = buildSignedApprovalButton("approval-1");
    const monitor = buildMonitor({ allowFrom: [approvedUserId], actionId: action.id });
    const handler = captureHandler(monitor);

    const req = createReq({
      user_id: approvedUserId,
      user_name: "alice",
      channel_id: "chan-1",
      post_id: "post-1",
      context: action.integration.context,
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      update: { message: "Resolved: Allowed once", props: { attachments: [] } },
    });
    expect(mocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-1", decision: "allow-once" }),
    );
    expect(
      (monitor as unknown as { dispatchMock: ReturnType<typeof vi.fn> }).dispatchMock,
    ).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized approval click and never resolves or dispatches", async () => {
    const action = buildSignedApprovalButton("approval-1");
    const monitor = buildMonitor({ allowFrom: [approvedUserId], actionId: action.id });
    const handler = captureHandler(monitor);

    const req = createReq({
      user_id: otherUserId,
      user_name: "mallory",
      channel_id: "chan-1",
      post_id: "post-1",
      context: action.integration.context,
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ephemeral_text).toContain("not authorized");
    expect(mocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
    expect(
      (monitor as unknown as { dispatchMock: ReturnType<typeof vi.fn> }).dispatchMock,
    ).not.toHaveBeenCalled();
  });
});
