import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export function generateToolName(): string {
  return `windsurf_endless_${randomBytes(4).toString('hex')}`;
}

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

const TOOL_NAME_FILE = 'toolName.txt';

export async function loadOrCreateToolName(globalStoragePath: string): Promise<string> {
  const filePath = path.join(globalStoragePath, TOOL_NAME_FILE);
  try {
    const stored = (await fs.readFile(filePath, 'utf8')).trim();
    if (stored && stored.startsWith('windsurf_endless_')) {
      return stored;
    }
  } catch {
    // file not found or unreadable → generate new
  }
  const name = generateToolName();
  await saveToolName(globalStoragePath, name);
  return name;
}

export async function rotateToolName(globalStoragePath: string): Promise<string> {
  const name = generateToolName();
  await saveToolName(globalStoragePath, name);
  return name;
}

async function saveToolName(globalStoragePath: string, name: string): Promise<void> {
  await fs.mkdir(globalStoragePath, { recursive: true });
  await fs.writeFile(path.join(globalStoragePath, TOOL_NAME_FILE), name, 'utf8');
}
