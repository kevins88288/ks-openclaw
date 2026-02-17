/**
 * Job Tracker - Creates and updates BullMQ jobs for agent runs
 *
 * Hooks into sessions_spawn and agent_end to track job lifecycle.
 * Uses runId as BullMQ jobId for direct lookup — no in-memory maps needed.
 */

import type { PluginLogger } from "openclaw/plugin-sdk";
import { Queue } from "bullmq";
import type { AgentJob } from "./types.js";
import { createQueueOptions, DEFAULT_JOB_TIMEOUT_MS } from "./queue-config.js";
import { asBullMQConnection, type RedisConnection } from "./redis-connection.js";

export class JobTracker {
  private queues: Map<string, Queue> = new Map();

  constructor(
    private connection: RedisConnection,
    private logger: PluginLogger,
  ) {}

  private getQueueForAgent(agentId: string): Queue {
    const queueName = `agent:${agentId}`;

    if (!this.queues.has(queueName)) {
      const queue = new Queue(queueName, {
        connection: asBullMQConnection(this.connection),
        ...createQueueOptions(),
      });

      this.queues.set(queueName, queue);
      this.logger.info(`job-tracker: created queue ${queueName}`);
    }

    return this.queues.get(queueName)!;
  }

  /**
   * Create a job from an after_tool_call hook (Phase 1 — tracking sessions_spawn).
   * Uses runId as the BullMQ jobId for direct lookup.
   */
  async createJob(params: {
    target: string;
    task: string;
    dispatchedBy: string;
    runId?: string;
    sessionKey?: string;
    project?: string;
    timeoutMs?: number;
    // Phase 2 dispatcher context
    dispatcherSessionKey?: string;
    dispatcherAgentId?: string;
    dispatcherDepth?: number;
    dispatcherOrigin?: { channel?: string; accountId?: string; to?: string; threadId?: string | number };
    label?: string;
    model?: string;
    thinking?: string;
    cleanup?: 'delete' | 'keep';
  }): Promise<string> {
    const queue = this.getQueueForAgent(params.target);

    const jobData: AgentJob = {
      jobId: params.runId ?? '', // Populated by hook (Phase 1) or left empty for Worker (Phase 2)
      target: params.target,
      task: params.task,
      dispatchedBy: params.dispatchedBy,
      project: params.project,
      status: "queued",
      queuedAt: Date.now(),
      openclawRunId: params.runId,
      openclawSessionKey: params.sessionKey,
      timeoutMs: params.timeoutMs || DEFAULT_JOB_TIMEOUT_MS,
      // Phase 2 fields
      dispatcherSessionKey: params.dispatcherSessionKey,
      dispatcherAgentId: params.dispatcherAgentId,
      dispatcherDepth: params.dispatcherDepth,
      dispatcherOrigin: params.dispatcherOrigin,
      label: params.label,
      model: params.model,
      thinking: params.thinking,
      cleanup: params.cleanup,
    };

    const addOpts: Record<string, unknown> = {};
    if (params.runId) {
      // Phase 1: use runId as BullMQ jobId for idempotent tracking
      addOpts.jobId = params.runId;
    }

    const job = await queue.add("agent-run", jobData, addOpts);
    const jobId = job.id!;

    // Update job data with actual BullMQ jobId
    if (!params.runId) {
      await job.updateData({ ...jobData, jobId });
    }

    // Write to Redis job index for O(1) lookups
    await this.indexJob(jobId, queue.name);

    this.logger.info(`job-tracker: created job ${jobId} for ${params.target}`);
    return jobId;
  }

  // ---------------------------------------------------------------------------
  // Redis job index — O(1) jobId → queueName lookup
  // ---------------------------------------------------------------------------

  private static readonly JOB_INDEX_KEY = "bull:job-index";

  private async indexJob(jobId: string, queueName: string): Promise<void> {
    try {
      await this.connection.hset(JobTracker.JOB_INDEX_KEY, jobId, queueName);
    } catch (err) {
      this.logger.warn(`job-tracker: failed to index job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Look up the queue name for a given jobId using the Redis index.
   * Returns null if not found.
   */
  async findQueueForJob(jobId: string): Promise<string | null> {
    try {
      const queueName = await this.connection.hget(JobTracker.JOB_INDEX_KEY, jobId);
      return queueName ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get the Queue instance for a given queue name, creating it if needed.
   * Exposed for the Worker to resolve queues by name from the index.
   */
  getOrCreateQueue(queueName: string): Queue {
    if (!this.queues.has(queueName)) {
      const queue = new Queue(queueName, {
        connection: asBullMQConnection(this.connection),
        ...createQueueOptions(),
      });
      this.queues.set(queueName, queue);
    }
    return this.queues.get(queueName)!;
  }

  async updateJobStatus(
    runId: string,
    status: AgentJob["status"],
    extras?: {
      startedAt?: number;
      completedAt?: number;
      error?: string;
      result?: string;
    },
  ): Promise<void> {
    // Try index-based lookup first
    const queueName = await this.findQueueForJob(runId);
    if (queueName) {
      const queue = this.getOrCreateQueue(queueName);
      try {
        const job = await queue.getJob(runId);
        if (job) {
          await job.updateData({ ...job.data, status, ...extras });
          this.logger.info(`job-tracker: updated job ${runId} status to ${status}`);
          return;
        }
      } catch (err) {
        this.logger.warn(`job-tracker: index hit but getJob failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Fallback: scan all known queues
    for (const queue of this.queues.values()) {
      try {
        const job = await queue.getJob(runId);
        if (job) {
          await job.updateData({ ...job.data, status, ...extras });
          // Repair index
          await this.indexJob(runId, queue.name);
          this.logger.info(`job-tracker: updated job ${runId} status to ${status} (repaired index)`);
          return;
        }
      } catch {
        continue;
      }
    }

    this.logger.warn(`job-tracker: job ${runId} not found in any queue`);
  }

  async findJobByRunId(runId: string): Promise<AgentJob | null> {
    // Try index-based lookup first
    const queueName = await this.findQueueForJob(runId);
    if (queueName) {
      const queue = this.getOrCreateQueue(queueName);
      try {
        const job = await queue.getJob(runId);
        if (job) {
          return job.data as AgentJob;
        }
      } catch {
        // Fall through to scan
      }
    }

    // Fallback: scan all known queues
    for (const queue of this.queues.values()) {
      try {
        const job = await queue.getJob(runId);
        if (job) {
          // Repair index
          await this.indexJob(runId, queue.name);
          return job.data as AgentJob;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  async getQueueStats(agentId?: string): Promise<Record<string, any>> {
    const stats: Record<string, any> = {};

    const queuesToCheck = agentId
      ? [this.getQueueForAgent(agentId)]
      : Array.from(this.queues.values());

    for (const queue of queuesToCheck) {
      const counts = await queue.getJobCounts(
        "wait",
        "active",
        "completed",
        "failed",
        "delayed",
        "paused",
      );

      stats[queue.name] = counts;
    }

    return stats;
  }

  async close(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();
    this.logger.info("job-tracker: closed all queues");
  }
}
