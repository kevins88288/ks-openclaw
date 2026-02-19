/**
 * CLI Commands for Queue Management
 *
 * openclaw queue stats
 * openclaw queue list [agent]
 * openclaw queue inspect <jobId>
 * openclaw queue retry <jobId>
 * openclaw queue drain <agent> --confirm
 */

import type { Command } from "commander";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { Queue } from "bullmq";
import type { PluginState } from "../index.js";
import { createQueueOptions } from "./queue-config.js";
import { asBullMQConnection, type RedisConnection } from "./redis-connection.js";
import { createRedisConnection, closeRedisConnection } from "./redis-connection.js";

type CliContext = {
  program: Command;
  config: any;
  logger: PluginLogger;
};

/**
 * Get a Redis connection — use the shared one if available, otherwise create a temporary one.
 * Returns [connection, needsClose].
 */
function getConnection(state: PluginState, ctx: CliContext): [RedisConnection, boolean] {
  if (state.connection) {
    return [state.connection, false];
  }

  const pluginConfig = ctx.config.plugins?.["redis-orchestrator"] as any;
  const redisConfig = {
    host: pluginConfig?.redis?.host || "127.0.0.1",
    port: pluginConfig?.redis?.port || 6379,
    password: pluginConfig?.redis?.password || process.env.REDIS_PASSWORD,
  };

  return [createRedisConnection(redisConfig, ctx.logger), true];
}

export function registerQueueCommands(program: Command, state: PluginState, ctx: CliContext): void {
  const queue = program.command("queue").description("Manage agent job queues");

  queue
    .command("stats")
    .description("Show queue statistics")
    .option("-a, --agent <agentId>", "Filter by agent ID")
    .action(async (options) => {
      const [connection, needsClose] = getConnection(state, ctx);
      try {
        const agentId = options.agent;
        const queueNames = agentId ? [`agent-${agentId}`] : await getQueueNames(connection);

        console.log("Queue Statistics:\n");

        let totalPending = 0;
        let totalActive = 0;
        let totalCompleted = 0;
        let totalFailed = 0;

        for (const queueName of queueNames) {
          const q = new Queue(queueName, {
            connection: asBullMQConnection(connection),
            ...createQueueOptions(),
          });

          const counts = await q.getJobCounts("wait", "active", "completed", "failed", "delayed");

          console.log(`📊 ${queueName}:`);
          console.log(`   Pending: ${counts.wait || 0}`);
          console.log(`   Active: ${counts.active || 0}`);
          console.log(`   Completed: ${counts.completed || 0}`);
          console.log(`   Failed: ${counts.failed || 0}`);
          console.log(`   Delayed: ${counts.delayed || 0}`);
          console.log("");

          totalPending += counts.wait || 0;
          totalActive += counts.active || 0;
          totalCompleted += counts.completed || 0;
          totalFailed += counts.failed || 0;

          await q.close();
        }

        console.log("Summary:");
        console.log(`   Total Pending: ${totalPending}`);
        console.log(`   Total Active: ${totalActive}`);
        console.log(`   Total Completed: ${totalCompleted}`);
        console.log(`   Total Failed: ${totalFailed}`);
      } catch (err) {
        console.error(
          "Error getting queue stats:",
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      } finally {
        if (needsClose) {
          await closeRedisConnection(connection, ctx.logger);
        }
      }
    });

  queue
    .command("list")
    .description("List jobs in queue")
    .option("-a, --agent <agentId>", "Filter by agent ID")
    .option("-s, --status <status>", "Filter by status (wait, active, completed, failed)")
    .option("-l, --limit <number>", "Limit number of results", "20")
    .action(async (options) => {
      const [connection, needsClose] = getConnection(state, ctx);
      try {
        const agentId = options.agent;
        const status = options.status || "active";
        const limit = parseInt(options.limit, 10);

        const queueNames = agentId ? [`agent-${agentId}`] : await getQueueNames(connection);

        console.log(`Jobs (status: ${status}):\n`);

        for (const queueName of queueNames) {
          const q = new Queue(queueName, {
            connection: asBullMQConnection(connection),
            ...createQueueOptions(),
          });

          const jobs = await q.getJobs([status], 0, limit - 1);

          if (jobs.length === 0) {
            await q.close();
            continue;
          }

          console.log(`Queue: ${queueName}`);
          for (const job of jobs) {
            const data = job.data;
            console.log(`  ${job.id}`);
            console.log(`    Target: ${data.target}`);
            console.log(
              `    Task: ${data.task.substring(0, 60)}${data.task.length > 60 ? "..." : ""}`,
            );
            console.log(`    Status: ${data.status}`);
            console.log(`    Queued: ${new Date(data.queuedAt).toISOString()}`);
            if (data.startedAt) {
              console.log(`    Started: ${new Date(data.startedAt).toISOString()}`);
            }
            console.log("");
          }

          await q.close();
        }
      } catch (err) {
        console.error("Error listing jobs:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        if (needsClose) {
          await closeRedisConnection(connection, ctx.logger);
        }
      }
    });

  queue
    .command("retry")
    .description("Retry a failed job")
    .argument("<jobId>", "Job ID to retry")
    .action(async (jobId: string) => {
      const [connection, needsClose] = getConnection(state, ctx);
      try {
        const queueNames = await getQueueNames(connection);

        for (const queueName of queueNames) {
          const q = new Queue(queueName, {
            connection: asBullMQConnection(connection),
            ...createQueueOptions(),
          });

          const job = await q.getJob(jobId);

          if (job) {
            const jobState = await job.getState();

            if (jobState !== "failed") {
              console.error(`Job ${jobId} is not in failed state (current state: ${jobState})`);
              await q.close();
              process.exit(1);
            }

            await job.retry(jobState);
            const data = job.data;
            console.log(`Job ${jobId} re-queued for agent ${data.target}`);
            await q.close();
            return;
          }

          await q.close();
        }

        console.error(`Job ${jobId} not found in any queue`);
        process.exit(1);
      } catch (err) {
        console.error("Error retrying job:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        if (needsClose) {
          await closeRedisConnection(connection, ctx.logger);
        }
      }
    });

  queue
    .command("drain")
    .description("Remove all waiting/delayed jobs from an agent queue")
    .argument("<agent>", "Agent ID to drain")
    .option("--confirm", "Confirm drain operation (required)")
    .action(async (agent: string, options: { confirm?: boolean }) => {
      if (!options.confirm) {
        console.error(
          "Error: --confirm flag is required to drain a queue. This removes all waiting and delayed jobs.\n" +
            `Usage: openclaw queue drain ${agent} --confirm`,
        );
        process.exit(1);
      }

      const [connection, needsClose] = getConnection(state, ctx);
      try {
        const queueName = `agent-${agent}`;
        const q = new Queue(queueName, {
          connection: asBullMQConnection(connection),
          ...createQueueOptions(),
        });

        // Get counts before draining for reporting
        const countsBefore = await q.getJobCounts("wait", "delayed");
        const totalBefore = (countsBefore.wait || 0) + (countsBefore.delayed || 0);

        // Drain waiting jobs
        await q.drain();

        // Clean delayed jobs
        await q.clean(0, 0, "delayed");

        console.log(`Drained ${totalBefore} jobs from agent ${agent}`);

        await q.close();
      } catch (err) {
        console.error("Error draining queue:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        if (needsClose) {
          await closeRedisConnection(connection, ctx.logger);
        }
      }
    });

  queue
    .command("inspect")
    .description("Inspect a specific job")
    .argument("<jobId>", "Job ID to inspect")
    .action(async (jobId: string) => {
      const [connection, needsClose] = getConnection(state, ctx);
      try {
        const queueNames = await getQueueNames(connection);

        for (const queueName of queueNames) {
          const q = new Queue(queueName, {
            connection: asBullMQConnection(connection),
            ...createQueueOptions(),
          });

          const job = await q.getJob(jobId);

          if (job) {
            const data = job.data;

            console.log("Job Details:\n");
            console.log(`Job ID: ${job.id}`);
            console.log(`Queue: ${queueName}`);
            console.log(`Target Agent: ${data.target}`);
            console.log(`Dispatched By: ${data.dispatchedBy}`);
            console.log(`Status: ${data.status}`);
            console.log(`\nTask:\n${data.task}`);
            console.log(`\nTimeline:`);
            console.log(`  Queued: ${new Date(data.queuedAt).toISOString()}`);
            if (data.startedAt) {
              console.log(`  Started: ${new Date(data.startedAt).toISOString()}`);
            }
            if (data.completedAt) {
              console.log(`  Completed: ${new Date(data.completedAt).toISOString()}`);
              const duration = data.completedAt - (data.startedAt || data.queuedAt);
              console.log(`  Duration: ${Math.round(duration / 1000)}s`);
            }

            console.log(`\nRetries:`);
            console.log(`  Attempts: ${job.attemptsMade}/${job.opts.attempts || 3}`);

            if (data.error) {
              console.log(`\nError:\n${data.error}`);
            }

            if (data.result) {
              console.log(`\nResult:\n${data.result}`);
            }

            console.log(`\nOpenClaw Context:`);
            console.log(`  Run ID: ${data.openclawRunId}`);
            console.log(`  Session Key: ${data.openclawSessionKey}`);

            if (data.project) {
              console.log(`  Project: ${data.project}`);
            }

            await q.close();
            return;
          }

          await q.close();
        }

        console.error(`Job ${jobId} not found in any queue`);
        process.exit(1);
      } catch (err) {
        console.error("Error inspecting job:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      } finally {
        if (needsClose) {
          await closeRedisConnection(connection, ctx.logger);
        }
      }
    });
}

async function getQueueNames(connection: RedisConnection): Promise<string[]> {
  const keys: string[] = await connection.keys("bull:agent-*:meta");
  return keys
    .map((key: string) => {
      const match = key.match(/bull:(agent-[^:]+):/);
      return match ? match[1] : null;
    })
    .filter((name: string | null): name is string => name !== null);
}
