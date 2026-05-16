import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WindsurfAuth } from '../../src/adapters/windsurf-auth';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('WindsurfAuth', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('Devin Auth 不支持密码登录时回退 Firebase', async () => {
    const auth = new WindsurfAuth(logger);
    const httpsPost = vi
      .fn()
      .mockResolvedValueOnce({
        auth_method: { method: 'auth1', has_password: false },
      })
      .mockResolvedValueOnce({
        idToken: 'firebase-id-token',
        refreshToken: 'refresh-token',
        email: 'a@test.com',
        localId: 'local-id',
        expiresIn: '3600',
      });
    (auth as any).httpsPost = httpsPost;

    const result = await auth.signIn('a@test.com', 'password', 'acc_1');

    expect(result.idToken).toBe('firebase-id-token');
    expect(result.provider).toBeUndefined();
    expect(httpsPost).toHaveBeenCalledTimes(2);
  });

  it('优先使用 Devin Auth 并返回 session token', async () => {
    const auth = new WindsurfAuth(logger);
    const httpsPost = vi
      .fn()
      .mockResolvedValueOnce({
        auth_method: { method: 'auth1', has_password: true },
      })
      .mockResolvedValueOnce({
        token: 'auth1_token',
        user_id: 'user-1',
        email: 'a@test.com',
      });
    (auth as any).httpsPost = httpsPost;
    (auth as any).windsurfPostAuth = vi.fn(async () => ({
      sessionToken: 'devin-session-token$abc',
      auth1Token: 'auth1_token_after_post_auth',
      accountId: 'account-1',
      primaryOrgId: 'org-1',
    }));

    const result = await auth.signIn('a@test.com', 'password', 'acc_1');

    expect(result).toMatchObject({
      idToken: 'devin-session-token$abc',
      refreshToken: '',
      email: 'a@test.com',
      localId: 'user-1',
      provider: 'devin-auth',
      devinAuth1Token: 'auth1_token_after_post_auth',
      devinAccountId: 'account-1',
      devinPrimaryOrgId: 'org-1',
    });
    expect(httpsPost).toHaveBeenCalledTimes(2);
  });

  it('Devin Auth 遇到 TLS 断连会重试后继续登录', async () => {
    vi.useFakeTimers();
    const auth = new WindsurfAuth(logger);
    (auth as any).sleep = vi.fn(async () => undefined);
    const httpsPost = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          '网络错误: Client network socket disconnected before secure TLS connection was established',
        ),
      )
      .mockResolvedValueOnce({
        token: 'auth1_token',
        user_id: 'user-1',
        email: 'a@test.com',
      });
    (auth as any).httpsPost = httpsPost;
    (auth as any).curlJsonPost = vi.fn(async () => ({
      auth_method: { method: 'auth1', has_password: true },
    }));
    (auth as any).windsurfPostAuth = vi.fn(async () => ({
      sessionToken: 'devin-session-token$abc',
    }));

    const result = await auth.signIn('a@test.com', 'password', 'acc_1');

    expect(result.idToken).toBe('devin-session-token$abc');
    expect(httpsPost).toHaveBeenCalledTimes(2);
    expect((auth as any).curlJsonPost).toHaveBeenCalledTimes(1);
  });

  it('Devin Auth HTTPS TLS 断连时会用直连 curl fallback', async () => {
    const auth = new WindsurfAuth(logger);
    const httpsPost = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          '网络错误: Client network socket disconnected before secure TLS connection was established',
        ),
      )
      .mockResolvedValueOnce({
        token: 'auth1_token',
        user_id: 'user-1',
        email: 'a@test.com',
      });
    (auth as any).httpsPost = httpsPost;
    (auth as any).curlJsonPost = vi.fn(async () => ({
      auth_method: { method: 'auth1', has_password: true },
    }));
    (auth as any).windsurfPostAuth = vi.fn(async () => ({
      sessionToken: 'devin-session-token$abc',
    }));

    const result = await auth.signIn('a@test.com', 'password', 'acc_1');

    expect(result.idToken).toBe('devin-session-token$abc');
    expect((auth as any).curlJsonPost).toHaveBeenCalledTimes(1);
  });

  it('WindsurfPostAuth HTTPS TLS 断连时会用直连 curl proto fallback', async () => {
    const auth = new WindsurfAuth(logger);
    (auth as any).httpsPost = vi
      .fn()
      .mockResolvedValueOnce({
        auth_method: { method: 'auth1', has_password: true },
      })
      .mockResolvedValueOnce({
        token: 'auth1_token',
        user_id: 'user-1',
        email: 'a@test.com',
      });
    (auth as any).windsurfPostAuth = vi.fn(async () => {
      throw new Error(
        'WindsurfPostAuth 网络错误: Client network socket disconnected before secure TLS connection was established',
      );
    });
    (auth as any).curlProtoPost = vi.fn(async () =>
      Buffer.from([
        0x0a,
        'devin-session-token$abc'.length,
        ...Buffer.from('devin-session-token$abc'),
      ]),
    );

    const result = await auth.signIn('a@test.com', 'password', 'acc_1');

    expect(result.idToken).toBe('devin-session-token$abc');
    expect((auth as any).curlProtoPost).toHaveBeenCalledTimes(1);
  });

  it('WindsurfPostAuth 遇到 TLS 断连会重试', async () => {
    const auth = new WindsurfAuth(logger);
    (auth as any).sleep = vi.fn(async () => undefined);
    const httpsPost = vi
      .fn()
      .mockResolvedValueOnce({
        auth_method: { method: 'auth1', has_password: true },
      })
      .mockResolvedValueOnce({
        token: 'auth1_token',
        user_id: 'user-1',
        email: 'a@test.com',
      });
    const windsurfPostAuth = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'WindsurfPostAuth 网络错误: Client network socket disconnected before secure TLS connection was established',
        ),
      )
      .mockResolvedValueOnce({
        sessionToken: 'devin-session-token$abc',
      });
    (auth as any).httpsPost = httpsPost;
    (auth as any).windsurfPostAuth = windsurfPostAuth;
    (auth as any).curlProtoPost = vi.fn(async () =>
      Buffer.from([
        0x0a,
        'devin-session-token$abc'.length,
        ...Buffer.from('devin-session-token$abc'),
      ]),
    );

    const result = await auth.signIn('a@test.com', 'password', 'acc_1');

    expect(result.idToken).toBe('devin-session-token$abc');
    expect(windsurfPostAuth).toHaveBeenCalledTimes(1);
    expect((auth as any).curlProtoPost).toHaveBeenCalledTimes(1);
  });


  it('Devin Auth 和 Firebase 都失败时同时暴露两个失败原因', async () => {
    const auth = new WindsurfAuth(logger);
    (auth as any).httpsPost = vi
      .fn()
      .mockResolvedValueOnce({
        auth_method: { method: 'auth1', has_password: false },
      })
      .mockRejectedValue(new Error('网络错误: Client network socket disconnected before secure TLS connection was established'));
    (auth as any).sleep = vi.fn(async () => undefined);

    await expect(auth.signIn('a@test.com', 'password', 'acc_1')).rejects.toThrow(
      /Devin Auth 登录失败: Devin Auth 不支持密码登录; Firebase 登录失败:/,
    );
  });

  it('Devin Auth 429 时不再回退 Firebase，避免扩大限流', async () => {
    const auth = new WindsurfAuth(logger);
    (auth as any).httpsPost = vi
      .fn()
      .mockRejectedValueOnce(new Error('请求失败: HTTP 429'));

    await expect(auth.signIn('a@test.com', 'password', 'acc_1')).rejects.toThrow(
      /Devin Auth 登录失败: 请求失败: HTTP 429/,
    );
  });

  it('quota 查询场景优先使用 Firebase', async () => {
    const auth = new WindsurfAuth(logger);
    const signInWithDevinAuth = vi.spyOn(auth as any, 'signInWithDevinAuth');
    const httpsPost = vi.fn().mockResolvedValueOnce({
      idToken: 'firebase-id-token',
      refreshToken: 'refresh-token',
      email: 'a@test.com',
      localId: 'local-id',
      expiresIn: '3600',
    });
    (auth as any).httpsPost = httpsPost;

    const result = await auth.signIn('a@test.com', 'password', 'acc_1', {
      providerPreference: 'firebase',
    });

    expect(result.idToken).toBe('firebase-id-token');
    expect(signInWithDevinAuth).not.toHaveBeenCalled();
    expect(httpsPost).toHaveBeenCalledTimes(1);
  });

  it('resolveAuth1Token 通过 GetCurrentUser 获取真实邮箱', async () => {
    const auth = new WindsurfAuth(logger);
    (auth as any).windsurfPostAuth = vi.fn(async () => ({
      sessionToken: 'devin-session-token$xyz',
      auth1Token: 'auth1_usln...',
      accountId: 'account-42',
      primaryOrgId: 'org-1',
    }));
    (auth as any).getCurrentUser = vi.fn(async () => ({
      email: 'real-user@example.com',
    }));
    (auth as any).registerUser = vi.fn(async () => ({
      apiKey: 'ws-api-key-123',
      name: 'Test User',
      apiServerUrl: 'https://server.codeium.com',
    }));

    const result = await auth.resolveAuth1Token('auth1_uslny66zeboixyinxgly3tzzc5ja7mkg45meyqi4iv27j4lo5jsa');

    expect(result.sessionToken).toBe('devin-session-token$xyz');
    expect(result.apiKey).toBe('ws-api-key-123');
    expect(result.name).toBe('Test User');
    expect(result.accountId).toBe('account-42');
    expect(result.email).toBe('real-user@example.com');
    expect((auth as any).getCurrentUser).toHaveBeenCalledTimes(1);
    expect((auth as any).registerUser).toHaveBeenCalledTimes(1);
  });

  it('resolveAuth1Token survives GetCurrentUser + RegisterUser failure gracefully', async () => {
    const auth = new WindsurfAuth(logger);
    (auth as any).windsurfPostAuth = vi.fn(async () => ({
      sessionToken: 'devin-session-token$xyz',
      accountId: 'account-42',
    }));
    (auth as any).getCurrentUser = vi.fn(async () => {
      throw new Error('GetCurrentUser 失败');
    });
    (auth as any).registerUser = vi.fn(async () => {
      throw new Error('RegisterUser 失败');
    });

    const result = await auth.resolveAuth1Token('auth1_test');

    expect(result.sessionToken).toBe('devin-session-token$xyz');
    expect(result.apiKey).toBe('');
    expect(result.name).toBe('account-42');
    expect(result.email).toBe('');
    expect(result.accountId).toBe('account-42');
  });

  it('signIn 检测到 auth1_ 密码时直接走 WindsurfPostAuth，跳过邮箱/密码登录', async () => {
    const auth = new WindsurfAuth(logger);
    const windsurfPostAuthSpy = vi.fn(async () => ({
      sessionToken: 'devin-session-token$direct',
      auth1Token: 'auth1_test',
      accountId: 'account-direct',
      primaryOrgId: 'org-direct',
    }));
    (auth as any).windsurfPostAuth = windsurfPostAuthSpy;

    const result = await auth.signIn('any@email.com', 'auth1_test_token', 'acc_direct');

    expect(result.idToken).toBe('devin-session-token$direct');
    expect(result.provider).toBe('devin-auth');
    expect(result.devinAuth1Token).toBe('auth1_test');
    expect(result.devinAccountId).toBe('account-direct');
    expect(result.devinPrimaryOrgId).toBe('org-direct');
    expect(windsurfPostAuthSpy).toHaveBeenCalledTimes(1);
    expect(windsurfPostAuthSpy).toHaveBeenCalledWith('auth1_test_token');
  });
});
