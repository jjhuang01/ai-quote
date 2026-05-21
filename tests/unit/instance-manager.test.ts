import { mkdtemp, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceManager } from '../../src/core/instance-manager';

const spawnMock = vi.hoisted(() => vi.fn(() => ({
  pid: 4321,
  unref: vi.fn(),
})));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('vscode', () => ({
  env: {
    appName: 'Windsurf',
    appRoot: '/Applications/Windsurf.app/Contents/Resources/app',
  },
}));

describe('InstanceManager', () => {
  afterEach(() => {
    spawnMock.mockClear();
  });

  it('creates an isolated clone user data dir and launches a new window without touching the main state database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'quote-instance-manager-'));
    const manager = new InstanceManager(root, {
      executablePath: '/Applications/Windsurf.app/Contents/MacOS/Windsurf',
    });

    const result = await manager.createClone({ label: '分身 1' });

    expect(result.id).toMatch(/^quote-clone-/);
    expect(result.label).toBe('分身 1');
    expect(result.pid).toBe(4321);
    expect(result.userDataDir.startsWith(path.join(root, 'instances'))).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Windsurf.app/Contents/MacOS/Windsurf',
      ['--user-data-dir', result.userDataDir, '--new-window'],
      { detached: true, stdio: 'ignore' },
    );

    const registry = JSON.parse(await readFile(path.join(root, 'instances', 'registry.json'), 'utf8'));
    expect(registry.instances).toHaveLength(1);
    expect(registry.instances[0].id).toBe(result.id);
    expect(registry.instances[0].userDataDir).toBe(result.userDataDir);
  });
});
