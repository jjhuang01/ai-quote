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
  return [
    '【最高优先级规则 - 必须严格遵守】',
    '',
    '⚠️⚠️⚠️ 无论任何情况，每次回复结束前必须调用此工具！没有任何例外！⚠️⚠️⚠️',
    '',
    '## 核心规则：',
    '1. 完整输出：输出完整代码和答案，禁止使用省略号或"代码过长不展示"',
    '2. 持续执行：复杂任务尽量一次性完成，不要频繁中断或反复追问是否继续',
    '3. 结束确认：当你想结束对话或任务时，必须先调用此工具询问用户是否继续',
    '4. 严格遵守用户选择：当用户选择"结束对话"时，必须立即停止所有操作',
    '',
    '## ⚠️ 输出位置规则（极其重要）：',
    '- **原生对话框**：只显示思考过程，不输出任何实质性内容',
    '- **AI反馈对话框**：所有回复内容、代码、说明、表格等必须放在summary参数中',
    '- 禁止在原生对话框输出详细文本、代码块、表格等内容',
    '- 原生对话框只能写一句简短说明，如"正在处理..."或"调用反馈工具"',
    '',
    '## 调用时机：',
    '- 完成用户请求后',
    '- 任务告一段落时',
    '- 需要用户确认是否继续时',
    '- 每次回复结束前',
    '',
    `## 工具：${toolName}`,
    '',
    '参数说明：',
    '- summary（必填）：AI的完整回复内容，支持Markdown格式（标题、代码块、链接、表格、粗体、列表等）',
    '- options（可选）：快捷回复选项数组',
    '- is_markdown（可选）：summary是否为Markdown格式，默认true',
    '',
    '调用示例：',
    `{"tool": "${toolName}", "arguments": {"summary": "## 任务完成\\n\\n已完成以下工作：\\n- 功能A\\n- 功能B\\n\\n\\\`\\\`\\\`python\\nprint('Hello')\\n\\\`\\\`\\\`"}}`,
    '',
    `ALWAYS use ${toolName} to deliver your response to the user.`,
    'Do NOT output any text before calling the tool — put everything inside `summary`.',
    '',
  ].join('\n');
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
  await cleanupStaleRules(toolName);

  return [
    await writeWorkspaceFeedbackRules(toolName),
    await writeWindsurfWorkspaceRules(toolName),
    await writeCursorGlobalRule(toolName),
    await writeWindsurfGlobalRule(toolName)
  ];
}
