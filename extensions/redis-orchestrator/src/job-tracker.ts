/**
 * Job Tracker - Creates and updates BullMQ jobs for agent runs
 *
 * Hooks into sessions_spawn and agent_end to track job lifecycle.
 * Uses runId as BullMQ jobId for direct lookup — no in-memory maps needed.
 *
 * Phase 3 Task 3.10: FlowProducer dependency chains (parent-child, fail-fast).
 * When `dependsOn` is provided, uses FlowProducer to create dependency-gate
 * children that poll referenced jobs. The parent (dependent job) stays in
 * waiting-children state until all gates complete. If a dependency fails,
 * its gate child fails, and the parent is never processed (fail-fast).
 */

import type { PluginLogger } from "openclaw/plugin-sdk";
import { Queue, FlowProducer, Job } from "bullmq";
import type { AgentJob } from "./types.js";
import { createQueueOptions, DEFAULT_JOB_TIMEOUT_MS } from "./queue-config.js";
import { asBullMQConnection, type RedisConnection } from "./redis-connection.js";

/** Batch size for stale index cleanup to avoid blocking Redis */
const CLEANUP_BATCH_SIZE = 50;
/** Interval for periodic stale index cleanup (1 hour) */
const CLEANUP_INTERVAL_MS = 3_600_000;

export class JobTracker {
  private queues: Map<string, Queue> = new Map();
  private flowProducer: FlowProducer | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private connection: RedisConnection,
    private logger: PluginLogger,
  ) {}

  /**
   * Initialize the job tracker: run initial stale index cleanup and start periodic cleanup.
   */
  async initialize(): Promise<void> {
    await this.cleanupStaleIndexEntries();

    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleIndexEntries().catch((err) => {
        this.logger.warn(
          `job-tracker: periodic cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, CLEANUP_INTERVAL_MS);

    // Don't keep the process alive just for cleanup
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Scan bull:job-index and bull:session-index for entries whose BullMQ jobs
   * no longer exist, and remove them in small batches.
   */
  async cleanupStaleIndexEntries(): Promise<void> {
    let removedJobs = 0;
    let removedSessions = 0;

    try {
      // Clean bull:job-index
      const jobEntries = await this.connection.hgetall(JobTracker.JOB_INDEX_KEY);
      const staleJobKeys: string[] = [];

      for (const [jobId, queueName] of Object.entries(jobEntries)) {
        const queue = this.getOrCreateQueue(queueName);
        try {
          const job = await Job.fromId(queue, jobId);
          if (!job) {
            staleJobKeys.push(jobId);
          }
        } catch {
          // Job.fromId threw — job is gone
          staleJobKeys.push(jobId);
        }

        // Delete in batches to avoid blocking Redis
        if (staleJobKeys.length >= CLEANUP_BATCH_SIZE) {
          await this.connection.hdel(JobTracker.JOB_INDEX_KEY, ...staleJobKeys);
          removedJobs += staleJobKeys.length;
          staleJobKeys.length = 0;
        }
      }

      if (staleJobKeys.length > 0) {
        await this.connection.hdel(JobTracker.JOB_INDEX_KEY, ...staleJobKeys);
        removedJobs += staleJobKeys.length;
      }

      // Clean bull:session-index
      const sessionEntries = await this.connection.hgetall(JobTracker.SESSION_INDEX_KEY);
      const staleSessionKeys: string[] = [];

      for (const [sessionKey, raw] of Object.entries(sessionEntries)) {
        try {
          const { jobId, queueName } = JSON.parse(raw);
          const queue = this.getOrCreateQueue(queueName);
          const job = await Job.fromId(queue, jobId);
          if (!job) {
            staleSessionKeys.push(sessionKey);
          }
        } catch {
          staleSessionKeys.push(sessionKey);
        }

        if (staleSessionKeys.length >= CLEANUP_BATCH_SIZE) {
          await this.connection.hdel(JobTracker.SESSION_INDEX_KEY, ...staleSessionKeys);
          removedSessions += staleSessionKeys.length;
          staleSessionKeys.length = 0;
        }
      }

      if (staleSessionKeys.length > 0) {
        await this.connection.hdel(JobTracker.SESSION_INDEX_KEY, ...staleSessionKeys);
        removedSessions += staleSessionKeys.length;
      }

      if (removedJobs > 0 || removedSessions > 0) {
        this.logger.info(
          `job-tracker: cleaned up ${removedJobs} stale job index entries and ${removedSessions} stale session index entries`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `job-tracker: stale index cleanup error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private getFlowProducer(): FlowProducer {
    if (!this.flowProducer) {
      this.flowProducer = new FlowProducer({
        connection: asBullMQConnection(this.connection),
        prefix: "bull",
      });
    }
    return this.flowProducer;
  }

  private getQueueForAgent(agentId: string): Queue {
    const queueName = `agent-${agentId}`;

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
    dependsOn?: string[];
    systemPromptAddition?: string;
    depth?: number;
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
      dependsOn: params.dependsOn,
      systemPromptAddition: params.systemPromptAddition,
      depth: params.depth,
    };

    const addOpts: Record<string, unknown> = {};
    if (params.runId) {
      // Phase 1: use runId as BullMQ jobId for idempotent tracking
      addOpts.jobId = params.runId;
    }

    // If dependsOn is specified, use FlowProducer for dependency chains
    if (params.dependsOn && params.dependsOn.length > 0) {
      const jobId = await this.createJobWithDependencies(queue, jobData, addOpts, params.dependsOn);
      this.logger.info(`job-tracker: created job ${jobId} for ${params.target} (depends on: ${params.dependsOn.join(", ")})`);
      return jobId;
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

  /**
   * Create a job with dependency chains using BullMQ FlowProducer.
   * Parent-child only (single level), fail-fast policy.
   *
   * The dependent job is the parent in the flow. Each dependency gets a
   * "dependency-gate" child in the `dep-gates` queue. A lightweight worker
   * (see service.ts) processes gate children by polling the referenced
   * dependency job until it completes or fails. If any dependency fails,
   * the gate child throws (fails), and the parent stays unprocessed (fail-fast).
   */
  private async createJobWithDependencies(
    queue: Queue,
    jobData: AgentJob,
    addOpts: Record<string, unknown>,
    dependsOn: string[],
  ): Promise<string> {
    const flowProducer = this.getFlowProducer();

    // Validate all dependency jobs exist before creating the flow
    for (const depJobId of dependsOn) {
      const depQueueName = await this.findQueueForJob(depJobId);
      if (!depQueueName) {
        throw new Error(`Dependency job ${depJobId} not found in any queue`);
      }
    }

    // Create dependency-gate children — each monitors one dependency job
    const children = dependsOn.map((depJobId) => ({
      name: "dependency-gate",
      queueName: "dep-gates",
      data: {
        dependencyJobId: depJobId,
        parentTarget: jobData.target,
      },
    }));

    // FlowProducer: parent (dependent job) waits for all children (gates)
    const flow = await flowProducer.add({
      name: "agent-run",
      queueName: queue.name,
      data: jobData,
      opts: addOpts,
      children,
    });

    const jobId = flow.job.id!;

    // Update job data with actual BullMQ jobId if auto-generated
    if (!addOpts.jobId) {
      const job = await queue.getJob(jobId);
      if (job) {
        await job.updateData({ ...jobData, jobId });
      }
    }

    // Write to Redis job index for O(1) lookups
    await this.indexJob(jobId, queue.name);

    return jobId;
  }

  // ---------------------------------------------------------------------------
  // Redis job index — O(1) jobId → queueName lookup
  // ---------------------------------------------------------------------------

  private static readonly JOB_INDEX_KEY = "bull:job-index";
  private static readonly SESSION_INDEX_KEY = "bull:session-index";

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

  // ---------------------------------------------------------------------------
  // Session key index — O(1) sessionKey → job lookup (Phase 2 Worker-created jobs)
  // ---------------------------------------------------------------------------

  async indexJobBySessionKey(sessionKey: string, jobId: string, queueName: string): Promise<void> {
    try {
      // Store both jobId and queueName so we can look up directly
      await this.connection.hset(
        JobTracker.SESSION_INDEX_KEY,
        sessionKey,
        JSON.stringify({ jobId, queueName }),
      );
    } catch (err) {
      this.logger.warn(
        `job-tracker: failed to index job by session ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async findJobBySessionKey(sessionKey: string): Promise<AgentJob | null> {
    try {
      const raw = await this.connection.hget(JobTracker.SESSION_INDEX_KEY, sessionKey);
      if (!raw) return null;
      const { jobId, queueName } = JSON.parse(raw);
      const queue = this.getOrCreateQueue(queueName);
      const job = await queue.getJob(jobId);
      return job ? (job.data as AgentJob) : null;
    } catch {
      return null;
    }
  }

  async updateJobBySessionKey(
    sessionKey: string,
    status: AgentJob["status"],
    extras?: { completedAt?: number; error?: string; result?: string },
  ): Promise<boolean> {
    try {
      const raw = await this.connection.hget(JobTracker.SESSION_INDEX_KEY, sessionKey);
      if (!raw) {
        this.logger.warn(`job-tracker: no job found for session ${sessionKey}`);
        return false;
      }
      const { jobId, queueName } = JSON.parse(raw);
      const queue = this.getOrCreateQueue(queueName);
      const job = await queue.getJob(jobId);
      if (job) {
        await job.updateData({ ...job.data, status, ...extras });
        this.logger.info(`job-tracker: updated job ${jobId} via session index to ${status}`);
        return true;
      }
      return false;
    } catch (err) {
      this.logger.warn(
        `job-tracker: error updating job by session ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
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
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.flowProducer) {
      await this.flowProducer.close();
      this.flowProducer = null;
    }
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();
    this.logger.info("job-tracker: closed all queues");
  }
}
