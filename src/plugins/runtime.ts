import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

/**
 * Plugin HTTP route registry pinning lifecycle:
 *
 * 1. Gateway startup:  `createGatewayRuntimeState` pins the initial registry.
 * 2. Per-message loads: `setActivePluginRegistry` updates `registry` but leaves
 *    `httpRouteRegistry` untouched while pinned, preventing per-turn route churn.
 * 3. Config reload / restart: the new registry is pinned FIRST (swap), then the
 *    old registry is released (no-op because the reference no longer matches).
 *    This eliminates any window where HTTP requests would see an empty route table.
 * 4. Gateway close: the release closure fires; if no new pin replaced it, the
 *    registry unpins and falls back to `state.registry`.
 */
type RegistryState = {
  registry: PluginRegistry | null;
  httpRouteRegistry: PluginRegistry | null;
  httpRouteRegistryPinned: boolean;
  key: string | null;
  version: number;
};

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      registry: createEmptyPluginRegistry(),
      httpRouteRegistry: null,
      httpRouteRegistryPinned: false,
      key: null,
      version: 0,
    };
  }
  return globalState[REGISTRY_STATE];
})();

export function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string) {
  state.registry = registry;
  if (!state.httpRouteRegistryPinned) {
    state.httpRouteRegistry = registry;
  }
  state.key = cacheKey ?? null;
  state.version += 1;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.registry;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.registry) {
    state.registry = createEmptyPluginRegistry();
    if (!state.httpRouteRegistryPinned) {
      state.httpRouteRegistry = state.registry;
    }
    state.version += 1;
  }
  return state.registry;
}

/**
 * Pin a plugin registry as the authoritative HTTP route source.
 *
 * Safe to call while already pinned — the new registry overwrites the previous
 * pin immediately.  This enables "swap-then-release" semantics during config
 * reload: pin the NEW registry first (routes switch instantly), then release the
 * old one (which becomes a no-op because the registry reference no longer matches).
 */
export function pinActivePluginHttpRouteRegistry(registry: PluginRegistry) {
  state.httpRouteRegistry = registry;
  state.httpRouteRegistryPinned = true;
}

/**
 * Release a previously pinned HTTP route registry.
 *
 * If `registry` is provided and does not match the currently pinned registry,
 * the call is a no-op.  This is the expected outcome after swap-then-release:
 * the new pin already replaced the old reference, so releasing the old one
 * has no effect on the active route table.
 */
export function releasePinnedPluginHttpRouteRegistry(registry?: PluginRegistry) {
  if (registry && state.httpRouteRegistry !== registry) {
    return;
  }
  state.httpRouteRegistryPinned = false;
  state.httpRouteRegistry = state.registry;
}

export function getActivePluginHttpRouteRegistry(): PluginRegistry | null {
  return state.httpRouteRegistry ?? state.registry;
}

export function requireActivePluginHttpRouteRegistry(): PluginRegistry {
  const existing = getActivePluginHttpRouteRegistry();
  if (existing) {
    return existing;
  }
  const created = requireActivePluginRegistry();
  state.httpRouteRegistry = created;
  return created;
}

export function resolveActivePluginHttpRouteRegistry(fallback: PluginRegistry): PluginRegistry {
  const routeRegistry = getActivePluginHttpRouteRegistry();
  if (!routeRegistry) {
    return fallback;
  }
  const routeCount = routeRegistry.httpRoutes?.length ?? 0;
  const fallbackRouteCount = fallback.httpRoutes?.length ?? 0;
  if (routeCount === 0 && fallbackRouteCount > 0) {
    return fallback;
  }
  return routeRegistry;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

export function getActivePluginRegistryVersion(): number {
  return state.version;
}
