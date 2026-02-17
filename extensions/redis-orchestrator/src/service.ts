/**
 * Redis Orchestrator Service
 * 
 * Main service that coordinates job tracking, hooks, and recovery
 */

import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import type Redis from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import { createRedisConnection, closeRedisConnection } from './redis-connection.js';
import { QueueCircuitBreaker } from './circuit-breaker.js';
import { JobTracker } from './job-tracker.js';
import { DLQAlerter } from './dlq-alerting.js';
import { createQueueOptions } from './queue-config.js';

export function createRedisOrchestratorService(): OpenClawPluginService {
  let connection: Redis | null = null;
  let circuitBreaker: QueueCircuitBreaker | null = null;
  let jobTracker: JobTracker | null = null;
  let dlqAlerter: DLQAlerter | null = null;
  let queueEvents: Map<string, QueueEvents> = new Map();
  
  return {
    id: 'redis-orchestrator',
    
    async start(ctx: OpenClawPluginServiceContext) {
      const pluginConfig = ctx.config.plugins?.['redis-orchestrator'] as any;
      
      if (pluginConfig?.enabled === false) {
        ctx.logger.info('redis-orchestrator: disabled by config');
        return;
      }
      
      const redisConfig = {
        host: pluginConfig?.redis?.host || '127.0.0.1',
        port: pluginConfig?.redis?.port || 6379,
        password: pluginConfig?.redis?.password,
      };
      
      const circuitBreakerConfig = {
        failMax: pluginConfig?.circuitBreaker?.failureThreshold || 5,
        resetTimeout: pluginConfig?.circuitBreaker?.resetTimeout || 30000,
      };
      
      try {
        // Initialize Redis connection
        connection = createRedisConnection(redisConfig, ctx.logger);
        
        // Wait for Redis to be ready
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Redis connection timeout'));
          }, 10000);
          
          connection!.once('ready', () => {
            clearTimeout(timeout);
            resolve();
          });
          
          connection!.once('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        
        ctx.logger.info('redis-orchestrator: Redis connection established');
        
        // Initialize components
        circuitBreaker = new QueueCircuitBreaker(circuitBreakerConfig, ctx.logger);
        jobTracker = new JobTracker(connection, ctx.logger);
        dlqAlerter = new DLQAlerter(ctx.logger);
        
        // Set up DLQ event listeners for all agent queues
        await setupDLQListeners(connection, dlqAlerter, ctx, queueEvents);
        
        // Recover interrupted jobs on startup (Task 1.11)
        await recoverInterruptedJobs(connection, jobTracker, ctx);
        
        ctx.logger.info('redis-orchestrator: service started');
        
      } catch (err) {
        ctx.logger.error(`redis-orchestrator: startup failed: ${err instanceof Error ? err.message : String(err)}`);
        // Don't throw - allow OpenClaw to start without the orchestrator
        // Circuit breaker will handle fallback to direct dispatch
      }
    },
    
    async stop(ctx: OpenClawPluginServiceContext) {
      // Close all queue event listeners
      for (const events of queueEvents.values()) {
        await events.close();
      }
      queueEvents.clear();
      
      // Close job tracker (closes all queues)
      if (jobTracker) {
        await jobTracker.close();
        jobTracker = null;
      }
      
      // Close Redis connection
      if (connection) {
        await closeRedisConnection(connection, ctx.logger);
        connection = null;
      }
      
      ctx.logger.info('redis-orchestrator: service stopped');
    },
  };
}

async function setupDLQListeners(
  connection: Redis,
  dlqAlerter: DLQAlerter,
  ctx: OpenClawPluginServiceContext,
  queueEvents: Map<string, QueueEvents>,
): Promise<void> {
  // Listen for failed jobs across all agent queues
  // In Phase 1, we set up listeners for common agents
  const agents = ['jarvis', 'iris', 'groot', 'ultron', 'vision', 'alfred', 'lucius'];
  
  for (const agentId of agents) {
    const queueName = `agent:${agentId}`;
    const events = new QueueEvents(queueName, {
      connection,
      ...createQueueOptions(),
    });
    
    events.on('failed', async ({ jobId, failedReason }) => {
      try {
        // Get the job details
        const queue = new Queue(queueName, {
          connection,
          ...createQueueOptions(),
        });
        
        const job = await queue.getJob(jobId);
        
        if (job && job.attemptsMade >= (job.opts.attempts || 3)) {
          // Job has exhausted all retries - send DLQ alert
          await dlqAlerter.sendAlert(job, failedReason);
        }
        
        await queue.close();
      } catch (err) {
        ctx.logger.warn(`Failed to handle DLQ alert for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    
    queueEvents.set(queueName, events);
  }
  
  ctx.logger.info(`redis-orchestrator: DLQ listeners set up for ${agents.length} agents`);
}

async function recoverInterruptedJobs(
  connection: Redis,
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
        connection,
        ...createQueueOptions(),
      });
      
      const activeJobs = await queue.getJobs(['active']);
      
      for (const job of activeJobs) {
        if (job.data.status === 'announcing') {
          announcingCount++;
          // TODO: Resume announce flow for this job
          // This will be implemented in Phase 1 once we have the announce hook
          ctx.logger.info(`redis-orchestrator: found interrupted announcing job ${job.id}`);
        }
      }
      
      await queue.close();
    }
    
    if (activeCount > 0 || announcingCount > 0) {
      ctx.logger.info(`redis-orchestrator: recovered ${activeCount} active jobs, ${announcingCount} announcing jobs`);
    }
    
  } catch (err) {
    ctx.logger.warn(`redis-orchestrator: recovery check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Export shared instances for hooks to access
export let sharedConnection: Redis | null = null;
export let sharedCircuitBreaker: QueueCircuitBreaker | null = null;
export let sharedJobTracker: JobTracker | null = null;

// These will be set by the plugin's register function
export function setSharedInstances(
  connection: Redis,
  breaker: QueueCircuitBreaker,
  tracker: JobTracker,
): void {
  sharedConnection = connection;
  sharedCircuitBreaker = breaker;
  sharedJobTracker = tracker;
}
