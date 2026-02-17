# Redis Orchestrator Plugin

BullMQ-based orchestration layer for durable agent job tracking in OpenClaw.

## Phase 1: Reliability Foundation

This plugin adds durability around the existing `sessions_spawn`/`sessions_send` pipeline by tracking jobs in Redis-backed BullMQ queues.

### Features

- ✅ **Durable job tracking** - Jobs survive gateway restarts
- ✅ **Automatic retries** - Failed spawns/sends are retried with exponential backoff
- ✅ **DLQ alerting** - Notifications when jobs exhaust all retries
- ✅ **Circuit breaker** - Falls back to direct dispatch if Redis is unavailable
- ✅ **CLI tools** - Inspect and monitor job queues
- ✅ **Recovery** - Resumes interrupted jobs on gateway restart

### Installation

From the OpenClaw repository root:

```bash
pnpm install
```

This will install the plugin's dependencies (`bullmq` and `ioredis`) as part of the workspace.

### Configuration

Add to your OpenClaw config:

```json5
{
  plugins: {
    'redis-orchestrator': {
      enabled: true,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        password: '', // Optional
      },
      circuitBreaker: {
        failureThreshold: 5,
        resetTimeout: 30000, // 30 seconds
      },
      dlq: {
        alertChannel: 'discord',
      },
    },
  },
}
```

### Redis Setup

The plugin requires a Redis instance with:

- **AOF enabled** - Ensures durability of job data
- **maxmemory-policy: noeviction** - Prevents job data from being evicted

Check your Redis configuration:

```bash
docker exec gcp-redis redis-cli config get appendonly
docker exec gcp-redis redis-cli config get maxmemory-policy
```

If needed, enable AOF:

```bash
docker exec gcp-redis redis-cli config set appendonly yes
docker exec gcp-redis redis-cli config set maxmemory-policy noeviction
```

### CLI Commands

```bash
# View queue statistics
openclaw queue stats
openclaw queue stats --agent jarvis

# List jobs
openclaw queue list
openclaw queue list --agent jarvis --status active
openclaw queue list --status failed --limit 50

# Inspect a specific job
openclaw queue inspect <jobId>
```

### How It Works

```
User → sessions_spawn
  ↓
OpenClaw creates agent session
  ↓
after_tool_call hook → BullMQ job created (status: queued → active)
  ↓
Agent runs
  ↓
agent_end hook → BullMQ job updated (status: announcing)
  ↓
Announce flow delivers result to dispatcher
  ↓
BullMQ job completed (status: completed)
```

### Circuit Breaker

If Redis becomes unavailable:

1. After 5 consecutive failures, circuit opens
2. All spawns fall back to direct `sessions_spawn` (unreliable but available)
3. After 30 seconds, circuit enters half-open state
4. Next successful operation closes the circuit

### Acceptance Criteria

Phase 1:

- [x] Gateway restart mid-task: job state survives in Redis
- [x] `sessions_spawn` failure: retried automatically
- [x] DLQ alert if all retries fail
- [x] `sessions_send` failure: tracked for retry
- [x] `openclaw queue stats` shows live job counts
- [x] Redis down: circuit breaker falls back, warning logged
- [x] No behavior change for agents

### Architecture

```
BullMQ (durability layer)
  → Tracks jobs in Redis queues
  → Survives crashes, retries on failure
  → Wraps the announce pipeline

Existing Announce Pipeline (delivery layer)  
  → Handles steer/collect/followup modes
  → Stays as-is, BullMQ adds reliability around it

callGateway (injection layer)
  → Actual message injection
  → Unchanged
```

### Files

- `index.ts` - Plugin entry point
- `src/types.ts` - Type definitions
- `src/circuit-breaker.ts` - Circuit breaker implementation
- `src/redis-connection.ts` - Redis connection management
- `src/queue-config.ts` - BullMQ configuration
- `src/job-tracker.ts` - Job creation and updates
- `src/dlq-alerting.ts` - DLQ notifications
- `src/cli-commands.ts` - CLI commands
- `src/service.ts` - Main background service
- `src/hooks.ts` - Plugin hooks (after_tool_call, agent_end)

### Next Phases

**Phase 2:** Agent tools (`queue_dispatch`, `queue_status`, `queue_list`, `queue_activity`)

**Phase 3:** Dependency chains, Bull Board UI, multi-project orchestration

### Development

The plugin is implemented as an OpenClaw extension in the `extensions/` directory. It uses the plugin SDK to register hooks, services, and CLI commands.

Key hooks:
- `gateway_start` - Initialize Redis connection and shared instances
- `after_tool_call` - Track `sessions_spawn` and `sessions_send` calls
- `agent_end` - Update job status when agent finishes
- `gateway_stop` - Cleanup connections

### Troubleshooting

**Circuit breaker keeps opening:**
- Check Redis is running: `docker ps | grep redis`
- Check connectivity: `docker exec gcp-redis redis-cli ping`
- Check logs: Look for "redis-orchestrator" messages

**Jobs not showing in queue stats:**
- Verify plugin is enabled in config
- Check Redis connection in gateway logs
- Ensure queue name matches agent ID pattern

**DLQ alerts not appearing:**
- Phase 1 logs to console (Discord integration in Phase 2)
- Check for jobs with status 'failed' in queue list
- Inspect failed jobs with `openclaw queue inspect <jobId>`
