import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { RuleWriteResult } from '../core/contracts';

function buildRuleTemplate(toolName: string): string {
  return `# Available Tools

## ${toolName}

Parameters:
- summary (required): Provide the final markdown response here.

ALWAYS call ${toolName} at the end.

## Format

{
  "tool": "${toolName}",
  "arguments": {
    "summary": "Detailed markdown response here"
  }
}
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
  await fs.writeFile(filePath, buildRuleTemplate(toolName), 'utf8');
  return { path: filePath, written: true };
}

export async function writeCursorGlobalRule(toolName: string): Promise<RuleWriteResult> {
  const cursorRoot = path.join(os.homedir(), '.cursor');
  try {
    await fs.access(cursorRoot);
  } catch {
    return {
      path: path.join(cursorRoot, 'rules', 'EVILZIXIE.mdc'),
      written: false,
      reason: 'Cursor directory does not exist.'
    };
  }

  const targetPath = path.join(cursorRoot, 'rules', 'EVILZIXIE.mdc');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, buildRuleTemplate(toolName), 'utf8');
  return { path: targetPath, written: true };
}

export async function configureGlobalRules(toolName: string): Promise<RuleWriteResult[]> {
  return [await writeWorkspaceFeedbackRules(toolName), await writeCursorGlobalRule(toolName)];
}
