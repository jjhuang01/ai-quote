import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const ALPHA_CHARS = 'abcdefghijklmnopqrstuvwxyz';

function randomAlpha(len: number): string {
  const bytes = randomBytes(len);
  return Array.from(bytes).map(b => ALPHA_CHARS[b % ALPHA_CHARS.length]).join('');
}

// Pattern: 4 random lowercase letters + underscore + 8 hex chars
// e.g. kpzm_a1b2c3d4  — neutral, unrecognizable by detection rules
export function generateToolName(): string {
  return `${randomAlpha(4)}_${randomBytes(4).toString('hex')}`;
}

export function isValidToolName(name: string): boolean {
  return /^[a-z]{4}_[a-f0-9]{8}$/.test(name);
}

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

const TOOL_NAME_FILE = 'toolName.txt';

export async function loadOrCreateToolName(globalStoragePath: string): Promise<string> {
  const filePath = path.join(globalStoragePath, TOOL_NAME_FILE);
  try {
    const stored = (await fs.readFile(filePath, 'utf8')).trim();
    if (stored && isValidToolName(stored)) {
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
