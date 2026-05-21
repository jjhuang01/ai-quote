import * as vscode from 'vscode';
import type { DataManager } from './data-manager';
import type { LoggerLike } from './logger';

export class QuotaPoller implements vscode.Disposable {
  private readonly dataManager: DataManager;
  private readonly logger: LoggerLike;
  private readonly onUpdate: () => void;
  
  private timer: NodeJS.Timeout | undefined = undefined;
  private activePromise: Promise<{ success: boolean; error?: string }> | null = null;
  private disposables: vscode.Disposable[] = [];
  
  private readonly pollIntervalMs = 10_000;
  private readonly inactivePollIntervalMs = 60_000;

  constructor(dataManager: DataManager, logger: LoggerLike, onUpdate: () => void) {
    this.dataManager = dataManager;
    this.logger = logger;
    this.onUpdate = onUpdate;

    // Listen to window focus change to immediately trigger a refresh if we refocus
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.logger.debug('Window focused — triggering immediate quota refresh.');
          this.triggerImmediate();
        }
      })
    );
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    this.logger.info('Quota background poller started.');
    this.scheduleNext(this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.logger.info('Quota background poller stopped.');
  }

  public dispose(): void {
    this.stop();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  public triggerImmediate(): void {
    // Prevent re-entry: if a poll is already running, skip
    if (this.activePromise) {
      return;
    }
    // Clear scheduled timer and run poll immediately, then reschedule
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.runPoll();
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.runPoll();
    }, delayMs);
  }

  private async runPoll(): Promise<void> {
    const isFocused = vscode.window.state.focused;
    
    // If not focused, skip the 10s fetch and schedule a longer wait (60s)
    if (!isFocused) {
      this.scheduleNext(this.inactivePollIntervalMs);
      return;
    }

    // Skip if already fetching
    if (this.activePromise || this.dataManager.windsurfAccounts.isQuotaFetching) {
      this.scheduleNext(this.pollIntervalMs);
      return;
    }

    const currentId = this.dataManager.windsurfAccounts.getCurrentAccountId();
    if (!currentId) {
      this.scheduleNext(this.pollIntervalMs);
      return;
    }

    try {
      this.activePromise = this.dataManager.windsurfAccounts.fetchRealQuota(currentId, { mode: 'auto' });
      const result = await this.activePromise;
      
      this.logger.debug('Quota background poll finished.', {
        accountId: currentId,
        success: result.success,
      });

      if (result.success) {
        this.onUpdate();
      }
    } catch (error) {
      this.logger.warn('Quota background poll failed.', {
        accountId: currentId,
        error: String(error),
      });
    } finally {
      this.activePromise = null;
      this.scheduleNext(this.pollIntervalMs);
    }
  }
}
