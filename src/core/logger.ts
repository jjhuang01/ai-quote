import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerLike {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

const LOG_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const LOG_ROTATE_KEEP = 3; // 保留 .1 .2 .3 归档

export class QuoteLogger {
  private readonly channel = vscode.window.createOutputChannel('WindSurf Account Manager');
  private readonly logFilePath: string;
  private rotating = false;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.logFilePath = path.join(context.logUri.fsPath, 'windsurf-account-manager.log');
  }

  public dispose(): void {
    this.channel.dispose();
  }

  public debug(message: string, extra?: Record<string, unknown>): void {
    this.write('debug', message, extra);
  }

  public info(message: string, extra?: Record<string, unknown>): void {
    this.write('info', message, extra);
  }

  public warn(message: string, extra?: Record<string, unknown>): void {
    this.write('warn', message, extra);
  }

  public error(message: string, extra?: Record<string, unknown>): void {
    this.write('error', message, extra);
  }

  public getLogFilePath(): string {
    return this.logFilePath;
  }

  public async getRecentLogs(count = 200): Promise<string> {
    try {
      const content = await fs.readFile(this.logFilePath, 'utf8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      return lines.slice(-count).join('\n');
    } catch {
      return '';
    }
  }

  private write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    const record = {
      level,
      message,
      timestamp: new Date().toISOString(),
      extra: extra ?? {}
    };
    this.channel.appendLine(`[${record.level.toUpperCase()}] ${record.timestamp} ${record.message}`);
    if (extra && Object.keys(extra).length > 0) {
      this.channel.appendLine(JSON.stringify(extra, null, 2));
    }
    void this.persist(record);
  }

  private async persist(record: Record<string, unknown>): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
      await fs.appendFile(this.logFilePath, `${JSON.stringify(record)}\n`, 'utf8');
      void this.rotateIfNeeded();
    } catch {
      this.channel.appendLine('[WARN] Failed to persist structured log record.');
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    if (this.rotating) return;
    try {
      const stat = await fs.stat(this.logFilePath);
      if (stat.size < LOG_MAX_BYTES) return;

      this.rotating = true;

      // 删除最旧的归档
      const oldest = `${this.logFilePath}.${LOG_ROTATE_KEEP}`;
      await fs.unlink(oldest).catch(() => {});

      // 逐级轮转: .2 → .3, .1 → .2, current → .1
      for (let i = LOG_ROTATE_KEEP - 1; i >= 1; i--) {
        const from = `${this.logFilePath}.${i}`;
        const to = `${this.logFilePath}.${i + 1}`;
        await fs.rename(from, to).catch(() => {});
      }

      await fs.rename(this.logFilePath, `${this.logFilePath}.1`).catch(() => {});
    } catch {
      // 轮转失败不阻塞正常日志写入
    } finally {
      this.rotating = false;
    }
  }
}
