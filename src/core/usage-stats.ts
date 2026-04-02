import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { UsageStats } from './contracts';
import type { LoggerLike } from './logger';

const DEFAULT_STATS: UsageStats = {
  totalConversations: 0,
  continueCount: 0,
  pauseCount: 0,
  endCount: 0,
  dailyAverage: 0,
  continueRate: 0,
  lastResetAt: new Date().toISOString()
};

export class UsageStatsManager {
  private readonly filePath: string;
  private stats: UsageStats = { ...DEFAULT_STATS };
  private readonly logger: LoggerLike;

  public constructor(context: vscode.ExtensionContext, logger: LoggerLike) {
    this.filePath = path.join(context.globalStorageUri.fsPath, 'usage-stats.json');
    this.logger = logger;
  }

  public async initialize(): Promise<void> {
    await this.load();
  }

  public get(): UsageStats {
    return { ...this.stats };
  }

  public async recordConversation(): Promise<void> {
    this.stats.totalConversations += 1;
    this.recalculate();
    await this.save();
  }

  public async recordContinue(): Promise<void> {
    this.stats.continueCount += 1;
    this.recalculate();
    await this.save();
  }

  public async recordPause(): Promise<void> {
    this.stats.pauseCount += 1;
    await this.save();
  }

  public async recordEnd(): Promise<void> {
    this.stats.endCount += 1;
    this.recalculate();
    await this.save();
  }

  public async reset(): Promise<void> {
    this.stats = {
      ...DEFAULT_STATS,
      lastResetAt: new Date().toISOString()
    };
    await this.save();
    this.logger.info('UsageStats reset.');
  }

  private recalculate(): void {
    const total = this.stats.totalConversations;
    if (total > 0) {
      this.stats.continueRate = Math.round((this.stats.continueCount / total) * 100);
    }
    const daysSinceReset = Math.max(1, Math.round(
      (Date.now() - new Date(this.stats.lastResetAt).getTime()) / (1000 * 60 * 60 * 24)
    ));
    this.stats.dailyAverage = Math.round(total / daysSinceReset);
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as Partial<UsageStats>;
      this.stats = { ...DEFAULT_STATS, ...data };
    } catch {
      this.stats = { ...DEFAULT_STATS };
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.stats, null, 2), 'utf8');
  }
}
