import { describe, expect, it } from "vitest";
import { resolveTextChunkLimit } from "../../../../src/auto-reply/chunk.js";
import { MATTERMOST_DEFAULT_CHUNK_LIMIT } from "./accounts.js";

describe("MATTERMOST_DEFAULT_CHUNK_LIMIT", () => {
  it("is 50000", () => {
    expect(MATTERMOST_DEFAULT_CHUNK_LIMIT).toBe(50000);
  });

  it("resolveTextChunkLimit returns 50000 for mattermost with no config override", () => {
    // Simulates the monitor.ts inbound path after the fix:
    // fallbackLimit: account.textChunkLimit ?? MATTERMOST_DEFAULT_CHUNK_LIMIT
    expect(
      resolveTextChunkLimit(undefined, "mattermost", undefined, {
        fallbackLimit: MATTERMOST_DEFAULT_CHUNK_LIMIT,
      }),
    ).toBe(50000);
  });

  it("resolveTextChunkLimit uses config override over MATTERMOST_DEFAULT_CHUNK_LIMIT", () => {
    const cfg = { channels: { mattermost: { textChunkLimit: 12345 } } };
    expect(
      resolveTextChunkLimit(cfg, "mattermost", undefined, {
        fallbackLimit: MATTERMOST_DEFAULT_CHUNK_LIMIT,
      }),
    ).toBe(12345);
  });
});
