import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EchoBridgeServer } from '../../src/core/bridge';
import type { LoggerLike } from '../../src/core/logger';

const logger: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe('EchoBridgeServer', () => {
  const bridge = new EchoBridgeServer(logger, 0, 'windsurf_endless_test', 'Visual Studio Code');

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
    expect(json.toolName).toBe('windsurf_endless_test');
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

  it('getSseUrl 返回正确格式', () => {
    expect(bridge.getSseUrl()).toBe(`http://127.0.0.1:${bridge.getPort()}/sse`);
  });
});
