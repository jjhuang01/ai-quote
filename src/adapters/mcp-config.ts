import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IdeTarget, McpConfigFile } from '../core/contracts';

export const IDE_TARGETS: IdeTarget[] = [
  {
    id: 'windsurf',
    name: 'Windsurf',
    appNames: ['windsurf'],
    configPath: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    confidence: 'proven'
  },
  {
    id: 'cursor',
    name: 'Cursor',
    appNames: ['cursor'],
    configPath: path.join(os.homedir(), '.cursor', 'mcp.json'),
    confidence: 'proven'
  },
  {
    id: 'kiro',
    name: 'Kiro',
    appNames: ['kiro'],
    configPath: path.join(os.homedir(), '.kiro', 'steering', 'mcp.json'),
    confidence: 'inferred'
  },
  {
    id: 'trae',
    name: 'Trae',
    appNames: ['trae'],
    configPath: path.join(os.homedir(), '.trae', 'mcp.json'),
    confidence: 'proven'
  },
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    appNames: ['visual studio code', 'vscodium', 'code - oss'],
    configPath: path.join(os.homedir(), '.vscode', 'mcp.json'),
    confidence: 'proven'
  }
];

export function detectCurrentIde(): IdeTarget {
  const appName = vscode.env.appName.toLowerCase();
  return IDE_TARGETS.find(target => target.appNames.some(candidate => appName.includes(candidate))) ?? IDE_TARGETS[4];
}

/** 3 days in milliseconds — long enough that no human session should hit it */
const MCP_TIMEOUT_MS = 259_200_000;

export function mergeMcpConfig(existing: McpConfigFile | undefined, toolName: string, url: string): McpConfigFile {
  const next: McpConfigFile = existing ?? { mcpServers: {} };
  next.mcpServers ??= {};
  next.mcpServers[toolName] = { url, timeout: MCP_TIMEOUT_MS };
  return next;
}

/** Remove a tool entry from MCP config (used for cleanup of session-scoped secondary instances). */
export async function removeMcpConfigEntry(target: IdeTarget, toolName: string): Promise<void> {
  try {
    const raw = await fs.readFile(target.configPath, 'utf8');
    const config = JSON.parse(raw) as McpConfigFile;
    if (config.mcpServers?.[toolName]) {
      delete config.mcpServers[toolName];
      await fs.writeFile(target.configPath, JSON.stringify(config, null, 2), 'utf8');
    }
  } catch {
    // Config file doesn't exist or is unreadable — nothing to clean up
  }
}

export async function writeMcpConfig(target: IdeTarget, toolName: string, url: string): Promise<string> {
  await fs.mkdir(path.dirname(target.configPath), { recursive: true });

  let existing: McpConfigFile | undefined;
  try {
    const raw = await fs.readFile(target.configPath, 'utf8');
    existing = JSON.parse(raw) as McpConfigFile;
  } catch {
    existing = { mcpServers: {} };
  }

  // Clean up stale entries from previous tool name rotations
  cleanupStaleMcpEntries(existing, toolName);

  const merged = mergeMcpConfig(existing, toolName, url);
  await fs.writeFile(target.configPath, JSON.stringify(merged, null, 2), 'utf8');
  return target.configPath;
}

/**
 * Remove stale Quote tool entries from MCP config.
 * Matches the 4-char_8-hex pattern (e.g. "abcd_12345678") but keeps the current tool.
 */
function cleanupStaleMcpEntries(config: McpConfigFile, currentToolName: string): void {
  const toolNamePattern = /^[a-z]{4}_[0-9a-f]{8}$/;
  for (const key of Object.keys(config.mcpServers ?? {})) {
    if (toolNamePattern.test(key) && key !== currentToolName) {
      delete config.mcpServers![key];
    }
  }
}

/**
 * Verify our tool entry still exists in the MCP config file.
 * Windsurf's settings UI may overwrite the file and remove our entry.
 * Returns true if the entry was present (or successfully re-written).
 */
export async function ensureMcpConfigEntry(target: IdeTarget, toolName: string, url: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(target.configPath, 'utf8');
    const config = JSON.parse(raw) as McpConfigFile;
    const entry = config.mcpServers?.[toolName];
    if (entry && typeof entry === 'object' && 'url' in entry) {
      return true; // Entry exists
    }
    // Entry missing — re-write
    await writeMcpConfig(target, toolName, url);
    return true;
  } catch {
    return false;
  }
}
