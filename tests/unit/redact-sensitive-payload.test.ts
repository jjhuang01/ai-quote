import { describe, expect, it } from 'vitest';
import { redactSensitivePayload } from '../../src/utils/redact-sensitive-payload';

describe('redactSensitivePayload', () => {
  it('保留原始结构并脱敏敏感字段', () => {
    const input = {
      auth_token: 'auth-token-123456',
      nested: {
        apiKey: 'sk-test-abcdef',
        sessionToken: 'session-token-xyz',
        safe: 'keep-me',
      },
      items: [
        { password: 'secret-pass' },
        { message: 'hello' },
      ],
    };

    expect(redactSensitivePayload(input)).toEqual({
      auth_token: 'auth...56',
      nested: {
        apiKey: 'sk-t...ef',
        sessionToken: 'sess...yz',
        safe: 'keep-me',
      },
      items: [
        { password: 'secr...ss' },
        { message: 'hello' },
      ],
    });
  });
});
