import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostClient, MattermostPost } from "./client.js";
import {
  __resetMattermostReplyContextCacheForTest,
  resolveMattermostReplyContext,
  resolveMattermostReplyContextForPost,
} from "./threading.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(
  post: MattermostPost | null,
  opts?: { throwError?: boolean },
): MattermostClient {
  return {
    baseUrl: "http://localhost:8065",
    apiBaseUrl: "http://localhost:8065/api/v4",
    token: "tok",
    request: vi.fn(async (_path: string) => {
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
    id: "parent-1",
    user_id: "user-1",
    message: "This is the specific message being replied to",
    create_at: 1700000000000,
    ...overrides,
  };
}

async function resolveUserInfo(userId: string) {
  return { username: `@${userId}` };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetMattermostReplyContextCacheForTest();
  vi.useRealTimers();
});

describe("resolveMattermostReplyContext", () => {
  it("fetches parent post when parent_id differs from root_id", async () => {
    const post = makePost();
    const client = makeClient(post);

    const result = await resolveMattermostReplyContextForPost({
      client,
      threadRootId: "root-1",
      parentPostId: "parent-1",
      resolveUserInfo,
    });

    expect(result).not.toBeNull();
    expect(result?.body).toBe("This is the specific message being replied to");
    expect(result?.sender).toBe("@user-1");
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("returns null when parent_id === root_id", async () => {
    const post = makePost({ id: "same-id" });
    const client = makeClient(post);

    const result = await resolveMattermostReplyContextForPost({
      client,
      threadRootId: "same-id",
      parentPostId: "same-id",
      resolveUserInfo,
    });

    expect(result).toBeNull();
    // Guarded: should not fetch
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("returns null when parent_id is empty", async () => {
    const post = makePost();
    const client = makeClient(post);

    const result = await resolveMattermostReplyContextForPost({
      client,
      threadRootId: "root-1",
      parentPostId: "   ",
      resolveUserInfo,
    });

    expect(result).toBeNull();
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("cache hit returns cached result without a second fetch", async () => {
    const post = makePost();
    const client = makeClient(post);

    const r1 = await resolveMattermostReplyContext({
      client,
      parentPostId: "parent-cached",
      resolveUserInfo,
    });
    const r2 = await resolveMattermostReplyContext({
      client,
      parentPostId: "parent-cached",
      resolveUserInfo,
    });

    expect(r1).not.toBeNull();
    expect(r2).toEqual(r1);
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("API failure returns null safely (fail-open)", async () => {
    const client = makeClient(null, { throwError: true });

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "error-post",
      resolveUserInfo,
    });

    expect(result).toBeNull();
  });

  it("post not found (404) returns null safely", async () => {
    const client = makeClient(null);

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "not-found",
      resolveUserInfo,
    });

    expect(result).toBeNull();
  });

  it("truncates body at 1000 chars", async () => {
    const longText = "B".repeat(2000);
    const post = makePost({ message: longText });
    const client = makeClient(post);

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "long-post",
      resolveUserInfo,
    });

    expect(result?.body).toHaveLength(1000);
    expect(result?.body).toBe("B".repeat(1000));
  });

  it("returns null when post message is empty", async () => {
    const post = makePost({ message: "" });
    const client = makeClient(post);

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "empty-msg",
      resolveUserInfo,
    });

    expect(result).toBeNull();
  });

  it("returns null when post message is only whitespace", async () => {
    const post = makePost({ message: "   " });
    const client = makeClient(post);

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "whitespace-msg",
      resolveUserInfo,
    });

    expect(result).toBeNull();
  });

  it("negatively caches null results — avoids repeated API calls during outage", async () => {
    vi.useFakeTimers();
    const client = makeClient(null);

    // First call — null result
    const r1 = await resolveMattermostReplyContext({
      client,
      parentPostId: "null-parent",
      resolveUserInfo,
    });
    expect(r1).toBeNull();

    // Advance 10s (still within 30s negative TTL)
    vi.advanceTimersByTime(10_000);

    // Second call — should hit negative cache, NOT calling API again
    const r2 = await resolveMattermostReplyContext({
      client,
      parentPostId: "null-parent",
      resolveUserInfo,
    });
    expect(r2).toBeNull();
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    vi.useRealTimers();
  });

  it("re-fetches after positive TTL expires (5 minutes)", async () => {
    vi.useFakeTimers();
    const post = makePost();
    const client = makeClient(post);

    const r1 = await resolveMattermostReplyContext({
      client,
      parentPostId: "parent-ttl",
      resolveUserInfo,
    });
    expect(r1).not.toBeNull();

    // Advance past 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const r2 = await resolveMattermostReplyContext({
      client,
      parentPostId: "parent-ttl",
      resolveUserInfo,
    });
    expect(r2).not.toBeNull();
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    vi.useRealTimers();
  });

  it("uses userId as sender fallback when resolveUserInfo returns null", async () => {
    const post = makePost({ user_id: "user-xyz" });
    const client = makeClient(post);

    const result = await resolveMattermostReplyContext({
      client,
      parentPostId: "fallback-post",
      resolveUserInfo: async () => null,
    });

    expect(result?.sender).toBe("user-xyz");
  });

  it("evicts oldest entries when LRU max (500) is exceeded", async () => {
    // Fill cache with 500 entries
    for (let i = 0; i < 500; i++) {
      const post = makePost({ id: `reply-${i}`, message: `Reply message ${i}` });
      const client = makeClient(post);
      await resolveMattermostReplyContext({
        client,
        parentPostId: `reply-${i}`,
        resolveUserInfo,
      });
    }

    // 501st entry triggers LRU eviction of reply-0
    const newPost = makePost({ id: "reply-new", message: "New reply entry" });
    const newClient = makeClient(newPost);
    await resolveMattermostReplyContext({
      client: newClient,
      parentPostId: "reply-new",
      resolveUserInfo,
    });

    // reply-0 was evicted; refetching it should call request again
    const evictedPost = makePost({ id: "reply-0", message: "Reply message 0" });
    const evictedClient = makeClient(evictedPost);
    await resolveMattermostReplyContext({
      client: evictedClient,
      parentPostId: "reply-0",
      resolveUserInfo,
    });

    expect((evictedClient.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("__resetMattermostReplyContextCacheForTest clears both caches", async () => {
    const post = makePost();
    const client = makeClient(post);

    // Populate positive cache
    await resolveMattermostReplyContext({ client, parentPostId: "reset-test", resolveUserInfo });

    __resetMattermostReplyContextCacheForTest();

    // Should re-fetch since cache was cleared
    await resolveMattermostReplyContext({ client, parentPostId: "reset-test", resolveUserInfo });

    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
});
