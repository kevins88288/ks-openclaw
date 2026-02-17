/**
 * DLQ Alerting - Send Discord notifications when jobs enter the Dead Letter Queue
 */

import type { Job } from 'bullmq';
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { AgentJob } from './types.js';

export class DLQAlerter {
  constructor(
    private logger: PluginLogger,
  ) {}
  
  async sendAlert(job: Job<AgentJob>, reason: string): Promise<void> {
    const data = job.data;
    
    const message = [
      '🚨 **Agent Job Failed (DLQ)**',
      '',
      `**Job:** ${data.jobId}`,
      `**Agent:** ${data.target}`,
      `**Task:** "${data.task.substring(0, 100)}${data.task.length > 100 ? '...' : ''}"`,
      `**Dispatched by:** ${data.dispatchedBy}`,
      `**Attempts:** ${job.attemptsMade}/${job.opts.attempts}`,
      `**Last error:** ${reason}`,
      '',
      `**Action needed:** Run \`openclaw queue inspect ${data.jobId}\` for details`,
    ].join('\n');
    
    this.logger.error(message);
    
    // TODO: In production, send to Discord via callGateway or direct Discord API
    // For Phase 1, we log to console. Phase 2 will add the actual Discord integration.
    // 
    // Example for Phase 2:
    // await callGateway({
    //   method: 'message.send',
    //   params: {
    //     channel: 'discord',
    //     to: process.env.DISCORD_DLQ_CHANNEL_ID,
    //     content: message,
    //   },
    // });
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
      lines.push(`Result: ${data.result.substring(0, 200)}${data.result.length > 200 ? '...' : ''}`);
    }
    
    return lines.join('\n');
  }
}
