import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AccountInfo, AccountStats } from './contracts';
import type { LoggerLike } from './logger';

export class AccountManager {
  private readonly accountFile: string;
  private accounts: AccountInfo[] = [];
  private currentAccountId?: string;
  private readonly logger: LoggerLike;

  public constructor(context: vscode.ExtensionContext, logger: LoggerLike) {
    this.accountFile = path.join(context.globalStorageUri.fsPath, 'accounts.json');
    this.logger = logger;
  }

  public async initialize(): Promise<void> {
    await this.load();
  }

  public async addAccount(account: Omit<AccountInfo, 'id' | 'createdAt'>): Promise<AccountInfo> {
    const newAccount: AccountInfo = {
      ...account,
      id: this.generateId(),
      createdAt: new Date().toISOString()
    };
    this.accounts.push(newAccount);
    await this.save();
    this.logger.info('Account added.', { id: newAccount.id, provider: newAccount.provider });
    return newAccount;
  }

  public getCurrentAccount(): AccountInfo | undefined {
    if (!this.currentAccountId) {
      return this.accounts[0];
    }
    return this.accounts.find(a => a.id === this.currentAccountId);
  }

  public setCurrentAccount(id: string): boolean {
    const account = this.accounts.find(a => a.id === id);
    if (!account) {
      return false;
    }
    this.currentAccountId = id;
    return true;
  }

  public getAll(): AccountInfo[] {
    return [...this.accounts];
  }

  public getById(id: string): AccountInfo | undefined {
    return this.accounts.find(a => a.id === id);
  }

  public async updateLastLogin(id: string): Promise<void> {
    const account = this.accounts.find(a => a.id === id);
    if (account) {
      account.lastLoginAt = new Date().toISOString();
      await this.save();
    }
  }

  public async removeAccount(id: string): Promise<boolean> {
    const index = this.accounts.findIndex(a => a.id === id);
    if (index === -1) {
      return false;
    }
    this.accounts.splice(index, 1);
    if (this.currentAccountId === id) {
      this.currentAccountId = this.accounts[0]?.id;
    }
    await this.save();
    this.logger.info('Account removed.', { id });
    return true;
  }

  public getStats(): AccountStats {
    // TODO: 实现真实统计
    return {
      totalConversations: 0,
      totalMessages: 0,
      totalFeedback: 0,
      lastActiveAt: this.accounts.reduce((latest, a) => {
        const lastLogin = a.lastLoginAt;
        if (!lastLogin) return latest;
        if (!latest) return lastLogin;
        return lastLogin > latest ? lastLogin : latest;
      }, undefined as string | undefined)
    };
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.accountFile, 'utf8');
      const data = JSON.parse(raw) as { accounts: AccountInfo[]; currentId?: string };
      this.accounts = data.accounts ?? [];
      this.currentAccountId = data.currentId;
    } catch {
      this.accounts = [];
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.accountFile), { recursive: true });
    const data = {
      accounts: this.accounts,
      currentId: this.currentAccountId
    };
    await fs.writeFile(this.accountFile, JSON.stringify(data, null, 2), 'utf8');
  }

  private generateId(): string {
    return `acc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

// Windsurf 账户管理器 - 从原始插件推断
export class WindsurfAccountManager {
  private readonly logger: LoggerLike;

  public constructor(logger: LoggerLike) {
    this.logger = logger;
  }

  public async getAccount(): Promise<AccountInfo | undefined> {
    // TODO: 实现 Windsurf 账户获取逻辑
    this.logger.debug('WindsurfAccountManager.getAccount called');
    return undefined;
  }

  public async refreshAccount(): Promise<void> {
    // TODO: 实现 Windsurf 账户刷新逻辑
    this.logger.debug('WindsurfAccountManager.refreshAccount called');
  }
}
