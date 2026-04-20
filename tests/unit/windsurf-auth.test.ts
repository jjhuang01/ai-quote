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
});
