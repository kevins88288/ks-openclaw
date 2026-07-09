// Mattermost tests cover the invalid-RootId retry-without-threading behavior
// in sendMessageMattermost: a stale/invalid thread root reference should not
// silently drop the outbound message — it should be retried once without
// threading.
import { beforeEach, describe, expect, it, vi } from "vitest";

let sendMessageMattermost: typeof import("./send.js").sendMessageMattermost;
let resetMattermostOpaqueTargetCacheForTests: typeof import("./target-resolution.js").resetMattermostOpaqueTargetCacheForTests;

const mockState = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  loadOutboundMediaFromUrl: vi.fn(),
  recordActivity: vi.fn(),
  resolveMattermostAccount: vi.fn(() => ({
    accountId: "default",
    botToken: "bot-token",
    baseUrl: "https://mattermost.example.com",
    config: {},
  })),
  createMattermostClient: vi.fn(),
  createMattermostDirectChannel: vi.fn(),
  createMattermostDirectChannelWithRetry: vi.fn(),
  createMattermostPost: vi.fn(),
  fetchMattermostChannelByName: vi.fn(),
  fetchMattermostMe: vi.fn(),
  fetchMattermostUser: vi.fn(),
  fetchMattermostUserTeams: vi.fn(),
  fetchMattermostUserByUsername: vi.fn(),
  normalizeMattermostBaseUrl: vi.fn((input: string | undefined) => input?.trim() ?? ""),
  uploadMattermostFile: vi.fn(),
  loggerWarn: vi.fn(),
}));

function mockCall(mock: unknown, label: string, index = 0): unknown[] {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  const call = calls?.at(index);
  if (!call) {
    throw new Error(`Expected ${label} call ${index + 1}`);
  }
  return call;
}

vi.mock("../../runtime-api.js", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("./runtime-api.js", () => ({
  loadOutboundMediaFromUrl: mockState.loadOutboundMediaFromUrl,
}));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: (cfg: unknown) => {
    if (cfg) {
      return cfg;
    }
    throw new Error("Mattermost send requires a resolved runtime config");
  },
  resolveMarkdownTableMode: vi.fn(() => "off"),
}));

vi.mock("openclaw/plugin-sdk/text-chunking", () => ({
  convertMarkdownTables: vi.fn((text: string) => text),
}));

vi.mock("openclaw/plugin-sdk/string-coerce-runtime", () => ({
  normalizeLowercaseStringOrEmpty: vi.fn((value: string | null | undefined) => {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim().toLowerCase();
  }),
  normalizeOptionalString: vi.fn((value: string | null | undefined) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }),
  normalizeStringifiedOptionalString: vi.fn((value: unknown) => {
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : undefined;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      const normalized = String(value).trim();
      return normalized.length > 0 ? normalized : undefined;
    }
    return undefined;
  }),
}));

vi.mock("./accounts.js", () => ({
  resolveMattermostAccount: mockState.resolveMattermostAccount,
}));

vi.mock("./client.js", () => ({
  createMattermostClient: mockState.createMattermostClient,
  createMattermostDirectChannel: mockState.createMattermostDirectChannel,
  createMattermostDirectChannelWithRetry: mockState.createMattermostDirectChannelWithRetry,
  createMattermostPost: mockState.createMattermostPost,
  fetchMattermostChannelByName: mockState.fetchMattermostChannelByName,
  fetchMattermostMe: mockState.fetchMattermostMe,
  fetchMattermostUser: mockState.fetchMattermostUser,
  fetchMattermostUserTeams: mockState.fetchMattermostUserTeams,
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
      getChildLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: mockState.loggerWarn,
        error: vi.fn(),
      }),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "off",
        convertMarkdownTables: (text: string) => text,
      },
      activity: {
        record: mockState.recordActivity,
      },
    },
  }),
}));

describe("sendMessageMattermost — invalid RootId retry", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockState.loadConfig.mockReset();
    mockState.loadConfig.mockReturnValue({});
    mockState.recordActivity.mockReset();
    mockState.resolveMattermostAccount.mockReset();
    mockState.resolveMattermostAccount.mockReturnValue({
      accountId: "default",
      botToken: "bot-token",
      baseUrl: "https://mattermost.example.com",
      config: {},
    });
    mockState.loadOutboundMediaFromUrl.mockReset();
    mockState.createMattermostClient.mockReset();
    mockState.createMattermostDirectChannel.mockReset();
    mockState.createMattermostDirectChannelWithRetry.mockReset();
    mockState.createMattermostPost.mockReset();
    mockState.fetchMattermostChannelByName.mockReset();
    mockState.fetchMattermostMe.mockReset();
    mockState.fetchMattermostUser.mockReset();
    mockState.fetchMattermostUserTeams.mockReset();
    mockState.fetchMattermostUserByUsername.mockReset();
    mockState.uploadMattermostFile.mockReset();
    mockState.loggerWarn.mockReset();
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostDirectChannelWithRetry.mockResolvedValue({ id: "dm-channel-1" });
    mockState.fetchMattermostMe.mockResolvedValue({ id: "bot-user" });
    mockState.fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }]);
    mockState.fetchMattermostChannelByName.mockResolvedValue({ id: "town-square" });
    mockState.uploadMattermostFile.mockResolvedValue({ id: "file-1" });
    ({ sendMessageMattermost } = await import("./send.js"));
    ({ resetMattermostOpaqueTargetCacheForTests } = await import("./target-resolution.js"));
    resetMattermostOpaqueTargetCacheForTests();
  });

  it("retries once without rootId and succeeds when Mattermost rejects a stale RootId", async () => {
    mockState.createMattermostPost
      .mockRejectedValueOnce(new Error("Mattermost API 400 Bad Request: Invalid RootId parameter."))
      .mockResolvedValueOnce({ id: "post-1" });

    const result = await sendMessageMattermost("channel:town-square", "hello", {
      cfg: {},
      replyToId: "stale-root-id",
    } as never);

    expect(mockState.createMattermostPost).toHaveBeenCalledTimes(2);
    const firstCall = mockCall(mockState.createMattermostPost, "createMattermostPost", 0)[1] as {
      rootId?: string;
    };
    expect(firstCall.rootId).toBe("stale-root-id");
    const secondCall = mockCall(mockState.createMattermostPost, "createMattermostPost", 1)[1] as {
      rootId?: string;
    };
    expect(secondCall).not.toHaveProperty("rootId");
    expect(result.messageId).toBe("post-1");
    expect(mockState.loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("propagates non-RootId errors without retrying", async () => {
    mockState.createMattermostPost.mockRejectedValue(
      new Error("Mattermost API 500 Internal Server Error: something broke"),
    );

    await expect(
      sendMessageMattermost("channel:town-square", "hello", {
        cfg: {},
        replyToId: "some-thread-id",
      } as never),
    ).rejects.toThrow("Mattermost API 500");

    expect(mockState.createMattermostPost).toHaveBeenCalledTimes(1);
  });

  it("does not retry an Invalid RootId error when no replyToId was provided", async () => {
    mockState.createMattermostPost.mockRejectedValue(
      new Error("Mattermost API 400 Bad Request: Invalid RootId parameter."),
    );

    await expect(
      sendMessageMattermost("channel:town-square", "hello", {
        cfg: {},
      } as never),
    ).rejects.toThrow("Invalid RootId");

    expect(mockState.createMattermostPost).toHaveBeenCalledTimes(1);
  });
});
