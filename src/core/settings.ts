import * as path from 'node:path';
import * as vscode from 'vscode';
import { safeReadJson, safeWriteJson } from '../utils/safe-json';
import type { PluginSettings } from './contracts';
import { DEFAULT_SETTINGS } from './contracts';
import type { LoggerLike } from './logger';

export class SettingsManager {
  private readonly settingsFile: string;
  private settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private readonly logger: LoggerLike;
  private readonly onDidChangeSettingsEmitter = new vscode.EventEmitter<void>();
  private settingsWatcher?: vscode.FileSystemWatcher;
  private watcherDisposables: vscode.Disposable[] = [];

  public readonly onDidChangeSettings = this.onDidChangeSettingsEmitter.event;

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
    const next = this.get();
    this.onDidChangeSettingsEmitter.fire();
    return next;
  }

  public async reset(): Promise<PluginSettings> {
    this.settings = { ...DEFAULT_SETTINGS };
    await this.save();
    this.logger.info('Settings reset to defaults.');
    const next = this.get();
    this.onDidChangeSettingsEmitter.fire();
    return next;
  }

  public async reloadFromDisk(): Promise<boolean> {
    const previous = JSON.stringify(this.settings);
    await this.load();
    const changed = JSON.stringify(this.settings) !== previous;
    if (changed) {
      this.logger.info('Reloaded settings from disk.');
      this.onDidChangeSettingsEmitter.fire();
    }
    return changed;
  }

  public startWatching(): void {
    if (this.settingsWatcher) return;
    const pattern = new vscode.RelativePattern(
      path.dirname(this.settingsFile),
      path.basename(this.settingsFile),
    );
    this.settingsWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const reload = async (): Promise<void> => {
      try {
        await this.reloadFromDisk();
      } catch (error) {
        this.logger.warn('Settings sync reload failed.', { error: String(error) });
      }
    };
    this.watcherDisposables = [
      this.settingsWatcher.onDidChange(() => {
        void reload();
      }),
      this.settingsWatcher.onDidCreate(() => {
        void reload();
      }),
    ];
  }

  public dispose(): void {
    this.watcherDisposables.forEach((disposable) => disposable.dispose());
    this.watcherDisposables = [];
    this.settingsWatcher?.dispose();
    this.settingsWatcher = undefined;
    this.onDidChangeSettingsEmitter.dispose();
  }

  private async load(): Promise<void> {
    const data = await safeReadJson<Partial<PluginSettings>>(this.settingsFile);
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  }

  private async save(): Promise<void> {
    await safeWriteJson(this.settingsFile, this.settings);
  }
}
