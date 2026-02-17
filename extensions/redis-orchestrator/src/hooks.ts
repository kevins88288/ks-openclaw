/**
 * Plugin Hooks for Redis Orchestrator
 * 
 * Hook into sessions_spawn (after_tool_call) and agent_end to track job lifecycle
 */

import type {
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
  PluginHookAgentEndEvent,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk";
import type { JobTracker } from './job-tracker.js';
import type { QueueCircuitBreaker } from './circuit-breaker.js';
import type { PluginLogger } from "openclaw/plugin-sdk";

export function createAfterToolCallHook(
  jobTracker: JobTracker | null,
  circuitBreaker: QueueCircuitBreaker | null,
  logger: PluginLogger,
) {
  return async (
    event: PluginHookAfterToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<void> => {
    // Only track sessions_spawn calls
    if (event.toolName !== 'sessions_spawn') {
      return;
    }
    
    // If Redis is down or not initialized, circuit breaker will handle it
    if (!jobTracker || !circuitBreaker) {
      return;
    }
    
    try {
      const params = event.params as any;
      const result = event.result as any;
      
      // Extract spawn details from the tool call
      const task = params.task;
      const targetAgent = params.agentId || ctx.agentId || 'unknown';
      const runId = result?.runId;
      const sessionKey = result?.childSessionKey;
      
      if (!runId || !sessionKey) {
        logger.warn('redis-orchestrator: sessions_spawn missing runId or sessionKey');
        return;
      }
      
      // Create BullMQ job to track this spawn
      await circuitBreaker.dispatch(
        async () => {
          await jobTracker!.createJob({
            target: targetAgent,
            task,
            dispatchedBy: ctx.agentId || 'unknown',
            runId,
            sessionKey,
            project: params.project,
            timeoutMs: params.runTimeoutSeconds ? params.runTimeoutSeconds * 1000 : undefined,
          });
        },
        async () => {
          // Fallback: just log, don't create job
          logger.warn(`redis-orchestrator: circuit breaker open, skipping job creation for ${runId}`);
        },
      );
      
    } catch (err) {
      logger.warn(`redis-orchestrator: after_tool_call hook error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export function createAgentEndHook(
  jobTracker: JobTracker | null,
  circuitBreaker: QueueCircuitBreaker | null,
  logger: PluginLogger,
) {
  return async (
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> => {
    if (!jobTracker || !circuitBreaker) {
      return;
    }
    
    try {
      // We need to find the runId for this session
      // In Phase 1, we'll rely on the sessionKey being tracked
      // The runId should be available from the session context
      
      // For now, we'll extract from session key if it's a subagent session
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        return;
      }
      
      // Subagent sessions have format: agent:{agentId}:subagent:{uuid}
      // The uuid is the runId
      const match = sessionKey.match(/agent:[^:]+:subagent:([^:]+)/);
      if (!match) {
        // Not a subagent session, nothing to track
        return;
      }
      
      const runId = match[1];
      
      await circuitBreaker.dispatch(
        async () => {
          // Update job status to 'announcing'
          await jobTracker!.updateJobStatus(runId, 'announcing', {
            startedAt: Date.now(),
          });
          
          // Note: We don't mark as 'completed' here because completion means
          // "result delivered to dispatcher" not "agent finished"
          // The announce flow completion will update to 'completed'
          
          logger.info(`redis-orchestrator: agent ${ctx.agentId} ended, job ${runId} status -> announcing`);
        },
        async () => {
          logger.warn(`redis-orchestrator: circuit breaker open, skipping status update for ${runId}`);
        },
      );
      
    } catch (err) {
      logger.warn(`redis-orchestrator: agent_end hook error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export function createSessionsSendRetryHook(
  jobTracker: JobTracker | null,
  circuitBreaker: QueueCircuitBreaker | null,
  logger: PluginLogger,
) {
  return async (
    event: PluginHookAfterToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<void> => {
    // Track sessions_send failures for retry
    if (event.toolName !== 'sessions_send') {
      return;
    }
    
    if (!jobTracker || !circuitBreaker) {
      return;
    }
    
    try {
      const result = event.result as any;
      
      // If the send failed, we could queue a retry here
      // For Phase 1, we'll just log failures
      if (result?.status === 'error' || result?.status === 'timeout') {
        logger.warn(`redis-orchestrator: sessions_send failed: ${result.error || 'timeout'}`);
        // TODO Phase 1: Queue retry via BullMQ
      }
      
    } catch (err) {
      logger.warn(`redis-orchestrator: sessions_send hook error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
