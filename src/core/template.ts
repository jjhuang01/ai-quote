import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TemplateItem } from './contracts';
import type { LoggerLike } from './logger';

export class TemplateManager {
  private readonly filePath: string;
  private items: TemplateItem[] = [];
  private readonly logger: LoggerLike;

  public constructor(context: vscode.ExtensionContext, logger: LoggerLike) {
    this.filePath = path.join(context.globalStorageUri.fsPath, 'templates.json');
    this.logger = logger;
  }

  public async initialize(): Promise<void> {
    await this.load();
  }

  public getAll(): TemplateItem[] {
    return [...this.items];
  }

  public getById(id: string): TemplateItem | undefined {
    return this.items.find(i => i.id === id);
  }

  public async add(name: string, content: string): Promise<TemplateItem> {
    const item: TemplateItem = {
      id: `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name,
      content,
      createdAt: new Date().toISOString()
    };
    this.items.push(item);
    await this.save();
    this.logger.info('Template added.', { id: item.id, name });
    return item;
  }

  public async update(id: string, name: string, content: string): Promise<boolean> {
    const item = this.items.find(i => i.id === id);
    if (!item) return false;
    item.name = name;
    item.content = content;
    await this.save();
    return true;
  }

  public async delete(id: string): Promise<boolean> {
    const index = this.items.findIndex(i => i.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    await this.save();
    this.logger.info('Template deleted.', { id });
    return true;
  }

  public async clear(): Promise<void> {
    this.items = [];
    await this.save();
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as { items: TemplateItem[] };
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
