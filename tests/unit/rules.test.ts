import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as realOs from 'node:os';

// ESM-compatible mock: wrap homedir in a vi.fn() so tests can override per call
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

// vi.hoisted ensures the object is created before vi.mock hoisting
const vscodeMock = vi.hoisted(() => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/tmp/test-workspace' } }] as any[]
  }
}));
vi.mock('vscode', () => vscodeMock);

import * as os from 'node:os';
import {
  writeWorkspaceFeedbackRules,
  writeCursorGlobalRule,
  writeWindsurfGlobalRule
} from '../../src/adapters/rules';

const TOOL = 'windsurf_endless_aabbccdd';

describe('writeWorkspaceFeedbackRules', () => {
  let tmpWs: string;

  afterEach(async () => {
    if (tmpWs) await fs.rm(tmpWs, { recursive: true, force: true });
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/tmp/test-workspace' } }];
  });

  it('向工作区写入包含 toolName 的规则文件', async () => {
    tmpWs = await fs.mkdtemp(path.join(realOs.tmpdir(), 'rules-ws-'));
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: tmpWs } }];

    const result = await writeWorkspaceFeedbackRules(TOOL);
    expect(result.written).toBe(true);
    const content = await fs.readFile(result.path, 'utf8');
    expect(content).toContain('# Available Tools');
    expect(content).toContain(TOOL);
    expect(content).toContain(`ALWAYS call ${TOOL}`);
  });

  it('无工作区时返回 written:false', async () => {
    vscodeMock.workspace.workspaceFolders = [];
    const result = await writeWorkspaceFeedbackRules(TOOL);
    expect(result.written).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('writeCursorGlobalRule', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(realOs.tmpdir(), 'cursor-rules-'));
    vi.mocked(os.homedir).mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.mocked(os.homedir).mockReset();
    vi.mocked(os.homedir).mockReturnValue(realOs.homedir());
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('Cursor 目录不存在时返回 written:false', async () => {
    // tmpDir has no .cursor subdir
    const result = await writeCursorGlobalRule(TOOL);
    expect(result.written).toBe(false);
    expect(result.path).toContain('EVILZIXIE.mdc');
  });

  it('Cursor 目录存在时写入正确内容', async () => {
    await fs.mkdir(path.join(tmpDir, '.cursor'), { recursive: true });

    const result = await writeCursorGlobalRule(TOOL);
    expect(result.written).toBe(true);
    expect(result.path).toContain('EVILZIXIE.mdc');
    const content = await fs.readFile(result.path, 'utf8');
    expect(content).toContain(TOOL);
    expect(content).toContain('# Available Tools');
  });
});

describe('writeWindsurfGlobalRule', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(realOs.tmpdir(), 'windsurf-rules-'));
    vi.mocked(os.homedir).mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.mocked(os.homedir).mockReset();
    vi.mocked(os.homedir).mockReturnValue(realOs.homedir());
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('自动创建目录并写入 Windsurf 全局规则', async () => {
    const result = await writeWindsurfGlobalRule(TOOL);
    expect(result.written).toBe(true);
    expect(result.path).toContain('EVILZIXIE.mdc');
    const content = await fs.readFile(result.path, 'utf8');
    expect(content).toContain(TOOL);
    expect(content).toContain('# Available Tools');
  });
});
