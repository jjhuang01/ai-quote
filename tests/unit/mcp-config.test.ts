import { beforeAll, describe, expect, it, vi } from 'vitest';

const vscodeMock = {
  env: { appName: 'Windsurf' }
};

vi.mock('vscode', () => vscodeMock);

let mergeMcpConfig: typeof import('../../src/adapters/mcp-config').mergeMcpConfig;
let detectCurrentIde: typeof import('../../src/adapters/mcp-config').detectCurrentIde;
let pruneMcpConfig: typeof import('../../src/adapters/mcp-config').pruneMcpConfig;

beforeAll(async () => {
  ({ mergeMcpConfig, detectCurrentIde, pruneMcpConfig } = await import('../../src/adapters/mcp-config'));
});

describe('mergeMcpConfig', () => {
  it('adds a server entry when config is empty', () => {
    const merged = mergeMcpConfig(undefined, 'tool-a', 'http://127.0.0.1:3456/sse');
    expect(merged.mcpServers['tool-a']?.url).toBe('http://127.0.0.1:3456/sse');
    expect(merged.mcpServers['tool-a']?.timeout).toBe(259_200_000);
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

  it('覆盖相同 toolName 的旧 URL', () => {
    const merged = mergeMcpConfig(
      { mcpServers: { 'tool-a': { url: 'http://127.0.0.1:3000/sse' } } },
      'tool-a',
      'http://127.0.0.1:4000/sse'
    );
    expect(merged.mcpServers['tool-a']?.url).toBe('http://127.0.0.1:4000/sse');
    expect(merged.mcpServers['tool-a']?.timeout).toBe(259_200_000);
    expect(Object.keys(merged.mcpServers)).toHaveLength(1);
  });

  it('mcpServers 缺失时自动初始化', () => {
    const merged = mergeMcpConfig({} as any, 'tool-b', 'http://127.0.0.1:5000/sse');
    expect(merged.mcpServers['tool-b']?.url).toBe('http://127.0.0.1:5000/sse');
  });
});

describe('pruneMcpConfig', () => {
  it('只删除指定的 owned tool names，保留其他 MCP', () => {
    const result = pruneMcpConfig({
      mcpServers: {
        ours_a: { url: 'http://127.0.0.1:3456/sse' },
        ours_b: { url: 'http://127.0.0.1:3457/sse' },
        other_mcp: { url: 'http://127.0.0.1:9999/sse' },
      },
    }, ['ours_a', 'ours_b']);

    expect(result.removed.sort()).toEqual(['ours_a', 'ours_b']);
    expect(result.config.mcpServers).toEqual({
      other_mcp: { url: 'http://127.0.0.1:9999/sse' },
    });
  });
});

describe('detectCurrentIde', () => {
  it('识别 Windsurf', () => {
    vscodeMock.env.appName = 'Windsurf';
    const ide = detectCurrentIde();
    expect(ide.id).toBe('windsurf');
    expect(ide.configPath).toContain('mcp_config.json');
  });

  it('识别 Cursor', () => {
    vscodeMock.env.appName = 'Cursor';
    const ide = detectCurrentIde();
    expect(ide.id).toBe('cursor');
  });

  it('未知 IDE 回退到 VS Code', () => {
    vscodeMock.env.appName = 'Some Unknown Editor';
    const ide = detectCurrentIde();
    expect(ide.id).toBe('vscode');
  });

  it('识别 Trae', () => {
    vscodeMock.env.appName = 'Trae';
    const ide = detectCurrentIde();
    expect(ide.id).toBe('trae');
  });
});
