# Phase 3 Batch 1+2 Build Report

**Branch:** `feature/redis-orchestrator`
**Commits:**
- `cd4efb680` — Phase 3 batch 1: platform alignment
- `1c5e4b475` — Phase 3 batch 2: security hardening

---

## Batch 1: Platform Alignment

### Task 3.0 — Use `api.pluginConfig` ✅
- Added `pluginConfig?: Record<string, unknown>` to `PluginState` in `index.ts`
- `register()` stores `api.pluginConfig` into `state.pluginConfig`
- `service.ts:start()` reads config from `state.pluginConfig` (redis, circuitBreaker sections)
- Removed manual `pluginEntry` / `ctx.config.plugins.entries` extraction

### Task 3.1a — Switch SDK-available imports ✅
- All `AnyAgentTool`, `OpenClawPluginToolContext`, `jsonResult`, `readStringParam`, `readNumberParam`, `optionalStringEnum` imports use `openclaw/plugin-sdk`
- All `PluginLogger`, `OpenClawPluginService`, `OpenClawPluginServiceContext` use `openclaw/plugin-sdk`
- Hook types (`PluginHookAfterToolCallEvent`, etc.) use `openclaw/plugin-sdk`
- Note: `normalizeAgentId` is NOT in the plugin SDK (despite task listing it as available). It remains as a COUPLING import from `src/routing/session-key.js`.

### Task 3.1b — Document remaining core imports ✅
All `../../../src/` and `../../../../src/` imports have `// COUPLING:` comments:
- `service.ts`: `listAgentIds` from `agents/agent-scope.js`
- `worker.ts`: 12 imports (agent-scope, lanes, model-selection, subagent-announce, subagent-depth, subagent-registry, sessions-helpers, thinking, config, gateway/call, session-key, delivery-context)
- `queue-dispatch.ts`: 5 imports (config, session-key, agent-scope, subagent-depth, delivery-context)
- `queue-list.ts`: 3 imports (session-key, config, agent-scope)
- `queue-activity.ts`: 2 imports (config, agent-scope)

### Task 3.2 — configSchema with safeParse ✅
- New file: `src/config-schema.ts` with TypeBox schema
- Schema fields: `redis.{host, port, password, tls}`, `circuitBreaker.{failureThreshold, resetTimeout}`, `rateLimit.{dispatchesPerMinute, maxQueueDepth}`, `dlq.{alertChannel}`
- `safeParse()` returns `{ success, data?, error? }` with proper `issues[]` format
- JSON schema in `openclaw.plugin.json` manifest for static validation
- `redis.tls` is schema-only (no TLS implementation)

---

## Batch 2: Security Hardening

### Task 3.3 — Cross-agent authorization ✅
**queue_status:**
- Auth check: `job.data.dispatchedBy === callerAgentId || job.data.target === callerAgentId`
- Returns `"Unauthorized: you can only view jobs you dispatched or that target you."` on failure
- `callerAgentId` from `ctx.agentId`
- `stripSensitiveFields()` removes `openclawSessionKey` for non-system agents

**queue_list:**
- Filters results: only includes jobs where caller is dispatcher or target
- Fetches 3x limit to allow for auth filtering, then caps to limit
- `stripSensitiveFields()` on all returned records

**Auth helpers** (`src/auth-helpers.ts`):
- `isSystemAgent()` — `lucius` and `main` bypass auth
- `stripSensitiveFields()` — removes `openclawSessionKey` for non-system agents

### Task 3.4 — Rate limiting on queue_dispatch ✅
**Dispatches per minute:**
- Redis INCR + EXPIRE pattern on key `ratelimit:dispatch:{callerAgentId}` with 60s TTL
- Default: 10/min, configurable via `pluginConfig.rateLimit.dispatchesPerMinute`
- 0 = unlimited
- Error: `"Rate limit exceeded: {n}/{max} dispatches this minute"`

**Queue depth cap:**
- Calls `queue.getJobCounts("wait", "delayed", "active")` before adding job
- Default: 50, configurable via `pluginConfig.rateLimit.maxQueueDepth`
- Error: `"Queue depth exceeded: {n}/{max} pending jobs for agent {target}"`

### Task 3.5 — DLQ alert content redaction ✅
- Task content truncated to 200 chars in `redactTaskForAlert()`
- Base64 patterns: `data:[^;]+;base64,[A-Za-z0-9+/=]+` → `[redacted-base64]`
- Standalone base64 blocks (40+ chars) also stripped
- `dispatcherOrigin` fields (accountId, threadId) excluded from alerts entirely
- `formatJobSummary()` also applies redaction to result text

### Task 3.6 — Circuit breaker auth failure detection ✅
- `forceOpen(reason: string)` method on `QueueCircuitBreaker`
  - Immediately sets state to `open`, sets failures to failMax
  - No-op if already open
- `createRedisConnection()` accepts optional `onAuthFailure?: () => void` callback
  - Error handler detects `/NOAUTH|ERR AUTH/` and calls callback
- `service.ts:start()` wires `connection.on("error")` to `state.circuitBreaker.forceOpen()` on auth failure

---

## Files Changed

| File | Change |
|------|--------|
| `index.ts` | Added `pluginConfig` to PluginState, store from `api.pluginConfig` in register() |
| `openclaw.plugin.json` | Added full configSchema JSON schema |
| `src/config-schema.ts` | **New** — TypeBox schema + safeParse + JSON schema |
| `src/auth-helpers.ts` | **New** — isSystemAgent(), stripSensitiveFields() |
| `src/service.ts` | Read config from state.pluginConfig, wire auth failure to circuit breaker |
| `src/circuit-breaker.ts` | Added forceOpen(reason) method |
| `src/redis-connection.ts` | Added onAuthFailure callback parameter |
| `src/dlq-alerting.ts` | Content redaction: truncate, strip base64, exclude dispatcherOrigin |
| `src/tools/queue-status.ts` | Auth check + stripSensitiveFields |
| `src/tools/queue-list.ts` | Auth filtering + stripSensitiveFields, SDK imports |
| `src/tools/queue-dispatch.ts` | Rate limiting (per-min + queue depth), COUPLING comments |
| `src/tools/queue-activity.ts` | SDK imports, COUPLING comments |
| `src/worker.ts` | COUPLING comments on all core imports |

## Acceptance Criteria

**Batch 1:**
- [x] Service reads config from `state.pluginConfig` (set in `register()` from `api.pluginConfig`)
- [x] All SDK-available imports use `openclaw/plugin-sdk`
- [x] All remaining `../../../src/` imports have `// COUPLING:` comments
- [x] `configSchema.safeParse` on plugin definition validates config at load time
- [x] Config schema includes `rateLimit.dispatchesPerMinute`, `rateLimit.maxQueueDepth`, and `redis.tls` fields

**Batch 2:**
- [x] `queue_status` rejects with "Unauthorized" when caller didn't dispatch or isn't target
- [x] `queue_list` returns only jobs involving the calling agent
- [x] Neither tool returns `openclawSessionKey` in responses (for non-system agents)
- [x] `queue_dispatch` rejects after rate limit threshold (Redis-based, configurable)
- [x] `queue_dispatch` rejects when queue depth >= maxQueueDepth (configurable)
- [x] DLQ alerts: task truncated to 200 chars, base64 stripped, dispatcherOrigin removed
- [x] Circuit breaker `forceOpen()` fires on NOAUTH from ioredis error event
