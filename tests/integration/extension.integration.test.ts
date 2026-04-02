import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';

suite('AI Echo Rebuild Integration', () => {
  test('commands are contributed', async () => {
    const extension = vscode.extensions.getExtension('local-rebuild.ai-echo-rebuild');
    assert.ok(extension, 'Extension should be discoverable by identifier.');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('infiniteDialog.openPanel'));
    assert.ok(commands.includes('infiniteDialog.refresh'));
    assert.ok(commands.includes('infiniteDialog.testFeedback'));
    assert.ok(commands.includes('infiniteDialog.showStatus'));
  });
});
