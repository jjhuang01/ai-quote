import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { safeWriteJson, safeReadJson } from "../utils/safe-json";
import type {
  WindsurfAccount,
  AutoSwitchConfig,
  QuotaSnapshot,
  AccountQuota,
  RealQuotaInfo,
} from "./contracts";
import { DEFAULT_AUTO_SWITCH, DEFAULT_QUOTA } from "./contracts";
import type { LoggerLike } from "./logger";
import { WindsurfAuth } from "../adapters/windsurf-auth";
import { WindsurfQuotaFetcher } from "../adapters/quota-fetcher";
import type { WindsurfPlanInfo } from "../adapters/quota-fetcher";

const WINDSURF_API_SERVER = "https://server.codeium.com";

/**
 * 运行时发现 Windsurf 原生的 auth 命令（无需补丁）
 * Windsurf 内部命令名由 metadata 动态生成，通过模式匹配获取
 */
async function findWindsurfAuthCommand(): Promise<string | undefined> {
  const cmds = await vscode.commands.getCommands(true);
  return cmds.find(
    (c) =>
      c.toLowerCase().includes('provideauthtokentoauthprovider') &&
      !c.toLowerCase().includes('shit'),
  );
}

export interface SwitchResult {
  success: boolean;
  error?: string;
}

export class WindsurfAccountManager {
  private readonly filePath: string;
  private accounts: WindsurfAccount[] = [];
  private currentAccountId?: string;
  private pendingSwitchId?: string;
  private autoSwitch: AutoSwitchConfig = { ...DEFAULT_AUTO_SWITCH };
  private readonly logger: LoggerLike;
  private readonly auth: WindsurfAuth;
  private readonly quotaFetcher: WindsurfQuotaFetcher;
  private _quotaFetching = false;

  public constructor(context: vscode.ExtensionContext, logger: LoggerLike) {
    this.filePath = path.join(
      context.globalStorageUri.fsPath,
      "windsurf-accounts.json",
    );
    this.logger = logger;
    this.auth = new WindsurfAuth(logger);
    this.quotaFetcher = new WindsurfQuotaFetcher(this.auth, logger);
  }

  public get isQuotaFetching(): boolean {
    return this._quotaFetching;
  }

  public setFirebaseApiKey(key: string): void {
    this.auth.setApiKey(key);
  }

  public async initialize(): Promise<void> {
    await this.load();
  }

  // --- Query ---

  public getAll(): WindsurfAccount[] {
    return [...this.accounts];
  }

  public getById(id: string): WindsurfAccount | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  public getCurrentAccount(): WindsurfAccount | undefined {
    if (!this.currentAccountId) return undefined;
    return this.accounts.find((a) => a.id === this.currentAccountId);
  }

  public async getRealCurrentAccountId(): Promise<string | undefined> {
    try {
      const result = await this.quotaFetcher.fetchFromLocalProto();
      if (!result.success) return undefined;
      const email = result.userEmail?.toLowerCase();
      if (!email) return undefined;
      const matched = this.accounts.find(
        (a) => a.email.toLowerCase() === email,
      );
      return matched?.id;
    } catch {
      return undefined;
    }
  }

  public getCurrentAccountId(): string | undefined {
    return this.currentAccountId;
  }

  public getAutoSwitchConfig(): AutoSwitchConfig {
    return { ...this.autoSwitch };
  }

  // --- CRUD ---

  public async add(email: string, password: string): Promise<WindsurfAccount> {
    const account: WindsurfAccount = {
      id: `ws_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      email,
      password,
      plan: "Free",
      creditsUsed: 0,
      creditsTotal: 0,
      quota: { ...DEFAULT_QUOTA },
      expiresAt: "",
      isActive: this.accounts.length === 0,
      addedAt: new Date().toISOString(),
    };
    this.accounts.push(account);
    if (account.isActive) {
      this.currentAccountId = account.id;
    }
    await this.save();
    this.logger.info("WindsurfAccount added.", { id: account.id, email });
    return account;
  }

  public async importBatch(
    lines: string,
  ): Promise<{ added: number; skipped: number }> {
    const entries = lines
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Build email lookup Set for O(1) dedup
    const existingEmails = new Set(this.accounts.map((a) => a.email));
    const hadAccounts = this.accounts.length > 0;

    let added = 0;
    let skipped = 0;

    for (const entry of entries) {
      // 分隔符优先级: 连续4+个连字符 > 冒号 > 空格
      // 贪婪匹配连字符：-------（7个）整体作为分隔符，而非只匹配前4个
      const dashMatch = entry.match(/-{4,}/);
      const sep = dashMatch
        ? dashMatch[0]
        : entry.includes(":")
          ? ":"
          : null;
      let email: string;
      let password: string;
      if (sep) {
        const idx = entry.indexOf(sep);
        email = entry.slice(0, idx).trim();
        password = entry.slice(idx + sep.length).trim();
      } else {
        const spaceIdx = entry.indexOf(" ");
        if (spaceIdx <= 0) {
          skipped++;
          continue;
        }
        email = entry.slice(0, spaceIdx).trim();
        password = entry.slice(spaceIdx + 1).trim();
      }
      if (!email || !password) {
        skipped++;
        continue;
      }
      if (existingEmails.has(email)) {
        skipped++;
        continue;
      }
      existingEmails.add(email);
      const account: WindsurfAccount = {
        id: `ws_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        email,
        password,
        plan: "Free",
        creditsUsed: 0,
        creditsTotal: 0,
        quota: { ...DEFAULT_QUOTA },
        expiresAt: "",
        isActive: !hadAccounts && added === 0,
        addedAt: new Date().toISOString(),
      };
      this.accounts.push(account);
      if (account.isActive) {
        this.currentAccountId = account.id;
      }
      added++;
    }

    if (added > 0) {
      await this.save();
    }

    this.logger.info("Batch import done.", { added, skipped });
    return { added, skipped };
  }

  public async update(
    id: string,
    partial: Partial<
      Pick<
        WindsurfAccount,
        | "plan"
        | "creditsUsed"
        | "creditsTotal"
        | "expiresAt"
        | "lastCheckedAt"
        | "quota"
      >
    >,
  ): Promise<boolean> {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return false;
    Object.assign(account, partial);
    await this.save();
    return true;
  }

  public async delete(id: string): Promise<boolean> {
    const index = this.accounts.findIndex((a) => a.id === id);
    if (index === -1) return false;
    this.accounts.splice(index, 1);
    if (this.currentAccountId === id) {
      this.currentAccountId = this.accounts[0]?.id;
    }
    await this.save();
    this.logger.info("WindsurfAccount deleted.", { id });
    return true;
  }

  public async deleteBatch(ids: string[]): Promise<number> {
    const idSet = new Set(ids);
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => !idSet.has(a.id));
    const removed = before - this.accounts.length;
    if (idSet.has(this.currentAccountId ?? "")) {
      this.currentAccountId =
        this.accounts.find((a) => a.isActive)?.id ?? this.accounts[0]?.id;
    }
    if (removed > 0) await this.save();
    this.logger.info("Batch delete done.", { requested: ids.length, removed });
    return removed;
  }

  public async clear(): Promise<void> {
    this.accounts = [];
    this.currentAccountId = undefined;
    await this.save();
  }

  // --- Switch ---

  /**
   * 切换到指定账号，执行真实的 Windsurf session 注入（无补丁方案）
   * 流程: Firebase signIn → 获取 idToken → 调用 Windsurf 原生命令注入 session
   */
  public async switchTo(id: string): Promise<SwitchResult> {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return { success: false, error: "账号不存在" };

    // ── 步骤1: Firebase 登录获取 idToken ──────────────────────────────────
    let idToken: string;
    try {
      const auth = await this.auth.signIn(
        account.email,
        account.password,
        account.id,
      );
      idToken = auth.idToken;
      this.logger.info("Firebase signIn OK for switch.", {
        email: account.email,
      });
    } catch (err) {
      return { success: false, error: `Firebase 登录失败: ${String(err)}` };
    }

    // ── 步骤2: 发现 Windsurf 原生 auth 命令 ──────────────────────────────
    const authCmd = await findWindsurfAuthCommand();
    if (!authCmd) {
      return {
        success: false,
        error: "未找到 Windsurf 认证命令，请确保 Windsurf 已完全加载。",
      };
    }
    this.logger.info("Found Windsurf auth command.", { command: authCmd });

    // ── 步骤3: 注入新 session（不先 logout，避免中断当前会话） ──────────
    try {
      // 传入 idToken，Windsurf 内部 handleAuthToken → registerUser(idToken) 完成注册
      const result = await vscode.commands.executeCommand<{
        session?: unknown;
        error?: unknown;
      }>(authCmd, idToken);
      if (result?.error) {
        this.logger.warn("Windsurf auth command returned error.", { error: result.error });
        return { success: false, error: `Windsurf 认证失败: ${JSON.stringify(result.error)}` };
      }
    } catch (err) {
      return { success: false, error: `Session 注入失败: ${String(err)}` };
    }

    // ── 步骤4: 更新内部状态 ──────────────────────────────────────────────
    // 注: 不需要重启 LS。handleAuthToken 内部已执行:
    //   _cachedSessions=[newSession] + secrets.store + _sessionChangeEmitter.fire
    //   LS 的下一次请求会自动读取新 session。
    this.accounts.forEach((a) => {
      a.isActive = a.id === id;
    });
    this.currentAccountId = id;
    // 清除缓存的 apiKey，下次 quota 获取时会重新通过 registerUser 获取
    account.apiKey = undefined;
    await this.save();
    this.logger.info("Switched to account (no-patch).", { id, email: account.email });
    return { success: true };
  }

  public async autoSwitchIfNeeded(): Promise<boolean> {
    if (!this.autoSwitch.enabled) return false;

    // Refresh currentAccountId from real Windsurf login state
    const realId = await this.getRealCurrentAccountId();
    if (realId && realId !== this.currentAccountId) {
      this.accounts.forEach((a) => {
        a.isActive = a.id === realId;
      });
      this.currentAccountId = realId;
      await this.save();
    }

    const current = this.getCurrentAccount();
    if (!current) return false;

    // ── 判断当前账号是否需要切换 ──────────────────────────────────────────
    const needSwitch = this._accountNeedsSwitch(current);
    if (!needSwitch) return false;

    // ── 找余量充足的候选账号 ──────────────────────────────────────────────
    const next = this.accounts.find((a) => {
      if (a.id === current.id) return false;
      return this._accountHasSufficientQuota(a);
    });

    if (!next) {
      this.logger.warn(
        "Auto-switch: no available account with sufficient quota.",
      );
      return false;
    }

    const switchResult = await this.switchTo(next.id);
    if (!switchResult.success) {
      this.logger.warn("Auto-switch failed.", { error: switchResult.error });
      return false;
    }
    this.logger.info("Auto-switched account.", {
      from: current.id,
      to: next.id,
    });
    return true;
  }

  /**
   * 判断账号是否需要切换（配额不足）
   * 优先使用 realQuota（API 实时数据），fallback 到本地计数器
   */
  private _accountNeedsSwitch(account: WindsurfAccount): boolean {
    const rq = account.realQuota;
    const threshold = this.autoSwitch.threshold;

    if (rq) {
      // realQuota 可用: 优先用百分比判断（quota 制下 remainingMessages 不可靠：
      // Free plan availablePromptCredits=0 导致 remainingMessages=0，但 dailyRemainingPercent=100）
      const hasDailyPct = rq.dailyRemainingPercent >= 0;
      const hasWeeklyPct = rq.weeklyRemainingPercent >= 0;
      const dailyExhausted =
        this.autoSwitch.switchOnDaily &&
        (hasDailyPct
          ? rq.dailyRemainingPercent <= 5
          : rq.billingStrategy === 'credits' && rq.remainingMessages <= threshold);
      const weeklyExhausted =
        this.autoSwitch.switchOnWeekly &&
        hasWeeklyPct &&
        rq.weeklyRemainingPercent <= 5;
      return dailyExhausted || weeklyExhausted;
    }

    // fallback: 本地计数器
    const q = account.quota;
    const dailyRemaining =
      q.dailyLimit > 0 ? q.dailyLimit - q.dailyUsed : Infinity;
    const weeklyRemaining =
      q.weeklyLimit > 0 ? q.weeklyLimit - q.weeklyUsed : Infinity;
    if (
      (this.autoSwitch.switchOnDaily && dailyRemaining <= threshold) ||
      (this.autoSwitch.switchOnWeekly && weeklyRemaining <= threshold)
    ) {
      return true;
    }

    // fallback: 旧 credits 字段
    if (account.creditsTotal > 0) {
      return account.creditsTotal - account.creditsUsed <= threshold;
    }

    return false;
  }

  /**
   * 判断账号是否有足够配额可以切入
   * 优先使用 realQuota，fallback 到本地计数器
   */
  private _accountHasSufficientQuota(account: WindsurfAccount): boolean {
    const rq = account.realQuota;
    const threshold = this.autoSwitch.threshold;

    if (rq) {
      // quota 制下 remainingMessages 不可靠，优先用百分比判断
      const hasDailyPct = rq.dailyRemainingPercent >= 0;
      const dailyOk =
        !this.autoSwitch.switchOnDaily ||
        (hasDailyPct
          ? rq.dailyRemainingPercent > 5
          : rq.billingStrategy === 'credits'
            ? rq.remainingMessages > threshold
            : true);  // 无百分比且非 credits 制，默认允许切入
      const weeklyOk =
        !this.autoSwitch.switchOnWeekly ||
        rq.weeklyRemainingPercent < 0 ||  // -1 = 无数据，不阻止切入
        rq.weeklyRemainingPercent > 5;
      return dailyOk && weeklyOk;
    }

    // fallback: 本地计数器
    const aq = account.quota;
    const dr = aq.dailyLimit > 0 ? aq.dailyLimit - aq.dailyUsed : Infinity;
    const wr = aq.weeklyLimit > 0 ? aq.weeklyLimit - aq.weeklyUsed : Infinity;
    return dr > threshold && wr > threshold;
  }

  public async updateAutoSwitch(
    config: Partial<AutoSwitchConfig>,
  ): Promise<AutoSwitchConfig> {
    this.autoSwitch = { ...this.autoSwitch, ...config };
    await this.save();
    return this.getAutoSwitchConfig();
  }

  // --- Quota Tracking ---

  public async recordPrompt(accountId?: string): Promise<void> {
    const id = accountId ?? this.currentAccountId;
    if (!id) return;
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return;

    this.autoResetIfNeeded(account);
    account.quota.dailyUsed += 1;
    account.quota.weeklyUsed += 1;
    account.creditsUsed += 1;
    account.lastCheckedAt = new Date().toISOString();
    await this.save();
  }

  public async setQuotaLimits(
    id: string,
    dailyLimit: number,
    weeklyLimit: number,
  ): Promise<boolean> {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return false;
    account.quota.dailyLimit = dailyLimit;
    account.quota.weeklyLimit = weeklyLimit;
    if (!account.quota.dailyResetAt) {
      account.quota.dailyResetAt = this.nextDailyReset();
    }
    if (!account.quota.weeklyResetAt) {
      account.quota.weeklyResetAt = this.nextWeeklyReset();
    }
    await this.save();
    return true;
  }

  public getQuotaSnapshots(): QuotaSnapshot[] {
    return this.accounts.map((a) => {
      this.autoResetIfNeeded(a);
      const q = a.quota;
      const rq = a.realQuota;

      // 优先使用真实配额数据计算 warningLevel
      let warningLevel: QuotaSnapshot["warningLevel"] = "ok";
      if (rq) {
        // -1 = API 未返回百分比字段（无数据），不应触发 warning
        if (rq.dailyRemainingPercent >= 0 && rq.dailyRemainingPercent <= 0) warningLevel = "critical";
        else if (rq.dailyRemainingPercent >= 0 && rq.dailyRemainingPercent <= 10) warningLevel = "warn";
        else if (rq.weeklyRemainingPercent >= 0 && rq.weeklyRemainingPercent <= 10) warningLevel = "warn";
      } else {
        const dr = q.dailyLimit > 0 ? q.dailyLimit - q.dailyUsed : 0;
        const wr = q.weeklyLimit > 0 ? q.weeklyLimit - q.weeklyUsed : 0;
        if (q.dailyLimit > 0 && dr <= 0) warningLevel = "critical";
        else if (q.dailyLimit > 0 && dr <= this.autoSwitch.creditWarning)
          warningLevel = "warn";
        else if (q.weeklyLimit > 0 && wr <= this.autoSwitch.creditWarning)
          warningLevel = "warn";
      }

      const dr = q.dailyLimit > 0 ? q.dailyLimit - q.dailyUsed : 0;
      const wr = q.weeklyLimit > 0 ? q.weeklyLimit - q.weeklyUsed : 0;

      return {
        accountId: a.id,
        email: a.email,
        plan: rq?.planName ?? a.plan,
        dailyUsed: q.dailyUsed,
        dailyLimit: q.dailyLimit,
        dailyRemaining: Math.max(0, dr),
        dailyResetIn: rq
          ? this.humanCountdownUnix(rq.dailyResetAtUnix)
          : q.dailyResetAt
            ? this.humanCountdown(q.dailyResetAt)
            : "--",
        weeklyUsed: q.weeklyUsed,
        weeklyLimit: q.weeklyLimit,
        weeklyRemaining: Math.max(0, wr),
        weeklyResetIn: rq
          ? this.humanCountdownUnix(rq.weeklyResetAtUnix)
          : q.weeklyResetAt
            ? this.humanCountdown(q.weeklyResetAt)
            : "--",
        warningLevel,
        real: rq,
      };
    });
  }

  // --- Real Quota Fetching ---

  /**
   * 获取单个账号的真实配额
   */
  public async fetchRealQuota(
    accountId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const id = accountId ?? this.currentAccountId;
    const account = id ? this.accounts.find((a) => a.id === id) : undefined;
    if (!account) {
      return { success: false, error: "账号不存在" };
    }

    this._quotaFetching = true;
    try {
      let result;

      // 有密码 → 优先 Channel B (GetPlanStatus API, 实时数据)
      if (account.password) {
        result = await this.quotaFetcher.fetchFromGetPlanStatus(
          account.id,
          account.email,
          account.password,
        );
      }

      // Channel B 失败或无密码 → 降级到 fetchQuota (E → D → A → B)
      if (!result?.success) {
        result = await this.quotaFetcher.fetchQuota(
          account.id,
          account.email,
          account.password,
          { forceRefresh: true },
        );
      }

      if (result.success && result.planInfo) {
        account.realQuota = this.planInfoToRealQuota(
          result.planInfo,
          result.source,
          result.fetchedAt,
        );
        // cache/proto 数据属于当前 Windsurf 登录账号，不一定是被查询账号
        // 只有 api/apikey 来源才可信地更新 plan
        if (result.source === 'api' || result.source === 'apikey') {
          account.plan = this.validPlan(result.planInfo.planName, account.plan);
        }
        account.lastCheckedAt = result.fetchedAt;
        await this.save();
        return { success: true };
      }

      return { success: false, error: result.error };
    } finally {
      this._quotaFetching = false;
    }
  }

  /**
   * 批量获取所有账号的真实配额
   *
   * 策略:
   * 1. Channel D (apikey) 无邮箱限制调用一次，匹配到对应账号 → 应用实时数据
   * 优先级: Channel B (GetPlanStatus API, 实时) > Channel E/A (本地缓存, 可能过期)
   * Channel E/A 仅用于无密码账号的兜底
   */
  public async fetchAllRealQuotas(): Promise<{
    success: number;
    failed: number;
    errors: string[];
  }> {
    this._quotaFetching = true;
    let success = 0;
    let failed = 0;
    const errors: string[] = [];
    const updatedIds = new Set<string>();

    try {
      // 步骤1: Channel B —— 所有有密码的账号直接走 GetPlanStatus API（实时数据）
      for (const account of this.accounts) {
        if (!account.password) continue;

        const result = await this.quotaFetcher.fetchFromGetPlanStatus(
          account.id,
          account.email,
          account.password,
        );

        if (result.success && result.planInfo) {
          account.realQuota = this.planInfoToRealQuota(
            result.planInfo,
            result.source,
            result.fetchedAt,
          );
          // Channel B source = 'api'，可信更新 plan
          if (result.source === 'api' || result.source === 'apikey') {
            account.plan = this.validPlan(result.planInfo.planName, account.plan);
          }
          account.lastCheckedAt = result.fetchedAt;
          updatedIds.add(account.id);
          success++;
          this.logger.info("Channel B quota applied.", {
            email: account.email,
            daily: result.planInfo.quotaUsage?.dailyRemainingPercent,
          });
        } else {
          this.logger.warn("Channel B failed.", {
            email: account.email,
            error: result.error,
          });
        }

        // 避免 rate limit
        if (this.accounts.length > 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      // 步骤2: 对 Channel B 未覆盖的账号（无密码），降级到 Channel E/A
      for (const account of this.accounts) {
        if (updatedIds.has(account.id)) continue;

        // Channel E (proto) → Channel D (apikey) → Channel A (cachedPlanInfo)
        const result = await this.quotaFetcher.fetchQuota(
          account.id,
          account.email,
          account.password,
          { preferLocal: true },
        );

        if (result.success && result.planInfo) {
          account.realQuota = this.planInfoToRealQuota(
            result.planInfo,
            result.source,
            result.fetchedAt,
          );
          // cache/proto 数据可能属于其他账号，不更新 plan
          if (result.source === 'api' || result.source === 'apikey') {
            account.plan = this.validPlan(result.planInfo.planName, account.plan);
          }
          account.lastCheckedAt = result.fetchedAt;
          updatedIds.add(account.id);
          success++;
          this.logger.info("Fallback quota applied.", {
            email: account.email,
            source: result.source,
          });
        } else {
          failed++;
          errors.push(`${account.email}: ${result.error ?? "未知错误"}`);
        }
      }

      if (success > 0) {
        await this.save();
      }

      return { success, failed, errors };
    } finally {
      this._quotaFetching = false;
    }
  }

  private static readonly VALID_PLANS: ReadonlySet<string> = new Set([
    'Trial', 'Pro', 'Enterprise', 'Free', 'Max', 'Teams'
  ]);

  private validPlan(apiPlanName: string, fallback: WindsurfAccount['plan']): WindsurfAccount['plan'] {
    return WindsurfAccountManager.VALID_PLANS.has(apiPlanName)
      ? (apiPlanName as WindsurfAccount['plan'])
      : fallback;
  }

  private planInfoToRealQuota(
    info: WindsurfPlanInfo,
    source: "local" | "api" | "apikey" | "cache" | "proto",
    fetchedAt: string,
  ): RealQuotaInfo {
    // -1 = API 未返回此字段（无数据），0 = 耗尽，100 = 满额
    const clampPct = (v: number | undefined) =>
      v === undefined ? -1 : Math.max(0, Math.min(100, v));
    return {
      planName: info.planName,
      billingStrategy: info.billingStrategy,
      dailyRemainingPercent: clampPct(info.quotaUsage?.dailyRemainingPercent),
      weeklyRemainingPercent: clampPct(info.quotaUsage?.weeklyRemainingPercent),
      dailyResetAtUnix: info.quotaUsage?.dailyResetAtUnix ?? 0,
      weeklyResetAtUnix: info.quotaUsage?.weeklyResetAtUnix ?? 0,
      messages: info.usage?.messages ?? 0,
      usedMessages: info.usage?.usedMessages ?? 0,
      remainingMessages: info.usage?.remainingMessages ?? 0,
      flowActions: info.usage?.flowActions ?? 0,
      usedFlowActions: info.usage?.usedFlowActions ?? 0,
      remainingFlowActions: info.usage?.remainingFlowActions ?? 0,
      overageBalanceMicros: info.quotaUsage?.overageBalanceMicros ?? 0,
      planEndTimestamp: info.endTimestamp ?? 0,
      fetchedAt,
      source,
    };
  }

  private humanCountdownUnix(unixSeconds: number): string {
    if (!unixSeconds) return "--";
    const ms = unixSeconds * 1000 - Date.now();
    if (ms <= 0) return "即将重置";
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 24) return `${Math.floor(h / 24)}天${h % 24}时`;
    return h > 0 ? `${h}时${m}分` : `${m}分`;
  }

  private autoResetIfNeeded(account: WindsurfAccount): void {
    const now = Date.now();
    if (
      account.quota.dailyResetAt &&
      now >= new Date(account.quota.dailyResetAt).getTime()
    ) {
      account.quota.dailyUsed = 0;
      account.quota.dailyResetAt = this.nextDailyReset();
    }
    if (
      account.quota.weeklyResetAt &&
      now >= new Date(account.quota.weeklyResetAt).getTime()
    ) {
      account.quota.weeklyUsed = 0;
      account.quota.weeklyResetAt = this.nextWeeklyReset();
    }
  }

  private nextDailyReset(): string {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  private nextWeeklyReset(): string {
    const d = new Date();
    const day = d.getDay();
    const daysUntilMonday = day === 0 ? 1 : 8 - day;
    d.setDate(d.getDate() + daysUntilMonday);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  private humanCountdown(isoTarget: string): string {
    const ms = new Date(isoTarget).getTime() - Date.now();
    if (ms <= 0) return "即将重置";
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 24) return `${Math.floor(h / 24)}天${h % 24}时`;
    return h > 0 ? `${h}时${m}分` : `${m}分`;
  }

  // --- Machine ID Reset ---

  public async resetMachineId(): Promise<{
    success: boolean;
    message: string;
  }> {
    const machineIdPaths = [
      path.join(os.homedir(), ".windsurf", "machineid"),
      path.join(os.homedir(), ".config", "windsurf", "machineid"),
      path.join(process.env.APPDATA ?? os.homedir(), "Windsurf", "machineid"),
    ];

    const newId = Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join("");

    for (const p of machineIdPaths) {
      try {
        await fs.access(p);
        await fs.writeFile(p, newId, "utf8");
        this.logger.info("Machine ID reset.", { path: p });
        return { success: true, message: `已重置: ${p}` };
      } catch {
        // file doesn't exist at this path, try next
      }
    }

    return { success: false, message: "未找到 Windsurf machineId 文件" };
  }

  // --- Persistence ---

  // --- Pending Switch (无感切换：reload 后自动恢复) ---

  public getPendingSwitchId(): string | undefined {
    return this.pendingSwitchId;
  }

  public async clearPendingSwitchId(): Promise<void> {
    this.pendingSwitchId = undefined;
    await this.save();
  }

  private async load(): Promise<void> {
    const data = await safeReadJson<{
      accounts: WindsurfAccount[];
      currentId?: string;
      autoSwitch?: AutoSwitchConfig;
      pendingSwitchId?: string;
    }>(this.filePath);
    this.accounts = (data?.accounts ?? []).map((a) => ({
      ...a,
      quota: a.quota
        ? { ...DEFAULT_QUOTA, ...a.quota }
        : { ...DEFAULT_QUOTA },
    }));
    this.currentAccountId = data?.currentId;
    this.autoSwitch = { ...DEFAULT_AUTO_SWITCH, ...(data?.autoSwitch ?? {}) };
    this.pendingSwitchId = data?.pendingSwitchId;
  }

  private async save(): Promise<void> {
    const payload: Record<string, unknown> = {
      accounts: this.accounts,
      currentId: this.currentAccountId,
      autoSwitch: this.autoSwitch,
    };
    if (this.pendingSwitchId) {
      payload.pendingSwitchId = this.pendingSwitchId;
    }
    await safeWriteJson(this.filePath, payload);
  }
}
