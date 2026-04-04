import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuoteBridge } from '../../src/core/bridge';
import type { LoggerLike } from '../../src/core/logger';

const logger: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe('QuoteBridge', () => {
  const bridge = new QuoteBridge(logger, 0, 'kpzm_a1b2c3d4', 'Visual Studio Code');

  beforeAll(async () => {
    await bridge.start();
  });

  afterAll(async () => {
    await bridge.stop();
  });

  it('serves version info', async () => {
    const response = await fetch(`http://127.0.0.1:${bridge.getPort()}/api/version`);
    const json = await response.json() as { success: boolean };
    expect(json.success).toBe(true);
  });

  it('accepts bridge messages', async () => {
    const response = await fetch(`http://127.0.0.1:${bridge.getPort()}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'test', text: 'hello bridge' })
    });
    const json = await response.json() as { success: boolean; data: { text: string } };
    expect(json.success).toBe(true);
    expect(json.data.text).toBe('hello bridge');
  });

  it('/status 返回 running:true 和正确 toolName', async () => {
    const response = await fetch(`http://127.0.0.1:${bridge.getPort()}/status`);
    const json = await response.json() as { running: boolean; toolName: string; port: number };
    expect(json.running).toBe(true);
    expect(json.toolName).toBe('kpzm_a1b2c3d4');
    expect(json.port).toBe(bridge.getPort());
  });

  it('未知路径返回 404', async () => {
    const response = await fetch(`http://127.0.0.1:${bridge.getPort()}/nonexistent`);
    expect(response.status).toBe(404);
    const json = await response.json() as { success: boolean };
    expect(json.success).toBe(false);
  });

  it('OPTIONS 请求返回 204 CORS 头', async () => {
    const response = await fetch(`http://127.0.0.1:${bridge.getPort()}/message`, {
      method: 'OPTIONS'
    });
    expect(response.status).toBe(204);
  });

  it('/mcp 也返回 version 信息', async () => {
    const response = await fetch(`http://127.0.0.1:${bridge.getPort()}/mcp`);
    const json = await response.json() as { success: boolean };
    expect(json.success).toBe(true);
  });

  it('MCP JSON-RPC initialize 通过 SSE 返回 serverInfo', async () => {
    // Connect SSE to get sessionId
    let sessionId = '';
    await new Promise<void>((resolve) => {
      const ctrl = new AbortController();
      const sseUrl = `http://127.0.0.1:${bridge.getPort()}/sse`;
      fetch(sseUrl, { signal: ctrl.signal }).then(async (res) => {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = dec.decode(value);
          const m = text.match(/data: (\/message\?sessionId=([^\s]+))/);
          if (m) { sessionId = m[2]; ctrl.abort(); resolve(); break; }
        }
      }).catch(() => {});
    });

    expect(sessionId).not.toBe('');

    const rpcRes = await fetch(`http://127.0.0.1:${bridge.getPort()}/message?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    });
    expect(rpcRes.status).toBe(202);
  });

  it('getSseUrl 返回正确格式', () => {
    expect(bridge.getSseUrl()).toBe(`http://127.0.0.1:${bridge.getPort()}/sse`);
  });
});
