import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { safeWriteJson, safeReadJson } from "../utils/safe-json";
import type {
  WindsurfAccount,
  AutoSwitchConfig,
  AutoSwitchResult,
  QuotaSnapshot,
  AccountQuota,
  RealQuotaInfo,
  ImportBatchResult,
  ImportSkipReasons,
} from "./contracts";
import { DEFAULT_AUTO_SWITCH, DEFAULT_QUOTA } from "./contracts";
import type { LoggerLike } from "./logger";
import { WindsurfAuth } from "../adapters/windsurf-auth";
import { WindsurfPatchService } from "../adapters/windsurf-patch";
import { WindsurfQuotaFetcher } from "../adapters/quota-fetcher";
import type { QuotaFetchResult, WindsurfPlanInfo } from "../adapters/quota-fetcher";

const WINDSURF_API_SERVER = "https://server.codeium.com";
const WINDSURF_COMMAND_DISCOVERY_TIMEOUT_MS = 3000;
const WINDSURF_COMMAND_EXECUTION_TIMEOUT_MS = 15000;
const WINDSURF_SWITCH_VERIFY_TIMEOUT_MS = 10000;
const WINDSURF_SWITCH_VERIFY_INTERVAL_MS = 500;
const RELAXED_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

async function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} 超时 (${ms}ms)`));
        }, ms);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * 运行时发现 Windsurf 原生的 auth 命令（无需补丁）
 * Windsurf 内部命令名由 metadata 动态生成，通过模式匹配获取
 */
async function findWindsurfAuthCommand(): Promise<string | undefined> {
  const cmds = await withTimeout(
    vscode.commands.getCommands(true),
    WINDSURF_COMMAND_DISCOVERY_TIMEOUT_MS,
    "发现 Windsurf 认证命令",
  );
  return cmds.find(
    (c) =>
      c.toLowerCase().includes("provideauthtokentoauthprovider") &&
      !c.toLowerCase().includes("shit"),
  );
}

async function findPatchedWindsurfAuthCommand(): Promise<string | undefined> {
  const cmds = await withTimeout(
    vscode.commands.getCommands(true),
    WINDSURF_COMMAND_DISCOVERY_TIMEOUT_MS,
    "发现 Windsurf 补丁认证命令",
  );
  return cmds.find(
    (c) =>
      c.toLowerCase().includes("provideauthtokentoauthprovider") &&
      c.toLowerCase().includes("shit"),
  );
}

export interface SwitchResult {
  success: boolean;
  error?: string;
}

interface PersistedWindsurfAccounts {
  revision?: number;
  updatedAt?: string;
  accounts: WindsurfAccount[];
  currentId?: string;
  autoSwitch?: AutoSwitchConfig;
  pendingSwitchId?: string;
}

interface RuntimeSwitchVerification {
  verified: boolean;
  source?: "local" | "api" | "apikey" | "cache" | "proto" | "authstatus";
  observedEmail?: string;
  error?: string;
}

interface QuotaWriteGuardResult {
  allowed: boolean;
  reason?: string;
}

type AuthFailureCategory =
  | "firebase_device_rate_limited"
  | "credentials_invalid"
  | "windsurf_rate_limited"
  | "generic";

export class WindsurfAccountManager {
  private readonly filePath: string;
  private accounts: WindsurfAccount[] = [];
  private currentAccountId?: string;
  private pendingSwitchId?: string;
  private autoSwitch: AutoSwitchConfig = { ...DEFAULT_AUTO_SWITCH };
  private revision = 0;
  private updatedAt = "";
  private readonly onDidChangeAccountsEmitter = new vscode.EventEmitter<void>();
  private accountsWatcher?: vscode.FileSystemWatcher;
  private watcherDisposables: vscode.Disposable[] = [];
  private readonly logger: LoggerLike;
  private readonly auth: WindsurfAuth;
  private readonly quotaFetcher: WindsurfQuotaFetcher;
  private _quotaFetching = false;
  private _quotaFetchingAll = false;
  private readonly quotaFetchingCounts = new Map<string, number>();
  private lastAutoSwitchResult?: AutoSwitchResult;

  public readonly onDidChangeAccounts = this.onDidChangeAccountsEmitter.event;

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

  public get isQuotaFetchingAll(): boolean {
    return this._quotaFetchingAll;
  }

  public getQuotaFetchingAccountIds(): string[] {
    return [...this.quotaFetchingCounts.entries()]
      .filter(([, count]) => count > 0)
      .map(([accountId]) => accountId);
  }

  public getLastAutoSwitchResult(): AutoSwitchResult | undefined {
    return this.lastAutoSwitchResult;
  }

  private markQuotaFetchStateChanged(): void {
    const nextFetching =
      this._quotaFetchingAll || this.quotaFetchingCounts.size > 0;
    const changed = this._quotaFetching !== nextFetching;
    this._quotaFetching = nextFetching;
    if (changed || this.quotaFetchingCounts.size > 0 || this._quotaFetchingAll) {
      this.onDidChangeAccountsEmitter.fire();
    }
  }

  private beginQuotaFetch(accountIds: string[], all = false): () => void {
    if (all) {
      this._quotaFetchingAll = true;
    }
    for (const accountId of accountIds) {
      this.quotaFetchingCounts.set(
        accountId,
        (this.quotaFetchingCounts.get(accountId) ?? 0) + 1,
      );
    }
    this.markQuotaFetchStateChanged();

    let finished = false;
    return () => {
      if (finished) {
        return;
      }
      finished = true;
      if (all) {
        this._quotaFetchingAll = false;
      }
      for (const accountId of accountIds) {
        const count = this.quotaFetchingCounts.get(accountId) ?? 0;
        if (count <= 1) {
          this.quotaFetchingCounts.delete(accountId);
        } else {
          this.quotaFetchingCounts.set(accountId, count - 1);
        }
      }
      this.markQuotaFetchStateChanged();
    };
  }

  public setFirebaseApiKey(key: string): void {
    this.auth.setApiKey(key);
  }

  public setDebugRawResponses(enabled: boolean): void {
    this.quotaFetcher.setDebugRawResponses(enabled);
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

  public getImmediateCurrentAccountId(): string | undefined {
    return this.pendingSwitchId ?? this.currentAccountId;
  }

  public async getDisplayCurrentAccountId(): Promise<string | undefined> {
    return this.resolveCurrentAccountId({ persistRealMatch: true });
  }

  private async resolveCurrentAccountId(options?: {
    persistRealMatch?: boolean;
  }): Promise<string | undefined> {
    if (this.pendingSwitchId) {
      const pendingId = this.pendingSwitchId;
      void this.getRealCurrentAccountId()
        .then(async (realId) => {
          if (realId === pendingId) {
            await this.finalizePendingSwitch(
              realId,
              options?.persistRealMatch ?? false,
            );
          }
        })
        .catch(() => undefined);
      return pendingId;
    }

    const realId = await this.getRealCurrentAccountId();

    if (this.pendingSwitchId) {
      if (realId === this.pendingSwitchId) {
        await this.finalizePendingSwitch(
          realId,
          options?.persistRealMatch ?? false,
        );
        return realId;
      }
      return this.pendingSwitchId;
    }

    if (realId) {
      if (options?.persistRealMatch && realId !== this.currentAccountId) {
        this.accounts.forEach((account) => {
          account.isActive = account.id === realId;
        });
        this.currentAccountId = realId;
        await this.save();
      }
      return realId;
    }

    return this.currentAccountId;
  }

  private async finalizePendingSwitch(
    settledId: string,
    persist: boolean,
  ): Promise<void> {
    let changed = false;
    if (this.currentAccountId !== settledId) {
      this.currentAccountId = settledId;
      changed = true;
    }
    this.accounts.forEach((account) => {
      const nextActive = account.id === settledId;
      if (account.isActive !== nextActive) {
        account.isActive = nextActive;
        changed = true;
      }
    });
    if (this.pendingSwitchId) {
      this.pendingSwitchId = undefined;
      changed = true;
    }
    if (persist && changed) {
      await this.save();
    }
  }

  private async verifyRuntimeSwitch(
    expectedEmail: string,
    timeoutMs = WINDSURF_SWITCH_VERIFY_TIMEOUT_MS,
  ): Promise<RuntimeSwitchVerification> {
    const deadline = Date.now() + timeoutMs;
    let lastObservedEmail: string | undefined;
    let lastError: string | undefined;

    while (Date.now() <= deadline) {
      const verification = await this.probeRuntimeSwitch(expectedEmail);
      if (verification.verified) {
        return verification;
      }
      lastObservedEmail = verification.observedEmail ?? lastObservedEmail;
      lastError = verification.error ?? lastError;

      if (Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, WINDSURF_SWITCH_VERIFY_INTERVAL_MS),
      );
    }

    return {
      verified: false,
      observedEmail: lastObservedEmail,
      error: lastError,
    };
  }

  private evaluateRuntimeSwitchSource(
    result: Pick<QuotaFetchResult, "source" | "userEmail" | "error">,
    expectedEmail: string,
  ): RuntimeSwitchVerification {
    const expectedRuntimeEmail = expectedEmail.trim().toLowerCase();
    const observedEmailCandidate = result.userEmail?.trim();
    const observedEmail =
      observedEmailCandidate && this.isLikelyEmail(observedEmailCandidate)
        ? observedEmailCandidate
        : undefined;
    const runtimeEmail = observedEmail?.toLowerCase();
    if (runtimeEmail === expectedRuntimeEmail) {
      return {
        verified: true,
        source: result.source,
        observedEmail,
      };
    }

    return {
      verified: false,
      source: result.source,
      observedEmail,
      error: runtimeEmail
        ? `来源 ${result.source} 当前运行时账号仍是 ${observedEmail}`
        : (result.error ?? `来源 ${result.source} 未返回当前账号邮箱`),
    };
  }

  private async probeRuntimeSwitch(
    expectedEmail: string,
  ): Promise<RuntimeSwitchVerification> {
    const authStatusVerification = this.evaluateRuntimeSwitchSource(
      await this.quotaFetcher.fetchCurrentRuntimeUserFromAuthStatus(expectedEmail),
      expectedEmail,
    );
    if (authStatusVerification.verified) {
      return authStatusVerification;
    }

    const protoVerification = this.evaluateRuntimeSwitchSource(
      await this.quotaFetcher.fetchFromLocalProto(),
      expectedEmail,
    );
    if (protoVerification.verified) {
      return protoVerification;
    }

    const apiKeyVerification = this.evaluateRuntimeSwitchSource(
      await this.quotaFetcher.fetchFromLocalApiKey(),
      expectedEmail,
    );
    if (apiKeyVerification.verified) {
      return apiKeyVerification;
    }

    if (authStatusVerification.observedEmail) {
      return authStatusVerification;
    }
    if (apiKeyVerification.observedEmail) {
      return apiKeyVerification;
    }
    if (protoVerification.observedEmail) {
      return protoVerification;
    }
    if (authStatusVerification.error) {
      return authStatusVerification;
    }
    if (apiKeyVerification.error) {
      return apiKeyVerification;
    }

    return protoVerification;
  }

  private async finalizePendingSwitchIfRuntimeMatches(
    expectedId: string,
    persist: boolean,
  ): Promise<boolean> {
    const runtimeId = await this.getRealCurrentAccountId();
    if (runtimeId !== expectedId) {
      return false;
    }
    await this.finalizePendingSwitch(expectedId, persist);
    return true;
  }

  private async commitVerifiedSwitch(
    id: string,
    injectedApiKey?: string,
  ): Promise<void> {
    await this.revalidateBeforeWrite();
    const target = this.accounts.find((account) => account.id === id);
    if (!target) {
      throw new Error("账号不存在");
    }
    this.accounts.forEach((account) => {
      account.isActive = account.id === id;
    });
    this.currentAccountId = id;
    this.pendingSwitchId = undefined;
    if (injectedApiKey !== undefined) {
      target.apiKey = injectedApiKey;
    }
    await this.save();
  }

  private async reconcileSwitchResultWithRuntime(options: {
    id: string;
    email: string;
    fallbackError: string;
    phase: string;
    injectedApiKey?: string;
  }): Promise<SwitchResult> {
    const verification = await this.probeRuntimeSwitch(options.email);
    if (!verification.verified) {
      return { success: false, error: options.fallbackError };
    }

    await this.commitVerifiedSwitch(options.id, options.injectedApiKey);
    this.logger.warn("Recovered switch result from runtime truth.", {
      id: options.id,
      email: options.email,
      phase: options.phase,
      observedEmail: verification.observedEmail,
      fallbackError: options.fallbackError,
    });
    return { success: true };
  }

  private isQuotaResultAssignableToAccount(
    account: WindsurfAccount,
    result: {
      source: "local" | "api" | "apikey" | "cache" | "proto" | "authstatus";
      userEmail?: string;
    },
  ): QuotaWriteGuardResult {
    if (result.source === "api" || result.source === "local") {
      return { allowed: true };
    }

    const observedEmail = result.userEmail?.trim().toLowerCase();
    if (!observedEmail) {
      return {
        allowed: false,
        reason: `来源 ${result.source} 未返回可校验邮箱`,
      };
    }

    if (observedEmail !== account.email.trim().toLowerCase()) {
      return {
        allowed: false,
        reason: `来源 ${result.source} 实际属于 ${result.userEmail}，目标账号是 ${account.email}`,
      };
    }

    return { allowed: true };
  }

  private async resolveRuntimeBackedAccountIdForUsage(): Promise<
    string | undefined
  > {
    const realId = await this.getRealCurrentAccountId();
    if (!realId) {
      return this.currentAccountId;
    }

    if (realId === this.pendingSwitchId) {
      await this.finalizePendingSwitch(realId, false);
      return realId;
    }

    if (realId !== this.currentAccountId) {
      this.accounts.forEach((account) => {
        account.isActive = account.id === realId;
      });
      this.currentAccountId = realId;
      await this.save();
    }

    return realId;
  }

  private classifyAuthFailure(error: string): AuthFailureCategory {
    const normalized = error.toLowerCase();

    if (
      normalized.includes("too_many_attempts_try_later") ||
      normalized.includes("too-many-requests") ||
      normalized.includes("too many requests") ||
      normalized.includes("firautherrorcodetoomanyrequests")
    ) {
      return "firebase_device_rate_limited";
    }

    if (
      normalized.includes("wrong password") ||
      normalized.includes("invalid password") ||
      normalized.includes("invalid login credentials") ||
      normalized.includes("invalid_login_credentials") ||
      normalized.includes("user not found") ||
      normalized.includes("email not found") ||
      normalized.includes("invalid email") ||
      normalized.includes("密码错误") ||
      normalized.includes("账号不存在")
    ) {
      return "credentials_invalid";
    }

    if (
      normalized.includes("rate limit") ||
      normalized.includes("quota exceeded") ||
      normalized.includes("quota exhausted") ||
      normalized.includes("capacity")
    ) {
      return "windsurf_rate_limited";
    }

    return "generic";
  }

  private isAuthRateLimitError(error: unknown): boolean {
    const raw = String(error);
    return (
      this.classifyAuthFailure(raw) === "firebase_device_rate_limited" ||
      raw.toLowerCase().includes("http 429")
    );
  }

  private formatSwitchAuthFailure(error: unknown): string {
    const raw = String(error);
    const category = this.classifyAuthFailure(raw);

    switch (category) {
      case "firebase_device_rate_limited":
        return `登录失败: 检测到 Firebase 登录限流，可能与当前设备标识触发风控有关。可尝试重置机器 ID 后重试；若仍失败，请等待一段时间再试。原始错误: ${raw}`;
      case "credentials_invalid":
        return `登录失败: 账号或密码可能不正确，请先检查凭据是否有效。原始错误: ${raw}`;
      case "windsurf_rate_limited":
        return `登录失败: 当前更像是 Windsurf 服务端限流或额度/容量限制，重置机器 ID 通常无效，建议稍后重试或切换到不消耗额度的模型。原始错误: ${raw}`;
      default:
        return `登录失败: ${raw}`;
    }
  }

  public getAutoSwitchConfig(): AutoSwitchConfig {
    return { ...this.autoSwitch };
  }

  private applyPersistedState(
    data: PersistedWindsurfAccounts | undefined,
  ): void {
    this.accounts = (data?.accounts ?? []).map((a) => ({
      ...a,
      quota: a.quota ? { ...DEFAULT_QUOTA, ...a.quota } : { ...DEFAULT_QUOTA },
    }));
    this.currentAccountId = data?.currentId;
    this.autoSwitch = { ...DEFAULT_AUTO_SWITCH, ...(data?.autoSwitch ?? {}) };
    this.pendingSwitchId = data?.pendingSwitchId;
    this.revision = data?.revision ?? 0;
    this.updatedAt = data?.updatedAt ?? "";
  }

  private async readPersistedState(): Promise<
    PersistedWindsurfAccounts | undefined
  > {
    return safeReadJson<PersistedWindsurfAccounts>(this.filePath);
  }

  private applyDiskState(data: PersistedWindsurfAccounts | undefined): boolean {
    const nextRevision = data?.revision ?? 0;
    if (nextRevision <= this.revision) {
      return false;
    }
    const previousRevision = this.revision;
    this.applyPersistedState(data);
    this.logger.info("Reloaded newer account state from disk.", {
      previousRevision,
      nextRevision,
    });
    return true;
  }

  public async reloadFromDisk(): Promise<boolean> {
    const data = await this.readPersistedState();
    const changed = this.applyDiskState(data);
    if (changed) {
      this.onDidChangeAccountsEmitter.fire();
    }
    return changed;
  }

  private async revalidateBeforeWrite(): Promise<boolean> {
    const data = await this.readPersistedState();
    const changed = this.applyDiskState(data);
    if (changed) {
      this.onDidChangeAccountsEmitter.fire();
    }
    return changed;
  }

  public startWatching(): void {
    if (this.accountsWatcher) return;

    const pattern = new vscode.RelativePattern(
      path.dirname(this.filePath),
      path.basename(this.filePath),
    );
    this.accountsWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const reload = async (): Promise<void> => {
      try {
        await this.reloadFromDisk();
      } catch (error) {
        this.logger.warn("Account sync reload failed.", {
          error: String(error),
        });
      }
    };

    this.watcherDisposables = [
      this.accountsWatcher.onDidChange(() => {
        void reload();
      }),
      this.accountsWatcher.onDidCreate(() => {
        void reload();
      }),
    ];
  }

  public stopWatching(): void {
    this.watcherDisposables.forEach((disposable) => disposable.dispose());
    this.watcherDisposables = [];
    this.accountsWatcher?.dispose();
    this.accountsWatcher = undefined;
  }

  public dispose(): void {
    this.stopWatching();
    this.onDidChangeAccountsEmitter.dispose();
  }

  // --- CRUD ---

  private isLikelyEmail(value: string): boolean {
    return RELAXED_EMAIL_PATTERN.test(value);
  }

  public async add(email: string, password: string): Promise<WindsurfAccount> {
    const reloaded = await this.revalidateBeforeWrite();
    if (reloaded) {
      throw new Error("账号状态已在其他窗口更新，请重试操作");
    }
    if (!this.isLikelyEmail(email)) {
      throw new Error("账号格式无效，请输入合法邮箱");
    }
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

  public async importBatch(lines: string): Promise<ImportBatchResult> {
    const reloaded = await this.revalidateBeforeWrite();
    if (reloaded) {
      throw new Error("账号状态已在其他窗口更新，请重试操作");
    }
    this.logger.info("Batch import started.", {
      lineCount: lines.split("\n").length,
    });
    const entries = lines
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Build email lookup Set for O(1) dedup
    const existingEmails = new Set(this.accounts.map((a) => a.email));
    const hadAccounts = this.accounts.length > 0;

    let added = 0;
    let skipped = 0;
    const skippedReasons: ImportSkipReasons = {
      invalidFormat: 0,
      invalidEmail: 0,
      missingPassword: 0,
      duplicate: 0,
    };

    for (const entry of entries) {
      // 分隔符优先级: 连续4+个连字符 > 冒号 > 空格
      // 贪婪匹配连字符：-------（7个）整体作为分隔符，而非只匹配前4个
      const dashMatch = entry.match(/-{4,}/);
      const sep = dashMatch ? dashMatch[0] : entry.includes(":") ? ":" : null;
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
          skippedReasons.invalidFormat += 1;
          continue;
        }
        email = entry.slice(0, spaceIdx).trim();
        password = entry.slice(spaceIdx + 1).trim();
      }
      if (!email) {
        skipped++;
        skippedReasons.invalidFormat += 1;
        continue;
      }
      if (!this.isLikelyEmail(email)) {
        skipped++;
        skippedReasons.invalidEmail += 1;
        continue;
      }
      if (!password) {
        skipped++;
        skippedReasons.missingPassword += 1;
        continue;
      }
      if (existingEmails.has(email)) {
        skipped++;
        skippedReasons.duplicate += 1;
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

    this.logger.info("Batch import done.", { added, skipped, skippedReasons });
    return { added, skipped, skippedReasons };
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
    await this.revalidateBeforeWrite();
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return false;
    Object.assign(account, partial);
    await this.save();
    return true;
  }

  public async delete(id: string): Promise<boolean> {
    await this.revalidateBeforeWrite();
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
    await this.revalidateBeforeWrite();
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
    await this.revalidateBeforeWrite();
    this.accounts = [];
    this.currentAccountId = undefined;
    await this.save();
  }

  // --- Switch ---

  /**
   * 切换到指定账号，执行真实的 Windsurf session 注入。
   * 优先使用已安装的无感补丁命令直接注入 apiKey session；没有补丁时保留原生命令 fallback。
   */
  public async switchTo(id: string): Promise<SwitchResult> {
    await this.revalidateBeforeWrite();
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return { success: false, error: "账号不存在" };

    const runtimeAlreadyTarget = await this.probeRuntimeSwitch(account.email);
    if (runtimeAlreadyTarget.verified) {
      await this.commitVerifiedSwitch(id);
      this.logger.info(
        "Switch skipped because runtime already matches target account.",
        {
          id,
          email: account.email,
        },
      );
      return { success: true };
    }

    // ── 步骤1: 获取 Windsurf 可消费 auth token ────────────────────────────
    let idToken: string;
    try {
      const auth = await this.auth.signIn(
        account.email,
        account.password,
        account.id,
      );
      idToken = auth.idToken;
      this.logger.info("Windsurf auth token ready for switch.", {
        email: account.email,
        provider: auth.provider ?? "firebase",
      });
    } catch (err) {
      return this.reconcileSwitchResultWithRuntime({
        id,
        email: account.email,
        phase: "auth",
        fallbackError: this.formatSwitchAuthFailure(err),
      });
    }

    // ── 步骤2: 发现 Windsurf session 注入命令 ────────────────────────────
    this.logger.info("Discovering Windsurf auth commands.", {
      email: account.email,
    });
    let patchedAuthCmd: string | undefined;
    let nativeAuthCmd: string | undefined;
    try {
      [patchedAuthCmd, nativeAuthCmd] = await Promise.all([
        findPatchedWindsurfAuthCommand(),
        findWindsurfAuthCommand(),
      ]);
    } catch (err) {
      this.logger.warn("Windsurf auth command discovery failed.", {
        error: String(err),
      });
      return {
        success: false,
        error: `发现 Windsurf 认证命令失败: ${String(err)}`,
      };
    }

    if (!patchedAuthCmd) {
      const patchStatus = await WindsurfPatchService.isPatchApplied();
      if (!patchStatus.applied) {
        this.logger.warn(
          "Windsurf seamless patch is not applied during switch.",
          {
            extensionPath: patchStatus.extensionPath,
            error: patchStatus.error,
          },
        );
        const patchResult = await WindsurfPatchService.checkAndApply(
          this.logger,
        );
        if (patchResult.success && patchResult.needsRestart) {
          return {
            success: false,
            error: "无感补丁已写入，请重启 Windsurf 后再次切换账号。",
          };
        }
        if (!patchResult.success) {
          this.logger.warn("Auto apply Windsurf seamless patch failed.", {
            error: patchResult.error,
            permissionHint: patchResult.permissionHint,
          });
        }
      }
    }

    if (!patchedAuthCmd && !nativeAuthCmd) {
      return {
        success: false,
        error: "未找到 Windsurf 认证命令，请确保 Windsurf 已完全加载。",
      };
    }
    this.logger.info("Found Windsurf auth command.", {
      command: patchedAuthCmd ?? nativeAuthCmd,
      mode: patchedAuthCmd ? "patched" : "native",
    });

    // ── 步骤3: 注入新 session（不先 logout，避免中断当前会话） ──────────
    let injectedApiKey: string | undefined;
    try {
      if (patchedAuthCmd) {
        const registered = await this.auth.registerUser(idToken);
        injectedApiKey = registered.apiKey;
        const result = await withTimeout(
          vscode.commands.executeCommand<{
            session?: unknown;
            error?: unknown;
          }>(patchedAuthCmd, {
            apiKey: registered.apiKey,
            name: registered.name,
            apiServerUrl: registered.apiServerUrl ?? WINDSURF_API_SERVER,
          }),
          WINDSURF_COMMAND_EXECUTION_TIMEOUT_MS,
          "执行 Windsurf 补丁认证命令",
        );
        if (result?.error) {
          this.logger.warn("Windsurf patched auth command returned error.", {
            error: result.error,
          });
          injectedApiKey = undefined;
          if (!nativeAuthCmd) {
            return this.reconcileSwitchResultWithRuntime({
              id,
              email: account.email,
              phase: "patched-command",
              fallbackError: `Windsurf 认证失败: ${JSON.stringify(result.error)}`,
            });
          }
        } else {
          this.logger.info(
            "Injected Windsurf session through patched command.",
            {
              id,
              email: account.email,
            },
          );
        }
      }

      if (!patchedAuthCmd || !injectedApiKey) {
        if (!nativeAuthCmd) {
          return {
            success: false,
            error: "未找到 Windsurf 原生认证命令，且补丁注入未成功。",
          };
        }
        // 传入 token，Windsurf 内部 handleAuthToken → registerUser(token) 完成注册
        const result = await withTimeout(
          vscode.commands.executeCommand<{
            session?: unknown;
            error?: unknown;
          }>(nativeAuthCmd, idToken),
          WINDSURF_COMMAND_EXECUTION_TIMEOUT_MS,
          "执行 Windsurf 原生认证命令",
        );
        if (result?.error) {
          this.logger.warn("Windsurf auth command returned error.", {
            error: result.error,
          });
          return this.reconcileSwitchResultWithRuntime({
            id,
            email: account.email,
            phase: "native-command",
            fallbackError: `Windsurf 认证失败: ${JSON.stringify(result.error)}`,
          });
        }
      }
    } catch (err) {
      if (!patchedAuthCmd || !nativeAuthCmd) {
        return this.reconcileSwitchResultWithRuntime({
          id,
          email: account.email,
          phase: "session-injection",
          fallbackError: `Session 注入失败: ${String(err)}`,
          injectedApiKey,
        });
      }
      this.logger.warn(
        "Patched session injection failed, falling back to native auth command.",
        {
          error: String(err),
        },
      );
      try {
        const result = await withTimeout(
          vscode.commands.executeCommand<{
            session?: unknown;
            error?: unknown;
          }>(nativeAuthCmd, idToken),
          WINDSURF_COMMAND_EXECUTION_TIMEOUT_MS,
          "执行 Windsurf 原生认证命令 fallback",
        );
        if (result?.error) {
          this.logger.warn("Windsurf auth command returned error.", {
            error: result.error,
          });
          return this.reconcileSwitchResultWithRuntime({
            id,
            email: account.email,
            phase: "native-command-fallback",
            fallbackError: `Windsurf 认证失败: ${JSON.stringify(result.error)}`,
          });
        }
        injectedApiKey = undefined;
      } catch (fallbackErr) {
        return this.reconcileSwitchResultWithRuntime({
          id,
          email: account.email,
          phase: "native-command-fallback",
          fallbackError: `Session 注入失败: ${String(err)}; fallback: ${String(fallbackErr)}`,
          injectedApiKey,
        });
      }
    }

    // ── 步骤4: 验证运行时当前账号确实已切换 ───────────────────────────────
    const verification = await this.verifyRuntimeSwitch(account.email);
    if (!verification.verified) {
      this.logger.warn(
        "Windsurf runtime account verification failed after switch.",
        {
          expectedEmail: account.email,
          source: verification.source,
          observedEmail: verification.observedEmail,
          error: verification.error,
        },
      );
      const detail =
        verification.error ??
        (verification.observedEmail
          ? `当前仍检测到 ${verification.observedEmail}`
          : "无法从本地运行时确认当前账号");
      return {
        success: false,
        error: `切换后校验失败：${detail}。为避免账号混乱，本次切换未标记为成功。`,
      };
    }

    // ── 步骤5: 更新内部状态 ──────────────────────────────────────────────
    await this.commitVerifiedSwitch(id, injectedApiKey);
    this.logger.info("Switched to account.", {
      id,
      email: account.email,
      mode: injectedApiKey ? "patched" : "native",
    });
    return { success: true };
  }

  public async autoSwitchIfNeeded(): Promise<boolean> {
    if (!this.autoSwitch.enabled) return false;

    const currentId = await this.resolveCurrentAccountId({
      persistRealMatch: true,
    });
    const current = currentId ? this.getById(currentId) : undefined;
    if (!current) return false;

    // ── 判断当前账号是否需要切换 ──────────────────────────────────────────
    const needSwitch = this._accountNeedsSwitch(current);
    if (!needSwitch) {
      this.lastAutoSwitchResult = {
        triggeredAt: new Date().toISOString(),
        triggered: false,
        fromAccountId: current.id,
        reason: "当前账号配额仍充足",
        success: true,
      };
      return false;
    }

    // ── 找余量充足的候选账号 ──────────────────────────────────────────────
    const next = this.accounts.find((a) => {
      if (a.id === current.id) return false;
      return this._accountHasSufficientQuota(a);
    });

    if (!next) {
      this.logger.warn(
        "Auto-switch: no available account with sufficient quota.",
      );
      this.lastAutoSwitchResult = {
        triggeredAt: new Date().toISOString(),
        triggered: true,
        fromAccountId: current.id,
        reason: "未找到可切入的候选账号",
        success: false,
        message: "自动换号失败：没有可用账号",
      };
      return false;
    }

    const switchResult = await this.switchTo(next.id);
    if (!switchResult.success) {
      this.logger.warn("Auto-switch failed.", { error: switchResult.error });
      this.lastAutoSwitchResult = {
        triggeredAt: new Date().toISOString(),
        triggered: true,
        fromAccountId: current.id,
        toAccountId: next.id,
        reason: switchResult.error ?? "切换失败",
        success: false,
        message: switchResult.error ?? "自动换号失败",
      };
      return false;
    }
    this.logger.info("Auto-switched account.", {
      from: current.id,
      to: next.id,
    });
    this.lastAutoSwitchResult = {
      triggeredAt: new Date().toISOString(),
      triggered: true,
      fromAccountId: current.id,
      toAccountId: next.id,
      reason: "触发自动换号",
      success: true,
      message: "自动换号成功",
    };
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
      // -1 + resetAtUnix > 0 = no data but quota tracked → treat as exhausted
      const dailyExhaustedNoData = !hasDailyPct && rq.dailyResetAtUnix > 0;
      const weeklyExhaustedNoData = !hasWeeklyPct && rq.weeklyResetAtUnix > 0;
      const dailyExhausted =
        this.autoSwitch.switchOnDaily &&
        (dailyExhaustedNoData ||
          (hasDailyPct
            ? rq.dailyRemainingPercent <= 5
            : rq.billingStrategy === "credits" &&
              rq.remainingMessages <= threshold));
      const weeklyExhausted =
        this.autoSwitch.switchOnWeekly &&
        (weeklyExhaustedNoData ||
          (hasWeeklyPct && rq.weeklyRemainingPercent <= 5));
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
      const hasWeeklyPct = rq.weeklyRemainingPercent >= 0;
      // -1 + resetAtUnix > 0 = no data but quota tracked → treat as exhausted
      const dailyExhaustedNoData = !hasDailyPct && rq.dailyResetAtUnix > 0;
      const weeklyExhaustedNoData = !hasWeeklyPct && rq.weeklyResetAtUnix > 0;
      const dailyOk =
        !this.autoSwitch.switchOnDaily ||
        (!dailyExhaustedNoData &&
          (hasDailyPct
            ? rq.dailyRemainingPercent > 5
            : rq.billingStrategy === "credits"
              ? rq.remainingMessages > threshold
              : true)); // 无百分比且非 credits 制且无 reset 时间，默认允许切入
      const weeklyOk =
        !this.autoSwitch.switchOnWeekly ||
        (!weeklyExhaustedNoData &&
          (!hasWeeklyPct || // -1 without reset time = 真的无数据，不阻止切入
            rq.weeklyRemainingPercent > 5));
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
    await this.revalidateBeforeWrite();
    this.autoSwitch = { ...this.autoSwitch, ...config };
    await this.save();
    return this.getAutoSwitchConfig();
  }

  // --- Quota Tracking ---

  public async recordPrompt(accountId?: string): Promise<void> {
    await this.revalidateBeforeWrite();
    const id =
      accountId ?? (await this.resolveRuntimeBackedAccountIdForUsage());
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
    await this.revalidateBeforeWrite();
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
        // -1 = API 未返回百分比字段；但 resetAtUnix > 0 表示配额有跟踪 → 视为耗尽
        const dailyExhaustedNoData =
          rq.dailyRemainingPercent < 0 && rq.dailyResetAtUnix > 0;
        const weeklyExhaustedNoData =
          rq.weeklyRemainingPercent < 0 && rq.weeklyResetAtUnix > 0;
        if (
          dailyExhaustedNoData ||
          (rq.dailyRemainingPercent >= 0 && rq.dailyRemainingPercent <= 0)
        )
          warningLevel = "critical";
        else if (weeklyExhaustedNoData) warningLevel = "critical";
        else if (
          rq.dailyRemainingPercent >= 0 &&
          rq.dailyRemainingPercent <= 10
        )
          warningLevel = "warn";
        else if (
          rq.weeklyRemainingPercent >= 0 &&
          rq.weeklyRemainingPercent <= 10
        )
          warningLevel = "warn";
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

    const endQuotaFetch = this.beginQuotaFetch([account.id]);
    try {
      let result;

      // 单账号刷新优先使用本地可验证通道，只有本地不可用时才触发登录态网络请求。
      result = await this.quotaFetcher.fetchQuota(
        account.id,
        account.email,
        account.password,
        { forceRefresh: true, preferLocal: true },
      );

      if (result.success && result.planInfo) {
        // Revalidate may rebuild this.accounts, so re-find the target after
        await this.revalidateBeforeWrite();
        const target = this.accounts.find((a) => a.id === id);
        if (target) {
          const quotaGuard = this.isQuotaResultAssignableToAccount(
            target,
            result,
          );
          if (!quotaGuard.allowed) {
            this.logger.warn("Rejected quota write for mismatched account.", {
              accountId: target.id,
              email: target.email,
              source: result.source,
              observedEmail: result.userEmail,
              reason: quotaGuard.reason,
            });
            return { success: false, error: quotaGuard.reason };
          }
          target.realQuota = this.planInfoToRealQuota(
            result.planInfo,
            result.source,
            result.fetchedAt,
          );
          // cache/proto 数据属于当前 Windsurf 登录账号，不一定是被查询账号
          // 只有 api/apikey 来源才可信地更新 plan
          if (result.source === "api" || result.source === "apikey") {
            target.plan = this.validPlan(result.planInfo.planName, target.plan);
          }
          target.lastCheckedAt = result.fetchedAt;
          if (id && id === this.pendingSwitchId) {
            await this.finalizePendingSwitchIfRuntimeMatches(id, false);
          }
          await this.save();
        }
        return { success: true };
      }

      return { success: false, error: result.error };
    } finally {
      endQuotaFetch();
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
    const accountIds = this.accounts.map((account) => account.id);
    const endQuotaFetch = this.beginQuotaFetch(accountIds, true);
    let success = 0;
    let failed = 0;
    const errors: string[] = [];
    const updatedIds = new Set<string>();

    try {
      // 步骤1: Channel B —— 有密码账号串行走 GetPlanStatus；一旦遇到登录限流立即停止，避免扩大风控。
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
          if (result.source === "api" || result.source === "apikey") {
            account.plan = this.validPlan(
              result.planInfo.planName,
              account.plan,
            );
          }
          account.lastCheckedAt = result.fetchedAt;
          updatedIds.add(account.id);
          success++;
          this.logger.info("Channel B quota applied.", {
            email: account.email,
            daily: result.planInfo.quotaUsage?.dailyRemainingPercent,
          });
        } else {
          failed++;
          errors.push(`${account.email}: ${result.error ?? "未知错误"}`);
          this.logger.warn("Channel B failed.", {
            email: account.email,
            error: result.error,
          });
          if (this.isAuthRateLimitError(result.error)) {
            errors.push("检测到登录限流，已停止后续账号的网络配额刷新");
            break;
          }
        }

        // 避免 rate limit
        if (this.accounts.length > 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      // 步骤2: 对 Channel B 未覆盖的账号（无密码），降级到 Channel E/A
      for (const account of this.accounts) {
        if (updatedIds.has(account.id)) continue;
        if (account.password) continue;

        // Channel E (proto) → Channel D (apikey) → Channel A (cachedPlanInfo)
        const result = await this.quotaFetcher.fetchQuota(
          account.id,
          account.email,
          account.password,
          { forceRefresh: true, preferLocal: true },
        );

        if (result.success && result.planInfo) {
          const quotaGuard = this.isQuotaResultAssignableToAccount(
            account,
            result,
          );
          if (!quotaGuard.allowed) {
            failed++;
            errors.push(
              `${account.email}: ${quotaGuard.reason ?? "额度来源与账号不匹配"}`,
            );
            this.logger.warn("Skipped quota update for mismatched account.", {
              email: account.email,
              source: result.source,
              observedEmail: result.userEmail,
              reason: quotaGuard.reason,
            });
            continue;
          }
          account.realQuota = this.planInfoToRealQuota(
            result.planInfo,
            result.source,
            result.fetchedAt,
          );
          // cache/proto 数据可能属于其他账号，不更新 plan
          if (result.source === "api" || result.source === "apikey") {
            account.plan = this.validPlan(
              result.planInfo.planName,
              account.plan,
            );
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
      endQuotaFetch();
    }
  }

  private static readonly VALID_PLANS: ReadonlySet<string> = new Set([
    "Trial",
    "Pro",
    "Enterprise",
    "Free",
    "Max",
    "Teams",
  ]);

  private validPlan(
    apiPlanName: string,
    fallback: WindsurfAccount["plan"],
  ): WindsurfAccount["plan"] {
    return WindsurfAccountManager.VALID_PLANS.has(apiPlanName)
      ? (apiPlanName as WindsurfAccount["plan"])
      : fallback;
  }

  private planInfoToRealQuota(
    info: WindsurfPlanInfo,
    source: "local" | "api" | "apikey" | "cache" | "proto" | "authstatus",
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
    const telemetryPaths = await this.findTelemetryStoragePaths();
    const newId = randomBytes(16).toString("hex");
    const updatedTelemetryPaths: string[] = [];

    for (const storagePath of telemetryPaths) {
      try {
        const raw = await fs.readFile(storagePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const telemetry = this.asObject(parsed.telemetry);
        if (!telemetry) continue;

        telemetry.machineId = newId;
        telemetry.macMachineId = newId;
        telemetry.sqmId = newId;
        telemetry.devDeviceId = newId;
        parsed.telemetry = telemetry;

        const backupPath = `${storagePath}.bak-${Date.now()}`;
        await fs.writeFile(backupPath, raw, "utf8");
        await fs.writeFile(
          storagePath,
          JSON.stringify(parsed, null, 2),
          "utf8",
        );
        this.logger.info("Machine ID reset via telemetry storage.", {
          path: storagePath,
          backupPath,
        });
        updatedTelemetryPaths.push(storagePath);
      } catch (error) {
        this.logger.debug("Telemetry machine ID reset skipped.", {
          path: storagePath,
          error: String(error),
        });
      }
    }

    if (updatedTelemetryPaths.length > 0) {
      const targets = updatedTelemetryPaths.map((storagePath) =>
        path.dirname(storagePath),
      );
      return {
        success: true,
        message: `已重置 telemetry 机器标识 (${updatedTelemetryPaths.length} 个): ${targets.join(", ")}`,
      };
    }

    const machineIdPaths = [
      path.join(os.homedir(), ".windsurf", "machineid"),
      path.join(os.homedir(), ".config", "windsurf", "machineid"),
      path.join(process.env.APPDATA ?? os.homedir(), "Windsurf", "machineid"),
    ];

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

  private async findTelemetryStoragePaths(): Promise<string[]> {
    const candidates = this.getTelemetryStorageCandidates();

    const found: string[] = [];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        found.push(candidate);
      } catch {
        // ignore missing candidates
      }
    }
    return found;
  }

  private getTelemetryStorageCandidates(): string[] {
    const appName = vscode.env.appName.toLowerCase();
    const ideOrder = appName.includes("cursor")
      ? ["Cursor", "Windsurf"]
      : ["Windsurf", "Cursor"];
    const candidates: string[] = [];

    for (const ideName of ideOrder) {
      candidates.push(
        path.join(
          os.homedir(),
          "Library/Application Support",
          ideName,
          "User",
          "globalStorage",
          "storage.json",
        ),
        path.join(
          os.homedir(),
          ".config",
          ideName,
          "User",
          "globalStorage",
          "storage.json",
        ),
      );
      if (process.env.APPDATA) {
        candidates.push(
          path.join(
            process.env.APPDATA,
            ideName,
            "User",
            "globalStorage",
            "storage.json",
          ),
        );
      }
    }

    return [...new Set(candidates)];
  }

  private asObject(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    return value as Record<string, unknown>;
  }

  // --- Persistence ---

  // --- Pending Switch (无感切换：reload 后自动恢复) ---

  public getPendingSwitchId(): string | undefined {
    return this.pendingSwitchId;
  }

  public async clearPendingSwitchId(): Promise<void> {
    if (await this.revalidateBeforeWrite()) {
      return;
    }
    this.pendingSwitchId = undefined;
    await this.save();
  }

  private async load(): Promise<void> {
    const data = await this.readPersistedState();
    this.applyPersistedState(data);
  }

  private async save(): Promise<void> {
    const diskState = await this.readPersistedState();
    const diskRevision = diskState?.revision ?? 0;
    if (diskRevision > this.revision) {
      const changed = this.applyDiskState(diskState);
      if (changed) {
        this.onDidChangeAccountsEmitter.fire();
      }
      throw new Error("账号状态已在其他窗口更新，请刷新后重试");
    }

    this.revision += 1;
    this.updatedAt = new Date().toISOString();

    const payload: PersistedWindsurfAccounts = {
      revision: this.revision,
      updatedAt: this.updatedAt,
      accounts: this.accounts,
      currentId: this.currentAccountId,
      autoSwitch: this.autoSwitch,
    };
    if (this.pendingSwitchId) {
      payload.pendingSwitchId = this.pendingSwitchId;
    }
    await safeWriteJson(this.filePath, payload);
    this.onDidChangeAccountsEmitter.fire();
  }
}
