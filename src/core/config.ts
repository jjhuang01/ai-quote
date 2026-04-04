import * as vscode from 'vscode';

export interface QuoteConfig {
  serverPort: number;
  autoConfigureRules: boolean;
  dialogTimeoutSeconds: number;
}

export function getExtensionConfig(): QuoteConfig {
  const config = vscode.workspace.getConfiguration('quote');
  return {
    serverPort: config.get<number>('serverPort', 3456),
    autoConfigureRules: config.get<boolean>('autoConfigureRules', true),
    dialogTimeoutSeconds: config.get<number>('dialogTimeoutSeconds', 0)
  };
}
