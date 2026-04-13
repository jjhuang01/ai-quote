import * as vscode from 'vscode';
import type { HistoryItem, QueueItem, AccountInfo, FeedbackItem } from './contracts';
import { HistoryManager } from './history';
import { QueueManager } from './queue';
import { AccountManager } from './account';
import { FeedbackManager } from './feedback';
import { SettingsManager } from './settings';
import { ShortcutManager } from './shortcut';
import { TemplateManager } from './template';
import { UsageStatsManager } from './usage-stats';
import { WindsurfAccountManager } from './windsurf-account';
import type { LoggerLike } from './logger';

export interface SessionHistory {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  messageCount: number;
}

export class DataManager {
  private static instance: DataManager | undefined;

  public readonly history: HistoryManager;
  public readonly queue: QueueManager;
  public readonly account: AccountManager;
  public readonly feedback: FeedbackManager;
  public readonly settings: SettingsManager;
  public readonly shortcuts: ShortcutManager;
  public readonly templates: TemplateManager;
  public readonly usageStats: UsageStatsManager;
  public readonly windsurfAccounts: WindsurfAccountManager;
  public readonly globalStoragePath: string;

  private sessionHistory: SessionHistory[] = [];
  private currentSessionId: string | undefined;
  private statusTTL = 30_000;
  private lastStatusUpdate = 0;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly logger: LoggerLike
  ) {
    this.globalStoragePath = context.globalStorageUri.fsPath;
    this.history = new HistoryManager(context);
    this.queue = new QueueManager(logger);
    this.account = new AccountManager(context, logger);
    this.feedback = new FeedbackManager(context, logger);
    this.settings = new SettingsManager(context, logger);
    this.shortcuts = new ShortcutManager(context, logger);
    this.templates = new TemplateManager(context, logger);
    this.usageStats = new UsageStatsManager(context, logger);
    this.windsurfAccounts = new WindsurfAccountManager(context, logger);
  }

  public static getInstance(context?: vscode.ExtensionContext, logger?: LoggerLike): DataManager {
    if (!DataManager.instance) {
      if (!context || !logger) {
        throw new Error('DataManager must be initialized with context and logger first.');
      }
      DataManager.instance = new DataManager(context, logger);
    }
    return DataManager.instance;
  }

  public static resetInstance(): void {
    DataManager.instance = undefined;
  }

  public async initialize(): Promise<void> {
    await this.history.initialize();
    await this.account.initialize();
    await this.feedback.initialize();
    await this.settings.initialize();
    await this.shortcuts.initialize();
    await this.templates.initialize();
    await this.usageStats.initialize();
    await this.windsurfAccounts.initialize();
    this.windsurfAccounts.startWatching();
    const savedSettings = this.settings.get();
    if (savedSettings.firebaseApiKey) {
      this.windsurfAccounts.setFirebaseApiKey(savedSettings.firebaseApiKey);
    }
    this.startSession();
    this.logger.info('DataManager initialized.');
  }

  public dispose(): void {
    this.windsurfAccounts.dispose();
  }

  public startSession(): void {
    this.currentSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.sessionHistory.push({
      sessionId: this.currentSessionId,
      startedAt: new Date().toISOString(),
      messageCount: 0
    });
    // 限制 sessionHistory 最多 50 条
    if (this.sessionHistory.length > 50) {
      this.sessionHistory = this.sessionHistory.slice(-50);
    }
    this.logger.debug('Session started.', { sessionId: this.currentSessionId });
  }

  public endSession(): void {
    const current = this.sessionHistory.find(s => s.sessionId === this.currentSessionId);
    if (current) {
      current.endedAt = new Date().toISOString();
    }
    this.currentSessionId = undefined;
    this.logger.debug('Session ended.');
  }

  public getSessionHistory(): SessionHistory[] {
    return [...this.sessionHistory];
  }

  public getCurrentSessionId(): string | undefined {
    return this.currentSessionId;
  }

  public incrementSessionMessageCount(): void {
    const current = this.sessionHistory.find(s => s.sessionId === this.currentSessionId);
    if (current) {
      current.messageCount += 1;
    }
  }

  public isStatusStale(): boolean {
    return Date.now() - this.lastStatusUpdate > this.statusTTL;
  }

  public markStatusUpdated(): void {
    this.lastStatusUpdate = Date.now();
  }

  public setStatusTTL(ttl: number): void {
    this.statusTTL = ttl;
  }

  public getStatusTTL(): number {
    return this.statusTTL;
  }

  public getStats(): {
    totalHistory: number;
    totalQueue: number;
    totalAccounts: number;
    totalFeedback: number;
    activeSessions: number;
  } {
    return {
      totalHistory: this.history.getAll().length,
      totalQueue: this.queue.getAll().length,
      totalAccounts: this.account.getAll().length,
      totalFeedback: this.feedback.getAll().length,
      activeSessions: this.sessionHistory.filter(s => !s.endedAt).length
    };
  }

  public paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; total: number; page: number; pageSize: number; totalPages: number } {
    const total = items.length;
    const totalPages = Math.ceil(total / pageSize);
    const safePages = Math.max(0, Math.min(page, totalPages - 1));
    const start = safePages * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      total,
      page: safePages,
      pageSize,
      totalPages
    };
  }
}
