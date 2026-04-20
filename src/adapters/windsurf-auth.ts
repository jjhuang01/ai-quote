import * as https from "node:https";
import { spawn } from "node:child_process";
import type { LoggerLike } from "../core/logger";

// Firebase Auth REST API
// https://firebase.google.com/docs/reference/rest/auth

export interface FirebaseAuthResult {
  idToken: string;
  refreshToken: string;
  email: string;
  localId: string;
  expiresIn: string;
  provider?: "firebase" | "devin-auth";
  devinAuth1Token?: string;
  devinAccountId?: string;
  devinPrimaryOrgId?: string;
}

export interface FirebaseAuthError {
  error: {
    code: number;
    message: string;
    errors: Array<{ message: string; domain: string; reason: string }>;
  };
}

interface DevinConnectionsResult {
  auth_method?: {
    method?: string;
    has_password?: boolean;
  };
}

interface DevinPasswordLoginResult {
  token: string;
  user_id: string;
  email: string;
}

interface DevinPostAuthResult {
  sessionToken: string;
  auth1Token?: string;
  accountId?: string;
  primaryOrgId?: string;
}

export interface SignInOptions {
  providerPreference?: "devin-auth" | "firebase";
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
  private tokenCache = new Map<
    string,
    {
      idToken: string;
      refreshToken: string;
      expiresAt: number;
    }
  >();

  // Windsurf 官方 Firebase Web API Key (来源: crispvibe/Windsurf-Tool/js/constants.js)
  static readonly WINDSURF_FIREBASE_API_KEY =
    "AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY";

  public constructor(logger: LoggerLike, firebaseApiKey?: string) {
    this.logger = logger;
    this.firebaseApiKey =
      firebaseApiKey ?? WindsurfAuth.WINDSURF_FIREBASE_API_KEY;
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
  public async signIn(
    email: string,
    password: string,
    accountId?: string,
    options?: SignInOptions,
  ): Promise<FirebaseAuthResult> {
    // 检查缓存
    if (accountId) {
      const cached = this.tokenCache.get(accountId);
      if (cached && cached.expiresAt > Date.now() + 60_000) {
        return {
          idToken: cached.idToken,
          refreshToken: cached.refreshToken,
          email,
          localId: "",
          expiresIn: String(Math.floor((cached.expiresAt - Date.now()) / 1000)),
        };
      }
    }

    if (options?.providerPreference === "firebase") {
      return this.signInWithFirebaseFallback(email, password, accountId);
    }

    let devinErr: Error | undefined;
    try {
      return await this.signInWithDevinAuth(email, password, accountId);
    } catch (err) {
      devinErr = err instanceof Error ? err : new Error(String(err));
      this.logger.warn("Devin Auth signIn failed, trying Firebase fallback.", {
        email,
        error: devinErr.message,
      });
    }

    if (!this.firebaseApiKey) {
      throw new Error(
        `Devin Auth 登录失败: ${devinErr.message}; Firebase API Key 未配置。请在设置中填写 quote.firebaseApiKey`,
      );
    }

    return this.signInWithFirebaseFallback(email, password, accountId, devinErr);
  }

  private async signInWithFirebaseFallback(
    email: string,
    password: string,
    accountId?: string,
    devinErr?: Error,
  ): Promise<FirebaseAuthResult> {
    const devinPrefix = devinErr
      ? `Devin Auth 登录失败: ${devinErr.message}; `
      : "";
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${this.firebaseApiKey}`;
    const body = JSON.stringify({
      email,
      password,
      returnSecureToken: true,
    });

    this.logger.info("Firebase signIn attempt.", { email });

    // Retry logic for transient network errors (TLS, socket disconnect)
    const maxRetries = 3;
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.httpsPost<FirebaseAuthResult>(url, body);

        if (!result.idToken) {
          throw new Error("Firebase returned empty idToken");
        }

        // Cache token
        if (accountId) {
          this.tokenCache.set(accountId, {
            idToken: result.idToken,
            refreshToken: result.refreshToken,
            expiresAt: Date.now() + parseInt(result.expiresIn, 10) * 1000,
          });
        }

        this.logger.info("Firebase signIn success.", { email, attempt });
        return result;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries && this.isTransientNetworkError(lastErr)) {
          this.logger.warn("Firebase signIn network error, retrying...", {
            email,
            attempt,
            error: lastErr.message,
          });
          await this.sleep(1000 * attempt); // 1s, 2s, 3s backoff
          continue;
        }
        this.logger.error("Firebase signIn failed.", {
          email,
          attempt,
          error: String(err),
        });
        throw new Error(
          `${devinPrefix}Firebase 登录失败: ${lastErr.message}`,
        );
      }
    }
    throw new Error(
      `${devinPrefix}Firebase 登录失败: ${lastErr?.message ?? "unknown"}`,
    );
  }

  /**
   * Windsurf 新认证后端。
   *
   * 实测链路:
   * 1. /_devin-auth/connections 确认邮箱支持 auth1 password
   * 2. /_devin-auth/password/login 返回 auth1 token
   * 3. SeatManagementService/WindsurfPostAuth 返回 devin-session-token
   *
   * devin-session-token 可直接用于 RegisterUser 与 GetPlanStatus，能绕开
   * Firebase TOO_MANY_ATTEMPTS_TRY_LATER 限流。
   */
  private async signInWithDevinAuth(
    email: string,
    password: string,
    accountId?: string,
  ): Promise<FirebaseAuthResult> {
    this.logger.info("Devin Auth signIn attempt.", {
      email,
    });

    const connections = await this.withNetworkRetry(
      "Devin Auth connections",
      () =>
        this.httpsPostWithDirectFallback<DevinConnectionsResult>(
          "https://windsurf.com/_devin-auth/connections",
          JSON.stringify({ email }),
        ),
    );
    if (
      connections.auth_method?.method !== "auth1" ||
      connections.auth_method.has_password !== true
    ) {
      throw new Error("Devin Auth 不支持密码登录");
    }

    const login = await this.withNetworkRetry(
      "Devin Auth password login",
      () =>
        this.httpsPostWithDirectFallback<DevinPasswordLoginResult>(
          "https://windsurf.com/_devin-auth/password/login",
          JSON.stringify({ email, password }),
        ),
    );
    if (!login.token) {
      throw new Error("Devin Auth 返回空 token");
    }

    const postAuth = await this.withNetworkRetry(
      "WindsurfPostAuth",
      () => this.windsurfPostAuthWithDirectFallback(login.token),
    );
    if (!postAuth.sessionToken) {
      throw new Error("WindsurfPostAuth 返回空 sessionToken");
    }

    const result: FirebaseAuthResult = {
      idToken: postAuth.sessionToken,
      refreshToken: "",
      email: login.email || email,
      localId: login.user_id,
      expiresIn: "3600",
      provider: "devin-auth",
      devinAuth1Token: postAuth.auth1Token ?? login.token,
      devinAccountId: postAuth.accountId,
      devinPrimaryOrgId: postAuth.primaryOrgId,
    };

    if (accountId) {
      this.tokenCache.set(accountId, {
        idToken: result.idToken,
        refreshToken: result.refreshToken,
        expiresAt: Date.now() + 3600 * 1000,
      });
    }

    this.logger.info("Devin Auth signIn success.", {
      email,
      accountId: postAuth.accountId,
      primaryOrgId: postAuth.primaryOrgId,
    });
    return result;
  }

  /**
   * 用 refreshToken 刷新 idToken
   */
  public async refreshIdToken(
    refreshToken: string,
    accountId?: string,
  ): Promise<{ idToken: string; refreshToken: string }> {
    if (!this.firebaseApiKey) {
      throw new Error("Firebase API Key 未配置");
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
        expiresAt: Date.now() + parseInt(result.expires_in, 10) * 1000,
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

  /**
   * 用 Firebase idToken 向 Windsurf 注册/获取真实 API Key
   * 新版 (Windsurf 最新) 调用 SeatManagementService.RegisterUser on register.windsurf.com
   * 旧版回退: api.codeium.com / server.codeium.com
   */
  public async registerUser(
    idToken: string,
  ): Promise<{ apiKey: string; name: string; apiServerUrl: string }> {
    const body = JSON.stringify({ firebase_id_token: idToken });

    // 新端点（当前 Windsurf 版本）
    try {
      const url =
        "https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser";
      const result = await this.httpsPost<{
        api_key?: string;
        name?: string;
        api_server_url?: string;
      }>(url, body);
      if (result.api_key) {
        this.logger.info("RegisterUser success (new endpoint).", { url });
        return {
          apiKey: result.api_key,
          name: result.name ?? "",
          apiServerUrl: result.api_server_url ?? "",
        };
      }
    } catch (err) {
      this.logger.warn("RegisterUser new endpoint failed, trying fallback.", {
        error: String(err),
      });
    }

    // 旧端点回退（兼容旧版 Windsurf）
    const fallbacks = [
      "https://api.codeium.com/exa.language_server_pb.LanguageServerService/RegisterUser",
      "https://server.codeium.com/exa.language_server_pb.LanguageServerService/RegisterUser",
    ];
    let lastError = "";
    for (const url of fallbacks) {
      try {
        const result = await this.httpsPost<{
          api_key?: string;
          name?: string;
        }>(url, body);
        if (result.api_key) {
          this.logger.info("RegisterUser success (fallback endpoint).", {
            url,
          });
          return {
            apiKey: result.api_key,
            name: result.name ?? "",
            apiServerUrl: "",
          };
        }
      } catch (err) {
        lastError = String(err);
        this.logger.warn("RegisterUser fallback failed.", {
          url,
          error: lastError,
        });
      }
    }
    throw new Error(
      `RegisterUser 失败，无法获取 Windsurf API Key: ${lastError}`,
    );
  }

  private httpsPostForm<T>(urlString: string, formBody: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(formBody),
            Referer: "https://windsurf.com/",
            Origin: "https://windsurf.com",
          },
          timeout: 10_000,
        },
        (res) => {
          let chunks = "";
          res.on("data", (chunk) => {
            chunks += chunk;
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(chunks);
              if (res.statusCode && res.statusCode >= 400) {
                const errMsg =
                  parsed?.error?.message ?? `HTTP ${res.statusCode}`;
                reject(new Error(`请求失败: ${errMsg}`));
              } else {
                resolve(parsed as T);
              }
            } catch {
              reject(
                new Error(`Firebase 返回非 JSON: ${chunks.slice(0, 200)}`),
              );
            }
          });
        },
      );
      req.on("error", (err) => reject(new Error(`网络错误: ${err.message}`)));
      req.on("timeout", () => {
        req.destroy(new Error("Firebase 请求超时"));
      });
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
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Referer: "https://windsurf.com/",
            Origin: "https://windsurf.com",
          },
          timeout: 10_000,
        },
        (res) => {
          let chunks = "";
          res.on("data", (chunk) => {
            chunks += chunk;
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(chunks);
              if (res.statusCode && res.statusCode >= 400) {
                const errMsg =
                  parsed?.error?.message ?? `HTTP ${res.statusCode}`;
                reject(new Error(`请求失败: ${errMsg}`));
              } else {
                resolve(parsed as T);
              }
            } catch {
              reject(
                new Error(`Firebase 返回非 JSON: ${chunks.slice(0, 200)}`),
              );
            }
          });
        },
      );
      req.on("error", (err) => reject(new Error(`网络错误: ${err.message}`)));
      req.on("timeout", () => {
        req.destroy(new Error("Firebase 请求超时"));
      });
      req.write(body);
      req.end();
    });
  }

  private async withNetworkRetry<T>(
    label: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const maxRetries = 3;
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await action();
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries && this.isTransientNetworkError(lastErr)) {
          this.logger.warn(`${label} network error, retrying...`, {
            attempt,
            error: lastErr.message,
          });
          await this.sleep(1000 * attempt);
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr ?? new Error(`${label} failed`);
  }

  private isTransientNetworkError(err: Error): boolean {
    const message = err.message.toLowerCase();
    return (
      message.includes("tls") ||
      message.includes("socket") ||
      message.includes("network") ||
      message.includes("econn") ||
      message.includes("etimedout") ||
      message.includes("timeout") ||
      message.includes("disconnected before secure")
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async httpsPostWithDirectFallback<T>(
    urlString: string,
    body: string,
  ): Promise<T> {
    try {
      return await this.httpsPost<T>(urlString, body);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this.isTransientNetworkError(error)) {
        throw error;
      }
      this.logger.warn("HTTPS request failed, retrying with direct curl.", {
        url: new URL(urlString).hostname,
        error: error.message,
      });
      return this.curlJsonPost<T>(urlString, body);
    }
  }

  private async windsurfPostAuthWithDirectFallback(
    auth1Token: string,
  ): Promise<DevinPostAuthResult> {
    try {
      return await this.windsurfPostAuth(auth1Token);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this.isTransientNetworkError(error)) {
        throw error;
      }
      this.logger.warn("WindsurfPostAuth failed, retrying with direct curl.", {
        error: error.message,
      });
      const body = Buffer.concat([
        this.encodeProtoString(1, auth1Token),
        this.encodeProtoString(2, ""),
      ]);
      const raw = await this.curlProtoPost(
        "https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth",
        body,
        ["X-Devin-Auth1-Token: " + auth1Token],
      );
      const fields = this.decodeProtoStrings(raw);
      return {
        sessionToken: fields.get(1) ?? "",
        auth1Token: fields.get(3),
        accountId: fields.get(4),
        primaryOrgId: fields.get(5),
      };
    }
  }

  private async curlJsonPost<T>(url: string, body: string): Promise<T> {
    const raw = await this.runCurl(url, body, [
      "Content-Type: application/json",
      "Origin: https://windsurf.com",
      "Referer: https://windsurf.com/",
      "User-Agent: Mozilla/5.0",
    ]);
    try {
      return JSON.parse(raw.toString("utf8")) as T;
    } catch {
      throw new Error(`curl 返回非 JSON: ${raw.toString("utf8").slice(0, 200)}`);
    }
  }

  private curlProtoPost(
    url: string,
    body: Buffer,
    extraHeaders: string[],
  ): Promise<Buffer> {
    return this.runCurl(url, body, [
      "Content-Type: application/proto",
      "Accept: application/proto",
      "User-Agent: Mozilla/5.0",
      ...extraHeaders,
    ]);
  }

  private runCurl(
    url: string,
    body: string | Buffer,
    headers: string[],
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const args = [
        "--noproxy",
        "*",
        "-sS",
        "-m",
        "20",
        "-X",
        "POST",
        url,
        "--data-binary",
        "@-",
      ];
      for (const header of headers) {
        args.push("-H", header);
      }

      const child = spawn("curl", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          http_proxy: "",
          https_proxy: "",
          all_proxy: "",
        },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) =>
        reject(new Error(`curl 启动失败: ${error.message}`)),
      );
      child.on("close", (code) => {
        const output = Buffer.concat(stdout);
        if (code !== 0) {
          reject(
            new Error(
              `curl 请求失败(${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 200)}`,
            ),
          );
          return;
        }
        resolve(output);
      });
      child.stdin.end(body);
    });
  }

  private windsurfPostAuth(auth1Token: string): Promise<DevinPostAuthResult> {
    const body = Buffer.concat([
      this.encodeProtoString(1, auth1Token),
      this.encodeProtoString(2, ""),
    ]);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "web-backend.windsurf.com",
          port: 443,
          path: "/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth",
          method: "POST",
          headers: {
            "Content-Type": "application/proto",
            Accept: "application/proto",
            "Content-Length": body.length,
            "User-Agent": "Mozilla/5.0",
            "X-Devin-Auth1-Token": auth1Token,
          },
          timeout: 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            if (res.statusCode && res.statusCode >= 400) {
              reject(
                new Error(
                  `WindsurfPostAuth 请求失败: ${raw.toString("utf8").slice(0, 200)}`,
                ),
              );
              return;
            }
            const fields = this.decodeProtoStrings(raw);
            resolve({
              sessionToken: fields.get(1) ?? "",
              auth1Token: fields.get(3),
              accountId: fields.get(4),
              primaryOrgId: fields.get(5),
            });
          });
        },
      );
      req.on("error", (err) =>
        reject(new Error(`WindsurfPostAuth 网络错误: ${err.message}`)),
      );
      req.on("timeout", () => {
        req.destroy(new Error("WindsurfPostAuth 请求超时"));
      });
      req.write(body);
      req.end();
    });
  }

  private encodeProtoString(fieldNumber: number, value: string): Buffer {
    const valueBytes = Buffer.from(value, "utf8");
    const lengthBytes: number[] = [];
    let length = valueBytes.length;
    while (length > 127) {
      lengthBytes.push((length & 0x7f) | 0x80);
      length >>= 7;
    }
    lengthBytes.push(length & 0x7f);
    return Buffer.concat([
      Buffer.from([(fieldNumber << 3) | 2, ...lengthBytes]),
      valueBytes,
    ]);
  }

  private decodeProtoStrings(data: Buffer): Map<number, string> {
    const fields = new Map<number, string>();
    let pos = 0;
    while (pos < data.length) {
      const tag = data[pos++];
      const wireType = tag & 0x07;
      const fieldNumber = tag >> 3;
      if (wireType !== 2) {
        break;
      }

      let length = 0;
      let shift = 0;
      while (pos < data.length) {
        const byte = data[pos++];
        length |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      if (pos + length > data.length) break;
      fields.set(fieldNumber, data.subarray(pos, pos + length).toString("utf8"));
      pos += length;
    }
    return fields;
  }
}
