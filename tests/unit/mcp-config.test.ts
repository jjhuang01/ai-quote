import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { appName: 'Visual Studio Code' }
}));

let mergeMcpConfig: typeof import('../../src/adapters/mcp-config').mergeMcpConfig;

beforeAll(async () => {
  ({ mergeMcpConfig } = await import('../../src/adapters/mcp-config'));
});

describe('mergeMcpConfig', () => {
  it('adds a server entry when config is empty', () => {
    const merged = mergeMcpConfig(undefined, 'tool-a', 'http://127.0.0.1:3456/sse');
    expect(merged.mcpServers['tool-a']?.url).toBe('http://127.0.0.1:3456/sse');
  });

  it('preserves existing entries', () => {
    const merged = mergeMcpConfig(
      { mcpServers: { existing: { url: 'http://127.0.0.1:9999/sse' } } },
      'tool-a',
      'http://127.0.0.1:3456/sse'
    );
    expect(merged.mcpServers.existing?.url).toBe('http://127.0.0.1:9999/sse');
    expect(merged.mcpServers['tool-a']?.url).toBe('http://127.0.0.1:3456/sse');
  });
});
