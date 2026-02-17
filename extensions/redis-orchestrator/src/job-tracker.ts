/**
 * Job Tracker - Creates and updates BullMQ jobs for agent runs
 * 
 * Hooks into sessions_spawn and agent_end to track job lifecycle
 */

import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { AgentJob } from './types.js';
import { createQueueOptions, DEFAULT_JOB_TIMEOUT_MS } from './queue-config.js';

export class JobTracker {
  private queues: Map<string, Queue> = new Map();
  private jobIdToRunId: Map<string, string> = new Map();
  private runIdToJobId: Map<string, string> = new Map();
  
  constructor(
    private connection: Redis,
    private logger: PluginLogger,
  ) {}
  
  private getQueueForAgent(agentId: string): Queue {
    const queueName = `agent:${agentId}`;
    
    if (!this.queues.has(queueName)) {
      const queue = new Queue(queueName, {
        connection: this.connection,
        ...createQueueOptions(),
      });
      
      this.queues.set(queueName, queue);
      this.logger.info(`job-tracker: created queue ${queueName}`);
    }
    
    return this.queues.get(queueName)!;
  }
  
  async createJob(params: {
    target: string;
    task: string;
    dispatchedBy: string;
    runId: string;
    sessionKey: string;
    project?: string;
    timeoutMs?: number;
  }): Promise<string> {
    const queue = this.getQueueForAgent(params.target);
    
    const jobData: AgentJob = {
      jobId: params.runId, // Use runId as jobId for idempotency
      target: params.target,
      task: params.task,
      dispatchedBy: params.dispatchedBy,
      project: params.project,
      status: 'queued',
      queuedAt: Date.now(),
      openclawRunId: params.runId,
      openclawSessionKey: params.sessionKey,
      timeoutMs: params.timeoutMs || DEFAULT_JOB_TIMEOUT_MS,
    };
    
    const job = await queue.add('agent-run', jobData, {
      jobId: params.runId, // Use runId as job ID for idempotency
      timeout: jobData.timeoutMs,
    });
    
    this.jobIdToRunId.set(job.id!, params.runId);
    this.runIdToJobId.set(params.runId, job.id!);
    
    this.logger.info(`job-tracker: created job ${job.id} for ${params.target}`);
    return job.id!;
  }
  
  async updateJobStatus(runId: string, status: AgentJob['status'], extras?: {
    startedAt?: number;
    completedAt?: number;
    error?: string;
    result?: string;
  }): Promise<void> {
    const jobId = this.runIdToJobId.get(runId);
    if (!jobId) {
      this.logger.warn(`job-tracker: no job found for runId ${runId}`);
      return;
    }
    
    // Find the queue by iterating through all queues
    // In Phase 1, we track by runId mapping
    for (const queue of this.queues.values()) {
      try {
        const job = await queue.getJob(jobId);
        if (job) {
          const updates: Partial<AgentJob> = {
            status,
            ...extras,
          };
          
          await job.updateData({
            ...job.data,
            ...updates,
          });
          
          this.logger.info(`job-tracker: updated job ${jobId} status to ${status}`);
          
          // If completed or failed, mark the job accordingly in BullMQ
          if (status === 'completed') {
            await job.moveToCompleted(extras?.result || 'completed', job.token || '0', false);
          } else if (status === 'failed') {
            await job.moveToFailed(new Error(extras?.error || 'failed'), job.token || '0', false);
          }
          
          return;
        }
      } catch (err) {
        // Job not in this queue, continue
        continue;
      }
    }
    
    this.logger.warn(`job-tracker: job ${jobId} not found in any queue`);
  }
  
  async findJobByRunId(runId: string): Promise<AgentJob | null> {
    const jobId = this.runIdToJobId.get(runId);
    if (!jobId) {
      return null;
    }
    
    for (const queue of this.queues.values()) {
      try {
        const job = await queue.getJob(jobId);
        if (job) {
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
        'wait', 'active', 'completed', 'failed', 'delayed', 'paused'
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
    this.jobIdToRunId.clear();
    this.runIdToJobId.clear();
    this.logger.info('job-tracker: closed all queues');
  }
}
