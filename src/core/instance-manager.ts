import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface CloneInstanceRecord {
  id: string;
  label: string;
  userDataDir: string;
  createdAt: string;
  pid?: number;
  lastStartedAt?: string;
}

export interface CloneRegistry {
  instances: CloneInstanceRecord[];
}

export interface CreateCloneOptions {
  label: string;
}

export interface InstanceManagerOptions {
  executablePath?: string;
}

export class InstanceManager {
  private readonly instancesRoot: string;
  private readonly registryPath: string;

  public constructor(
    private readonly globalStoragePath: string,
    private readonly options: InstanceManagerOptions = {},
  ) {
    this.instancesRoot = path.join(globalStoragePath, 'instances');
    this.registryPath = path.join(this.instancesRoot, 'registry.json');
  }

  public async createClone(options: CreateCloneOptions): Promise<CloneInstanceRecord> {
    const now = new Date().toISOString();
    const id = `quote-clone-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const userDataDir = path.join(this.instancesRoot, id, 'user-data');
    await fs.mkdir(path.join(userDataDir, 'User', 'globalStorage'), { recursive: true });

    const child = spawn(this.resolveExecutablePath(), ['--user-data-dir', userDataDir, '--new-window'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    const record: CloneInstanceRecord = {
      id,
      label: options.label,
      userDataDir,
      createdAt: now,
      pid: child.pid,
      lastStartedAt: now,
    };
    const registry = await this.readRegistry();
    registry.instances.push(record);
    await this.writeRegistry(registry);
    return record;
  }

  private resolveExecutablePath(): string {
    if (this.options.executablePath) {
      return this.options.executablePath;
    }
    return process.execPath || vscode.env.appRoot;
  }

  private async readRegistry(): Promise<CloneRegistry> {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CloneRegistry>;
      return { instances: Array.isArray(parsed.instances) ? parsed.instances : [] };
    } catch {
      return { instances: [] };
    }
  }

  private async writeRegistry(registry: CloneRegistry): Promise<void> {
    await fs.mkdir(this.instancesRoot, { recursive: true });
    await fs.writeFile(this.registryPath, JSON.stringify(registry, null, 2), 'utf8');
  }
}
