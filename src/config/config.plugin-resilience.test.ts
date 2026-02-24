/**
 * S-19: Resilient Plugin Loading
 *
 * Orphaned plugin references in config (entries that reference plugins no longer
 * on disk) must NOT block gateway startup. They should produce warnings but allow
 * config to load successfully.
 *
 * RED tests — currently failing because validation.ts pushes "plugin not found"
 * to issues (fatal) instead of warnings (non-fatal).
 */
import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./config.js";

describe("S-19: resilient plugin loading — orphaned entries are warnings not errors", () => {
  it("accepts config with orphaned plugins.entries reference", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "main" }] },
      plugins: {
        enabled: false,
        entries: {
          "nonexistent-plugin": { enabled: true },
        },
      },
    });
    // MUST be ok — orphaned entry is a warning, not a fatal error
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Warning should exist so operators know something is stale
      const hasWarning = res.warnings?.some(
        (w) =>
          w.path === "plugins.entries.nonexistent-plugin" &&
          (w.message.includes("plugin not found") || w.message.includes("not discovered")),
      );
      expect(hasWarning).toBe(true);
    }
  });

  it("accepts config with orphaned plugins.allow reference", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "main" }] },
      plugins: {
        enabled: false,
        allow: ["nonexistent-allow-plugin"],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const hasWarning = res.warnings?.some(
        (w) =>
          w.path === "plugins.allow" &&
          (w.message.includes("plugin not found") || w.message.includes("not discovered")),
      );
      expect(hasWarning).toBe(true);
    }
  });

  it("accepts config with orphaned plugins.deny reference", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "main" }] },
      plugins: {
        enabled: false,
        deny: ["nonexistent-deny-plugin"],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const hasWarning = res.warnings?.some(
        (w) =>
          w.path === "plugins.deny" &&
          (w.message.includes("plugin not found") || w.message.includes("not discovered")),
      );
      expect(hasWarning).toBe(true);
    }
  });

  it("accepts config with orphaned plugins.slots.memory reference", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "main" }] },
      plugins: {
        enabled: false,
        slots: { memory: "nonexistent-memory-plugin" },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const hasWarning = res.warnings?.some(
        (w) =>
          w.path === "plugins.slots.memory" &&
          (w.message.includes("plugin not found") || w.message.includes("not discovered")),
      );
      expect(hasWarning).toBe(true);
    }
  });

  it("still rejects multiple unknown entries — all become warnings, config still ok", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "main" }] },
      plugins: {
        enabled: false,
        entries: {
          "ghost-plugin-a": { enabled: true },
          "ghost-plugin-b": { enabled: false },
        },
        allow: ["ghost-allow"],
      },
    });
    // All orphaned — still ok
    expect(res.ok).toBe(true);
    if (res.ok) {
      // All three orphaned references surface as warnings
      expect(res.warnings?.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("does not warn for known bundled plugins", () => {
    // Known bundled plugins (e.g. "discord", "telegram") should not produce warnings
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "main" }] },
      plugins: {
        enabled: false,
        entries: { discord: { enabled: true } },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const hasOrphanWarning = res.warnings?.some(
        (w) => w.path === "plugins.entries.discord" && w.message.includes("plugin not found"),
      );
      expect(hasOrphanWarning).toBe(false);
    }
  });
});
