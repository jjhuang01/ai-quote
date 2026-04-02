import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeedbackItem } from './contracts';
import type { LoggerLike } from './logger';

export class FeedbackManager {
  private readonly feedbackFile: string;
  private items: FeedbackItem[] = [];
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

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.feedbackFile, 'utf8');
      const data = JSON.parse(raw) as { items: FeedbackItem[] };
      this.items = data.items ?? [];
    } catch {
      this.items = [];
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.feedbackFile), { recursive: true });
    await fs.writeFile(this.feedbackFile, JSON.stringify({ items: this.items }, null, 2), 'utf8');
  }

  private generateId(): string {
    return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
