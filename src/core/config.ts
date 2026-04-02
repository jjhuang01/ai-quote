import * as vscode from 'vscode';

export interface EchoExtensionConfig {
  serverPort: number;
  autoConfigureRules: boolean;
}

export function getExtensionConfig(): EchoExtensionConfig {
  const config = vscode.workspace.getConfiguration('infiniteDialog');
  return {
    serverPort: config.get<number>('serverPort', 3456),
    autoConfigureRules: config.get<boolean>('autoConfigureRules', true)
  };
}
