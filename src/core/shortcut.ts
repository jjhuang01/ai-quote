import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ShortcutItem } from './contracts';
import type { LoggerLike } from './logger';
import { safeWriteJson, safeReadJson } from '../utils/safe-json';

const DEFAULT_LIMIT = 50;

export class ShortcutManager {
  private readonly filePath: string;
  private items: ShortcutItem[] = [];
  private limit = DEFAULT_LIMIT;
  private readonly logger: LoggerLike;

  public constructor(context: vscode.ExtensionContext, logger: LoggerLike) {
    this.filePath = path.join(context.globalStorageUri.fsPath, 'shortcuts.json');
    this.logger = logger;
  }

  public async initialize(): Promise<void> {
    await this.load();
  }

  public getAll(): ShortcutItem[] {
    return [...this.items];
  }

  public async add(content: string): Promise<ShortcutItem> {
    const item: ShortcutItem = {
      id: `sc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      content,
      createdAt: new Date().toISOString()
    };
    this.items.push(item);
    this.trim();
    await this.save();
    this.logger.info('Shortcut added.', { id: item.id });
    return item;
  }

  public async update(id: string, content: string): Promise<boolean> {
    const item = this.items.find(i => i.id === id);
    if (!item) return false;
    item.content = content;
    await this.save();
    return true;
  }

  public async delete(id: string): Promise<boolean> {
    const index = this.items.findIndex(i => i.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    await this.save();
    this.logger.info('Shortcut deleted.', { id });
    return true;
  }

  public async clear(): Promise<void> {
    this.items = [];
    await this.save();
  }

  private trim(): void {
    if (this.items.length > this.limit) {
      this.items = this.items.slice(0, this.limit);
    }
  }

  private async load(): Promise<void> {
    const data = await safeReadJson<{ items: ShortcutItem[]; limit?: number }>(this.filePath);
    this.items = data?.items ?? [];
    this.limit = data?.limit ?? DEFAULT_LIMIT;
  }

  private async save(): Promise<void> {
    await safeWriteJson(this.filePath, { items: this.items, limit: this.limit });
  }
}
