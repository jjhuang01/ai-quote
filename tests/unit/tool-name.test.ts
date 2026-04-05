import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createId, generateToolName, isValidToolName, loadOrCreateToolName, rotateToolName } from '../../src/utils/tool-name';

describe('tool-name utilities', () => {
  it('generates a neutral tool name with pattern <4alpha>_<hex8>', () => {
    const name = generateToolName();
    expect(name).toMatch(/^[a-z]{4}_[a-f0-9]{8}$/);
    expect(isValidToolName(name)).toBe(true);
  });

  it('does not contain windsurf or endless in generated name', () => {
    // Run multiple times to ensure no accidental matches
    for (let i = 0; i < 10; i++) {
      const name = generateToolName();
      expect(name).not.toContain('windsurf');
      expect(name).not.toContain('endless');
    }
  });

  it('generates unique ids with prefix', () => {
    expect(createId('msg')).toMatch(/^msg_[a-f0-9]{12}$/);
  });
});

describe('loadOrCreateToolName', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('首次调用：生成新名称并写入文件', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-name-test-'));
    const name = await loadOrCreateToolName(tmpDir);
    expect(name).toMatch(/^[a-z]{4}_[a-f0-9]{8}$/);
    const saved = await fs.readFile(path.join(tmpDir, 'toolName.txt'), 'utf8');
    expect(saved).toBe(name);
  });

  it('二次调用：复用已存储的名称', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-name-test-'));
    const first = await loadOrCreateToolName(tmpDir);
    const second = await loadOrCreateToolName(tmpDir);
    expect(second).toBe(first);
  });

  it('文件内容不符合新格式：重新生成', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-name-test-'));
    await fs.writeFile(path.join(tmpDir, 'toolName.txt'), 'old_invalid_name', 'utf8');
    const name = await loadOrCreateToolName(tmpDir);
    expect(name).toMatch(/^[a-z]{4}_[a-f0-9]{8}$/);
  });

  it('旧格式 windsurf_endless_ 名称：重新生成', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-name-test-'));
    await fs.writeFile(path.join(tmpDir, 'toolName.txt'), 'windsurf_endless_aabbccdd', 'utf8');
    const name = await loadOrCreateToolName(tmpDir);
    expect(name).toMatch(/^[a-z]{4}_[a-f0-9]{8}$/);
    // Must NOT preserve the old windsurf_endless_ format
    expect(name).not.toContain('windsurf');
  });

  it('文件内容为空字符串：重新生成', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-name-test-'));
    await fs.writeFile(path.join(tmpDir, 'toolName.txt'), '   ', 'utf8');
    const name = await loadOrCreateToolName(tmpDir);
    expect(name).toMatch(/^[a-z]{4}_[a-f0-9]{8}$/);
  });
});

describe('rotateToolName', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('总是生成新名称并覆盖文件', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-name-rotate-'));
    const first = await loadOrCreateToolName(tmpDir);
    const rotated = await rotateToolName(tmpDir);
    expect(rotated).toMatch(/^[a-z]{4}_[a-f0-9]{8}$/);
    // 名称可能相同（极低概率），但文件应被更新
    const saved = await fs.readFile(path.join(tmpDir, 'toolName.txt'), 'utf8');
    expect(saved).toBe(rotated);
    // 下次 load 返回旋转后的名称
    const reloaded = await loadOrCreateToolName(tmpDir);
    expect(reloaded).toBe(rotated);
    void first; // first recorded for reference
  });
});
