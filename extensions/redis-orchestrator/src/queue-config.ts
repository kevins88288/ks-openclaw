/**
 * BullMQ Queue Configuration
 *
 * Critical settings to prevent false stalls and duplicate executions
 */

import type { DefaultJobOptions, QueueOptions, WorkerOptions } from "bullmq";

// CRITICAL — these prevent duplicate agent executions
export const QUEUE_CONFIG = {
  lockDuration: 300_000, // 5 min (agents take 2-10 min, default 30s causes false stalls)
  stalledInterval: 180_000, // 3 min stall check interval
  maxStalledCount: 2, // Retry stalled job twice, then DLQ

  defaultJobOptions: {
    // LAUNCH-FAILURE retries only: these handle cases where the Worker's processJob()
    // fails to spawn the child session (e.g., gateway down, depth limit exceeded).
    // BullMQ marks the job "completed" once the child session launches successfully.
    // Agent-level failures (child runs but fails) are handled separately by the
    // re-dispatch pattern in the agent_end hook (see hooks.ts, Phase 3.5 Batch 1).
    attempts: 3, // Max launch-failure retry attempts
    backoff: {
      type: "exponential" as const,
      delay: 5000, // 5s base delay for launch retries (short — these are transient)
    },
    removeOnComplete: {
      age: 604_800, // Keep completed jobs 7 days (in seconds)
      count: 1000, // Keep at most 1000 completed jobs
    },
    removeOnFail: {
      age: 2_592_000, // Keep failed jobs 30 days (in seconds)
      count: 5000, // Keep at most 5000 failed jobs
    },
  } satisfies DefaultJobOptions,
} as const;

export const DEFAULT_JOB_TIMEOUT_MS = 1_800_000; // 30 min

export function createQueueOptions(prefix: string = "bull") {
  return {
    prefix,
    defaultJobOptions: QUEUE_CONFIG.defaultJobOptions,
  } as const;
}

export function createWorkerOptions(): Partial<WorkerOptions> {
  return {
    lockDuration: QUEUE_CONFIG.lockDuration,
    stalledInterval: QUEUE_CONFIG.stalledInterval,
    maxStalledCount: QUEUE_CONFIG.maxStalledCount,
    concurrency: 1, // Process one job at a time per worker
  };
}
