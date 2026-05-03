import * as vscode from 'vscode';

export type SwitchWarmupMode = 'off' | 'quota-only';

export interface QuoteConfig {
  serverPort: number;
  autoConfigureMcp: boolean;
  autoConfigureRules: boolean;
  cleanupOnDeactivate: boolean;
  dialogTimeoutSeconds: number;
  switchWarmupMode: SwitchWarmupMode;
}

function normalizeSwitchWarmupMode(value: string | undefined): SwitchWarmupMode {
  return value === 'off' ? 'off' : 'quota-only';
}

export function getSwitchWarmupMode(): SwitchWarmupMode {
  const config = vscode.workspace.getConfiguration('quote');
  return normalizeSwitchWarmupMode(
    config.get<string>('switchWarmupMode', 'quota-only')
  );
}

export function isSwitchWarmupEnabled(mode = getSwitchWarmupMode()): boolean {
  return mode === 'quota-only';
}

export function getSwitchWarmupSuccessMessage(
  email: string,
  mode = getSwitchWarmupMode()
): string {
  return isSwitchWarmupEnabled(mode)
    ? `已切换到 ${email}，正在预热新账号并刷新配额`
    : `已切换到 ${email}`;
}

export function getExtensionConfig(): QuoteConfig {
  const config = vscode.workspace.getConfiguration('quote');
  return {
    serverPort: config.get<number>('serverPort', 3456),
    autoConfigureMcp: config.get<boolean>('autoConfigureMcp', false),
    autoConfigureRules: config.get<boolean>('autoConfigureRules', false),
    cleanupOnDeactivate: config.get<boolean>('cleanupOnDeactivate', false),
    dialogTimeoutSeconds: config.get<number>('dialogTimeoutSeconds', 0),
    switchWarmupMode: getSwitchWarmupMode()
  };
}
