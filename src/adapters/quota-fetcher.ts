import * as https from 'node:https';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WindsurfAuth } from './windsurf-auth';
import type { LoggerLike } from '../core/logger';

// --- Windsurf Plan & Quota 真实数据结构 (从 cachedPlanInfo 逆向) ---

export interface WindsurfPlanInfo {
  planName: string;                    // 'Trial' | 'Pro' | 'Max' | 'Teams' | 'Free' | 'Enterprise'
  startTimestamp: number;              // ms
  endTimestamp: number;                // ms
  usage: {
    duration: number;
    messages: number;
    flowActions: number;
    flexCredits: number;
    usedMessages: number;
    usedFlowActions: number;
    usedFlexCredits: number;
    remainingMessages: number;
    remainingFlowActions: number;
    remainingFlexCredits: number;
  };
  hasBillingWritePermissions: boolean;
  gracePeriodStatus: number;
  billingStrategy: string;             // 'quota' | 'credits'
  quotaUsage: {
    dailyRemainingPercent?: number;    // 0-100, undefined = API 未返回此字段
    weeklyRemainingPercent?: number;   // 0-100, undefined = API 未返回此字段
    overageBalanceMicros: number;
    dailyResetAtUnix: number;          // unix seconds
    weeklyResetAtUnix: number;         // unix seconds
  };
}

export interface QuotaFetchResult {
  success: boolean;
  source: 'local' | 'api' | 'apikey' | 'cache' | 'proto';
  planInfo?: WindsurfPlanInfo;
  userEmail?: string;     // 来自 GetUserStatus 响应（当前登录用户邮箱）
  error?: string;
  fetchedAt: string;
}

// --- GetPlanStatus 响应 (web-backend.windsurf.com, application/json) ---
// 来源: crispvibe/Windsurf-Tool/js/accountQuery.js + 实测验证

interface GetPlanStatusPlanInfo {
  planName?: string;
  monthlyPromptCredits?: number;
  monthlyFlowCredits?: number;
  billingStrategy?: string;
}

interface GetPlanStatusResponse {
  planStatus?: {
    planInfo?: GetPlanStatusPlanInfo;
    planStart?: string;                   // ISO string
    planEnd?: string;                     // ISO string
    availablePromptCredits?: number;
    availableFlowCredits?: number;
    gracePeriodStatus?: string;
    dailyQuotaRemainingPercent?: number;
    weeklyQuotaRemainingPercent?: number;
    dailyQuotaResetAtUnix?: string | number;   // 注意: 服务器返回字符串
    weeklyQuotaResetAtUnix?: string | number;  // 注意: 服务器返回字符串
  };
}

// --- GetUserStatus 响应 (Language Server ConnectRPC) ---

interface PlanStatusProto {
  planInfo?: WindsurfPlanInfo;
  availablePromptCredits?: number;
  availableFlowCredits?: number;
  availableFlexCredits?: number;
}

interface UserStatusProto {
  planStatus?: PlanStatusProto;
  planInfo?: WindsurfPlanInfo;
  userEmail?: string;
}

interface GetUserStatusResponse {
  userStatus?: UserStatusProto;
}

// --- windsurfAuthStatus 结构 ---

interface WindsurfAuthStatus {
  apiKey?: string;
  userEmail?: string;
  userName?: string;
  userStatusProtoBinaryBase64?: string;
}

// --- sqlite3 CLI helper (跨平台) ---

/**
 * 通过 sqlite3 CLI 执行查询。Windows 默认未安装 sqlite3，会返回明确错误。
 * @returns 查询结果字符串，或 null 表示 sqlite3 不可用
 */
async function querySqlite(dbPath: string, sql: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise<string>((resolve, reject) => {
    execFile(
      'sqlite3',
      [dbPath, sql],
      { timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message;
          // ENOENT = sqlite3 binary not found (common on Windows)
          if ('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new Error(
              process.platform === 'win32'
                ? 'sqlite3 CLI 未找到。Windows 需手动安装: winget install SQLite.SQLite 或从 sqlite.org 下载'
                : 'sqlite3 CLI 未找到。请安装: brew install sqlite3 (macOS) 或 apt install sqlite3 (Linux)'
            ));
          } else {
            reject(new Error(`sqlite3 查询失败: ${msg}`));
          }
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}

// --- 最小 Protobuf 解码器 ---

interface ProtoField { type: 'varint' | 'bytes' | 'fixed32' | 'fixed64'; val: number | Buffer }
type ProtoFields = Map<number, ProtoField[]>;

function _parseVarint(data: Buffer, pos: number): [bigint, number] {
  let result = 0n, shift = 0n;
  while (pos < data.length) {
    const b = data[pos++];
    result |= BigInt(b & 0x7F) << shift;
    shift += 7n;
    if (!(b & 0x80)) break;
  }
  return [result, pos];
}

function _decodeProto(data: Buffer): ProtoFields {
  const fields: ProtoFields = new Map();
  let pos = 0;
  while (pos < data.length) {
    try {
      let tag: bigint; [tag, pos] = _parseVarint(data, pos);
      const fieldNum = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (!fields.has(fieldNum)) fields.set(fieldNum, []);
      const arr = fields.get(fieldNum)!;
      if (wireType === 0) {
        let v: bigint; [v, pos] = _parseVarint(data, pos);
        arr.push({ type: 'varint', val: Number(v) });
      } else if (wireType === 2) {
        let len: bigint; [len, pos] = _parseVarint(data, pos);
        const n = Number(len);
        arr.push({ type: 'bytes', val: data.slice(pos, pos + n) });
        pos += n;
      } else if (wireType === 5) {
        arr.push({ type: 'fixed32', val: data.readUInt32LE(pos) }); pos += 4;
      } else if (wireType === 1) {
        arr.push({ type: 'fixed64', val: Number(data.readBigUInt64LE(pos)) }); pos += 8;
      } else break;
    } catch { break; }
  }
  return fields;
}

function _protoStr(fields: ProtoFields, n: number): string | undefined {
  const arr = fields.get(n);
  if (!arr) return undefined;
  for (const e of arr) {
    if (e.type === 'bytes') {
      try { return (e.val as Buffer).toString('utf8'); } catch { /* skip */ }
    }
  }
  return undefined;
}

function _protoInt(fields: ProtoFields, n: number): number | undefined {
  return (fields.get(n)?.[0]?.val as number | undefined);
}

function _protoSub(fields: ProtoFields, n: number): ProtoFields | undefined {
  const arr = fields.get(n);
  if (!arr) return undefined;
  for (const e of arr) {
    if (e.type === 'bytes') {
      try { return _decodeProto(e.val as Buffer); } catch { /* skip */ }
    }
  }
  return undefined;
}

/**
 * 多通道配额获取器
 *
 * 通道 E: 读取 windsurfAuthStatus.userStatusProtoBinaryBase64 (protobuf)
 *         - 最高优先级：零网络依赖，实时数据（Windsurf 在每次 RPC 后更新）
 *         - 只能获取当前登录用户的配额
 *         - 字段映射: outer[7]=email, outer[13]=planStatus,
 *                    planStatus[14]=dailyRemainingPct, [15]=weeklyRemainingPct,
 *                    [17]=dailyResetUnix, [18]=weeklyResetUnix
 *
 * 通道 A: 读取 Windsurf IDE 本地 sqlite 存储 (cachedPlanInfo)
 *         - 零网络依赖，但可能过期（不如 Channel E 准确）
 *         - 只能获取当前登录用户的配额
 *
 * 通道 B: Firebase Auth + GetPlanStatus (web-backend.windsurf.com)
 *         - 支持任意账号，需要 Firebase API Key
 *         - 返回实时数据
 *
 * 通道 D: 读取 windsurfAuthStatus.apiKey + 调用 GetUserStatus
 *         - 仅支持旧格式 API Key（非 sk-ws-01- 前缀）
 *         - 新版 Windsurf 的 sk-ws-01 session token 不被服务器接受
 */
export class WindsurfQuotaFetcher {
  private readonly auth: WindsurfAuth;
  private readonly logger: LoggerLike;

  // 结果缓存: accountId → QuotaFetchResult (最多 100 条)
  private cache = new Map<string, QuotaFetchResult>();
  private readonly cacheTtlMs = 5 * 60_000; // 5 分钟
  private readonly cacheMaxSize = 100;
  private readonly languageServerBase = 'https://server.codeium.com';

  public constructor(auth: WindsurfAuth, logger: LoggerLike) {
    this.auth = auth;
    this.logger = logger;
  }

  private cacheSet(accountId: string, result: QuotaFetchResult): void {
    if (this.cache.size >= this.cacheMaxSize && !this.cache.has(accountId)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(accountId, result);
  }

  /**
   * 获取配额 (自动选择最佳通道)
   * 优先级: 缓存 → 通道D(apikey) → 通道A(local) → 通道B(firebase)
   */
  public async fetchQuota(
    accountId: string,
    email: string,
    password: string,
    options?: { forceRefresh?: boolean; preferLocal?: boolean }
  ): Promise<QuotaFetchResult> {
    const { forceRefresh, preferLocal } = options ?? {};

    // 检查缓存
    if (!forceRefresh) {
      const cached = this.cache.get(accountId);
      if (cached && (Date.now() - new Date(cached.fetchedAt).getTime()) < this.cacheTtlMs) {
        return { ...cached, source: 'cache' };
      }
    }

    // 通道 E: userStatusProtoBinaryBase64 proto 解码（最高优先级，实时，离线）
    if (preferLocal !== false) {
      const protoResult = await this.fetchFromLocalProto(email);
      if (protoResult.success && protoResult.planInfo) {
        this.cacheSet(accountId, protoResult);
        return protoResult;
      }
    }

    // 通道 D: windsurfAuthStatus.apiKey → GetUserStatus (实时，无需 Firebase)
    const apikeyResult = await this.fetchFromLocalApiKey(email);
    if (apikeyResult.success && apikeyResult.planInfo) {
      this.cacheSet(accountId, apikeyResult);
      return apikeyResult;
    }

    // 通道 A: 本地 cachedPlanInfo (快速，离线，但可能过期)
    if (preferLocal !== false) {
      const localResult = await this.fetchFromLocal();
      if (localResult.success && localResult.planInfo) {
        this.cacheSet(accountId, localResult);
        return localResult;
      }
    }

    // 通道 B: Firebase Auth + GetPlanStatus (web-backend.windsurf.com)
    const apiResult = await this.fetchFromGetPlanStatus(accountId, email, password);
    if (apiResult.success) {
      this.cacheSet(accountId, apiResult);
    }
    return apiResult;
  }

  /**
   * 批量获取所有账号配额
   */
  public async fetchAllQuotas(
    accounts: Array<{ id: string; email: string; password: string }>
  ): Promise<Map<string, QuotaFetchResult>> {
    const results = new Map<string, QuotaFetchResult>();

    for (const account of accounts) {
      const result = await this.fetchQuota(account.id, account.email, account.password);
      results.set(account.id, result);

      // 避免 rate limit: 每个请求间隔 500ms
      if (accounts.length > 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    return results;
  }

  /**
   * 通道 E: 解码 windsurfAuthStatus.userStatusProtoBinaryBase64
   * 这是 Windsurf 本地存储的实时 UserStatus protobuf，字段经逆向工程验证
   * @param expectedEmail 可选，用于验证解码出的邮箱是否匹配
   */
  public async fetchFromLocalProto(expectedEmail?: string): Promise<QuotaFetchResult> {
    try {
      const dbPath = this.getWindsurfStatePath();
      if (!dbPath) return { success: false, source: 'proto', error: 'Windsurf DB 未找到', fetchedAt: new Date().toISOString() };

      try { await fs.access(dbPath); } catch {
        return { success: false, source: 'proto', error: `DB 文件不存在: ${dbPath}`, fetchedAt: new Date().toISOString() };
      }

      const tmpDb = path.join(os.tmpdir(), `ws_proto_${Date.now()}.db`);
      try { await fs.copyFile(dbPath, tmpDb); } catch {
        return { success: false, source: 'proto', error: 'DB 文件复制失败', fetchedAt: new Date().toISOString() };
      }

      let raw: string;
      try {
        raw = await querySqlite(tmpDb, "SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';");
      } finally {
        await fs.unlink(tmpDb).catch(() => undefined);
      }

      if (!raw) return { success: false, source: 'proto', error: 'windsurfAuthStatus 为空', fetchedAt: new Date().toISOString() };

      const status = JSON.parse(raw) as WindsurfAuthStatus;
      const b64 = status.userStatusProtoBinaryBase64;
      if (!b64) return { success: false, source: 'proto', error: 'userStatusProtoBinaryBase64 字段不存在', fetchedAt: new Date().toISOString() };

      const buf = Buffer.from(b64, 'base64');
      const outer = _decodeProto(buf);

      // outer[7] = userEmail, outer[3] = displayName
      const userEmail = _protoStr(outer, 7) ?? _protoStr(outer, 3);

      if (expectedEmail && userEmail && userEmail.toLowerCase() !== expectedEmail.toLowerCase()) {
        return {
          success: false,
          source: 'proto',
          error: `当前 Windsurf 登录用户 (${userEmail}) 与目标账号 (${expectedEmail}) 不匹配`,
          fetchedAt: new Date().toISOString()
        };
      }

      // outer[13] = planStatus sub-message
      const planStatus = _protoSub(outer, 13);
      if (!planStatus) return { success: false, source: 'proto', error: '未找到 planStatus (field[13])', fetchedAt: new Date().toISOString() };

      // planStatus[1] = planInfo sub-message → [2] = planName
      const planInfoSub = _protoSub(planStatus, 1);
      const planName = planInfoSub ? (_protoStr(planInfoSub, 2) ?? 'Unknown') : 'Unknown';

      const dailyRemainingPercent  = _protoInt(planStatus, 14) ?? 100;
      const weeklyRemainingPercent = _protoInt(planStatus, 15) ?? 100;
      const dailyResetAtUnix       = _protoInt(planStatus, 17) ?? 0;
      const weeklyResetAtUnix      = _protoInt(planStatus, 18) ?? 0;
      const messagesTotal          = _protoInt(planStatus, 8)  ?? 0;
      const flowActionsTotal       = _protoInt(planStatus, 9)  ?? 0;

      // planStatus[2].field[1] = startTimestamp (unix seconds → ms)
      const startSub = _protoSub(planStatus, 2);
      const endSub   = _protoSub(planStatus, 3);
      const startMs  = ((_protoInt(startSub ?? new Map(), 1) ?? 0)) * 1000;
      const endMs    = ((_protoInt(endSub   ?? new Map(), 1) ?? 0)) * 1000;

      const dailyUsedPercent  = 100 - dailyRemainingPercent;
      const weeklyUsedPercent = 100 - weeklyRemainingPercent;
      const usedMessages      = Math.round(messagesTotal * dailyUsedPercent / 100);
      const usedFlowActions   = Math.round(flowActionsTotal * dailyUsedPercent / 100);

      const planInfo: WindsurfPlanInfo = {
        planName,
        startTimestamp: startMs,
        endTimestamp: endMs,
        usage: {
          duration: 0,
          messages: messagesTotal,
          flowActions: flowActionsTotal,
          flexCredits: 0,
          usedMessages,
          usedFlowActions,
          usedFlexCredits: 0,
          remainingMessages: messagesTotal - usedMessages,
          remainingFlowActions: flowActionsTotal - usedFlowActions,
          remainingFlexCredits: 0
        },
        hasBillingWritePermissions: false,
        gracePeriodStatus: 0,
        billingStrategy: 'quota',
        quotaUsage: {
          dailyRemainingPercent,
          weeklyRemainingPercent,
          overageBalanceMicros: 0,
          dailyResetAtUnix,
          weeklyResetAtUnix
        }
      };

      this.logger.info('Quota fetched via local proto (Channel E).', {
        email: userEmail, plan: planName, dailyRemaining: dailyRemainingPercent
      });

      return {
        success: true,
        source: 'proto',
        planInfo,
        userEmail,
        fetchedAt: new Date().toISOString()
      };
    } catch (err) {
      return { success: false, source: 'proto', error: String(err), fetchedAt: new Date().toISOString() };
    }
  }

  /**
   * 通道 D: 读取 windsurfAuthStatus.apiKey，调用 GetUserStatus 获取实时配额
   * @param expectedEmail 可选，用于验证返回的用户邮箱是否匹配
   */
  public async fetchFromLocalApiKey(expectedEmail?: string): Promise<QuotaFetchResult> {
    try {
      const apiKey = await this.readWindsurfApiKey();
      if (!apiKey) {
        return {
          success: false,
          source: 'apikey',
          error: 'windsurfAuthStatus 未找到 apiKey',
          fetchedAt: new Date().toISOString()
        };
      }

      const result = await this.getUserStatus(apiKey);
      if (!result) {
        return {
          success: false,
          source: 'apikey',
          error: 'GetUserStatus 返回空数据',
          fetchedAt: new Date().toISOString()
        };
      }

      const { planInfo, userEmail } = result;

      // 如果指定了 expectedEmail，验证是否匹配
      if (expectedEmail && userEmail && userEmail.toLowerCase() !== expectedEmail.toLowerCase()) {
        return {
          success: false,
          source: 'apikey',
          error: `当前 Windsurf 登录用户 (${userEmail}) 与目标账号 (${expectedEmail}) 不匹配`,
          fetchedAt: new Date().toISOString()
        };
      }

      if (!planInfo) {
        return {
          success: false,
          source: 'apikey',
          error: 'GetUserStatus 未返回 planInfo',
          fetchedAt: new Date().toISOString()
        };
      }

      this.logger.info('Quota fetched via GetUserStatus (apikey channel).', {
        email: userEmail,
        plan: planInfo.planName,
        dailyRemaining: planInfo.quotaUsage?.dailyRemainingPercent
      });

      return {
        success: true,
        source: 'apikey',
        planInfo,
        userEmail,
        fetchedAt: new Date().toISOString()
      };
    } catch (err) {
      return {
        success: false,
        source: 'apikey',
        error: String(err),
        fetchedAt: new Date().toISOString()
      };
    }
  }

  /**
   * 读取 Windsurf 本地 state.vscdb 中 windsurfAuthStatus 的 apiKey
   */
  private async readWindsurfApiKey(): Promise<string | null> {
    const dbPath = this.getWindsurfStatePath();
    if (!dbPath) return null;

    try {
      await fs.access(dbPath);
    } catch {
      this.logger.debug('readWindsurfApiKey: DB file not accessible.', { dbPath });
      return null;
    }

    const tmpDb = path.join(os.tmpdir(), `ws_state_${Date.now()}.db`);
    try {
      await fs.copyFile(dbPath, tmpDb);
    } catch {
      this.logger.debug('readWindsurfApiKey: DB file copy failed.', { dbPath });
      return null;
    }

    try {
      const raw = await querySqlite(tmpDb, "SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';");

      if (!raw) return null;
      const status = JSON.parse(raw) as WindsurfAuthStatus;
      const key = status.apiKey ?? null;
      // sk-ws-01- 是会话 token，无法直接调用 gRPC API（返回 200 空响应）
      // 只有旧格式 key 才可用于 GetUserStatus
      if (key && key.startsWith('sk-ws-01-')) {
        this.logger.debug('windsurfAuthStatus apiKey is sk-ws-01 session token, skipping Channel D.');
        return null;
      }
      return key;
    } catch (err) {
      this.logger.debug('readWindsurfApiKey: SQLite query failed.', { error: String(err) });
      return null;
    } finally {
      await fs.unlink(tmpDb).catch(() => undefined);
    }
  }

  /**
   * 调用 Language Server GetUserStatus API
   */
  private async getUserStatus(apiKey: string): Promise<{ planInfo?: WindsurfPlanInfo; userEmail?: string } | null> {
    const url = `${this.languageServerBase}/exa.language_server_pb.LanguageServerService/GetUserStatus`;
    const body = JSON.stringify({
      metadata: {
        apiKey,
        ideName: 'vscode',
        extensionName: 'codeium.windsurf-windsurf',
        extensionVersion: '1.9.0'
      }
    });

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const req = https.request(
        {
          hostname: urlObj.hostname,
          port: 443,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/connect+json',
            'Connect-Protocol-Version': '1',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 15_000
        },
        res => {
          let chunks = '';
          res.on('data', chunk => { chunks += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(chunks) as GetUserStatusResponse;
              const us = parsed.userStatus;
              if (!us) { resolve(null); return; }

              // 尝试从多个位置提取 planInfo
              let planInfo: WindsurfPlanInfo | undefined =
                us.planInfo ??
                us.planStatus?.planInfo;

              const userEmail = us.userEmail;

              // 如果 planInfo 缺少 quotaUsage 但有 planStatus 里的 credits，构造一个最小 planInfo
              // 注意: 此场景无法推断真实的日/周配额百分比，故不设置 quotaUsage
              // planInfoToRealQuota 的 clampPct 会将缺失的百分比默认为 100（满额），避免误报
              if (!planInfo && us.planStatus) {
                const ps = us.planStatus;
                const msgs = ps.availablePromptCredits ?? 0;
                const flows = ps.availableFlexCredits ?? ps.availableFlowCredits ?? 0;
                planInfo = {
                  planName: 'Pro',
                  startTimestamp: 0,
                  endTimestamp: 0,
                  usage: {
                    duration: 0,
                    messages: msgs,
                    flowActions: flows,
                    flexCredits: 0,
                    usedMessages: 0,
                    usedFlowActions: 0,
                    usedFlexCredits: 0,
                    remainingMessages: msgs,
                    remainingFlowActions: flows,
                    remainingFlexCredits: 0
                  },
                  hasBillingWritePermissions: false,
                  gracePeriodStatus: 0,
                  billingStrategy: 'credits',
                  quotaUsage: {
                    dailyRemainingPercent: 100,   // 无法推断，默认满额避免误报
                    weeklyRemainingPercent: 100,
                    overageBalanceMicros: 0,
                    dailyResetAtUnix: 0,
                    weeklyResetAtUnix: 0
                  }
                };
              }

              resolve({ planInfo, userEmail });
            } catch {
              this.logger.warn('GetUserStatus response not JSON.', { status: res.statusCode, body: chunks.slice(0, 200) });
              resolve(null);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('GetUserStatus 请求超时')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * 通道 A: 从 Windsurf IDE 本地 sqlite 存储读取
   */
  public async fetchFromLocal(): Promise<QuotaFetchResult> {
    try {
      const dbPath = this.getWindsurfStatePath();
      if (!dbPath) {
        return {
          success: false,
          source: 'local',
          error: 'Windsurf 状态数据库未找到',
          fetchedAt: new Date().toISOString()
        };
      }

      // 检查文件是否存在
      try {
        await fs.access(dbPath);
      } catch {
        return {
          success: false,
          source: 'local',
          error: `数据库文件不存在: ${dbPath}`,
          fetchedAt: new Date().toISOString()
        };
      }

      // 使用 sqlite3 CLI 查询 (避免添加 native 依赖)
      const raw = await querySqlite(dbPath, "SELECT value FROM ItemTable WHERE key='windsurf.settings.cachedPlanInfo';");
      let planInfo: WindsurfPlanInfo | null = null;
      if (raw) {
        try {
          planInfo = JSON.parse(raw) as WindsurfPlanInfo;
        } catch {
          throw new Error('cachedPlanInfo JSON 解析失败');
        }
      }

      if (!planInfo) {
        return {
          success: false,
          source: 'local',
          error: '本地缓存中无 planInfo 数据',
          fetchedAt: new Date().toISOString()
        };
      }

      this.logger.info('Quota fetched from local Windsurf storage.', {
        plan: planInfo.planName,
        dailyRemaining: planInfo.quotaUsage?.dailyRemainingPercent
      });

      return {
        success: true,
        source: 'local',
        planInfo,
        fetchedAt: new Date().toISOString()
      };
    } catch (err) {
      return {
        success: false,
        source: 'local',
        error: String(err),
        fetchedAt: new Date().toISOString()
      };
    }
  }

  /**
   * 通道 B: Firebase Auth → GetPlanStatus (web-backend.windsurf.com)
   * 支持任意账号，返回实时 quota 百分比 + 重置时间
   */
  public async fetchFromGetPlanStatus(accountId: string, email: string, password: string): Promise<QuotaFetchResult> {
    try {
      const authResult = await this.auth.signIn(email, password, accountId);
      const planInfo = await this.callGetPlanStatus(authResult.idToken);

      if (planInfo) {
        this.logger.info('Quota fetched via GetPlanStatus (Channel B).', {
          email, plan: planInfo.planName, dailyRemaining: planInfo.quotaUsage?.dailyRemainingPercent
        });
        return { success: true, source: 'api', planInfo, userEmail: email, fetchedAt: new Date().toISOString() };
      }

      return { success: false, source: 'api', error: 'GetPlanStatus 返回空数据', fetchedAt: new Date().toISOString() };
    } catch (err) {
      return { success: false, source: 'api', error: String(err), fetchedAt: new Date().toISOString() };
    }
  }

  /**
   * 调用 web-backend.windsurf.com/GetPlanStatus
   * Content-Type: application/json, 认证: body.auth_token + X-Auth-Token header
   */
  private async callGetPlanStatus(idToken: string): Promise<WindsurfPlanInfo | null> {
    const url = 'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus';
    const body = JSON.stringify({ auth_token: idToken });

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const req = https.request(
        {
          hostname: urlObj.hostname,
          port: 443,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': idToken,
            'Content-Length': Buffer.byteLength(body),
            'User-Agent': 'Mozilla/5.0'
          },
          timeout: 15_000
        },
        res => {
          let chunks = '';
          res.on('data', chunk => { chunks += chunk; });
          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 400) {
                this.logger.warn('GetPlanStatus HTTP error.', { status: res.statusCode, body: chunks.slice(0, 200) });
                resolve(null);
                return;
              }
              const parsed = JSON.parse(chunks) as GetPlanStatusResponse;
              const ps = parsed.planStatus;
              if (!ps) { resolve(null); return; }

              // NOTE: 使用 undefined 表示「API 未返回此字段」，不要默认为 100（否则误导用户）
              const dailyRemainingPercent  = ps.dailyQuotaRemainingPercent;   // undefined = no data
              const weeklyRemainingPercent = ps.weeklyQuotaRemainingPercent;  // undefined = no data
              this.logger.debug('GetPlanStatus raw quota fields.', {
                dailyRemainingPercent: ps.dailyQuotaRemainingPercent,
                weeklyRemainingPercent: ps.weeklyQuotaRemainingPercent,
                planName: ps.planInfo?.planName
              });
              const dailyResetAtUnix  = Number(ps.dailyQuotaResetAtUnix  ?? 0);
              const weeklyResetAtUnix = Number(ps.weeklyQuotaResetAtUnix ?? 0);
              const promptCredits = ps.availablePromptCredits ?? ps.planInfo?.monthlyPromptCredits ?? 0;
              const flowCredits   = ps.availableFlowCredits   ?? ps.planInfo?.monthlyFlowCredits   ?? 0;
              const startMs = ps.planStart ? new Date(ps.planStart).getTime() : 0;
              const endMs   = ps.planEnd   ? new Date(ps.planEnd).getTime()   : 0;
              const planName = ps.planInfo?.planName ?? 'Unknown';

              const usedDailyPct = dailyRemainingPercent !== undefined ? 100 - dailyRemainingPercent : 0;
              const usedPrompt   = Math.round(promptCredits * usedDailyPct / 100);
              const usedFlow     = Math.round(flowCredits   * usedDailyPct / 100);

              resolve({
                planName,
                startTimestamp: startMs,
                endTimestamp: endMs,
                usage: {
                  duration: 0,
                  messages: promptCredits,
                  flowActions: flowCredits,
                  flexCredits: 0,
                  usedMessages: usedPrompt,
                  usedFlowActions: usedFlow,
                  usedFlexCredits: 0,
                  remainingMessages: promptCredits - usedPrompt,
                  remainingFlowActions: flowCredits - usedFlow,
                  remainingFlexCredits: 0
                },
                hasBillingWritePermissions: false,
                gracePeriodStatus: 0,
                billingStrategy: 'quota',
                quotaUsage: {
                  dailyRemainingPercent,
                  weeklyRemainingPercent,
                  overageBalanceMicros: 0,
                  dailyResetAtUnix,
                  weeklyResetAtUnix
                }
              } as WindsurfPlanInfo);
            } catch {
              this.logger.warn('GetPlanStatus response not JSON.', { status: res.statusCode, body: chunks.slice(0, 200) });
              resolve(null);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('GetPlanStatus 请求超时')); });
      req.write(body);
      req.end();
    });
  }

  private getWindsurfStatePath(): string | null {
    const home = os.homedir();
    const appData = process.env.APPDATA;
    const candidates = [
      // macOS
      path.join(home, 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb'),
      // Linux
      path.join(home, '.config', 'Windsurf', 'User', 'globalStorage', 'state.vscdb'),
    ];
    // Windows: only add APPDATA path if it's a real, non-empty value
    if (appData && appData.length > 1) {
      candidates.push(path.join(appData, 'Windsurf', 'User', 'globalStorage', 'state.vscdb'));
    }

    // 按平台返回对应路径（实际存在性在调用处用 fs.access 检查）
    if (process.platform === 'win32') {
      // Windows: 只使用 APPDATA 路径（candidates[2]）；若 APPDATA 未设置则无法确定路径
      if (appData && appData.length > 1) {
        return path.join(appData, 'Windsurf', 'User', 'globalStorage', 'state.vscdb');
      }
      return null;
    }
    if (process.platform === 'darwin') {
      return candidates[0];
    }
    return candidates[1]; // linux
  }

  public clearCache(accountId?: string): void {
    if (accountId) {
      this.cache.delete(accountId);
    } else {
      this.cache.clear();
    }
  }
}
