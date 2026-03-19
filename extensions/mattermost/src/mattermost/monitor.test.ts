import type { OpenClawConfig } from "openclaw/plugin-sdk/mattermost";
import { describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import {
  evaluateMattermostMentionGate,
  resolveMattermostEffectiveReplyToId,
  resolveMattermostReplyRootId,
  resolveMattermostSpecificReplyParentId,
  resolveMattermostThreadSessionContext,
  type MattermostMentionGateInput,
  type MattermostRequireMentionResolverInput,
} from "./monitor.js";
import { buildThreadStarterContextFields } from "./threading.js";

function resolveRequireMentionForTest(params: MattermostRequireMentionResolverInput): boolean {
  const root = params.cfg.channels?.mattermost;
  const accountGroups = root?.accounts?.[params.accountId]?.groups;
  const groups = accountGroups ?? root?.groups;
  const groupConfig = params.groupId ? groups?.[params.groupId] : undefined;
  const defaultGroupConfig = groups?.["*"];
  const configMention =
    typeof groupConfig?.requireMention === "boolean"
      ? groupConfig.requireMention
      : typeof defaultGroupConfig?.requireMention === "boolean"
        ? defaultGroupConfig.requireMention
        : undefined;
  if (typeof configMention === "boolean") {
    return configMention;
  }
  if (typeof params.requireMentionOverride === "boolean") {
    return params.requireMentionOverride;
  }
  return true;
}

function evaluateMentionGateForMessage(params: { cfg: OpenClawConfig; threadRootId?: string }) {
  const account = resolveMattermostAccount({ cfg: params.cfg, accountId: "default" });
  const resolver = vi.fn(resolveRequireMentionForTest);
  const input: MattermostMentionGateInput = {
    kind: "channel",
    cfg: params.cfg,
    accountId: account.accountId,
    channelId: "chan-1",
    threadRootId: params.threadRootId,
    requireMentionOverride: account.requireMention,
    resolveRequireMention: resolver,
    wasMentioned: false,
    isControlCommand: false,
    commandAuthorized: false,
    oncharEnabled: false,
    oncharTriggered: false,
    canDetectMention: true,
  };
  const decision = evaluateMattermostMentionGate(input);
  return { account, resolver, decision };
}

describe("mattermost mention gating", () => {
  it("accepts unmentioned root channel posts in onmessage mode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "onmessage",
          groupPolicy: "open",
        },
      },
    };
    const { resolver, decision } = evaluateMentionGateForMessage({ cfg });
    expect(decision.dropReason).toBeNull();
    expect(decision.shouldRequireMention).toBe(false);
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        groupId: "chan-1",
        requireMentionOverride: false,
      }),
    );
  });

  it("accepts unmentioned thread replies in onmessage mode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "onmessage",
          groupPolicy: "open",
        },
      },
    };
    const { resolver, decision } = evaluateMentionGateForMessage({
      cfg,
      threadRootId: "thread-root-1",
    });
    expect(decision.dropReason).toBeNull();
    expect(decision.shouldRequireMention).toBe(false);
    const resolverCall = resolver.mock.calls.at(-1)?.[0];
    expect(resolverCall?.groupId).toBe("chan-1");
    expect(resolverCall?.groupId).not.toBe("thread-root-1");
  });

  it("rejects unmentioned channel posts in oncall mode", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          chatmode: "oncall",
          groupPolicy: "open",
        },
      },
    };
    const { decision, account } = evaluateMentionGateForMessage({ cfg });
    expect(account.requireMention).toBe(true);
    expect(decision.shouldRequireMention).toBe(true);
    expect(decision.dropReason).toBe("missing-mention");
  });
});

describe("resolveMattermostReplyRootId with block streaming payloads", () => {
  it("uses threadRootId for block-streamed payloads with replyToId", () => {
    // When block streaming sends a payload with replyToId from the threading
    // mode, the deliver callback should still use the existing threadRootId.
    expect(
      resolveMattermostReplyRootId({
        threadRootId: "thread-root-1",
        replyToId: "streamed-reply-id",
      }),
    ).toBe("thread-root-1");
  });

  it("falls back to payload replyToId when no threadRootId in block streaming", () => {
    // Top-level channel message: no threadRootId, payload carries the
    // inbound post id as replyToId from the "all" threading mode.
    expect(
      resolveMattermostReplyRootId({
        replyToId: "inbound-post-for-threading",
      }),
    ).toBe("inbound-post-for-threading");
  });
});

describe("resolveMattermostReplyRootId", () => {
  it("uses replyToId for top-level replies", () => {
    expect(
      resolveMattermostReplyRootId({
        replyToId: "inbound-post-123",
      }),
    ).toBe("inbound-post-123");
  });

  it("keeps the thread root when replying inside an existing thread", () => {
    expect(
      resolveMattermostReplyRootId({
        threadRootId: "thread-root-456",
        replyToId: "child-post-789",
      }),
    ).toBe("thread-root-456");
  });

  it("falls back to undefined when neither reply target is available", () => {
    expect(resolveMattermostReplyRootId({})).toBeUndefined();
  });
});

describe("resolveMattermostEffectiveReplyToId", () => {
  it("keeps an existing thread root", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "channel",
        postId: "post-123",
        replyToMode: "all",
        threadRootId: "thread-root-456",
      }),
    ).toBe("thread-root-456");
  });

  it("starts a thread for top-level channel messages when replyToMode is all", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "channel",
        postId: "post-123",
        replyToMode: "all",
      }),
    ).toBe("post-123");
  });

  it("starts a thread for top-level group messages when replyToMode is first", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "group",
        postId: "post-123",
        replyToMode: "first",
      }),
    ).toBe("post-123");
  });

  it("keeps direct messages non-threaded", () => {
    expect(
      resolveMattermostEffectiveReplyToId({
        kind: "direct",
        postId: "post-123",
        replyToMode: "all",
      }),
    ).toBeUndefined();
  });
});

describe("resolveMattermostThreadSessionContext", () => {
  it("forks channel sessions by top-level post when replyToMode is all", () => {
    expect(
      resolveMattermostThreadSessionContext({
        baseSessionKey: "agent:main:mattermost:default:chan-1",
        kind: "channel",
        postId: "post-123",
        replyToMode: "all",
      }),
    ).toEqual({
      effectiveReplyToId: "post-123",
      sessionKey: "agent:main:mattermost:default:chan-1:thread:post-123",
      parentSessionKey: "agent:main:mattermost:default:chan-1",
    });
  });

  it("keeps existing thread roots for threaded follow-ups", () => {
    expect(
      resolveMattermostThreadSessionContext({
        baseSessionKey: "agent:main:mattermost:default:chan-1",
        kind: "group",
        postId: "post-123",
        replyToMode: "first",
        threadRootId: "root-456",
      }),
    ).toEqual({
      effectiveReplyToId: "root-456",
      sessionKey: "agent:main:mattermost:default:chan-1:thread:root-456",
      parentSessionKey: "agent:main:mattermost:default:chan-1",
    });
  });

  it("keeps direct-message sessions linear", () => {
    expect(
      resolveMattermostThreadSessionContext({
        baseSessionKey: "agent:main:mattermost:default:user-1",
        kind: "direct",
        postId: "post-123",
        replyToMode: "all",
      }),
    ).toEqual({
      effectiveReplyToId: undefined,
      sessionKey: "agent:main:mattermost:default:user-1",
      parentSessionKey: undefined,
    });
  });
});

// ── Reply-to context injection (Gap 2) ───────────────────────────────────────

describe("resolveMattermostSpecificReplyParentId", () => {
  it("returns undefined when parentId is absent", () => {
    expect(
      resolveMattermostSpecificReplyParentId({
        parentId: undefined,
        threadRootId: "root-1",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when parentId is empty/whitespace", () => {
    expect(
      resolveMattermostSpecificReplyParentId({
        parentId: "   ",
        threadRootId: "root-1",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when parentId equals threadRootId", () => {
    expect(
      resolveMattermostSpecificReplyParentId({
        parentId: "root-1",
        threadRootId: "root-1",
      }),
    ).toBeUndefined();
  });

  it("returns parentId when it differs from threadRootId", () => {
    expect(
      resolveMattermostSpecificReplyParentId({
        parentId: "parent-1",
        threadRootId: "root-1",
      }),
    ).toBe("parent-1");
  });

  it("trims parentId and threadRootId", () => {
    expect(
      resolveMattermostSpecificReplyParentId({
        parentId: " parent-1 ",
        threadRootId: " root-1 ",
      }),
    ).toBe("parent-1");
  });
});

// ── Thread starter context injection ─────────────────────────────────────────
// Tests for the buildThreadStarterContextFields helper (pure unit tests).
// Integration with handlePost / handleInteraction is covered via this helper
// since the full monitor is not instantiatable in unit tests without a real runtime.

describe("buildThreadStarterContextFields", () => {
  const threadStarter = { text: "What is the status?", author: "@alice", timestamp: 1000 };

  it("sets ThreadStarterBody and IsFirstThreadTurn on the first thread message (no prior session)", () => {
    const fields = buildThreadStarterContextFields({
      threadRootId: "root-1",
      threadStarter,
      sessionPreviousTimestamp: undefined,
    });
    expect(fields.ThreadStarterBody).toBe("What is the status?");
    expect(fields.IsFirstThreadTurn).toBe(true);
  });

  it("does NOT set ThreadStarterBody when session already exists (prior timestamp)", () => {
    const fields = buildThreadStarterContextFields({
      threadRootId: "root-1",
      threadStarter,
      sessionPreviousTimestamp: 1234567890,
    });
    expect(fields.ThreadStarterBody).toBeUndefined();
    expect(fields.IsFirstThreadTurn).toBeUndefined();
  });

  it("does NOT set ThreadStarterBody for non-thread messages (no threadRootId)", () => {
    const fields = buildThreadStarterContextFields({
      threadRootId: undefined,
      threadStarter,
      sessionPreviousTimestamp: undefined,
    });
    expect(fields.ThreadStarterBody).toBeUndefined();
    expect(fields.IsFirstThreadTurn).toBeUndefined();
  });

  it("sets IsFirstThreadTurn alongside ThreadStarterBody", () => {
    const fields = buildThreadStarterContextFields({
      threadRootId: "root-2",
      threadStarter,
      sessionPreviousTimestamp: undefined,
    });
    // Both set together
    expect(fields.ThreadStarterBody).toBeDefined();
    expect(fields.IsFirstThreadTurn).toBe(true);
  });

  it("handles null threadStarter gracefully (fetch failure)", () => {
    const fields = buildThreadStarterContextFields({
      threadRootId: "root-3",
      threadStarter: null,
      sessionPreviousTimestamp: undefined,
    });
    // IsFirstThreadTurn still set — we know it's a new session thread
    expect(fields.IsFirstThreadTurn).toBe(true);
    // ThreadStarterBody is undefined since fetch failed
    expect(fields.ThreadStarterBody).toBeUndefined();
  });

  it("truncation: ThreadStarterBody respects 2000-char limit from resolveMattermostThreadStarter", () => {
    // Simulate a pre-truncated result from the resolver
    const longText = "B".repeat(2000);
    const truncatedStarter = { text: longText, author: "@bob" };
    const fields = buildThreadStarterContextFields({
      threadRootId: "root-long",
      threadStarter: truncatedStarter,
      sessionPreviousTimestamp: undefined,
    });
    expect(fields.ThreadStarterBody).toHaveLength(2000);
  });
});
