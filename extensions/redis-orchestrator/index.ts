/**
 * Redis Orchestrator Plugin for OpenClaw
 * 
 * Phase 1: Durable job tracking with BullMQ
 * 
 * Adds reliability around existing sessions_spawn/sessions_send by tracking
 * jobs in Redis-backed BullMQ queues. Survives gateway restarts, retries on
 * failure, alerts on DLQ.
 */

import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk";
import { createRedisOrchestratorService } from './src/service.js';
import { registerQueueCommands } from './src/cli-commands.js';
import { 
  createAfterToolCallHook, 
  createAgentEndHook,
  createSessionsSendRetryHook,
} from './src/hooks.js';
import { createRedisConnection } from './src/redis-connection.js';
import { QueueCircuitBreaker } from './src/circuit-breaker.js';
import { JobTracker } from './src/job-tracker.js';
import type Redis from 'ioredis';

const plugin: OpenClawPluginDefinition = {
  id: 'redis-orchestrator',
  name: 'Redis Orchestrator',
  description: 'BullMQ-based orchestration layer for durable agent job tracking',
  version: '1.0.0',
  
  async register(api: OpenClawPluginApi) {
    api.logger.info('redis-orchestrator: registering plugin');
    
    // Register the background service
    api.registerService(createRedisOrchestratorService());
    
    // Shared instances for hooks (initialized by gateway_start hook)
    let connection: Redis | null = null;
    let circuitBreaker: QueueCircuitBreaker | null = null;
    let jobTracker: JobTracker | null = null;
    
    // Register gateway_start hook to initialize shared instances
    api.on('gateway_start', async () => {
      const pluginConfig = api.config.plugins?.['redis-orchestrator'] as any;
      
      if (pluginConfig?.enabled === false) {
        return;
      }
      
      try {
        const redisConfig = {
          host: pluginConfig?.redis?.host || '127.0.0.1',
          port: pluginConfig?.redis?.port || 6379,
          password: pluginConfig?.redis?.password,
        };
        
        const circuitBreakerConfig = {
          failMax: pluginConfig?.circuitBreaker?.failureThreshold || 5,
          resetTimeout: pluginConfig?.circuitBreaker?.resetTimeout || 30000,
        };
        
        // Initialize shared instances for hooks
        connection = createRedisConnection(redisConfig, api.logger);
        
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Redis connection timeout')), 10000);
          connection!.once('ready', () => {
            clearTimeout(timeout);
            resolve();
          });
          connection!.once('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        
        circuitBreaker = new QueueCircuitBreaker(circuitBreakerConfig, api.logger);
        jobTracker = new JobTracker(connection, api.logger);
        
        api.logger.info('redis-orchestrator: shared instances initialized');
      } catch (err) {
        api.logger.warn(`redis-orchestrator: failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    
    // Register gateway_stop hook to cleanup
    api.on('gateway_stop', async () => {
      if (jobTracker) {
        await jobTracker.close();
        jobTracker = null;
      }
      
      if (connection) {
        await connection.quit();
        connection = null;
      }
      
      circuitBreaker = null;
    });
    
    // Register after_tool_call hook to track sessions_spawn
    api.on('after_tool_call', createAfterToolCallHook(
      jobTracker,
      circuitBreaker,
      api.logger,
    ));
    
    // Register agent_end hook to update job status
    api.on('agent_end', createAgentEndHook(
      jobTracker,
      circuitBreaker,
      api.logger,
    ));
    
    // Register sessions_send retry hook
    api.on('after_tool_call', createSessionsSendRetryHook(
      jobTracker,
      circuitBreaker,
      api.logger,
    ));
    
    // Register CLI commands
    api.registerCli((ctx) => {
      if (!connection) {
        // CLI commands need a connection
        // Try to create one for CLI usage
        const pluginConfig = ctx.config.plugins?.['redis-orchestrator'] as any;
        const redisConfig = {
          host: pluginConfig?.redis?.host || '127.0.0.1',
          port: pluginConfig?.redis?.port || 6379,
          password: pluginConfig?.redis?.password,
        };
        
        const tempConnection = createRedisConnection(redisConfig, ctx.logger);
        registerQueueCommands(ctx.program, tempConnection, ctx.logger);
      } else {
        registerQueueCommands(ctx.program, connection, ctx.logger);
      }
    }, {
      commands: ['queue'],
    });
    
    api.logger.info('redis-orchestrator: plugin registered');
  },
};

export default plugin;
