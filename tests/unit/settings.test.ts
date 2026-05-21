import * as fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const watcherHandlers = vi.hoisted(() => ({
  change: undefined as undefined | (() => void),
  create: undefined as undefined | (() => void),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  copyFile: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('vscode', () => ({
  default: {},
  workspace: {
    createFileSystemWatcher: vi.fn(() => ({
      onDidChange: vi.fn((cb: () => void) => {
        watcherHandlers.change = cb;
        return { dispose: vi.fn() };
      }),
      onDidCreate: vi.fn((cb: () => void) => {
        watcherHandlers.create = cb;
        return { dispose: vi.fn() };
      }),
      dispose: vi.fn(),
    })),
  },
  RelativePattern: class {
    constructor(public base: string, public pattern: string) {}
  },
  EventEmitter: class<T = void> {
    private listeners: Array<(value: T) => void> = [];
    event = (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
    fire(value: T): void { this.listeners.forEach((listener) => listener(value)); }
    dispose(): void { this.listeners = []; }
  },
}));

import { SettingsManager } from '../../src/core/settings';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const context = {
  globalStorageUri: { fsPath: '/tmp/test-storage' },
} as any;

describe('SettingsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    watcherHandlers.change = undefined;
    watcherHandlers.create = undefined;
    (fs.readFile as any).mockRejectedValue(new Error('ENOENT'));
  });

  it('reloads settings from disk and notifies listeners for multi-window sync', async () => {
    const manager = new SettingsManager(context, logger as any) as any;
    const listener = vi.fn();
    manager.onDidChangeSettings(listener);
    await manager.initialize();

    (fs.readFile as any).mockResolvedValueOnce(JSON.stringify({ quotaAutoContinueEnabled: true }));
    const changed = await manager.reloadFromDisk();

    expect(changed).toBe(true);
    expect(manager.get().quotaAutoContinueEnabled).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('watches settings.json changes from other windows', async () => {
    const manager = new SettingsManager(context, logger as any) as any;
    const listener = vi.fn();
    manager.onDidChangeSettings(listener);
    await manager.initialize();
    manager.startWatching();

    (fs.readFile as any).mockResolvedValueOnce(JSON.stringify({ quotaAutoContinueEnabled: true }));
    watcherHandlers.change?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.get().quotaAutoContinueEnabled).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
