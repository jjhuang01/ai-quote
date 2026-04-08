import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { safeWriteJson, safeReadJson } from '../utils/safe-json';

export interface HistoryItem {
  id: string;
  type: 'conversation' | 'feedback' | 'event';
  title: string;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface HistoryConfig {
  limit: number;
}

const DEFAULT_LIMIT = 100;

export class HistoryManager {
  private readonly historyDir: string;
  private items: HistoryItem[] = [];
  private limit: number;

  public constructor(context: vscode.ExtensionContext) {
    this.historyDir = path.join(context.globalStorageUri.fsPath, 'history');
    this.limit = DEFAULT_LIMIT;
  }

  public async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.historyDir, { recursive: true });
      await this.load();
    } catch {
      this.items = [];
    }
  }

  public setLimit(limit: number): void {
    this.limit = limit;
    this.trim();
  }

  public async add(item: Omit<HistoryItem, 'id' | 'createdAt'>): Promise<HistoryItem> {
    const newItem: HistoryItem = {
      ...item,
      id: this.generateId(),
      createdAt: new Date().toISOString()
    };
    this.items.unshift(newItem);
    this.trim();
    await this.save();
    return newItem;
  }

  public getAll(): HistoryItem[] {
    return [...this.items];
  }

  public getById(id: string): HistoryItem | undefined {
    return this.items.find(item => item.id === id);
  }

  public getByType(type: HistoryItem['type']): HistoryItem[] {
    return this.items.filter(item => item.type === type);
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

  public search(query: string): HistoryItem[] {
    const lowerQuery = query.toLowerCase();
    return this.items.filter(item =>
      item.title.toLowerCase().includes(lowerQuery) ||
      item.content.toLowerCase().includes(lowerQuery)
    );
  }

  private trim(): void {
    if (this.items.length > this.limit) {
      this.items = this.items.slice(0, this.limit);
    }
  }

  private async load(): Promise<void> {
    const filePath = path.join(this.historyDir, 'history.json');
    const data = await safeReadJson<{ items: HistoryItem[]; limit: number }>(filePath);
    this.items = data?.items ?? [];
    this.limit = data?.limit ?? DEFAULT_LIMIT;
  }

  private async save(): Promise<void> {
    const filePath = path.join(this.historyDir, 'history.json');
    await safeWriteJson(filePath, { items: this.items, limit: this.limit });
  }

  private generateId(): string {
    return `hist_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
