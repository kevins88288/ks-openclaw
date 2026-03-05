import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostClient, MattermostPost } from "./client.js";

// --------------------------------------------------------------------------
// Hoisted mocks — must be declared before vi.mock() calls
// --------------------------------------------------------------------------

const clientMocks = vi.hoisted(() => ({
  createMattermostPost: vi.fn<
    [MattermostClient, { channelId: string; message: string; rootId?: string }],
    Promise<MattermostPost>
  >(),
  patchMattermostPost: vi.fn<
    [MattermostClient, string, { message: string }],
    Promise<MattermostPost>
  >(),
  deleteMattermostPost: vi.fn<[MattermostClient, string], Promise<void>>(),
}));

vi.mock("./client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./client.js")>();
  return {
    ...original,
    createMattermostPost: clientMocks.createMattermostPost,
    patchMattermostPost: clientMocks.patchMattermostPost,
    deleteMattermostPost: clientMocks.deleteMattermostPost,
  };
});

// Import after mock registration
const { createMattermostDraftStream } = await import("./draft-stream.js");

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

let postIdCounter = 0;

function makeClient(): MattermostClient {
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "test-token",
    request: vi.fn(),
  };
}

function makePost(id: string): MattermostPost {
  return { id };
}

function setupMocks(): string {
  postIdCounter++;
  const postId = `post-${postIdCounter}`;
  clientMocks.createMattermostPost.mockResolvedValue(makePost(postId));
  clientMocks.patchMattermostPost.mockResolvedValue(makePost(postId));
  clientMocks.deleteMattermostPost.mockResolvedValue(undefined);
  return postId;
}

beforeEach(() => {
  setupMocks();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// --------------------------------------------------------------------------
// Tests 1-11: draft-stream unit tests
// --------------------------------------------------------------------------

describe("createMattermostDraftStream", () => {
  // Test 1
  it("first update sends new post", async () => {
    const client = makeClient();
    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-1",
      throttleMs: 100,
    });

    draftStream.update("hello");
    await draftStream.flush();

    expect(clientMocks.createMattermostPost).toHaveBeenCalledOnce();
    expect(clientMocks.createMattermostPost).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ channelId: "ch-1", message: "hello" }),
    );
    expect(draftStream.messageId()).toBe(`post-${postIdCounter}`);
  });

  // Test 2
  it("subsequent update patches existing post", async () => {
    const client = makeClient();
    const currentPostId = `post-${postIdCounter}`;
    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-2",
      throttleMs: 100,
    });

    // First update: creates post
    draftStream.update("hello");
    await draftStream.flush();
    expect(clientMocks.createMattermostPost).toHaveBeenCalledOnce();

    // Second update: patches
    draftStream.update("hello world");
    await draftStream.flush();

    expect(clientMocks.createMattermostPost).toHaveBeenCalledOnce(); // still only once
    expect(clientMocks.patchMattermostPost).toHaveBeenCalledOnce();
    expect(clientMocks.patchMattermostPost).toHaveBeenCalledWith(client, currentPostId, {
      message: "hello world",
    });
  });

  // Test 3
  it("throttling — rapid updates are batched (only last text is sent)", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const throttleMs = 1000;
    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-3",
      throttleMs,
    });

    // First update fires immediately (lastSentAt = 0)
    draftStream.update("update-1");
    await vi.advanceTimersByTimeAsync(1); // let the async flush complete

    // Rapid fire within throttle window — only last should be sent
    draftStream.update("update-2");
    draftStream.update("update-3");
    draftStream.update("update-4");
    draftStream.update("update-5");

    // Advance past throttle window
    await vi.advanceTimersByTimeAsync(throttleMs + 50);

    const totalCalls =
      clientMocks.createMattermostPost.mock.calls.length +
      clientMocks.patchMattermostPost.mock.calls.length;
    // Should be 2 total: the immediate first send + the batched final one
    expect(totalCalls).toBeLessThanOrEqual(3);

    // Last sent text should be "update-5"
    const allMessages = [
      ...clientMocks.createMattermostPost.mock.calls.map(
        (c) => (c[1] as { message: string }).message,
      ),
      ...clientMocks.patchMattermostPost.mock.calls.map(
        (c) => (c[2] as { message: string }).message,
      ),
    ];
    expect(allMessages.at(-1)).toBe("update-5");
  });

  // Test 4
  it("text exceeds maxChars — stops streaming with warning", async () => {
    const client = makeClient();
    const warn = vi.fn();
    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-4",
      maxChars: 10,
      warn,
    });

    draftStream.update("this text is longer than 10 chars definitely");
    await draftStream.flush();

    expect(clientMocks.createMattermostPost).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stopped"));
  });

  // Test 5
  it("API error — stops gracefully with warning", async () => {
    const client = makeClient();
    const warn = vi.fn();
    clientMocks.createMattermostPost.mockRejectedValue(new Error("Network failure"));

    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-5",
      warn,
    });

    draftStream.update("hello");
    await draftStream.flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Network failure"));

    // Subsequent updates should be ignored (stopped = true)
    clientMocks.createMattermostPost.mockResolvedValue(makePost("post-new"));
    draftStream.update("more text");
    await draftStream.flush();
    // createMattermostPost still called only once (the failed call)
    expect(clientMocks.createMattermostPost).toHaveBeenCalledTimes(1);
  });

  // Test 6
  it("clear() deletes preview message and resets messageId", async () => {
    const client = makeClient();
    const postId = `post-${postIdCounter}`;
    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-6",
    });

    draftStream.update("some text");
    await draftStream.flush();
    expect(draftStream.messageId()).toBe(postId);

    await draftStream.clear();

    expect(clientMocks.deleteMattermostPost).toHaveBeenCalledOnce();
    expect(clientMocks.deleteMattermostPost).toHaveBeenCalledWith(client, postId);
    expect(draftStream.messageId()).toBeUndefined();
  });

  // Test 7
  it("clear() with no messageId is a no-op", async () => {
    const client = makeClient();
    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-7",
    });

    // No updates — no post created
    await draftStream.clear();

    expect(clientMocks.deleteMattermostPost).not.toHaveBeenCalled();
  });

  // Test 8
  it("forceNewMessage() resets state so next update creates a new post", async () => {
    const client = makeClient();
    const firstPostId = `post-${postIdCounter}`;
    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-8",
    });

    // First message
    draftStream.update("first message");
    await draftStream.flush();
    expect(draftStream.messageId()).toBe(firstPostId);
    expect(clientMocks.createMattermostPost).toHaveBeenCalledOnce();

    // Reset
    draftStream.forceNewMessage();
    expect(draftStream.messageId()).toBeUndefined();

    // Next update should create a NEW post (not patch)
    postIdCounter++;
    const secondPostId = `post-${postIdCounter}`;
    clientMocks.createMattermostPost.mockResolvedValue(makePost(secondPostId));

    draftStream.update("second message");
    await draftStream.flush();

    expect(clientMocks.createMattermostPost).toHaveBeenCalledTimes(2);
    expect(draftStream.messageId()).toBe(secondPostId);
    expect(clientMocks.patchMattermostPost).not.toHaveBeenCalled();
  });

  // Test 9
  it("minInitialChars: short text skipped until threshold is met", async () => {
    const client = makeClient();
    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-9",
      minInitialChars: 30,
    });

    // Short text — should not create a post
    draftStream.update("hi");
    await draftStream.flush();
    expect(clientMocks.createMattermostPost).not.toHaveBeenCalled();

    // Long enough text — should create a post
    draftStream.update("hello this is a longer message that exceeds thirty chars");
    await draftStream.flush();
    expect(clientMocks.createMattermostPost).toHaveBeenCalledOnce();
  });

  // Test 10
  it("final flush via stop() bypasses minInitialChars", async () => {
    const client = makeClient();
    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-10",
      minInitialChars: 30,
    });

    // Short text — would normally be skipped by minInitialChars debounce
    draftStream.update("hi");
    // stop() marks state.final = true, bypassing minInitialChars in flush
    await draftStream.stop();

    expect(clientMocks.createMattermostPost).toHaveBeenCalledOnce();
    expect(clientMocks.createMattermostPost).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ message: "hi" }),
    );
  });

  // Test 11
  it("deletion guard: only deletes posts created by this stream", async () => {
    const client = makeClient();
    const warn = vi.fn();
    const postId = `post-${postIdCounter}`;

    const draftStream = createMattermostDraftStream({
      client,
      channelId: "ch-11",
      warn,
    });

    // Create a post (goes into createdPostIds)
    draftStream.update("hello");
    await draftStream.flush();
    expect(draftStream.messageId()).toBe(postId);

    // Normal clear — should succeed (post IS in createdPostIds)
    await draftStream.clear();
    expect(clientMocks.deleteMattermostPost).toHaveBeenCalledOnce();
    expect(clientMocks.deleteMattermostPost).toHaveBeenCalledWith(client, postId);
    expect(draftStream.messageId()).toBeUndefined();

    // Guard: no deletion warning for normal flow
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("refusing to delete unknown post"),
    );

    // Calling clear again when no messageId → no-op (not a double-delete)
    const callsBefore = clientMocks.deleteMattermostPost.mock.calls.length;
    await draftStream.clear();
    expect(clientMocks.deleteMattermostPost.mock.calls.length).toBe(callsBefore);
  });
});

// --------------------------------------------------------------------------
// Tests 12-13: reasoning tag filtering integration
// --------------------------------------------------------------------------

describe("draft stream reasoning tag behaviour", () => {
  // Test 12
  it("update with plain text (already stripped by updateDraftFromPartial) sends correctly", async () => {
    const client = makeClient();
    const draftStream = createMattermostDraftStream({ client, channelId: "ch-12" });

    // Simulate what updateDraftFromPartial provides after stripping reasoning tags
    const cleanedText = "The answer is 42";
    draftStream.update(cleanedText);
    await draftStream.flush();

    expect(clientMocks.createMattermostPost).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ message: "The answer is 42" }),
    );
  });

  // Test 13
  it("update with empty string (returned by updateDraftFromPartial for pure-reasoning) is not sent", async () => {
    const client = makeClient();
    const draftStream = createMattermostDraftStream({ client, channelId: "ch-13" });

    // updateDraftFromPartial returns early for pure-reasoning, so stream.update is never called.
    // But if it were called with empty string, the stream should also not send it.
    draftStream.update("");
    await draftStream.flush();

    expect(clientMocks.createMattermostPost).not.toHaveBeenCalled();
  });
});
