import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PluginSettings } from './contracts';
import { DEFAULT_SETTINGS } from './contracts';
import type { LoggerLike } from './logger';
import { safeWriteJson, safeReadJson } from '../utils/safe-json';

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
    const data = await safeReadJson<Partial<PluginSettings>>(this.settingsFile);
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  }

  private async save(): Promise<void> {
    await safeWriteJson(this.settingsFile, this.settings);
  }
}
