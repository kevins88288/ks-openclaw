/**
 * DLQ Alerting - Send Discord notifications when jobs enter the Dead Letter Queue
 *
 * Phase 3 Task 3.5: Content redaction — truncate task, strip base64, redact dispatcherOrigin.
 */

import type { Job } from 'bullmq';
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { AgentJob } from './types.js';

/** Strip base64-encoded content from text (data URIs and standalone base64 blocks) */
function stripBase64(text: string): string {
  // Match data URIs (data:...;base64,...)
  let result = text.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, "[redacted-base64]");
  // Match standalone base64 blocks (40+ chars of base64 alphabet)
  result = result.replace(/[A-Za-z0-9+/=]{40,}/g, "[redacted-base64]");
  return result;
}

/** Sanitize task content for inclusion in alerts: strip base64, then truncate. */
function redactTaskForAlert(task: string, maxLength = 200): string {
  const cleaned = stripBase64(task);
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.substring(0, maxLength - 3) + "...";
}

export class DLQAlerter {
  constructor(
    private logger: PluginLogger,
  ) {}
  
  async sendAlert(job: Job<AgentJob>, reason: string): Promise<void> {
    const data = job.data;

    // Phase 3: Redact task content and strip dispatcherOrigin internals
    const redactedTask = redactTaskForAlert(data.task);
    
    const message = [
      '🚨 **Agent Job Failed (DLQ)**',
      '',
      `**Job:** ${data.jobId}`,
      `**Agent:** ${data.target}`,
      `**Task:** "${redactedTask}"`,
      `**Dispatched by:** ${data.dispatchedBy}`,
      `**Attempts:** ${job.attemptsMade}/${job.opts.attempts}`,
      `**Last error:** ${reason}`,
      '',
      `**Action needed:** Run \`openclaw queue inspect ${data.jobId}\` for details`,
    ].join('\n');
    
    this.logger.error(message);
    
    // TODO: In production, send to Discord via callGateway or direct Discord API
    // For Phase 1, we log to console. Phase 2 will add the actual Discord integration.
  }
  
  formatJobSummary(job: Job<AgentJob>): string {
    const data = job.data;
    const duration = data.completedAt && data.startedAt 
      ? data.completedAt - data.startedAt 
      : undefined;
    
    const lines = [
      `Job ID: ${data.jobId}`,
      `Target: ${data.target}`,
      `Status: ${data.status}`,
      `Dispatched by: ${data.dispatchedBy}`,
      `Queued: ${new Date(data.queuedAt).toISOString()}`,
    ];

    // Phase 3: Redact dispatcherOrigin — these are routing internals
    // (accountId, threadId are NOT included in alert summaries)
    
    if (data.startedAt) {
      lines.push(`Started: ${new Date(data.startedAt).toISOString()}`);
    }
    
    if (data.completedAt) {
      lines.push(`Completed: ${new Date(data.completedAt).toISOString()}`);
    }
    
    if (duration) {
      lines.push(`Duration: ${Math.round(duration / 1000)}s`);
    }
    
    if (data.error) {
      lines.push(`Error: ${data.error}`);
    }
    
    if (data.result) {
      const redactedResult = redactTaskForAlert(data.result, 200);
      lines.push(`Result: ${redactedResult}`);
    }
    
    return lines.join('\n');
  }
}
