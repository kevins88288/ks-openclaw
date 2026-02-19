/**
 * Dependency Gate Worker — Phase 3 Task 3.10
 *
 * Processes "dependency-gate" jobs created by FlowProducer when a job
 * has `dependsOn` set. Each gate child monitors a single existing job
 * and completes when that job completes (or fails if the dependency fails).
 *
 * The parent (dependent job) stays in waiting-children state until all
 * gate children complete. Fail-fast: if any dependency fails, its gate
 * child throws, causing it to exhaust retries and fail permanently.
 */

import type { PluginLogger } from "openclaw/plugin-sdk";
import { Worker, UnrecoverableError, type Job } from "bullmq";
import type { RedisConnection } from "./redis-connection.js";
import { asBullMQConnection } from "./redis-connection.js";
import type { JobTracker } from "./job-tracker.js";

/** How long to wait between polling dependency status (ms) */
const POLL_INTERVAL_MS = 5_000;
/** Max time to wait for a dependency before timing out (ms) */
const MAX_WAIT_MS = 1_800_000; // 30 min

interface DependencyGateData {
  dependencyJobId: string;
  parentTarget: string;
}

async function processGate(
  job: Job<DependencyGateData>,
  logger: PluginLogger,
  jobTracker: JobTracker,
): Promise<string> {
  const { dependencyJobId, parentTarget } = job.data;
  logger.info(`dep-gate: checking dependency ${dependencyJobId} for parent targeting ${parentTarget}`);

  const startTime = Date.now();

  // Poll the dependency job until it completes or fails
  while (Date.now() - startTime < MAX_WAIT_MS) {
    // Look up the dependency job queue
    const depQueueName = await jobTracker.findQueueForJob(dependencyJobId);
    if (!depQueueName) {
      throw new Error(`Dependency job ${dependencyJobId} not found in index`);
    }

    const depQueue = jobTracker.getOrCreateQueue(depQueueName);
    const depJob = await depQueue.getJob(dependencyJobId);

    if (!depJob) {
      throw new Error(`Dependency job ${dependencyJobId} not found in queue ${depQueueName}`);
    }

    const depState = await depJob.getState();

    if (depState === "completed") {
      logger.info(`dep-gate: dependency ${dependencyJobId} completed — gate passing`);
      return `dependency ${dependencyJobId} completed`;
    }

    if (depState === "failed") {
      // Fail-fast: dependency failed, so this gate fails, parent stays unprocessed.
      // UnrecoverableError because retrying won't fix a failed dependency.
      throw new UnrecoverableError(
        `Dependency job ${dependencyJobId} failed — fail-fast: ${depJob.data?.error || depJob.failedReason || "unknown reason"}`,
      );
    }

    // Still in progress — wait and poll again
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Dependency job ${dependencyJobId} timed out after ${MAX_WAIT_MS / 1000}s`);
}

/**
 * Create the dependency-gate worker that processes gate children.
 * Returns the Worker instance for lifecycle management.
 */
export function createDependencyGateWorker(
  connection: RedisConnection,
  logger: PluginLogger,
  jobTracker: JobTracker,
): Worker {
  const worker = new Worker<DependencyGateData, string>(
    "dep-gates",
    async (job) => processGate(job, logger, jobTracker),
    {
      connection: asBullMQConnection(connection),
      prefix: "bull",
      concurrency: 10, // Process multiple gates concurrently
      lockDuration: 2_100_000, // 35 min — must outlast MAX_WAIT_MS (30 min) + buffer
      stalledInterval: 300_000, // 5 min
      maxStalledCount: 2, // Extra resilience for long-running gate polls
    },
  );

  worker.on("error", (err) => {
    logger.warn(`dep-gate-worker: error: ${err.message}`);
  });

  worker.on("failed", (job, err) => {
    logger.warn(`dep-gate-worker: gate ${job?.id} failed: ${err.message}`);
  });

  worker.on("completed", (job) => {
    logger.info(`dep-gate-worker: gate ${job.id} completed`);
  });

  logger.info("dep-gate-worker: started dependency gate worker");
  return worker;
}
