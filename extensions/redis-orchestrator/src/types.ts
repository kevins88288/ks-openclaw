/**
 * Redis Orchestrator Types
 * 
 * Phase 1: Durable job tracking with BullMQ
 */

export type AgentJobStatus = 
  | 'queued' 
  | 'active' 
  | 'announcing' 
  | 'completed' 
  | 'failed' 
  | 'stalled';

export interface AgentJob {
  // Identity
  jobId: string;
  
  // Dispatch
  target: string;                    // Agent ID to execute
  task: string;                      // The instruction/prompt
  dispatchedBy: string;              // Which agent dispatched this
  project?: string;                  // Project/repo context
  
  // Lifecycle
  status: AgentJobStatus;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  
  // Result
  result?: string;                   // Agent output summary
  error?: string;                    // Failure reason
  
  // OpenClaw linkage
  openclawRunId?: string;            // Links to internal run tracking
  openclawSessionKey?: string;       // Child session where work executed
  
  // Config
  timeoutMs?: number;                // Default: 1800000 (30 min)
}

export interface QueueStats {
  pending: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  waiting: number;
}

export interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure: number;
}
