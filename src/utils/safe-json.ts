import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 文件写入序列化锁：同一路径的写入操作自动排队，防止并发竞态
 * 原子写入：先写 .tmp → rename（大多数文件系统上原子操作）
 * 备份恢复：主文件损坏时自动尝试 .bak
 */
const writeLocks = new Map<string, Promise<void>>();

export async function safeWriteJson(filePath: string, data: unknown): Promise<void> {
  const prev = writeLocks.get(filePath) ?? Promise.resolve();

  // 捕获当前写入的错误，以便向调用方传播
  let writeError: unknown;

  const current = prev.catch(() => { /* 前一次失败不阻塞本次 */ }).then(async () => {
    const dir = path.dirname(filePath);
    const tmpPath = `${filePath}.tmp`;
    const bakPath = `${filePath}.bak`;

    await fs.mkdir(dir, { recursive: true });

    // 写入临时文件
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');

    // 备份当前文件（忽略不存在的情况）
    try {
      await fs.copyFile(filePath, bakPath);
    } catch { /* 首次写入，主文件不存在 */ }

    // 原子替换
    await fs.rename(tmpPath, filePath);
  }).catch((err: unknown) => { writeError = err; });

  writeLocks.set(filePath, current);
  await current;

  // 链已安全续接，但写入错误必须上报给调用方
  if (writeError) throw writeError;
}

export async function safeReadJson<T>(filePath: string): Promise<T | undefined> {
  // 优先读主文件，损坏则尝试备份
  for (const p of [filePath, `${filePath}.bak`]) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      return JSON.parse(raw) as T;
    } catch { continue; }
  }
  return undefined;
}
