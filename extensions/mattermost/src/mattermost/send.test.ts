import { beforeEach, describe, expect, it, vi } from "vitest";
import { _testOnly_clearBotUserCache, sendMessageMattermost } from "./send.js";

const mockState = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  loadOutboundMediaFromUrl: vi.fn(),
  resolveMattermostAccount: vi.fn(() => ({
    accountId: "default",
    botToken: "bot-token",
    baseUrl: "https://mattermost.example.com",
  })),
  createMattermostClient: vi.fn(),
  createMattermostDirectChannel: vi.fn(),
  createMattermostPost: vi.fn(),
  fetchMattermostMe: vi.fn(),
  fetchMattermostUserByUsername: vi.fn(),
  normalizeMattermostBaseUrl: vi.fn((input: string | undefined) => input?.trim() ?? ""),
  uploadMattermostFile: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/mattermost", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("./accounts.js", () => ({
  resolveMattermostAccount: mockState.resolveMattermostAccount,
}));

vi.mock("./client.js", () => ({
  createMattermostClient: mockState.createMattermostClient,
  createMattermostDirectChannel: mockState.createMattermostDirectChannel,
  createMattermostPost: mockState.createMattermostPost,
  fetchMattermostMe: mockState.fetchMattermostMe,
  fetchMattermostUserByUsername: mockState.fetchMattermostUserByUsername,
  normalizeMattermostBaseUrl: mockState.normalizeMattermostBaseUrl,
  uploadMattermostFile: mockState.uploadMattermostFile,
}));

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => ({
    config: {
      loadConfig: mockState.loadConfig,
    },
    logging: {
      shouldLogVerbose: () => false,
      getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "off",
        convertMarkdownTables: (text: string) => text,
      },
      activity: {
        record: vi.fn(),
      },
    },
  }),
}));

describe("sendMessageMattermost", () => {
  beforeEach(() => {
    _testOnly_clearBotUserCache();
    mockState.loadConfig.mockReset();
    mockState.loadConfig.mockReturnValue({});
    mockState.resolveMattermostAccount.mockReset();
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
    });
    mockState.loadOutboundMediaFromUrl.mockReset();
    mockState.createMattermostClient.mockReset();
    mockState.createMattermostDirectChannel.mockReset();
    mockState.createMattermostPost.mockReset();
    mockState.fetchMattermostMe.mockReset();
    mockState.fetchMattermostUserByUsername.mockReset();
    mockState.uploadMattermostFile.mockReset();
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostPost.mockResolvedValue({ id: "post-1" });
    mockState.uploadMattermostFile.mockResolvedValue({ id: "file-1" });
  });

  it("uses provided cfg and skips runtime loadConfig", async () => {
    const providedCfg = {
      channels: {
        mattermost: {
          botToken: "provided-token",
        },
      },
    };

    await sendMessageMattermost("channel:town-square", "hello", {
      cfg: providedCfg as any,
      accountId: "work",
    });

    expect(mockState.loadConfig).not.toHaveBeenCalled();
    expect(mockState.resolveMattermostAccount).toHaveBeenCalledWith({
      cfg: providedCfg,
      accountId: "work",
    });
  });

  it("falls back to runtime loadConfig when cfg is omitted", async () => {
    const runtimeCfg = {
      channels: {
        mattermost: {
          botToken: "runtime-token",
        },
      },
    };
    mockState.loadConfig.mockReturnValueOnce(runtimeCfg);

    await sendMessageMattermost("channel:town-square", "hello");

    expect(mockState.loadConfig).toHaveBeenCalledTimes(1);
    expect(mockState.resolveMattermostAccount).toHaveBeenCalledWith({
      cfg: runtimeCfg,
      accountId: undefined,
    });
  });

  it("loads outbound media with trusted local roots before upload", async () => {
    mockState.loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("media-bytes"),
      fileName: "photo.png",
      contentType: "image/png",
      kind: "image",
    });

    await sendMessageMattermost("channel:town-square", "hello", {
      mediaUrl: "file:///tmp/agent-workspace/photo.png",
      mediaLocalRoots: ["/tmp/agent-workspace"],
    });

    expect(mockState.loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "file:///tmp/agent-workspace/photo.png",
      {
        mediaLocalRoots: ["/tmp/agent-workspace"],
      },
    );
    expect(mockState.uploadMattermostFile).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channelId: "town-square",
        fileName: "photo.png",
        contentType: "image/png",
      }),
    );
  });

  const BOT_ID = "c3zyaqawi3frxn3hqrthc8kmio";
  const TARGET_USER_ID = "so9wu6dbntgsmyb91bnkj6groe";
  const RESOLVED_DM_CHANNEL_ID = "dm-channel-resolved-id";

  it("DM channel name — bot first: resolves to real DM channel id", async () => {
    mockState.fetchMattermostMe.mockResolvedValue({ id: BOT_ID });
    mockState.createMattermostDirectChannel.mockResolvedValue({ id: RESOLVED_DM_CHANNEL_ID });

    const result = await sendMessageMattermost(
      `channel:${BOT_ID}__${TARGET_USER_ID}`,
      "hello",
    );

    expect(mockState.fetchMattermostMe).toHaveBeenCalledTimes(1);
    expect(mockState.createMattermostDirectChannel).toHaveBeenCalledWith(
      expect.anything(),
      [BOT_ID, TARGET_USER_ID],
    );
    expect(mockState.createMattermostPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelId: RESOLVED_DM_CHANNEL_ID }),
    );
    expect(result.channelId).toBe(RESOLVED_DM_CHANNEL_ID);
  });

  it("DM channel name — bot second (reversed): resolves to real DM channel id", async () => {
    mockState.fetchMattermostMe.mockResolvedValue({ id: BOT_ID });
    mockState.createMattermostDirectChannel.mockResolvedValue({ id: RESOLVED_DM_CHANNEL_ID });

    const result = await sendMessageMattermost(
      `channel:${TARGET_USER_ID}__${BOT_ID}`,
      "hello",
    );

    expect(mockState.fetchMattermostMe).toHaveBeenCalledTimes(1);
    expect(mockState.createMattermostDirectChannel).toHaveBeenCalledWith(
      expect.anything(),
      [BOT_ID, TARGET_USER_ID],
    );
    expect(mockState.createMattermostPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelId: RESOLVED_DM_CHANNEL_ID }),
    );
    expect(result.channelId).toBe(RESOLVED_DM_CHANNEL_ID);
  });

  it("Invalid RootId — retries once without rootId and succeeds", async () => {
    mockState.createMattermostPost
      .mockRejectedValueOnce(
        new Error("Mattermost API 400 Bad Request: Invalid RootId parameter."),
      )
      .mockResolvedValueOnce({ id: "post-1" });

    const result = await sendMessageMattermost("channel:town-square", "hello", {
      replyToId: "stale-root-id",
    });

    expect(mockState.createMattermostPost).toHaveBeenCalledTimes(2);
    // Second call should not include rootId
    const secondCall = mockState.createMattermostPost.mock.calls[1][1];
    expect(secondCall).not.toHaveProperty("rootId");
    expect(result.messageId).toBe("post-1");
  });

  it("Non-RootId error — propagates without retry", async () => {
    mockState.createMattermostPost.mockRejectedValue(
      new Error("Mattermost API 500 Internal Server Error: something broke"),
    );

    await expect(
      sendMessageMattermost("channel:town-square", "hello", {
        replyToId: "some-thread-id",
      }),
    ).rejects.toThrow("Mattermost API 500");

    expect(mockState.createMattermostPost).toHaveBeenCalledTimes(1);
  });
});
