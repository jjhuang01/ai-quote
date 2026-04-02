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
});
