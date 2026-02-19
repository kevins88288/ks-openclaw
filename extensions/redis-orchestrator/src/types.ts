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

  // Job completion storage (Phase 3.5 Batch 2)
  storeResult?: boolean;       // if true, capture agent's final message in job record after completion

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

/**
 * Approval record stored in Redis for human-gated dispatches.
 * Phase 3.6 Batch 1.
 *
 * Stored as: orch:approval:{id}  (string JSON, native TTL = 7 days)
 * Indexed in: orch:approvals:pending  (sorted set, score = createdAt)
 *             orch:approvals:project:{project}  (sorted set, if project is set)
 *
 * NOT stored in BullMQ — approval records are human-gated with a 7-day window
 * and have no worker. Using BullMQ for these would misuse its lifecycle mechanisms.
 */
export interface ApprovalRecord {
  id: string; // uuid — used as the jobId returned to callers
  status: "pending" | "approved" | "rejected" | "expired" | "approved_spawn_failed";

  // Original dispatch params (full, not truncated — for spawn context in Batch 2)
  callerAgentId: string;
  callerSessionKey: string;
  target: string;
  task: string; // full task, not truncated
  label?: string;
  project?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
  reason?: string; // why approval is required (human-readable)

  // Timestamps
  createdAt: number;
  approvedAt?: number;
  rejectedAt?: number;
  expiredAt?: number;

  // Discord linkage
  discordMessageId?: string; // message ID in #approval channel (set after send)
  discordChannelId?: string;

  // Spawn result (set in Batch 2 on /approve)
  spawnRunId?: string;
  spawnSessionKey?: string;
}

/**
 * A learning entry stored in the Redis learning index.
 * Phase 3.5 Batch 3.
 */
export interface LearningEntry {
  id: string;
  jobId: string;
  previousJobId?: string;
  projectId: string;
  phase?: string;
  agentId: string;
  learning: string;
  tags: string[];
  timestamp: number;
}
