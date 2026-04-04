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

export class EchoLogger {
  private readonly channel = vscode.window.createOutputChannel('AI Echo Rebuild');
  private readonly logFilePath: string;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.logFilePath = path.join(context.logUri.fsPath, 'ai-echo-rebuild.log');
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
    } catch {
      this.channel.appendLine('[WARN] Failed to persist structured log record.');
    }
  }
}
