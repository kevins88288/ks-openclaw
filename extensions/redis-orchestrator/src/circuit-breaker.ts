/**
 * Circuit Breaker for Redis Operations
 * 
 * If Redis is down, fall back to existing sessions_spawn (unreliable but available)
 */

import type { PluginLogger } from "openclaw/plugin-sdk";

export interface CircuitBreakerConfig {
  failMax: number;
  resetTimeout: number;
}

export class QueueCircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private config: CircuitBreakerConfig,
    private logger: PluginLogger,
  ) {}
  
  async dispatch<T>(
    fn: () => Promise<T>, 
    fallback: () => Promise<T>,
  ): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.config.resetTimeout) {
        this.state = 'half-open';
        this.logger.info('circuit-breaker: attempting reset (half-open)');
      } else {
        this.logger.warn('circuit-breaker: open, using fallback');
        return fallback(); // Use sessions_spawn directly
      }
    }
    
    try {
      const result = await fn();
      if (this.state === 'half-open') {
        this.logger.info('circuit-breaker: reset successful (closed)');
      }
      this.state = 'closed';
      this.failures = 0;
      return result;
    } catch (err) {
      this.failures++;
      this.lastFailure = Date.now();
      
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`circuit-breaker: failure ${this.failures}/${this.config.failMax}: ${errorMsg}`);
      
      if (this.failures >= this.config.failMax) {
        this.state = 'open';
        this.logger.error('circuit-breaker: opened, falling back to direct dispatch');
      }
      
      return fallback();
    }
  }

  /**
   * Force the circuit breaker into open state.
   * Used by external callers (e.g., Redis auth failure detection) to immediately
   * trip the breaker without waiting for the normal failure threshold.
   */
  forceOpen(reason: string): void {
    if (this.state === 'open') return; // Already open
    this.state = 'open';
    this.lastFailure = Date.now();
    this.failures = this.config.failMax;
    this.logger.error(`circuit-breaker: force-opened: ${reason}`);
  }
  
  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure,
    };
  }
  
  reset() {
    this.state = 'closed';
    this.failures = 0;
    this.lastFailure = 0;
    this.logger.info('circuit-breaker: manual reset');
  }
}
