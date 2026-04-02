import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WindsurfAccount, AutoSwitchConfig, QuotaSnapshot, AccountQuota, RealQuotaInfo } from './contracts';
import { DEFAULT_AUTO_SWITCH, DEFAULT_QUOTA } from './contracts';
import type { LoggerLike } from './logger';
import { WindsurfAuth } from '../adapters/windsurf-auth';
import { WindsurfQuotaFetcher } from '../adapters/quota-fetcher';
import type { WindsurfPlanInfo } from '../adapters/quota-fetcher';

export class WindsurfAccountManager {
  private readonly filePath: string;
  private accounts: WindsurfAccount[] = [];
  private currentAccountId?: string;
  private autoSwitch: AutoSwitchConfig = { ...DEFAULT_AUTO_SWITCH };
  private readonly logger: LoggerLike;
  private readonly auth: WindsurfAuth;
  private readonly quotaFetcher: WindsurfQuotaFetcher;
  private _quotaFetching = false;

  public constructor(context: vscode.ExtensionContext, logger: LoggerLike) {
    this.filePath = path.join(context.globalStorageUri.fsPath, 'windsurf-accounts.json');
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
    return this.accounts.find(a => a.id === id);
  }

  public getCurrentAccount(): WindsurfAccount | undefined {
    if (this.currentAccountId) {
      return this.accounts.find(a => a.id === this.currentAccountId);
    }
    return this.accounts.find(a => a.isActive);
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
      plan: 'Free',
      creditsUsed: 0,
      creditsTotal: 0,
      quota: { ...DEFAULT_QUOTA },
      expiresAt: '',
      isActive: this.accounts.length === 0,
      addedAt: new Date().toISOString()
    };
    this.accounts.push(account);
    if (account.isActive) {
      this.currentAccountId = account.id;
    }
    await this.save();
    this.logger.info('WindsurfAccount added.', { id: account.id, email });
    return account;
  }

  public async importBatch(lines: string): Promise<{ added: number; skipped: number }> {
    const entries = lines
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    let added = 0;
    let skipped = 0;

    for (const entry of entries) {
      const sep = entry.includes('----') ? '----' : entry.includes(':') ? ':' : null;
      let email: string;
      let password: string;
      if (sep) {
        const idx = entry.indexOf(sep);
        email = entry.slice(0, idx).trim();
        password = entry.slice(idx + sep.length).trim();
      } else {
        // 空格分隔: "email password"
        const spaceIdx = entry.indexOf(' ');
        if (spaceIdx <= 0) { skipped++; continue; }
        email = entry.slice(0, spaceIdx).trim();
        password = entry.slice(spaceIdx + 1).trim();
      }
      if (!email || !password) { skipped++; continue; }
      const exists = this.accounts.some(a => a.email === email);
      if (exists) { skipped++; continue; }
      await this.add(email, password);
      added++;
    }

    this.logger.info('Batch import done.', { added, skipped });
    return { added, skipped };
  }

  public async update(id: string, partial: Partial<Pick<WindsurfAccount, 'plan' | 'creditsUsed' | 'creditsTotal' | 'expiresAt' | 'lastCheckedAt' | 'quota'>>): Promise<boolean> {
    const account = this.accounts.find(a => a.id === id);
    if (!account) return false;
    Object.assign(account, partial);
    await this.save();
    return true;
  }

  public async delete(id: string): Promise<boolean> {
    const index = this.accounts.findIndex(a => a.id === id);
    if (index === -1) return false;
    this.accounts.splice(index, 1);
    if (this.currentAccountId === id) {
      this.currentAccountId = this.accounts[0]?.id;
    }
    await this.save();
    this.logger.info('WindsurfAccount deleted.', { id });
    return true;
  }

  public async clear(): Promise<void> {
    this.accounts = [];
    this.currentAccountId = undefined;
    await this.save();
  }

  // --- Switch ---

  public async switchTo(id: string): Promise<boolean> {
    const account = this.accounts.find(a => a.id === id);
    if (!account) return false;
    this.accounts.forEach(a => { a.isActive = a.id === id; });
    this.currentAccountId = id;
    await this.save();
    this.logger.info('Switched to account.', { id, email: account.email });
    return true;
  }

  public async autoSwitchIfNeeded(): Promise<boolean> {
    if (!this.autoSwitch.enabled) return false;
    const current = this.getCurrentAccount();
    if (!current) return false;

    const q = current.quota;
    const dailyRemaining = q.dailyLimit > 0 ? q.dailyLimit - q.dailyUsed : Infinity;
    const weeklyRemaining = q.weeklyLimit > 0 ? q.weeklyLimit - q.weeklyUsed : Infinity;

    const needSwitch =
      (this.autoSwitch.switchOnDaily && dailyRemaining <= this.autoSwitch.threshold) ||
      (this.autoSwitch.switchOnWeekly && weeklyRemaining <= this.autoSwitch.threshold);

    if (!needSwitch) {
      // 回退检查旧 credits 字段
      const legacyRemaining = current.creditsTotal - current.creditsUsed;
      if (current.creditsTotal > 0 && legacyRemaining > this.autoSwitch.threshold) return false;
      if (current.creditsTotal === 0 && !needSwitch) return false;
    }

    const next = this.accounts.find(a => {
      if (a.id === current.id) return false;
      const aq = a.quota;
      const dr = aq.dailyLimit > 0 ? aq.dailyLimit - aq.dailyUsed : Infinity;
      const wr = aq.weeklyLimit > 0 ? aq.weeklyLimit - aq.weeklyUsed : Infinity;
      return dr > this.autoSwitch.threshold && wr > this.autoSwitch.threshold;
    });

    if (!next) {
      this.logger.warn('Auto-switch: no available account with sufficient quota.');
      return false;
    }

    await this.switchTo(next.id);
    this.logger.info('Auto-switched account.', { from: current.id, to: next.id });
    return true;
  }

  public async updateAutoSwitch(config: Partial<AutoSwitchConfig>): Promise<AutoSwitchConfig> {
    this.autoSwitch = { ...this.autoSwitch, ...config };
    await this.save();
    return this.getAutoSwitchConfig();
  }

  // --- Quota Tracking ---

  public async recordPrompt(accountId?: string): Promise<void> {
    const id = accountId ?? this.currentAccountId;
    if (!id) return;
    const account = this.accounts.find(a => a.id === id);
    if (!account) return;

    this.autoResetIfNeeded(account);
    account.quota.dailyUsed += 1;
    account.quota.weeklyUsed += 1;
    account.creditsUsed += 1;
    account.lastCheckedAt = new Date().toISOString();
    await this.save();
  }

  public async setQuotaLimits(id: string, dailyLimit: number, weeklyLimit: number): Promise<boolean> {
    const account = this.accounts.find(a => a.id === id);
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
    return this.accounts.map(a => {
      this.autoResetIfNeeded(a);
      const q = a.quota;
      const rq = a.realQuota;

      // 优先使用真实配额数据计算 warningLevel
      let warningLevel: QuotaSnapshot['warningLevel'] = 'ok';
      if (rq) {
        if (rq.dailyRemainingPercent <= 0) warningLevel = 'critical';
        else if (rq.dailyRemainingPercent <= 10) warningLevel = 'warn';
        else if (rq.weeklyRemainingPercent <= 10) warningLevel = 'warn';
      } else {
        const dr = q.dailyLimit > 0 ? q.dailyLimit - q.dailyUsed : 0;
        const wr = q.weeklyLimit > 0 ? q.weeklyLimit - q.weeklyUsed : 0;
        if (q.dailyLimit > 0 && dr <= 0) warningLevel = 'critical';
        else if (q.dailyLimit > 0 && dr <= this.autoSwitch.creditWarning) warningLevel = 'warn';
        else if (q.weeklyLimit > 0 && wr <= this.autoSwitch.creditWarning) warningLevel = 'warn';
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
          : (q.dailyResetAt ? this.humanCountdown(q.dailyResetAt) : '--'),
        weeklyUsed: q.weeklyUsed,
        weeklyLimit: q.weeklyLimit,
        weeklyRemaining: Math.max(0, wr),
        weeklyResetIn: rq
          ? this.humanCountdownUnix(rq.weeklyResetAtUnix)
          : (q.weeklyResetAt ? this.humanCountdown(q.weeklyResetAt) : '--'),
        warningLevel,
        real: rq
      };
    });
  }

  // --- Real Quota Fetching ---

  /**
   * 获取单个账号的真实配额
   */
  public async fetchRealQuota(accountId?: string): Promise<{ success: boolean; error?: string }> {
    const id = accountId ?? this.currentAccountId;
    const account = id ? this.accounts.find(a => a.id === id) : undefined;
    if (!account) {
      return { success: false, error: '账号不存在' };
    }

    this._quotaFetching = true;
    try {
      let result;

      // 有密码 → 优先 Channel B (GetPlanStatus API, 实时数据)
      if (account.password) {
        result = await this.quotaFetcher.fetchFromGetPlanStatus(
          account.id, account.email, account.password
        );
      }

      // Channel B 失败或无密码 → 降级到 fetchQuota (E → D → A → B)
      if (!result?.success) {
        result = await this.quotaFetcher.fetchQuota(
          account.id, account.email, account.password, { forceRefresh: true }
        );
      }

      if (result.success && result.planInfo) {
        account.realQuota = this.planInfoToRealQuota(result.planInfo, result.source, result.fetchedAt);
        account.plan = (result.planInfo.planName as WindsurfAccount['plan']) || account.plan;
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
  public async fetchAllRealQuotas(): Promise<{ success: number; failed: number; errors: string[] }> {
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
          account.id, account.email, account.password
        );

        if (result.success && result.planInfo) {
          account.realQuota = this.planInfoToRealQuota(result.planInfo, result.source, result.fetchedAt);
          account.plan = (result.planInfo.planName as WindsurfAccount['plan']) || account.plan;
          account.lastCheckedAt = result.fetchedAt;
          updatedIds.add(account.id);
          success++;
          this.logger.info('Channel B quota applied.', { email: account.email, daily: result.planInfo.quotaUsage?.dailyRemainingPercent });
        } else {
          this.logger.warn('Channel B failed.', { email: account.email, error: result.error });
        }

        // 避免 rate limit
        if (this.accounts.length > 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // 步骤2: 对 Channel B 未覆盖的账号（无密码），降级到 Channel E/A
      for (const account of this.accounts) {
        if (updatedIds.has(account.id)) continue;

        // Channel E (proto) → Channel D (apikey) → Channel A (cachedPlanInfo)
        const result = await this.quotaFetcher.fetchQuota(
          account.id, account.email, account.password, { preferLocal: true }
        );

        if (result.success && result.planInfo) {
          account.realQuota = this.planInfoToRealQuota(result.planInfo, result.source, result.fetchedAt);
          account.plan = (result.planInfo.planName as WindsurfAccount['plan']) || account.plan;
          account.lastCheckedAt = result.fetchedAt;
          updatedIds.add(account.id);
          success++;
          this.logger.info('Fallback quota applied.', { email: account.email, source: result.source });
        } else {
          failed++;
          errors.push(`${account.email}: ${result.error ?? '未知错误'}`);
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

  private planInfoToRealQuota(info: WindsurfPlanInfo, source: 'local' | 'api' | 'apikey' | 'cache' | 'proto', fetchedAt: string): RealQuotaInfo {
    return {
      planName: info.planName,
      billingStrategy: info.billingStrategy,
      dailyRemainingPercent: info.quotaUsage?.dailyRemainingPercent ?? 0,
      weeklyRemainingPercent: info.quotaUsage?.weeklyRemainingPercent ?? 0,
      dailyResetAtUnix: info.quotaUsage?.dailyResetAtUnix ?? 0,
      weeklyResetAtUnix: info.quotaUsage?.weeklyResetAtUnix ?? 0,
      messages: info.usage?.messages ?? 0,
      usedMessages: info.usage?.usedMessages ?? 0,
      remainingMessages: info.usage?.remainingMessages ?? 0,
      flowActions: info.usage?.flowActions ?? 0,
      usedFlowActions: info.usage?.usedFlowActions ?? 0,
      remainingFlowActions: info.usage?.remainingFlowActions ?? 0,
      overageBalanceMicros: info.quotaUsage?.overageBalanceMicros ?? 0,
      fetchedAt,
      source
    };
  }

  private humanCountdownUnix(unixSeconds: number): string {
    if (!unixSeconds) return '--';
    const ms = unixSeconds * 1000 - Date.now();
    if (ms <= 0) return '即将重置';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 24) return `${Math.floor(h / 24)}天${h % 24}时`;
    return h > 0 ? `${h}时${m}分` : `${m}分`;
  }

  private autoResetIfNeeded(account: WindsurfAccount): void {
    const now = Date.now();
    if (account.quota.dailyResetAt && now >= new Date(account.quota.dailyResetAt).getTime()) {
      account.quota.dailyUsed = 0;
      account.quota.dailyResetAt = this.nextDailyReset();
    }
    if (account.quota.weeklyResetAt && now >= new Date(account.quota.weeklyResetAt).getTime()) {
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
    if (ms <= 0) return '即将重置';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 24) return `${Math.floor(h / 24)}天${h % 24}时`;
    return h > 0 ? `${h}时${m}分` : `${m}分`;
  }

  // --- Machine ID Reset ---

  public async resetMachineId(): Promise<{ success: boolean; message: string }> {
    const machineIdPaths = [
      path.join(process.env.HOME ?? '~', '.windsurf', 'machineid'),
      path.join(process.env.HOME ?? '~', '.config', 'windsurf', 'machineid'),
      path.join(process.env.APPDATA ?? '', 'Windsurf', 'machineid')
    ];

    const newId = Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    for (const p of machineIdPaths) {
      try {
        await fs.access(p);
        await fs.writeFile(p, newId, 'utf8');
        this.logger.info('Machine ID reset.', { path: p });
        return { success: true, message: `已重置: ${p}` };
      } catch {
        // file doesn't exist at this path, try next
      }
    }

    return { success: false, message: '未找到 Windsurf machineId 文件' };
  }

  // --- Persistence ---

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as {
        accounts: WindsurfAccount[];
        currentId?: string;
        autoSwitch?: AutoSwitchConfig;
      };
      this.accounts = (data.accounts ?? []).map(a => ({
        ...a,
        quota: a.quota ? { ...DEFAULT_QUOTA, ...a.quota } : { ...DEFAULT_QUOTA }
      }));
      this.currentAccountId = data.currentId;
      this.autoSwitch = { ...DEFAULT_AUTO_SWITCH, ...(data.autoSwitch ?? {}) };
    } catch {
      this.accounts = [];
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify({
      accounts: this.accounts,
      currentId: this.currentAccountId,
      autoSwitch: this.autoSwitch
    }, null, 2), 'utf8');
  }
}
