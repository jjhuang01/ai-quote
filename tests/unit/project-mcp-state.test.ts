import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const vscodeMock = {
  workspace: {
    workspaceFile: undefined as { fsPath: string } | undefined,
    workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
  },
  env: { appName: 'Windsurf' },
};

vi.mock('vscode', () => vscodeMock);

let resolveProjectMcpIdentity: typeof import('../../src/utils/project-mcp-state').resolveProjectMcpIdentity;
let initializeProjectMcpState: typeof import('../../src/utils/project-mcp-state').initializeProjectMcpState;
let maintainProjectMcpLease: typeof import('../../src/utils/project-mcp-state').maintainProjectMcpLease;
let releaseProjectMcpLease: typeof import('../../src/utils/project-mcp-state').releaseProjectMcpLease;
let listProjectToolNames: typeof import('../../src/utils/project-mcp-state').listProjectToolNames;
let rotateProjectToolName: typeof import('../../src/utils/project-mcp-state').rotateProjectToolName;

beforeAll(async () => {
  ({
    resolveProjectMcpIdentity,
    initializeProjectMcpState,
    maintainProjectMcpLease,
    releaseProjectMcpLease,
    listProjectToolNames,
    rotateProjectToolName,
  } = await import('../../src/utils/project-mcp-state'));
});

describe('project-mcp-state', () => {
  let tmpDir: string;

  afterEach(async () => {
    vscodeMock.workspace.workspaceFile = undefined;
    vscodeMock.workspace.workspaceFolders = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('workspace file identity is stable and persistent', () => {
    vscodeMock.workspace.workspaceFile = { fsPath: '/tmp/demo/demo.code-workspace' };

    const identity = resolveProjectMcpIdentity();

    expect(identity.persistent).toBe(true);
    expect(identity.id).toMatch(/^workspace:/);
    expect(identity.label).toBe('demo.code-workspace');
  });

  it('single-folder identity is stable and persistent', () => {
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/tmp/demo-project' } }];

    const identity = resolveProjectMcpIdentity();

    expect(identity.persistent).toBe(true);
    expect(identity.id).toMatch(/^folders:/);
    expect(identity.label).toBe('demo-project');
  });

  it('no-workspace identity is non-persistent and unique per call', () => {
    const first = resolveProjectMcpIdentity();
    const second = resolveProjectMcpIdentity();

    expect(first.persistent).toBe(false);
    expect(first.id).toMatch(/^window:anon_/);
    expect(second.id).toMatch(/^window:anon_/);
    expect(second.id).not.toBe(first.id);
  });

  it('reuses stored tool name for the same project and exposes keep list', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-mcp-state-'));
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/tmp/reuse-project' } }];

    const first = await initializeProjectMcpState(tmpDir, 3456);
    const second = await initializeProjectMcpState(tmpDir, 3555);
    const keepToolNames = await listProjectToolNames(tmpDir);

    expect(second.toolName).toBe(first.toolName);
    expect(keepToolNames).toContain(first.toolName);
  });

  it('prevents a second live instance from stealing the lease', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-mcp-state-'));
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/tmp/lease-project' } }];

    const owner = await initializeProjectMcpState(tmpDir, 3456);
    const contender = await initializeProjectMcpState(tmpDir, 3555);

    expect(owner.isOwner).toBe(true);
    expect(contender.isOwner).toBe(false);
    expect(contender.owner?.instanceId).toBe(owner.instanceId);
  });

  it('maintains and releases lease for the owning instance', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-mcp-state-'));
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/tmp/maintain-project' } }];

    const owner = await initializeProjectMcpState(tmpDir, 3456);
    const refreshed = await maintainProjectMcpLease(tmpDir, owner.identity.id, owner.instanceId, 4000);

    expect(refreshed.isOwner).toBe(true);
    expect(refreshed.owner?.port).toBe(4000);

    await releaseProjectMcpLease(tmpDir, owner.identity.id, owner.instanceId);
    const reacquired = await initializeProjectMcpState(tmpDir, 4555);

    expect(reacquired.isOwner).toBe(true);
    expect(reacquired.toolName).toBe(owner.toolName);
  });

  it('rotates tool name only for persistent project identities', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-mcp-state-'));
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/tmp/rotate-project' } }];

    const owner = await initializeProjectMcpState(tmpDir, 3456);
    const rotated = await rotateProjectToolName(tmpDir, owner.identity.id);
    const next = await initializeProjectMcpState(tmpDir, 3555);

    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(owner.toolName);
    expect(next.toolName).toBe(rotated);
  });
});
