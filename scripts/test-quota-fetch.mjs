#!/usr/bin/env node
/**
 * 测试脚本: 从 Windsurf 本地存储读取真实配额数据
 * 用法: node scripts/test-quota-fetch.mjs
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DB_PATH = join(homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb');

async function fetchLocalQuota() {
  console.log('📍 数据库路径:', DB_PATH);

  try {
    await access(DB_PATH);
    console.log('✅ 数据库文件存在');
  } catch {
    console.error('❌ 数据库文件不存在');
    return;
  }

  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      [DB_PATH, "SELECT value FROM ItemTable WHERE key='windsurf.settings.cachedPlanInfo';"],
      { timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error('❌ sqlite3 查询失败:', stderr || err.message);
          resolve(null);
          return;
        }
        const raw = stdout.trim();
        if (!raw) {
          console.log('⚠️ cachedPlanInfo 为空');
          resolve(null);
          return;
        }
        try {
          const info = JSON.parse(raw);
          console.log('\n🎯 真实配额数据:');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(`  套餐:        ${info.planName}`);
          console.log(`  计费策略:    ${info.billingStrategy}`);
          console.log('');
          console.log('  📊 使用量:');
          console.log(`    消息:      ${info.usage.usedMessages} / ${info.usage.messages} (剩余 ${info.usage.remainingMessages})`);
          console.log(`    Flow:      ${info.usage.usedFlowActions} / ${info.usage.flowActions} (剩余 ${info.usage.remainingFlowActions})`);
          console.log(`    Flex额度:  ${info.usage.usedFlexCredits} / ${info.usage.flexCredits}`);
          console.log('');
          console.log('  📈 配额:');
          console.log(`    日配额剩余: ${info.quotaUsage.dailyRemainingPercent}%`);
          console.log(`    周配额剩余: ${info.quotaUsage.weeklyRemainingPercent}%`);
          const dailyReset = new Date(info.quotaUsage.dailyResetAtUnix * 1000);
          const weeklyReset = new Date(info.quotaUsage.weeklyResetAtUnix * 1000);
          console.log(`    日重置时间: ${dailyReset.toLocaleString()}`);
          console.log(`    周重置时间: ${weeklyReset.toLocaleString()}`);
          console.log(`    超额费用:  $${(info.quotaUsage.overageBalanceMicros / 1_000_000).toFixed(2)}`);
          console.log('');
          const start = new Date(info.startTimestamp);
          const end = new Date(info.endTimestamp);
          console.log(`  📅 周期: ${start.toLocaleDateString()} ~ ${end.toLocaleDateString()}`);
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('\n✅ 本地配额读取成功 (通道 A 验证通过)');
          resolve(info);
        } catch (e) {
          console.error('❌ JSON 解析失败:', e.message);
          resolve(null);
        }
      }
    );
  });
}

// 同时检查 auth 状态
async function fetchAuthStatus() {
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      [DB_PATH, "SELECT key FROM ItemTable WHERE key LIKE '%windsurf_auth%' OR key LIKE '%Auth%' LIMIT 20;"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const keys = stdout.trim().split('\n').filter(Boolean);
        if (keys.length > 0) {
          console.log('\n🔑 发现的认证相关 keys:');
          keys.forEach(k => console.log(`  - ${k}`));
        }
        resolve(keys);
      }
    );
  });
}

console.log('🚀 Windsurf 配额获取测试\n');
await fetchLocalQuota();
await fetchAuthStatus();
