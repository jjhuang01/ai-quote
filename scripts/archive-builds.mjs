#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.cwd();
const ARCHIVES_DIR = path.join(PROJECT_ROOT, 'archives');
const ROOT_DIR = PROJECT_ROOT;

/**
 * 归档现有的 VSIX 文件
 */
async function archiveExistingBuilds() {
  try {
    // 确保归档目录存在
    await fs.mkdir(ARCHIVES_DIR, { recursive: true });

    // 读取根目录下的所有 .vsix 文件
    const files = await fs.readdir(ROOT_DIR);
    const vsixFiles = files.filter(file => file.endsWith('.vsix'));

    if (vsixFiles.length === 0) {
      console.log('📦 没有找到需要归档的 .vsix 文件');
      return;
    }

    // 创建时间戳目录
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archiveSubDir = path.join(ARCHIVES_DIR, timestamp);
    await fs.mkdir(archiveSubDir, { recursive: true });

    console.log(`📦 开始归档 ${vsixFiles.length} 个 .vsix 文件到 ${archiveSubDir}`);

    // 移动文件到归档目录
    for (const file of vsixFiles) {
      const srcPath = path.join(ROOT_DIR, file);
      const destPath = path.join(archiveSubDir, file);
      
      await fs.rename(srcPath, destPath);
      console.log(`  ✓ ${file} -> archives/${timestamp}/`);
    }

    // 创建归档清单
    const manifest = {
      timestamp: new Date().toISOString(),
      count: vsixFiles.length,
      files: vsixFiles,
      directory: `archives/${timestamp}/`
    };

    await fs.writeFile(
      path.join(archiveSubDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    console.log(`✅ 归档完成，清单: archives/${timestamp}/manifest.json`);

  } catch (error) {
    console.error('❌ 归档失败:', error.message);
    process.exit(1);
  }
}

/**
 * 清理旧归档（保留最近 10 个）
 */
async function cleanupOldArchives(keepCount = 10) {
  try {
    const archives = await fs.readdir(ARCHIVES_DIR);
    const archiveDirs = archives
      .filter(name => name !== '.gitkeep')
      .map(name => ({
        name,
        path: path.join(ARCHIVES_DIR, name),
        stat: null
      }));

    // 获取目录创建时间
    for (const archive of archiveDirs) {
      try {
        archive.stat = await fs.stat(archive.path);
      } catch {
        // 忽略无法访问的目录
      }
    }

    // 按时间排序，保留最新的 keepCount 个
    const validArchives = archiveDirs
      .filter(a => a.stat && a.stat.isDirectory())
      .sort((a, b) => b.stat.birthtimeMs - a.stat.birthtimeMs);

    if (validArchives.length <= keepCount) {
      console.log(`📦 归档数量 ${validArchives.length} 未超过保留限制 ${keepCount}`);
      return;
    }

    const toDelete = validArchives.slice(keepCount);
    console.log(`🗑️  清理 ${toDelete.length} 个旧归档（保留最新 ${keepCount} 个）`);

    for (const archive of toDelete) {
      await fs.rm(archive.path, { recursive: true, force: true });
      console.log(`  ✓ 删除: archives/${archive.name}`);
    }

  } catch (error) {
    console.error('❌ 清理归档失败:', error.message);
  }
}

/**
 * 主函数
 */
async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'archive':
      await archiveExistingBuilds();
      break;
    case 'cleanup':
      await cleanupOldArchives();
      break;
    case 'build':
      // 先归档，再构建
      await archiveExistingBuilds();
      await cleanupOldArchives();
      console.log('🔨 开始构建新版本...');
      execSync('npm run build', { stdio: 'inherit' });
      break;
    case 'release':
      // 先归档，再发布
      await archiveExistingBuilds();
      await cleanupOldArchives();
      console.log('🚀 开始发布新版本...');
      execSync('npm run release', { stdio: 'inherit' });
      break;
    default:
      console.log(`
用法: node scripts/archive-builds.mjs <command>

命令:
  archive    - 归档现有的 .vsix 文件
  cleanup    - 清理旧归档（保留最新 10 个）
  build      - 归档旧文件后构建新版本
  release    - 归档旧文件后发布新版本

示例:
  node scripts/archive-builds.mjs archive
  node scripts/archive-builds.mjs release
      `);
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
