/**
 * Hook metrics tracking for debugging and iteration
 */
export class HookMetrics {
  private totalCalls = 0;
  private quotaExhaustedDetections = 0;
  private rateLimitShortDetections = 0;
  private rateLimitLongDetections = 0;
  private autoSwitchTriggers = 0;
  private autoSwitchSuccesses = 0;
  private autoSwitchFailures = 0;
  private trajectoryBlocksAdded = 0;
  private errors = 0;

  recordCall(): void {
    this.totalCalls++;
  }

  recordDetection(type: 'quota_exhausted' | 'rate_limited_short' | 'rate_limited_long'): void {
    if (type === 'quota_exhausted') {
      this.quotaExhaustedDetections++;
    } else if (type === 'rate_limited_short') {
      this.rateLimitShortDetections++;
    } else if (type === 'rate_limited_long') {
      this.rateLimitLongDetections++;
    }
  }

  recordAutoSwitchTrigger(): void {
    this.autoSwitchTriggers++;
  }

  recordAutoSwitchSuccess(): void {
    this.autoSwitchSuccesses++;
  }

  recordAutoSwitchFailure(): void {
    this.autoSwitchFailures++;
  }

  recordTrajectoryBlockAdded(): void {
    this.trajectoryBlocksAdded++;
  }

  recordError(): void {
    this.errors++;
  }

  getMetrics(): Record<string, number> {
    return {
      totalCalls: this.totalCalls,
      quotaExhaustedDetections: this.quotaExhaustedDetections,
      rateLimitShortDetections: this.rateLimitShortDetections,
      rateLimitLongDetections: this.rateLimitLongDetections,
      autoSwitchTriggers: this.autoSwitchTriggers,
      autoSwitchSuccesses: this.autoSwitchSuccesses,
      autoSwitchFailures: this.autoSwitchFailures,
      trajectoryBlocksAdded: this.trajectoryBlocksAdded,
      errors: this.errors,
    };
  }

  reset(): void {
    this.totalCalls = 0;
    this.quotaExhaustedDetections = 0;
    this.rateLimitShortDetections = 0;
    this.rateLimitLongDetections = 0;
    this.autoSwitchTriggers = 0;
    this.autoSwitchSuccesses = 0;
    this.autoSwitchFailures = 0;
    this.trajectoryBlocksAdded = 0;
    this.errors = 0;
  }
}

let globalMetrics: HookMetrics | undefined;

export function getGlobalMetrics(): HookMetrics {
  if (!globalMetrics) {
    globalMetrics = new HookMetrics();
  }
  return globalMetrics;
}
