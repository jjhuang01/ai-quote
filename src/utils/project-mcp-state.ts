import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createId, generateToolName, isValidToolName } from './tool-name';

export interface ProjectMcpIdentity {
  id: string;
  label: string;
  persistent: boolean;
}

export interface ProjectMcpLease {
  instanceId: string;
  port: number;
  heartbeatAt: string;
}

export interface ProjectMcpRecord {
  identity: ProjectMcpIdentity;
  toolName: string;
  createdAt: string;
  updatedAt: string;
  lease?: ProjectMcpLease;
}

interface ProjectMcpStateFile {
  version: 1;
  projects: Record<string, ProjectMcpRecord>;
}

export interface ProjectMcpRuntimeState {
  identity: ProjectMcpIdentity;
  toolName: string;
  instanceId: string;
  isOwner: boolean;
  owner?: ProjectMcpLease;
}

const STATE_FILE = 'project-mcp-state.json';
const LEASE_TTL_MS = 45_000;

function statePath(globalStoragePath: string): string {
  return path.join(globalStoragePath, STATE_FILE);
}

function stableHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function normalizeFsPath(fsPath: string): string {
  return path.resolve(fsPath).normalize();
}

function collectPersistentToolNames(state: ProjectMcpStateFile): string[] {
  return Array.from(new Set(
    Object.values(state.projects)
      .filter((record) => record.identity.persistent && isValidToolName(record.toolName))
      .map((record) => record.toolName),
  ));
}

export function resolveProjectMcpIdentity(): ProjectMcpIdentity {
  const workspaceFile = vscode.workspace.workspaceFile?.fsPath;
  if (workspaceFile) {
    const normalized = normalizeFsPath(workspaceFile);
    return {
      id: `workspace:${stableHash(normalized)}`,
      label: path.basename(normalized),
      persistent: true,
    };
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 0) {
    const normalizedFolders = folders
      .map((folder) => normalizeFsPath(folder.uri.fsPath))
      .sort();
    const label = folders.length === 1
      ? path.basename(normalizedFolders[0])
      : `multi-root-${stableHash(normalizedFolders.join('|')).slice(0, 8)}`;
    return {
      id: `folders:${stableHash(normalizedFolders.join('|'))}`,
      label,
      persistent: true,
    };
  }

  return {
    id: `window:${createId('anon')}`,
    label: 'no-workspace',
    persistent: false,
  };
}

async function readState(globalStoragePath: string): Promise<ProjectMcpStateFile> {
  try {
    const raw = await fs.readFile(statePath(globalStoragePath), 'utf8');
    const parsed = JSON.parse(raw) as ProjectMcpStateFile;
    return parsed.version === 1 && parsed.projects ? parsed : { version: 1, projects: {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

async function writeState(globalStoragePath: string, state: ProjectMcpStateFile): Promise<void> {
  await fs.mkdir(globalStoragePath, { recursive: true });
  const target = statePath(globalStoragePath);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

function isLeaseAlive(lease: ProjectMcpLease | undefined, now = Date.now()): boolean {
  if (!lease) return false;
  const heartbeat = Date.parse(lease.heartbeatAt);
  return Number.isFinite(heartbeat) && now - heartbeat < LEASE_TTL_MS;
}

export async function initializeProjectMcpState(
  globalStoragePath: string,
  port: number,
): Promise<ProjectMcpRuntimeState> {
  const identity = resolveProjectMcpIdentity();
  const instanceId = createId('inst');
  const now = new Date().toISOString();
  const state = await readState(globalStoragePath);
  let record = state.projects[identity.id];

  if (!record || !isValidToolName(record.toolName)) {
    record = {
      identity,
      toolName: generateToolName(),
      createdAt: now,
      updatedAt: now,
    };
  } else {
    record.identity = identity;
    record.updatedAt = now;
  }

  const canOwn = identity.persistent && (!isLeaseAlive(record.lease) || record.lease?.instanceId === instanceId);
  if (canOwn) {
    record.lease = { instanceId, port, heartbeatAt: now };
  }

  state.projects[identity.id] = record;
  await writeState(globalStoragePath, state);

  return {
    identity,
    toolName: record.toolName,
    instanceId,
    isOwner: canOwn,
    owner: record.lease,
  };
}

export async function maintainProjectMcpLease(
  globalStoragePath: string,
  identityId: string,
  instanceId: string,
  port: number,
): Promise<{ isOwner: boolean; owner?: ProjectMcpLease }> {
  const state = await readState(globalStoragePath);
  const record = state.projects[identityId];
  if (!record || !record.identity.persistent) {
    return { isOwner: false, owner: record?.lease };
  }

  const now = new Date().toISOString();
  if (!isLeaseAlive(record.lease) || record.lease?.instanceId === instanceId) {
    record.lease = { instanceId, port, heartbeatAt: now };
    record.updatedAt = now;
    await writeState(globalStoragePath, state);
    return { isOwner: true, owner: record.lease };
  }

  return { isOwner: false, owner: record.lease };
}

export async function rotateProjectToolName(
  globalStoragePath: string,
  identityId: string,
): Promise<string | undefined> {
  const state = await readState(globalStoragePath);
  const record = state.projects[identityId];
  if (!record || !record.identity.persistent) {
    return undefined;
  }

  record.toolName = generateToolName();
  record.updatedAt = new Date().toISOString();
  await writeState(globalStoragePath, state);
  return record.toolName;
}

export async function listProjectToolNames(globalStoragePath: string): Promise<string[]> {
  const state = await readState(globalStoragePath);
  return collectPersistentToolNames(state);
}

export async function releaseProjectMcpLease(
  globalStoragePath: string,
  identityId: string,
  instanceId: string,
): Promise<void> {
  const state = await readState(globalStoragePath);
  const record = state.projects[identityId];
  if (!record || record.lease?.instanceId !== instanceId) {
    return;
  }
  delete record.lease;
  record.updatedAt = new Date().toISOString();
  await writeState(globalStoragePath, state);
}
