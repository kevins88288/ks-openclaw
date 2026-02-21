import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "./channel.js";
import { resetMattermostReactionBotUserCacheForTests } from "./mattermost/reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
  withMockedGlobalFetch,
} from "./mattermost/reactions.test-helpers.js";
import { sendMessageMattermost } from "./mattermost/send.js";

vi.mock("./mattermost/send.js", () => ({
  sendMessageMattermost: vi.fn(async () => ({
    messageId: "m1",
    channelId: "ch-1",
  })),
}));

describe("mattermostPlugin", () => {
  describe("messaging", () => {
    it("keeps @username targets", () => {
      const normalize = mattermostPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("@Alice");
      expect(normalize("@alice")).toBe("@alice");
    });

    it("normalizes mattermost: prefix to user:", () => {
      const normalize = mattermostPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("mattermost:USER123")).toBe("user:USER123");
    });
  });

  describe("pairing", () => {
    it("normalizes allowlist entries", () => {
      const normalize = mattermostPlugin.pairing?.normalizeAllowEntry;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("alice");
      expect(normalize("user:USER123")).toBe("user123");
    });
  });

  describe("capabilities", () => {
    it("declares reactions support", () => {
      expect(mattermostPlugin.capabilities?.reactions).toBe(true);
    });
  });

  describe("messageActions", () => {
    beforeEach(() => {
      resetMattermostReactionBotUserCacheForTests();
    });

    it("exposes react when mattermost is configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
          },
        },
      };

      const actions = mattermostPlugin.actions?.listActions?.({ cfg }) ?? [];
      expect(actions).toContain("react");
      expect(actions).not.toContain("send");
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "react" })).toBe(true);
    });

    it("hides react when mattermost is not configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
          },
        },
      };

      const actions = mattermostPlugin.actions?.listActions?.({ cfg }) ?? [];
      expect(actions).toEqual([]);
    });

    it("hides react when actions.reactions is false", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
            actions: { reactions: false },
          },
        },
      };

      const actions = mattermostPlugin.actions?.listActions?.({ cfg }) ?? [];
      expect(actions).not.toContain("react");
      expect(actions).not.toContain("send");
    });

    it("respects per-account actions.reactions in listActions", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            actions: { reactions: false },
            accounts: {
              default: {
                enabled: true,
                botToken: "test-token",
                baseUrl: "https://chat.example.com",
                actions: { reactions: true },
              },
            },
          },
        },
      };

      const actions = mattermostPlugin.actions?.listActions?.({ cfg }) ?? [];
      expect(actions).toContain("react");
    });

    it("blocks react when default account disables reactions and accountId is omitted", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            actions: { reactions: true },
            accounts: {
              default: {
                enabled: true,
                botToken: "test-token",
                baseUrl: "https://chat.example.com",
                actions: { reactions: false },
              },
            },
          },
        },
      };

      await expect(
        mattermostPlugin.actions?.handleAction?.({
          channel: "mattermost",
          action: "react",
          params: { messageId: "POST1", emoji: "thumbsup" },
          cfg,
        } as any),
      ).rejects.toThrow("Mattermost reactions are disabled in config");
    });

    it("handles react by calling Mattermost reactions API", async () => {
      const cfg = createMattermostTestConfig();
      const fetchImpl = createMattermostReactionFetchMock({
        mode: "add",
        postId: "POST1",
        emojiName: "thumbsup",
      });

      const result = await withMockedGlobalFetch(fetchImpl as unknown as typeof fetch, async () => {
        const result = await mattermostPlugin.actions?.handleAction?.({
          channel: "mattermost",
          action: "react",
          params: { messageId: "POST1", emoji: "thumbsup" },
          cfg,
          accountId: "default",
        } as any);

        return result;
      });

      expect(result?.content).toEqual([{ type: "text", text: "Reacted with :thumbsup: on POST1" }]);
      expect(result?.details).toEqual({});
    });

    it("only treats boolean remove flag as removal", async () => {
      const cfg = createMattermostTestConfig();
      const fetchImpl = createMattermostReactionFetchMock({
        mode: "add",
        postId: "POST1",
        emojiName: "thumbsup",
      });

      const result = await withMockedGlobalFetch(fetchImpl as unknown as typeof fetch, async () => {
        const result = await mattermostPlugin.actions?.handleAction?.({
          channel: "mattermost",
          action: "react",
          params: { messageId: "POST1", emoji: "thumbsup", remove: "true" },
          cfg,
          accountId: "default",
        } as any);

        return result;
      });

      expect(result?.content).toEqual([{ type: "text", text: "Reacted with :thumbsup: on POST1" }]);
    });
  });

  describe("outbound threadId routing", () => {
    const mockSend = sendMessageMattermost as ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockSend.mockClear();
    });

    it("uses threadId as replyToId when replyToId is absent", async () => {
      await mattermostPlugin.outbound!.sendText!({
        cfg: {} as OpenClawConfig,
        to: "channel:town-square",
        text: "sub-agent result",
        threadId: "root-post-123",
      } as any);

      expect(mockSend).toHaveBeenCalledWith(
        "channel:town-square",
        "sub-agent result",
        expect.objectContaining({ replyToId: "root-post-123" }),
      );
    });

    it("prefers replyToId over threadId when both present", async () => {
      await mattermostPlugin.outbound!.sendText!({
        cfg: {} as OpenClawConfig,
        to: "channel:town-square",
        text: "reply",
        replyToId: "specific-post-456",
        threadId: "root-post-123",
      } as any);

      expect(mockSend).toHaveBeenCalledWith(
        "channel:town-square",
        "reply",
        expect.objectContaining({ replyToId: "specific-post-456" }),
      );
    });

    it("does not set replyToId when neither replyToId nor threadId present", async () => {
      await mattermostPlugin.outbound!.sendText!({
        cfg: {} as OpenClawConfig,
        to: "channel:town-square",
        text: "top-level message",
      } as any);

      expect(mockSend).toHaveBeenCalledWith(
        "channel:town-square",
        "top-level message",
        expect.objectContaining({ replyToId: undefined }),
      );
    });

    it("uses threadId for sendMedia when replyToId is absent", async () => {
      await mattermostPlugin.outbound!.sendMedia!({
        cfg: {} as OpenClawConfig,
        to: "channel:town-square",
        text: "media in thread",
        mediaUrl: "https://example.com/image.png",
        threadId: "root-post-789",
      } as any);

      expect(mockSend).toHaveBeenCalledWith(
        "channel:town-square",
        "media in thread",
        expect.objectContaining({ replyToId: "root-post-789" }),
      );
    });

    it("coerces numeric threadId to string", async () => {
      await mattermostPlugin.outbound!.sendText!({
        cfg: {} as OpenClawConfig,
        to: "channel:town-square",
        text: "numeric thread",
        threadId: 42,
      } as any);

      expect(mockSend).toHaveBeenCalledWith(
        "channel:town-square",
        "numeric thread",
        expect.objectContaining({ replyToId: "42" }),
      );
    });
  });

  describe("config", () => {
    it("formats allowFrom entries", () => {
      const formatAllowFrom = mattermostPlugin.config.formatAllowFrom!;

      const formatted = formatAllowFrom({
        cfg: {} as OpenClawConfig,
        allowFrom: ["@Alice", "user:USER123", "mattermost:BOT999"],
      });
      expect(formatted).toEqual(["@alice", "user123", "bot999"]);
    });

    it("uses account responsePrefix overrides", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            responsePrefix: "[Channel]",
            accounts: {
              default: { responsePrefix: "[Account]" },
            },
          },
        },
      };

      const prefixContext = createReplyPrefixOptions({
        cfg,
        agentId: "main",
        channel: "mattermost",
        accountId: "default",
      });

      expect(prefixContext.responsePrefix).toBe("[Account]");
    });
  });
});
