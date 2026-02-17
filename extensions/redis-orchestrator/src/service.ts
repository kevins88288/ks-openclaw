/**
 * Redis Orchestrator Service
 *
 * Main service that coordinates job tracking, hooks, and recovery.
 * Populates/cleans up the shared PluginState so hooks can access instances.
 */

import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { Queue, QueueEvents, type Worker } from "bullmq";
import type { PluginState } from "../index.js";
import { QueueCircuitBreaker } from "./circuit-breaker.js";
import { DLQAlerter } from "./dlq-alerting.js";
import { JobTracker } from "./job-tracker.js";
import { createQueueOptions } from "./queue-config.js";
import { asBullMQConnection, type RedisConnection } from "./redis-connection.js";
import { createRedisConnection, closeRedisConnection } from "./redis-connection.js";
import { createWorkers, closeWorkers } from "./worker.js";

export function createRedisOrchestratorService(state: PluginState): OpenClawPluginService {
  let queueEventsMap: Map<string, QueueEvents> = new Map();
  let dlqQueuesMap: Map<string, Queue> = new Map();
  let workersMap: Map<string, Worker> = new Map();

  return {
    id: "redis-orchestrator",

    async start(ctx: OpenClawPluginServiceContext) {
      const pluginConfig = (ctx.config.plugins as any)?.["redis-orchestrator"];

      if (pluginConfig?.enabled === false) {
        ctx.logger.info("redis-orchestrator: disabled by config");
        return;
      }

      const redisConfig = {
        host: pluginConfig?.redis?.host || "127.0.0.1",
        port: pluginConfig?.redis?.port || 6379,
        password: pluginConfig?.redis?.password || process.env.REDIS_PASSWORD,
      };

      const circuitBreakerConfig = {
        failMax: pluginConfig?.circuitBreaker?.failureThreshold || 5,
        resetTimeout: pluginConfig?.circuitBreaker?.resetTimeout || 30000,
      };

      try {
        // Initialize Redis connection
        const connection = createRedisConnection(redisConfig, ctx.logger);

        // Wait for Redis to be ready
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Redis connection timeout"));
          }, 10000);

          connection.once("ready", () => {
            clearTimeout(timeout);
            resolve();
          });

          connection.once("error", (err: Error) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        ctx.logger.info("redis-orchestrator: Redis connection established");

        // Populate shared state — hooks read from this at call time
        state.connection = connection;
        state.circuitBreaker = new QueueCircuitBreaker(circuitBreakerConfig, ctx.logger);
        state.jobTracker = new JobTracker(connection, ctx.logger);
        state.dlqAlerter = new DLQAlerter(ctx.logger);

        // Set up DLQ event listeners for all agent queues
        await setupDLQListeners(connection, state.dlqAlerter, ctx, queueEventsMap, dlqQueuesMap);

        // Recover interrupted jobs on startup (Task 1.11)
        await recoverInterruptedJobs(connection, state.jobTracker, ctx);

        // Phase 2: Start BullMQ Workers for each agent queue
        const agentIds = ((ctx.config as any).agents?.list || [])
          .map((a: any) => a.id)
          .filter((id: string) => id !== "main");

        if (agentIds.length > 0) {
          workersMap = createWorkers(connection, agentIds, ctx.logger);
          ctx.logger.info(`redis-orchestrator: started ${workersMap.size} workers`);
        }

        ctx.logger.info("redis-orchestrator: service started");
      } catch (err) {
        ctx.logger.error(
          `redis-orchestrator: startup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Don't throw - allow OpenClaw to start without the orchestrator
        // Circuit breaker will handle fallback to direct dispatch
      }
    },

    async stop(ctx: OpenClawPluginServiceContext) {
      // Phase 2: Close all workers first (they hold jobs)
      if (workersMap.size > 0) {
        await closeWorkers(workersMap, ctx.logger);
        ctx.logger.info("redis-orchestrator: all workers closed");
      }

      // Close all queue event listeners
      for (const events of queueEventsMap.values()) {
        await events.close();
      }
      queueEventsMap.clear();

      // Close DLQ queue instances
      for (const queue of dlqQueuesMap.values()) {
        await queue.close();
      }
      dlqQueuesMap.clear();

      // Close job tracker (closes all queues)
      if (state.jobTracker) {
        await state.jobTracker.close();
        state.jobTracker = null;
      }

      // Close Redis connection
      if (state.connection) {
        await closeRedisConnection(state.connection, ctx.logger);
        state.connection = null;
      }

      state.circuitBreaker = null;
      state.dlqAlerter = null;

      ctx.logger.info("redis-orchestrator: service stopped");
    },
  };
}

async function setupDLQListeners(
  connection: RedisConnection,
  dlqAlerter: DLQAlerter,
  ctx: OpenClawPluginServiceContext,
  queueEventsMap: Map<string, QueueEvents>,
  dlqQueuesMap: Map<string, Queue>,
): Promise<void> {
  // Dynamic agent discovery from config
  const agents = ((ctx.config as any).agents?.list || [])
    .map((a: any) => a.id)
    .filter((id: string) => id !== "main");

  if (agents.length === 0) {
    ctx.logger.warn("redis-orchestrator: no agents found in config, DLQ listeners not set up");
    return;
  }

  for (const agentId of agents) {
    const queueName = `agent:${agentId}`;

    // QueueEvents only needs connection and prefix — not full queue options
    const bmConn = asBullMQConnection(connection);
    const events = new QueueEvents(queueName, {
      connection: bmConn,
      prefix: "bull",
    });

    // Prevent unhandled EventEmitter errors from crashing the process
    events.on("error", (err: Error) => {
      ctx.logger.warn(`redis-orchestrator: QueueEvents error for ${queueName}: ${err.message}`);
    });

    // Create one reusable Queue instance per agent for DLQ lookups
    const queue = new Queue(queueName, {
      connection: bmConn,
      ...createQueueOptions(),
    });
    dlqQueuesMap.set(queueName, queue);

    events.on(
      "failed",
      async ({ jobId, failedReason }: { jobId: string; failedReason: string }) => {
        try {
          const job = await queue.getJob(jobId);

          if (job && job.attemptsMade >= (job.opts.attempts || 3)) {
            // Job has exhausted all retries - send DLQ alert
            await dlqAlerter.sendAlert(job, failedReason);
          }
        } catch (err) {
          ctx.logger.warn(
            `Failed to handle DLQ alert for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );

    queueEventsMap.set(queueName, events);
  }

  ctx.logger.info(`redis-orchestrator: DLQ listeners set up for ${agents.length} agents`);
}

async function recoverInterruptedJobs(
  connection: RedisConnection,
  jobTracker: JobTracker,
  ctx: OpenClawPluginServiceContext,
): Promise<void> {
  try {
    const stats = await jobTracker.getQueueStats();

    let activeCount = 0;
    let announcingCount = 0;

    for (const [queueName, counts] of Object.entries(stats)) {
      activeCount += (counts as any).active || 0;

      // Check for jobs that were in 'announcing' state when gateway stopped
      const queue = new Queue(queueName, {
        connection: asBullMQConnection(connection),
        ...createQueueOptions(),
      });

      const activeJobs = await queue.getJobs(["active"]);

      for (const job of activeJobs) {
        if (job.data.status === "announcing") {
          announcingCount++;
          // TODO: Resume announce flow for this job
          // This will be implemented in Phase 1 once we have the announce hook
          ctx.logger.info(`redis-orchestrator: found interrupted announcing job ${job.id}`);
        }
      }

      await queue.close();
    }

    if (activeCount > 0 || announcingCount > 0) {
      ctx.logger.info(
        `redis-orchestrator: recovered ${activeCount} active jobs, ${announcingCount} announcing jobs`,
      );
    }
  } catch (err) {
    ctx.logger.warn(
      `redis-orchestrator: recovery check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
