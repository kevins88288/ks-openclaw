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
  | 'failed_permanent'
  | 'retrying'
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
  /** Agent lifecycle status (independent of BullMQ job state — see worker.ts header) */
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
  runTimeoutSeconds?: number;        // Timeout in seconds (from tool param)

  // Dispatcher context (Phase 2)
  dispatcherSessionKey?: string;
  dispatcherAgentId?: string;
  dispatcherDepth?: number;
  dispatcherOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };

  // Additional dispatch params
  label?: string;
  model?: string;
  thinking?: string;
  cleanup?: 'delete' | 'keep';
  systemPromptAddition?: string;
  depth?: number;

  // Agent-level retry tracking (Phase 3.5 Batch 1)
  retryCount?: number;         // how many agent-level re-dispatches have occurred (default 0)
  originalJobId?: string;      // links back to the first dispatch in a retry chain
  retriedByJobId?: string;     // links forward to the retry job (if re-dispatched)

  // Dependency chains (Phase 3 Task 3.10)
  dependsOn?: string[];
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
