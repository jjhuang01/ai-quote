import * as vscode from 'vscode';
import * as path from 'node:path';
import type { FeedbackItem } from './contracts';
import type { LoggerLike } from './logger';
import { safeWriteJson, safeReadJson } from '../utils/safe-json';

const DEFAULT_LIMIT = 200;

export class FeedbackManager {
  private readonly feedbackFile: string;
  private items: FeedbackItem[] = [];
  private limit = DEFAULT_LIMIT;
  private readonly logger: LoggerLike;

  public constructor(context: vscode.ExtensionContext, logger: LoggerLike) {
    this.feedbackFile = path.join(context.globalStorageUri.fsPath, 'feedback.json');
    this.logger = logger;
  }

  public async initialize(): Promise<void> {
    await this.load();
  }

  public async add(item: Omit<FeedbackItem, 'id' | 'createdAt'>): Promise<FeedbackItem> {
    const newItem: FeedbackItem = {
      ...item,
      id: this.generateId(),
      createdAt: new Date().toISOString()
    };
    this.items.unshift(newItem);
    this.trim();
    await this.save();
    this.logger.info('Feedback added.', { id: newItem.id, rating: newItem.rating });
    return newItem;
  }

  public getAll(): FeedbackItem[] {
    return [...this.items];
  }

  public getByConversation(conversationId: string): FeedbackItem[] {
    return this.items.filter(item => item.conversationId === conversationId);
  }

  public async delete(id: string): Promise<boolean> {
    const index = this.items.findIndex(item => item.id === id);
    if (index === -1) {
      return false;
    }
    this.items.splice(index, 1);
    await this.save();
    return true;
  }

  public async clear(): Promise<void> {
    this.items = [];
    await this.save();
  }

  public getStats(): {
    total: number;
    positive: number;
    negative: number;
    neutral: number;
  } {
    return {
      total: this.items.length,
      positive: this.items.filter(i => i.rating === 'positive').length,
      negative: this.items.filter(i => i.rating === 'negative').length,
      neutral: this.items.filter(i => i.rating === 'neutral').length
    };
  }

  private trim(): void {
    if (this.items.length > this.limit) {
      this.items = this.items.slice(0, this.limit);
    }
  }

  private async load(): Promise<void> {
    const data = await safeReadJson<{ items: FeedbackItem[]; limit?: number }>(this.feedbackFile);
    this.items = data?.items ?? [];
    this.limit = data?.limit ?? DEFAULT_LIMIT;
  }

  private async save(): Promise<void> {
    await safeWriteJson(this.feedbackFile, { items: this.items, limit: this.limit });
  }

  private generateId(): string {
    return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
