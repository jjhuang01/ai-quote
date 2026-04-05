import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { RuleWriteResult } from '../core/contracts';

/** Known rule directories to scan for stale .mdc files (lazy — must call os.homedir() at runtime). */
function getRuleDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.codeium', 'windsurf', 'rules'),
    path.join(home, '.cursor', 'rules'),
  ];
}

function buildRuleTemplate(toolName: string): string {
  return `# Available Tools

## ${toolName}

Parameters:
- summary (required): Put your COMPLETE response here in Markdown format (supports tables, code blocks, lists)
- reason (optional)

ALWAYS call ${toolName} at the end of EVERY response.

## Format

{"tool": "${toolName}", "arguments": {"summary": "Your full Markdown response here"}}
`;
}

export async function writeWorkspaceFeedbackRules(toolName: string): Promise<RuleWriteResult> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return {
      path: 'AI_FEEDBACK_RULES.md',
      written: false,
      reason: 'No workspace folder is open.'
    };
  }

  const filePath = path.join(workspaceFolder.uri.fsPath, 'AI_FEEDBACK_RULES.md');
  try {
    await fs.writeFile(filePath, buildRuleTemplate(toolName), 'utf8');
    return { path: filePath, written: true };
  } catch (err) {
    return { path: filePath, written: false, reason: String(err) };
  }
}

export async function writeCursorGlobalRule(toolName: string): Promise<RuleWriteResult> {
  const cursorRoot = path.join(os.homedir(), '.cursor');
  const targetPath = path.join(cursorRoot, 'rules', `${toolName}.mdc`);
  try {
    await fs.access(cursorRoot);
  } catch {
    return {
      path: targetPath,
      written: false,
      reason: 'Cursor directory does not exist.'
    };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, buildRuleTemplate(toolName), 'utf8');
  return { path: targetPath, written: true };
}

export async function writeWindsurfGlobalRule(toolName: string): Promise<RuleWriteResult> {
  const windsurfRulesDir = path.join(os.homedir(), '.codeium', 'windsurf', 'rules');
  const targetPath = path.join(windsurfRulesDir, `${toolName}.mdc`);
  try {
    await fs.mkdir(windsurfRulesDir, { recursive: true });
    await fs.writeFile(targetPath, buildRuleTemplate(toolName), 'utf8');
    return { path: targetPath, written: true };
  } catch (err) {
    return {
      path: targetPath,
      written: false,
      reason: String(err)
    };
  }
}

export async function writeWindsurfWorkspaceRules(toolName: string): Promise<RuleWriteResult> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return {
      path: '.windsurfrules',
      written: false,
      reason: 'No workspace folder is open.'
    };
  }

  const filePath = path.join(workspaceFolder.uri.fsPath, '.windsurfrules');
  try {
    await fs.writeFile(filePath, buildRuleTemplate(toolName), 'utf8');
    return { path: filePath, written: true };
  } catch (err) {
    return { path: filePath, written: false, reason: String(err) };
  }
}

/**
 * Remove stale .mdc rule files from global rule directories.
 * Keeps only the current toolName; deletes any other Quote-generated .mdc files
 * (matched by the 4-char_8-hex pattern like "abcd_12345678.mdc").
 */
export async function cleanupStaleRules(currentToolName: string): Promise<string[]> {
  const removed: string[] = [];
  const toolNamePattern = /^[a-z]{4}_[0-9a-f]{8}\.mdc$/;

  for (const dir of getRuleDirs()) {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (!toolNamePattern.test(entry)) continue;
        const name = entry.replace('.mdc', '');
        if (name === currentToolName) continue;
        try {
          await fs.unlink(path.join(dir, entry));
          removed.push(path.join(dir, entry));
        } catch { /* file already gone */ }
      }
    } catch { /* dir doesn't exist */ }
  }
  return removed;
}

export async function configureGlobalRules(toolName: string): Promise<RuleWriteResult[]> {
  return [
    await writeWorkspaceFeedbackRules(toolName),
    await writeWindsurfWorkspaceRules(toolName),
  ];
}
