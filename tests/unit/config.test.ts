import { describe, expect, it, vi } from 'vitest';

const values = vi.hoisted(() => new Map<string, unknown>());

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue: T): T => values.has(key) ? values.get(key) as T : defaultValue,
    }),
  },
}));

import { getExtensionConfig } from '../../src/core/config';

describe('getExtensionConfig', () => {
  it('defaults automatic MCP, rules, and deactivate cleanup to disabled', () => {
    values.clear();

    const config = getExtensionConfig();

    expect(config.autoConfigureMcp).toBe(false);
    expect(config.autoConfigureRules).toBe(false);
    expect(config.cleanupOnDeactivate).toBe(false);
  });

  it('reads explicit automatic configuration settings', () => {
    values.clear();
    values.set('autoConfigureMcp', true);
    values.set('autoConfigureRules', true);
    values.set('cleanupOnDeactivate', true);

    const config = getExtensionConfig();

    expect(config.autoConfigureMcp).toBe(true);
    expect(config.autoConfigureRules).toBe(true);
    expect(config.cleanupOnDeactivate).toBe(true);
  });
});
