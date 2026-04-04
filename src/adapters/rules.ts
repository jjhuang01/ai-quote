import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { RuleWriteResult } from '../core/contracts';

function buildRuleTemplate(toolName: string): string {
  return `# Available Tools

## ${toolName}

Parameters:
- summary (required): Put your COMPLETE response here in Markdown format (supports tables, code blocks, lists)
- options (optional): Array of quick-reply options to present to the user
- is_markdown (optional): Whether summary is Markdown formatted. Defaults to true.

ALWAYS use ${toolName} to deliver your response to the user.
Do NOT output any text before calling the tool — put everything inside \`summary\`.
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

export async function configureGlobalRules(toolName: string): Promise<RuleWriteResult[]> {
  return [
    await writeWorkspaceFeedbackRules(toolName),
    await writeWindsurfWorkspaceRules(toolName),
    await writeCursorGlobalRule(toolName),
    await writeWindsurfGlobalRule(toolName)
  ];
}
