import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostClient, MattermostPost } from "./client.js";
import {
  __resetMattermostReplyContextCacheForTest,
  __resetMattermostThreadStarterCacheForTest,
  buildMattermostThreadLabel,
  buildThreadStarterContextFields,
  resolveMattermostReplyContext,
  resolveMattermostThreadStarter,
} from "./thread-context.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(
  post: MattermostPost | null,
  opts?: { throwError?: boolean },
): MattermostClient {
  return {
    baseUrl: "http://localhost:8065",
    apiBaseUrl: "http://localhost:8065/api/v4",
    token: "tok",
    fetchImpl: vi.fn(),
    request: vi.fn(async () => {
      if (opts?.throwError) {
        throw new Error("API error");
      }
      if (!post) {
        throw new Error("Mattermost API 404 Not Found: Post not found");
      }
      return post;
    }),
  } as unknown as MattermostClient;
}

function makePost(overrides?: Partial<MattermostPost>): MattermostPost {
  return {
    id: "root-1",
    user_id: "user-1",
    channel_id: "chan-1",
    message: "This is the thread starter message",
    create_at: 1700000000000,
    ...overrides,
  };
}

async function resolveUserInfo(userId: string) {
  return { id: userId, username: `@${userId}` };
}

beforeEach(() => {
  __resetMattermostThreadStarterCacheForTest();
  __resetMattermostReplyContextCacheForTest();
  vi.useRealTimers();
});

// ── resolveMattermostThreadStarter ──────────────────────────────────────────

describe("resolveMattermostThreadStarter", () => {
  it("returns thread starter for a valid root post", async () => {
    const post = makePost();
    const client = makeClient(post);

    const result = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-1",
      resolveUserInfo,
    });

    expect(result).not.toBeNull();
    expect(result?.text).toBe("This is the thread starter message");
    expect(result?.author).toBe("@user-1");
    expect(result?.timestamp).toBe(1700000000000);
  });

  it("returns null when the root post has an empty message", async () => {
    const post = makePost({ message: "   " });
    const client = makeClient(post);

    const result = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-empty",
      resolveUserInfo,
    });

    expect(result).toBeNull();
  });

  it("returns null when fetch returns null (post not found)", async () => {
    const client = makeClient(null);

    const result = await resolveMattermostThreadStarter({
      client,
      rootPostId: "not-found",
      resolveUserInfo,
    });

    expect(result).toBeNull();
  });

  it("caches a positive result and avoids a second fetch", async () => {
    const post = makePost();
    const client = makeClient(post);

    const r1 = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-cached",
      resolveUserInfo,
    });
    const r2 = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-cached",
      resolveUserInfo,
    });

    expect(r1).not.toBeNull();
    expect(r2).toEqual(r1);
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("negatively caches null results within TTL", async () => {
    vi.useFakeTimers();
    const client = makeClient(null);

    const r1 = await resolveMattermostThreadStarter({
      client,
      rootPostId: "null-post",
      resolveUserInfo,
    });
    expect(r1).toBeNull();

    vi.advanceTimersByTime(10_000);

    const r2 = await resolveMattermostThreadStarter({
      client,
      rootPostId: "null-post",
      resolveUserInfo,
    });
    expect(r2).toBeNull();
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    vi.useRealTimers();
  });

  it("truncates text to 2000 characters", async () => {
    const longText = "A".repeat(3000);
    const post = makePost({ message: longText });
    const client = makeClient(post);

    const result = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-long",
      resolveUserInfo,
    });

    expect(result?.text).toHaveLength(2000);
  });

  it("uses userId as author fallback when resolveUserInfo returns null", async () => {
    const post = makePost({ user_id: "user-xyz" });
    const client = makeClient(post);

    const result = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-fallback",
      resolveUserInfo: async () => null,
    });

    expect(result?.author).toBe("user-xyz");
  });

  it("__resetMattermostThreadStarterCacheForTest clears the cache", async () => {
    const post = makePost();
    const client = makeClient(post);

    await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-reset",
      resolveUserInfo,
    });
    __resetMattermostThreadStarterCacheForTest();
    await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-reset",
      resolveUserInfo,
    });

    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
});

// ── buildThreadStarterContextFields ─────────────────────────────────────────

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

  it("does NOT set ThreadStarterBody when a session already exists (prior timestamp)", () => {
    const fields = buildThreadStarterContextFields({
      threadRootId: "root-1",
      threadStarter,
      sessionPreviousTimestamp: 1234567890,
    });
    expect(fields.ThreadStarterBody).toBeUndefined();
    expect(fields.IsFirstThreadTurn).toBeUndefined();
  });

  it("does NOT set fields for non-thread messages (no threadRootId)", () => {
    const fields = buildThreadStarterContextFields({
      threadRootId: undefined,
      threadStarter,
      sessionPreviousTimestamp: undefined,
    });
    expect(fields.ThreadStarterBody).toBeUndefined();
    expect(fields.IsFirstThreadTurn).toBeUndefined();
  });

  it("still sets IsFirstThreadTurn when threadStarter fetch failed (null)", () => {
    const fields = buildThreadStarterContextFields({
      threadRootId: "root-3",
      threadStarter: null,
      sessionPreviousTimestamp: undefined,
    });
    expect(fields.IsFirstThreadTurn).toBe(true);
    expect(fields.ThreadStarterBody).toBeUndefined();
  });
});

// ── buildMattermostThreadLabel ──────────────────────────────────────────────

describe("buildMattermostThreadLabel", () => {
  it("uses the thread starter snippet when available", () => {
    const label = buildMattermostThreadLabel({
      channelName: "general",
      threadStarter: { text: "Deploy the new release to prod", author: "@bob" },
      threadRootId: "root-1",
    });
    expect(label).toBe("Mattermost thread #general: Deploy the new release to prod");
  });

  it("falls back to the thread root ID when no starter text is available", () => {
    const label = buildMattermostThreadLabel({
      channelName: "general",
      threadStarter: null,
      threadRootId: "root-abc",
    });
    expect(label).toBe("Mattermost thread #general: root-abc");
  });

  it("truncates long snippets to 60 characters", () => {
    const longText = "x".repeat(120);
    const label = buildMattermostThreadLabel({
      channelName: "general",
      threadStarter: { text: longText, author: "@bob" },
      threadRootId: "root-1",
    });
    expect(label).toBe(`Mattermost thread #general: ${"x".repeat(60)}`);
  });
});

// ── resolveMattermostReplyContext ───────────────────────────────────────────

describe("resolveMattermostReplyContext", () => {
  it("fetches the parent post and returns body+sender", async () => {
    const post = makePost({
      id: "parent-1",
      channel_id: "chan-1",
      message: "This is the specific message being replied to",
    });
    const client = makeClient(post);

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "parent-1",
      expectedChannelId: "chan-1",
      resolveUserInfo,
    });

    expect(result).not.toBeNull();
    expect(result?.body).toBe("This is the specific message being replied to");
    expect(result?.sender).toBe("@user-1");
  });

  it("returns null on API failure (fail-open)", async () => {
    const client = makeClient(null, { throwError: true });

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "error-post",
      expectedChannelId: "chan-1",
      resolveUserInfo,
    });

    expect(result).toBeNull();
  });

  it("returns null when the post message is empty", async () => {
    const post = makePost({ id: "empty-msg", channel_id: "chan-1", message: "" });
    const client = makeClient(post);

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "empty-msg",
      expectedChannelId: "chan-1",
      resolveUserInfo,
    });

    expect(result).toBeNull();
  });

  it("truncates body at 1000 chars", async () => {
    const longText = "B".repeat(2000);
    const post = makePost({ id: "parent-long", channel_id: "chan-1", message: longText });
    const client = makeClient(post);

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "parent-long",
      expectedChannelId: "chan-1",
      resolveUserInfo,
    });

    expect(result?.body).toHaveLength(1000);
    expect(result?.body).toBe("B".repeat(1000));
  });

  it("caches a positive result and avoids a second fetch", async () => {
    const post = makePost({ id: "parent-cached", channel_id: "chan-1" });
    const client = makeClient(post);

    const r1 = await resolveMattermostReplyContext({
      client,
      parentPostId: "parent-cached",
      expectedChannelId: "chan-1",
      resolveUserInfo,
    });
    const r2 = await resolveMattermostReplyContext({
      client,
      parentPostId: "parent-cached",
      expectedChannelId: "chan-1",
      resolveUserInfo,
    });

    expect(r1).not.toBeNull();
    expect(r2).toEqual(r1);
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("negatively caches null results within TTL", async () => {
    vi.useFakeTimers();
    const client = makeClient(null);

    const r1 = await resolveMattermostReplyContext({
      client,
      parentPostId: "null-parent",
      expectedChannelId: "chan-1",
      resolveUserInfo,
    });
    expect(r1).toBeNull();

    vi.advanceTimersByTime(10_000);

    const r2 = await resolveMattermostReplyContext({
      client,
      parentPostId: "null-parent",
      expectedChannelId: "chan-1",
      resolveUserInfo,
    });
    expect(r2).toBeNull();
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    vi.useRealTimers();
  });

  // Security: cross-channel leakage guard. If a client-influenced parent_id
  // pointed at a post in a different channel than the inbound message, we must
  // not surface that other channel's content as reply-to context.
  it("returns null when the fetched post belongs to a different channel", async () => {
    const post = makePost({
      id: "cross-chan-post",
      channel_id: "chan-other",
      message: "Message from another channel",
    });
    const client = makeClient(post);

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "cross-chan-post",
      expectedChannelId: "chan-expected",
      resolveUserInfo,
    });

    expect(result).toBeNull();
  });

  it("allows the post when channel_id is absent on the response (fail-open)", async () => {
    const post = makePost({
      id: "no-channel-post",
      channel_id: undefined,
      message: "Post without channel_id",
    });
    const client = makeClient(post);

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "no-channel-post",
      expectedChannelId: "chan-expected",
      resolveUserInfo,
    });

    expect(result).not.toBeNull();
    expect(result?.body).toBe("Post without channel_id");
  });
});
