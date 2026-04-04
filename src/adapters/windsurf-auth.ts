import * as https from 'node:https';
import type { LoggerLike } from '../core/logger';

// Firebase Auth REST API
// https://firebase.google.com/docs/reference/rest/auth

export interface FirebaseAuthResult {
  idToken: string;
  refreshToken: string;
  email: string;
  localId: string;
  expiresIn: string;
}

export interface FirebaseAuthError {
  error: {
    code: number;
    message: string;
    errors: Array<{ message: string; domain: string; reason: string }>;
  };
}

/**
 * Windsurf/Codeium Firebase Auth 适配器
 *
 * 认证流程:
 * 1. 用 Firebase Auth REST API 登录 (email/password) → idToken
 * 2. 用 idToken 调用 Codeium API (server.codeium.com) → plan/quota 信息
 */
export class WindsurfAuth {
  // Codeium 的 Firebase Web API Key (公开嵌入在客户端中)
  // 可通过 settings 覆盖
  private firebaseApiKey: string;
  private readonly logger: LoggerLike;

  // Token 缓存: accountId → { idToken, refreshToken, expiresAt }
  private tokenCache = new Map<string, {
    idToken: string;
    refreshToken: string;
    expiresAt: number;
  }>();

  // Windsurf 官方 Firebase Web API Key (来源: crispvibe/Windsurf-Tool/js/constants.js)
  static readonly WINDSURF_FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';

  public constructor(logger: LoggerLike, firebaseApiKey?: string) {
    this.logger = logger;
    this.firebaseApiKey = firebaseApiKey ?? WindsurfAuth.WINDSURF_FIREBASE_API_KEY;
  }

  public setApiKey(key: string): void {
    this.firebaseApiKey = key;
    this.tokenCache.clear();
  }

  public getApiKey(): string {
    return this.firebaseApiKey;
  }

  /**
   * 用 email/password 登录 Firebase，获取 idToken
   */
  public async signIn(email: string, password: string, accountId?: string): Promise<FirebaseAuthResult> {
    if (!this.firebaseApiKey) {
      throw new Error('Firebase API Key 未配置。请在设置中填写 infiniteDialog.firebaseApiKey');
    }

    // 检查缓存
    if (accountId) {
      const cached = this.tokenCache.get(accountId);
      if (cached && cached.expiresAt > Date.now() + 60_000) {
        return {
          idToken: cached.idToken,
          refreshToken: cached.refreshToken,
          email,
          localId: '',
          expiresIn: String(Math.floor((cached.expiresAt - Date.now()) / 1000))
        };
      }
    }

    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${this.firebaseApiKey}`;
    const body = JSON.stringify({
      email,
      password,
      returnSecureToken: true
    });

    this.logger.info('Firebase signIn attempt.', { email });

    try {
      const result = await this.httpsPost<FirebaseAuthResult>(url, body);

      if (!result.idToken) {
        throw new Error('Firebase 返回了空 idToken');
      }

      // 缓存 token
      if (accountId) {
        this.tokenCache.set(accountId, {
          idToken: result.idToken,
          refreshToken: result.refreshToken,
          expiresAt: Date.now() + parseInt(result.expiresIn, 10) * 1000
        });
      }

      this.logger.info('Firebase signIn success.', { email });
      return result;
    } catch (err) {
      this.logger.error('Firebase signIn failed.', { email, error: String(err) });
      throw err;
    }
  }

  /**
   * 用 refreshToken 刷新 idToken
   */
  public async refreshIdToken(refreshToken: string, accountId?: string): Promise<{ idToken: string; refreshToken: string }> {
    if (!this.firebaseApiKey) {
      throw new Error('Firebase API Key 未配置');
    }

    // Firebase token refresh requires application/x-www-form-urlencoded (not JSON)
    // Ref: https://firebase.google.com/docs/reference/rest/auth#section-refresh-token
    const url = `https://securetoken.googleapis.com/v1/token?key=${this.firebaseApiKey}`;
    const formBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;

    const result = await this.httpsPostForm<{
      id_token: string;
      refresh_token: string;
      expires_in: string;
    }>(url, formBody);

    if (accountId) {
      this.tokenCache.set(accountId, {
        idToken: result.id_token,
        refreshToken: result.refresh_token,
        expiresAt: Date.now() + parseInt(result.expires_in, 10) * 1000
      });
    }

    return { idToken: result.id_token, refreshToken: result.refresh_token };
  }

  public clearCache(accountId?: string): void {
    if (accountId) {
      this.tokenCache.delete(accountId);
    } else {
      this.tokenCache.clear();
    }
  }

  private httpsPostForm<T>(urlString: string, formBody: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(formBody)
          },
          timeout: 10_000
        },
        res => {
          let chunks = '';
          res.on('data', chunk => { chunks += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(chunks);
              if (res.statusCode && res.statusCode >= 400) {
                const errMsg = parsed?.error?.message ?? `HTTP ${res.statusCode}`;
                reject(new Error(`Firebase Token Refresh 错误: ${errMsg}`));
              } else {
                resolve(parsed as T);
              }
            } catch {
              reject(new Error(`Firebase 返回非 JSON: ${chunks.slice(0, 200)}`));
            }
          });
        }
      );
      req.on('error', err => reject(new Error(`网络错误: ${err.message}`)));
      req.on('timeout', () => { req.destroy(new Error('Firebase 请求超时')); });
      req.write(formBody);
      req.end();
    });
  }

  private httpsPost<T>(urlString: string, body: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 10_000
        },
        res => {
          let chunks = '';
          res.on('data', chunk => { chunks += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(chunks);
              if (res.statusCode && res.statusCode >= 400) {
                const errMsg = parsed?.error?.message ?? `HTTP ${res.statusCode}`;
                reject(new Error(`Firebase Auth 错误: ${errMsg}`));
              } else {
                resolve(parsed as T);
              }
            } catch {
              reject(new Error(`Firebase 返回非 JSON: ${chunks.slice(0, 200)}`));
            }
          });
        }
      );
      req.on('error', err => reject(new Error(`网络错误: ${err.message}`)));
      req.on('timeout', () => { req.destroy(new Error('Firebase 请求超时')); });
      req.write(body);
      req.end();
    });
  }
}
