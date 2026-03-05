/**
 * Tests 16-18: Monitor streaming configuration logic.
 *
 * These tests verify the streaming config resolution that gates draft stream creation.
 * They test the logic extracted from handlePost's streaming setup block.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";

// --------------------------------------------------------------------------
// Helpers: simulate the streaming gate logic from monitor.ts
// --------------------------------------------------------------------------

/**
 * Mirrors the canStreamDraft check in monitor.ts handlePost():
 *
 *   const mattermostStreamMode = account.config.streaming ?? "off";
 *   const accountBlockStreamingEnabled =
 *     typeof account.config.blockStreaming === "boolean"
 *       ? account.config.blockStreaming
 *       : cfg.agents?.defaults?.blockStreamingDefault === "on";
 *   const canStreamDraft = mattermostStreamMode !== "off" && !accountBlockStreamingEnabled;
 */
function resolveCanStreamDraft(params: {
  streaming?: "off" | "partial" | "block";
  blockStreaming?: boolean;
  blockStreamingDefault?: "on" | "off";
}): boolean {
  const mattermostStreamMode = params.streaming ?? "off";
  const accountBlockStreamingEnabled =
    typeof params.blockStreaming === "boolean"
      ? params.blockStreaming
      : params.blockStreamingDefault === "on";
  return mattermostStreamMode !== "off" && !accountBlockStreamingEnabled;
}

// --------------------------------------------------------------------------
// Test 16: streaming: "partial" → draft stream is enabled
// --------------------------------------------------------------------------

describe("Test 16: streaming: partial enables draft stream", () => {
  it("canStreamDraft is true when streaming is 'partial' and blockStreaming is not set", () => {
    const result = resolveCanStreamDraft({ streaming: "partial" });
    expect(result).toBe(true);
  });

  it("canStreamDraft is true when streaming is 'block' and blockStreaming is not set", () => {
    const result = resolveCanStreamDraft({ streaming: "block" });
    expect(result).toBe(true);
  });

  it("resolveMattermostAccount exposes streaming field from config", () => {
    const account = resolveMattermostAccount({
      cfg: {
        channels: {
          mattermost: {
            botToken: "tok",
            baseUrl: "https://mm.example.com",
            allowFrom: ["*"],
            dmPolicy: "open",
            streaming: "partial",
          },
        },
      } as any,
    });
    expect(account.config.streaming).toBe("partial");
  });
});

// --------------------------------------------------------------------------
// Test 17: streaming: "off" (default) → no draft stream
// --------------------------------------------------------------------------

describe("Test 17: streaming: off (default) disables draft stream", () => {
  it("canStreamDraft is false when streaming is not set (defaults to off)", () => {
    const result = resolveCanStreamDraft({ streaming: undefined });
    expect(result).toBe(false);
  });

  it("canStreamDraft is false when streaming is explicitly 'off'", () => {
    const result = resolveCanStreamDraft({ streaming: "off" });
    expect(result).toBe(false);
  });

  it("resolveMattermostAccount returns undefined streaming by default", () => {
    const account = resolveMattermostAccount({
      cfg: {
        channels: {
          mattermost: {
            botToken: "tok",
            baseUrl: "https://mm.example.com",
            allowFrom: ["*"],
            dmPolicy: "open",
          },
        },
      } as any,
    });
    // No streaming field set → should be undefined (resolves to "off")
    expect(account.config.streaming).toBeUndefined();
    // The gate defaults to off
    expect(account.config.streaming ?? "off").toBe("off");
  });
});

// --------------------------------------------------------------------------
// Test 18: blockStreaming: true overrides preview streaming
// --------------------------------------------------------------------------

describe("Test 18: blockStreaming: true overrides streaming: partial", () => {
  it("canStreamDraft is false when streaming is 'partial' but blockStreaming is true", () => {
    const result = resolveCanStreamDraft({ streaming: "partial", blockStreaming: true });
    expect(result).toBe(false);
  });

  it("canStreamDraft is false when streaming is 'block' and blockStreaming is true", () => {
    const result = resolveCanStreamDraft({ streaming: "block", blockStreaming: true });
    expect(result).toBe(false);
  });

  it("canStreamDraft is true when blockStreaming is false and streaming is partial", () => {
    const result = resolveCanStreamDraft({ streaming: "partial", blockStreaming: false });
    expect(result).toBe(true);
  });

  it("blockStreamingDefault: on disables draft stream when blockStreaming is not explicit", () => {
    const result = resolveCanStreamDraft({
      streaming: "partial",
      blockStreaming: undefined,
      blockStreamingDefault: "on",
    });
    expect(result).toBe(false);
  });

  it("resolveMattermostAccount exposes blockStreaming field from config", () => {
    const account = resolveMattermostAccount({
      cfg: {
        channels: {
          mattermost: {
            botToken: "tok",
            baseUrl: "https://mm.example.com",
            allowFrom: ["*"],
            dmPolicy: "open",
            streaming: "partial",
            blockStreaming: true,
          },
        },
      } as any,
    });
    expect(account.config.streaming).toBe("partial");
    expect(account.config.blockStreaming).toBe(true);
    // Verify the gate would produce false
    expect(resolveCanStreamDraft({
      streaming: account.config.streaming,
      blockStreaming: account.config.blockStreaming,
    })).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Bonus: Verify config schema accepts streaming field
// --------------------------------------------------------------------------

describe("config schema accepts streaming field", () => {
  it("MattermostConfigSchema parses streaming field correctly", async () => {
    const { MattermostConfigSchema } = await import("../config-schema.js");

    const result = MattermostConfigSchema.safeParse({
      streaming: "partial",
      botToken: "test-token",
      baseUrl: "https://mm.example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streaming).toBe("partial");
    }
  });

  it("MattermostConfigSchema rejects invalid streaming value", async () => {
    const { MattermostConfigSchema } = await import("../config-schema.js");

    const result = MattermostConfigSchema.safeParse({
      streaming: "invalid-value",
      botToken: "test-token",
      baseUrl: "https://mm.example.com",
    });
    expect(result.success).toBe(false);
  });
});
