/**
 * Plugin Hooks for Redis Orchestrator
 * 
 * Hook into sessions_spawn (after_tool_call) and agent_end to track job lifecycle.
 * All hooks receive a shared PluginState object and read instances at call time,
 * avoiding the null-capture bug with JS closures.
 */

import type {
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
  PluginHookAgentEndEvent,
  PluginHookAgentContext,
  PluginLogger,
} from "openclaw/plugin-sdk";
import type { PluginState } from '../index.js';

export function createAfterToolCallHook(
  state: PluginState,
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
    
    // Read from shared state at call time (not registration time)
    if (!state.jobTracker || !state.circuitBreaker) {
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
      await state.circuitBreaker.dispatch(
        async () => {
          await state.jobTracker!.createJob({
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
  state: PluginState,
  logger: PluginLogger,
) {
  return async (
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> => {
    if (!state.jobTracker || !state.circuitBreaker) {
      return;
    }
    
    try {
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

      // Phase 2: Determine final status based on agent_end event
      const finalStatus = event.success ? 'completed' as const : 'failed' as const;
      const extras: {
        completedAt: number;
        error?: string;
        startedAt?: number;
      } = {
        completedAt: Date.now(),
      };

      if (!event.success && event.error) {
        extras.error = event.error;
      }
      
      await state.circuitBreaker.dispatch(
        async () => {
          await state.jobTracker!.updateJobStatus(runId, finalStatus, extras);
          
          logger.info(
            `redis-orchestrator: agent ${ctx.agentId} ended (${finalStatus}), job ${runId} status updated`,
          );
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
  state: PluginState,
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
    
    if (!state.jobTracker || !state.circuitBreaker) {
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
