import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PluginSettings } from './contracts';
import { DEFAULT_SETTINGS } from './contracts';
import type { LoggerLike } from './logger';

export class SettingsManager {
  private readonly settingsFile: string;
  private settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private readonly logger: LoggerLike;

  public constructor(context: vscode.ExtensionContext, logger: LoggerLike) {
    this.settingsFile = path.join(context.globalStorageUri.fsPath, 'settings.json');
    this.logger = logger;
  }

  public async initialize(): Promise<void> {
    await this.load();
  }

  public get(): PluginSettings {
    return { ...this.settings };
  }

  public async update(partial: Partial<PluginSettings>): Promise<PluginSettings> {
    this.settings = { ...this.settings, ...partial };
    await this.save();
    this.logger.info('Settings updated.', { keys: Object.keys(partial) });
    return this.get();
  }

  public async reset(): Promise<PluginSettings> {
    this.settings = { ...DEFAULT_SETTINGS };
    await this.save();
    this.logger.info('Settings reset to defaults.');
    return this.get();
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.settingsFile, 'utf8');
      const data = JSON.parse(raw) as Partial<PluginSettings>;
      this.settings = { ...DEFAULT_SETTINGS, ...data };
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await fs.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf8');
  }
}
