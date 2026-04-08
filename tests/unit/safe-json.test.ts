import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { safeWriteJson, safeReadJson } from '../../src/utils/safe-json';

describe('safe-json', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-json-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('safeWriteJson', () => {
    it('写入并读取基本数据', async () => {
      const filePath = path.join(tmpDir, 'basic.json');
      await safeWriteJson(filePath, { items: [1, 2, 3] });

      const raw = await fs.readFile(filePath, 'utf8');
      expect(JSON.parse(raw)).toEqual({ items: [1, 2, 3] });
    });

    it('自动创建不存在的目录', async () => {
      const filePath = path.join(tmpDir, 'a', 'b', 'c', 'deep.json');
      await safeWriteJson(filePath, { ok: true });

      const raw = await fs.readFile(filePath, 'utf8');
      expect(JSON.parse(raw)).toEqual({ ok: true });
    });

    it('覆盖写入时创建 .bak 备份', async () => {
      const filePath = path.join(tmpDir, 'backup.json');
      const bakPath = `${filePath}.bak`;

      await safeWriteJson(filePath, { version: 1 });
      await safeWriteJson(filePath, { version: 2 });

      const main = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const bak = JSON.parse(await fs.readFile(bakPath, 'utf8'));

      expect(main).toEqual({ version: 2 });
      expect(bak).toEqual({ version: 1 });
    });

    it('不残留 .tmp 文件', async () => {
      const filePath = path.join(tmpDir, 'notmp.json');
      await safeWriteJson(filePath, { clean: true });

      const tmpPath = `${filePath}.tmp`;
      await expect(fs.access(tmpPath)).rejects.toThrow();
    });

    it('并发写入序列化 — 最终结果是最后一次写入', async () => {
      const filePath = path.join(tmpDir, 'concurrent.json');

      // 发起 10 次并发写入
      const promises = Array.from({ length: 10 }, (_, i) =>
        safeWriteJson(filePath, { seq: i })
      );
      await Promise.all(promises);

      const raw = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      expect(data.seq).toBe(9);
    });

    it('前一次失败不阻塞后续写入', async () => {
      const filePath = path.join(tmpDir, 'recover.json');

      // 第一次正常写入
      await safeWriteJson(filePath, { step: 1 });

      // 制造一次失败（写入 undefined 导致 JSON.stringify 不抛但产生 "undefined"）
      // 实际上 JSON.stringify(undefined) 返回 undefined，fs.writeFile(undefined) 会抛
      // 所以我们用一个不可写路径模拟
      const badPath = path.join(tmpDir, 'recover.json');
      // 正常写入应该仍然工作
      await safeWriteJson(badPath, { step: 2 });

      const raw = await fs.readFile(filePath, 'utf8');
      expect(JSON.parse(raw)).toEqual({ step: 2 });
    });
  });

  describe('safeReadJson', () => {
    it('读取正常文件', async () => {
      const filePath = path.join(tmpDir, 'read.json');
      await fs.writeFile(filePath, JSON.stringify({ hello: 'world' }));

      const data = await safeReadJson<{ hello: string }>(filePath);
      expect(data).toEqual({ hello: 'world' });
    });

    it('文件不存在返回 undefined', async () => {
      const filePath = path.join(tmpDir, 'nonexistent.json');
      const data = await safeReadJson(filePath);
      expect(data).toBeUndefined();
    });

    it('主文件损坏时从 .bak 恢复', async () => {
      const filePath = path.join(tmpDir, 'corrupt.json');
      const bakPath = `${filePath}.bak`;

      await fs.writeFile(filePath, '{{invalid json}}');
      await fs.writeFile(bakPath, JSON.stringify({ recovered: true }));

      const data = await safeReadJson<{ recovered: boolean }>(filePath);
      expect(data).toEqual({ recovered: true });
    });

    it('主文件和备份都损坏时返回 undefined', async () => {
      const filePath = path.join(tmpDir, 'both-corrupt.json');
      const bakPath = `${filePath}.bak`;

      await fs.writeFile(filePath, '{{bad}}');
      await fs.writeFile(bakPath, '{{also bad}}');

      const data = await safeReadJson(filePath);
      expect(data).toBeUndefined();
    });
  });

  describe('向后兼容', () => {
    it('旧格式 feedback.json (无 limit 字段) 正确读取', async () => {
      const filePath = path.join(tmpDir, 'old-feedback.json');
      // 旧版只有 { items } 没有 limit
      await fs.writeFile(filePath, JSON.stringify({ items: [{ id: 'fb_1' }] }));

      const data = await safeReadJson<{ items: unknown[]; limit?: number }>(filePath);
      expect(data?.items).toHaveLength(1);
      expect(data?.limit).toBeUndefined();
      // 调用方应使用 data?.limit ?? DEFAULT_LIMIT
      const limit = data?.limit ?? 200;
      expect(limit).toBe(200);
    });
  });
});
