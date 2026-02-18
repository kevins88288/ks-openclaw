/**
 * Plugin Hooks for Redis Orchestrator
 * 
 * Hook into sessions_spawn (after_tool_call) and agent_end to track job lifecycle.
 * All hooks receive a shared PluginState object and read instances at call time,
 * avoiding the null-capture bug with JS closures.
 *
 * Phase 3.5 Batch 1: agent_end re-dispatch retry on agent failure, permanent
 * failure notification via callGateway.
 */

import type {
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
  PluginHookAgentEndEvent,
  PluginHookAgentContext,
  PluginLogger,
} from "openclaw/plugin-sdk";
import type { Job } from "bullmq";
import type { PluginState } from '../index.js';
import type { RedisOrchestratorConfig } from './config-schema.js';
// COUPLING: not in plugin-sdk — tracks src/gateway/call.js. File SDK exposure request if this breaks.
import { callGateway } from "../../../src/gateway/call.js";

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
      // Try session key index first (Phase 2 jobs)
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        return;
      }
      
      // Check if this is a subagent session
      const isSubagent = /agent:[^:]+:subagent:/.test(sessionKey);
      if (!isSubagent) {
        return;
      }

      // Phase 2: Determine final status based on agent_end event
      const finalStatus = event.success ? 'completed' as const : 'failed' as const;
      const extras: {
        completedAt: number;
        error?: string;
      } = {
        completedAt: Date.now(),
      };

      if (!event.success && event.error) {
        extras.error = event.error;
      }
      
      await state.circuitBreaker.dispatch(
        async () => {
          // Try session key index (works for Phase 2 Worker-created jobs)
          const updated = await state.jobTracker!.updateJobBySessionKey(
            sessionKey,
            finalStatus,
            extras,
          );
          
          // Fallback: try runId extraction (works for Phase 1 sessions_spawn jobs)
          if (!updated) {
            const match = sessionKey.match(/agent:[^:]+:subagent:([^:]+)/);
            if (match) {
              await state.jobTracker!.updateJobStatus(match[1], finalStatus, extras);
              logger.info(
                `redis-orchestrator: agent ${ctx.agentId} ended (${finalStatus}), job ${match[1]} status updated via runId fallback`,
              );
            }
          } else {
            logger.info(
              `redis-orchestrator: agent ${ctx.agentId} ended (${finalStatus}), job status updated via session index`,
            );
          }

          // Phase 3.5 Batch 2: Result capture — only if storeResult: true on the job
          if (event.success) {
            const resolved = await resolveJobFromSessionKey(state, sessionKey);
            if (resolved && resolved.job.data.storeResult) {
              try {
                const history = await callGateway<{ messages?: Array<{ role: string; content: string }> }>({
                  method: "sessions.history",
                  params: { sessionKey: ctx.sessionKey, limit: 1 },
                  timeoutMs: 10_000,
                });
                const lastMessage = history?.messages?.[0];
                if (lastMessage?.role === "assistant" && lastMessage.content) {
                  const truncated = lastMessage.content.length > 5000
                    ? lastMessage.content.slice(0, 5000)
                    : lastMessage.content;
                  await resolved.job.updateData({ ...resolved.job.data, result: truncated });
                }
              } catch (err) {
                // Best-effort — never block job completion
                logger.warn(`redis-orchestrator: result capture failed for job ${resolved.jobId}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          // Phase 3.5 Batch 1: Agent-level re-dispatch retry on failure
          if (!event.success) {
            await handleAgentFailureRetry(state, logger, sessionKey);
          }
        },
        async () => {
          logger.warn(`redis-orchestrator: circuit breaker open, skipping status update for ${sessionKey}`);
        },
      );
      
    } catch (err) {
      logger.warn(`redis-orchestrator: agent_end hook error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Shared helper: resolve BullMQ Job from session key index
// Used by result capture (Batch 2) and failure retry (Batch 1).
// ---------------------------------------------------------------------------

async function resolveJobFromSessionKey(
  state: PluginState,
  sessionKey: string,
): Promise<{ job: Job; jobId: string; queueName: string } | null> {
  const raw = await state.connection!.hget("bull:session-index", sessionKey);
  if (!raw) return null;
  const { jobId, queueName } = JSON.parse(raw);
  const queue = state.jobTracker!.getOrCreateQueue(queueName);
  const job = await queue.getJob(jobId);
  if (!job) return null;
  return { job, jobId, queueName };
}

/**
 * Phase 3.5 Batch 1: Handle agent-level failure retry.
 *
 * BullMQ's native retry only handles launch failures (processJob() throwing).
 * When the agent itself fails (success: false in agent_end), BullMQ has already
 * marked the job "completed" (child session launched OK). We implement retry by
 * creating a NEW job with incremented retryCount and exponential backoff delay.
 *
 * If no retries remain, sends a permanent failure notification to the dispatcher.
 */
async function handleAgentFailureRetry(
  state: PluginState,
  logger: PluginLogger,
  sessionKey: string,
): Promise<void> {
  try {
    // Resolve the BullMQ job from the session key index (shared helper)
    const resolved = await resolveJobFromSessionKey(state, sessionKey);
    if (!resolved) {
      logger.warn(`redis-orchestrator: retry: no session index entry for ${sessionKey}`);
      return;
    }

    const { job, jobId, queueName } = resolved;

    const config = (state.pluginConfig ?? {}) as RedisOrchestratorConfig;
    const maxAttempts = config.retry?.agentFailureAttempts ?? 3;
    const baseDelay = config.retry?.agentFailureBaseDelayMs ?? 300_000;
    const retryCount = job.data.retryCount ?? 0;

    if (retryCount < maxAttempts - 1) {
      // Retries remain — create a new job with incremented retryCount
      const backoffDelay = baseDelay * Math.pow(2, retryCount);
      const newJob = await queue.add(
        job.name,
        {
          ...job.data,
          retryCount: retryCount + 1,
          originalJobId: job.data.originalJobId ?? job.id,
          // Reset lifecycle fields for the new attempt
          status: "queued" as const,
          startedAt: undefined,
          completedAt: undefined,
          error: undefined,
          result: undefined,
          openclawRunId: undefined,
          openclawSessionKey: undefined,
          retriedByJobId: undefined,
        },
        { delay: backoffDelay },
      );

      // Update the failed job to link forward to the retry
      await job.updateData({
        ...job.data,
        status: "retrying",
        retriedByJobId: newJob.id,
      });

      // Index the new job for O(1) lookup
      if (newJob.id) {
        await state.connection!.hset("bull:job-index", newJob.id, queueName);
      }

      logger.info(
        `redis-orchestrator: retry: re-dispatched job ${jobId} → ${newJob.id} (attempt ${retryCount + 2}/${maxAttempts}, delay ${backoffDelay}ms)`,
      );
    } else {
      // No retries remain — mark as permanently failed
      await job.updateData({
        ...job.data,
        status: "failed_permanent",
      });

      logger.warn(
        `redis-orchestrator: retry: job ${jobId} permanently failed after ${retryCount + 1} of ${maxAttempts} attempts`,
      );

      // Send permanent failure notification (Change 3)
      await sendPermanentFailureNotification(state, logger, job.data, jobId, retryCount, maxAttempts);
    }
  } catch (err) {
    // Never throw from the agent_end handler
    logger.warn(
      `redis-orchestrator: retry handler error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Phase 3.5 Batch 1 Change 3: Send permanent failure notification via callGateway.
 *
 * Uses a sanitized template — never includes raw error content.
 * Only the terminal job in a retry chain sends the notification
 * (intermediate retry jobs have retriedByJobId set).
 */
async function sendPermanentFailureNotification(
  state: PluginState,
  logger: PluginLogger,
  jobData: import('./types.js').AgentJob,
  jobId: string,
  retryCount: number,
  maxAttempts: number,
): Promise<void> {
  // Only the terminal job sends notification — intermediate retries are skipped
  if (jobData.retriedByJobId) {
    return;
  }

  const dispatcherSessionKey = jobData.dispatcherSessionKey;
  if (!dispatcherSessionKey) {
    logger.warn(`redis-orchestrator: no dispatcherSessionKey for permanent failure notification on job ${jobId}`);
    return;
  }

  try {
    await callGateway({
      method: "sessions.send",
      params: {
        sessionKey: dispatcherSessionKey,
        message: `[Queue] Job failed permanently\nJob: ${jobId} | Label: ${jobData.label ?? "unlabeled"} | Target: ${jobData.target}\nAttempts: ${retryCount + 1} of ${maxAttempts}\nRun queue_status({ jobId: "${jobId}" }) for details.`,
      },
      timeoutMs: 10_000,
    });

    logger.info(`redis-orchestrator: sent permanent failure notification for job ${jobId}`);
  } catch (err) {
    // Session may be gone (cleaned up, gateway restart) — log via DLQ alert pattern and continue
    logger.warn(
      `redis-orchestrator: failed to send permanent failure notification for job ${jobId} (dispatcher session may be gone): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
