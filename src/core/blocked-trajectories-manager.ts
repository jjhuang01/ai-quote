import type { BlockedTrajectory, QuotaBlockType } from './contracts';

export class BlockedTrajectoriesManager {
  private blocked = new Map<string, BlockedTrajectory>();

  /**
   * Add a blocked trajectory
   */
  add(trajectory: BlockedTrajectory): void {
    this.blocked.set(trajectory.trajectoryId, trajectory);
  }

  /**
   * Remove a blocked trajectory
   */
  remove(trajectoryId: string): void {
    this.blocked.delete(trajectoryId);
  }

  /**
   * Get a blocked trajectory by ID
   */
  get(trajectoryId: string): BlockedTrajectory | undefined {
    return this.blocked.get(trajectoryId);
  }

  /**
   * Get all blocked trajectories
   */
  getAll(): BlockedTrajectory[] {
    return Array.from(this.blocked.values());
  }

  /**
   * Get trajectories by blocker type
   */
  getByBlockerType(blockerType: QuotaBlockType): BlockedTrajectory[] {
    return this.getAll().filter(t => t.blockerType === blockerType);
  }

  /**
   * Update wake status
   */
  updateWakeStatus(trajectoryId: string, status: BlockedTrajectory['wakeStatus'], error?: string): void {
    const trajectory = this.blocked.get(trajectoryId);
    if (trajectory) {
      trajectory.wakeStatus = status;
      trajectory.wakeAttemptedAt = new Date().toISOString();
      if (error) {
        trajectory.wakeError = error;
      }
    }
  }

  /**
   * Clear all blocked trajectories
   */
  clear(): void {
    this.blocked.clear();
  }

  /**
   * Get count of blocked trajectories
   */
  count(): number {
    return this.blocked.size;
  }
}
