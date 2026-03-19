import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostClient, MattermostPost } from "./client.js";
import {
  __resetMattermostThreadStarterCacheForTest,
  resolveMattermostThreadStarter,
} from "./threading.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(post: MattermostPost | null, opts?: { throwError?: boolean }): MattermostClient {
  return {
    baseUrl: "http://localhost:8065",
    apiBaseUrl: "http://localhost:8065/api/v4",
    token: "tok",
    request: vi.fn(async (path: string) => {
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
    message: "This is the thread starter message",
    create_at: 1700000000000,
    ...overrides,
  };
}

async function resolveUserInfo(userId: string) {
  return { username: `@${userId}` };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetMattermostThreadStarterCacheForTest();
  vi.useRealTimers();
});

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
    const post = makePost({ message: "" });
    const client = makeClient(post);

    const result = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-empty",
      resolveUserInfo,
    });

    expect(result).toBeNull();
  });

  it("returns null when the root post has only whitespace", async () => {
    const post = makePost({ message: "   " });
    const client = makeClient(post);

    const result = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-whitespace",
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

  it("cache hit avoids a second fetch within TTL", async () => {
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
    // Only one request should have been made
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("negatively caches null results for 30 seconds", async () => {
    vi.useFakeTimers();
    const client = makeClient(null);

    // First call — null result
    const r1 = await resolveMattermostThreadStarter({
      client,
      rootPostId: "null-post",
      resolveUserInfo,
    });
    expect(r1).toBeNull();

    // Advance by 10s (still within 30s negative TTL)
    vi.advanceTimersByTime(10_000);

    // Second call — should be served from negative cache, NOT calling request again
    const r2 = await resolveMattermostThreadStarter({
      client,
      rootPostId: "null-post",
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

    // First call — caches result
    const r1 = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-ttl",
      resolveUserInfo,
    });
    expect(r1).not.toBeNull();

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // Second call — cache expired, should re-fetch
    const r2 = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-ttl",
      resolveUserInfo,
    });
    expect(r2).not.toBeNull();
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    vi.useRealTimers();
  });

  it("evicts oldest entries when LRU max (500) is exceeded", async () => {
    // Fill the cache with 500 entries
    for (let i = 0; i < 500; i++) {
      const post = makePost({ id: `post-${i}`, message: `Message ${i}` });
      const client = makeClient(post);
      await resolveMattermostThreadStarter({
        client,
        rootPostId: `post-${i}`,
        resolveUserInfo,
      });
    }

    // The 501st entry should cause post-0 to be evicted (LRU)
    const newPost = makePost({ id: "post-new", message: "New entry" });
    const newClient = makeClient(newPost);
    await resolveMattermostThreadStarter({
      client: newClient,
      rootPostId: "post-new",
      resolveUserInfo,
    });

    // post-0 was evicted; re-fetching it should call request again
    const evictedPost = makePost({ id: "post-0", message: "Message 0" });
    const evictedClient = makeClient(evictedPost);
    await resolveMattermostThreadStarter({
      client: evictedClient,
      rootPostId: "post-0",
      resolveUserInfo,
    });

    expect((evictedClient.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("__resetMattermostThreadStarterCacheForTest clears the cache", async () => {
    const post = makePost();
    const client = makeClient(post);

    // Populate the cache
    await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-reset",
      resolveUserInfo,
    });

    // Reset the cache
    __resetMattermostThreadStarterCacheForTest();

    // Should re-fetch since cache was cleared
    await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-reset",
      resolveUserInfo,
    });

    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
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
    expect(result?.text).toBe("A".repeat(2000));
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

  it("handles missing user_id gracefully", async () => {
    const post = makePost({ user_id: undefined });
    const client = makeClient(post);

    const result = await resolveMattermostThreadStarter({
      client,
      rootPostId: "root-no-user",
      resolveUserInfo,
    });

    expect(result).not.toBeNull();
    expect(result?.text).toBe("This is the thread starter message");
    // author falls back to empty string (userId is empty)
    expect(typeof result?.author).toBe("string");
  });

  it("evicts oldest entries from negative cache when LRU max (500) is exceeded", async () => {
    // Fill the negative cache with 500 null-result entries
    for (let i = 0; i < 500; i++) {
      const nullClient = makeClient(null);
      await resolveMattermostThreadStarter({
        client: nullClient,
        rootPostId: `null-post-${i}`,
        resolveUserInfo,
      });
    }

    // The 501st null entry should cause null-post-0 to be evicted from negative cache
    const nullClient501 = makeClient(null);
    await resolveMattermostThreadStarter({
      client: nullClient501,
      rootPostId: "null-post-new",
      resolveUserInfo,
    });

    // null-post-0 was evicted from the negative cache; re-fetching it should call API again
    const rehydratedPost = makePost({ id: "null-post-0", message: "Back from eviction" });
    const rehydratedClient = makeClient(rehydratedPost);
    const result = await resolveMattermostThreadStarter({
      client: rehydratedClient,
      rootPostId: "null-post-0",
      resolveUserInfo,
    });

    // If the negative cache were still holding null-post-0, result would be null.
    // Eviction means the API was called again and we got the real post back.
    expect(result).not.toBeNull();
    expect(result?.text).toBe("Back from eviction");
  });
});
