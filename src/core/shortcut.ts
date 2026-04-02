import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ShortcutItem } from './contracts';
import type { LoggerLike } from './logger';

export class ShortcutManager {
  private readonly filePath: string;
  private items: ShortcutItem[] = [];
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

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as { items: ShortcutItem[] };
      this.items = data.items ?? [];
    } catch {
      this.items = [];
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify({ items: this.items }, null, 2), 'utf8');
  }
}
