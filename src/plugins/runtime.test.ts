import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  getActivePluginHttpRouteRegistry,
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resolveActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "./runtime.js";

describe("plugin runtime route registry", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("keeps the pinned route registry when the active plugin registry changes", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const laterRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);
    setActivePluginRegistry(laterRegistry);

    expect(resolveActivePluginHttpRouteRegistry(laterRegistry)).toBe(startupRegistry);
  });

  it("falls back to the provided registry when the pinned route registry has no routes", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const explicitRegistry = createEmptyPluginRegistry();
    explicitRegistry.httpRoutes.push({
      path: "/demo",
      auth: "plugin",
      match: "exact",
      handler: () => true,
      pluginId: "demo",
      source: "test",
    });

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);

    expect(resolveActivePluginHttpRouteRegistry(explicitRegistry)).toBe(explicitRegistry);
  });

  it("prefers the pinned route registry when it already owns routes", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const explicitRegistry = createEmptyPluginRegistry();
    startupRegistry.httpRoutes.push({
      path: "/bluebubbles-webhook",
      auth: "plugin",
      match: "exact",
      handler: () => true,
      pluginId: "bluebubbles",
      source: "test",
    });
    explicitRegistry.httpRoutes.push({
      path: "/plugins/diffs",
      auth: "plugin",
      match: "prefix",
      handler: () => true,
      pluginId: "diffs",
      source: "test",
    });

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);

    expect(resolveActivePluginHttpRouteRegistry(explicitRegistry)).toBe(startupRegistry);
  });

  it("pinning new registry while already pinned should overwrite", () => {
    const registryA = createEmptyPluginRegistry();
    const registryB = createEmptyPluginRegistry();
    registryA.httpRoutes.push({
      path: "/route-a",
      auth: "plugin",
      match: "exact",
      handler: () => true,
      pluginId: "a",
      source: "test",
    });
    registryB.httpRoutes.push({
      path: "/route-b",
      auth: "plugin",
      match: "exact",
      handler: () => true,
      pluginId: "b",
      source: "test",
    });

    pinActivePluginHttpRouteRegistry(registryA);
    pinActivePluginHttpRouteRegistry(registryB);

    expect(getActivePluginHttpRouteRegistry()).toBe(registryB);
  });

  it("no route gap during swap-then-release", () => {
    const registryA = createEmptyPluginRegistry();
    const registryB = createEmptyPluginRegistry();
    registryA.httpRoutes.push({
      path: "/route-a",
      auth: "plugin",
      match: "exact",
      handler: () => true,
      pluginId: "a",
      source: "test",
    });
    registryB.httpRoutes.push({
      path: "/route-b",
      auth: "plugin",
      match: "exact",
      handler: () => true,
      pluginId: "b",
      source: "test",
    });

    // Pin A (initial startup)
    setActivePluginRegistry(registryA);
    pinActivePluginHttpRouteRegistry(registryA);
    expect(getActivePluginHttpRouteRegistry()).toBe(registryA);

    // Swap: pin B while A is still pinned
    pinActivePluginHttpRouteRegistry(registryB);
    expect(getActivePluginHttpRouteRegistry()).toBe(registryB);

    // Release A (old) — should be a no-op since B is now pinned
    releasePinnedPluginHttpRouteRegistry(registryA);
    expect(getActivePluginHttpRouteRegistry()).toBe(registryB);
    expect(registryB.httpRoutes).toHaveLength(1);
  });
});
