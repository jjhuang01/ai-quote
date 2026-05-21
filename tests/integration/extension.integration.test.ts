import { suite, test } from 'mocha';
import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Windsurf Quote Integration', () => {
  test('commands are contributed', async () => {
    const extension = vscode.extensions.getExtension('opensource.windsurf-quote');
    assert.ok(extension, 'Extension should be discoverable by identifier.');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('quote.openPanel'));
    assert.ok(commands.includes('quote.refresh'));
    assert.ok(commands.includes('quote.testFeedback'));
    assert.ok(commands.includes('quote.showStatus'));
  });
});
