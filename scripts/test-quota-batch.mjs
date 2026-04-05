#!/usr/bin/env node
/**
 * scripts/test-quota-batch.mjs
 *
 * 批量测试 10 个 Windsurf 账号配额（Channel B: Firebase → GetPlanStatus）
 * 结果写入 logs/quota-test-<date>.json，终端输出可用/不可用汇总
 *
 * 使用方法:
 *   node scripts/test-quota-batch.mjs
 */

import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Firebase API Key (Channel B) ─────────────────────────────────────
const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';

// ── 抽样账号（来自 orders_2026-04-04.txt） ─────────────────────────
// 注意：dailyQuotaRemainingPercent = 剩余 %（非使用 %）
//   100 = 从未使用（全新账号）→ 可用 ✅
//   89  = 已使用 11%（89% 剩余）→ 可用 ✅
//   0   = 完全耗尽（0% 剩余）  → 不可用 ❌
const ACCOUNTS = [
  // ── 截图账号（用于与 Windsurf Plan Info 页对比验证）
  { email: 's1z6pkws4k@zyqwotq.shop',   password: 'br07zq5',       order: 'WEB20260402CFAT1SC5' },
  { email: 'elzkuhyfd6@gicnsjt.shop',   password: '96ahf4w9',      order: 'WEB20260402QYA87R14' },
  { email: 'v3g6r80qyu@zmshgwp.shop',   password: 'wt2got22q',     order: 'WEB202604024REELFKZ' },
  { email: 'rg307927xo@bukvofm.shop',   password: 'sm4i43z',       order: 'WEB202604029T50SBAB' },
  { email: '0gqvqg29pj@nqfffca.shop',   password: 'ca3798d1wb',    order: 'WEB20260402J908DZ8Z' },
  // ── 新购账号
  { email: '7sbgxp5lpu@pqubzct.shop',   password: 'mk765ww4i1',    order: 'WEB20260404VFXH7YRT' },
  { email: 'x4bbzla7bi@fvdcfqr.shop',   password: '3bm0o7lhf7',    order: 'WEB20260404U5BQ20J8' },
  { email: '2uyk6zvfys@fwqzotl.shop',   password: '471n4odwr3',     order: 'WEB202604036H4L0XR6' },
  { email: 'yyegiz17p3@nzccmyq.shop',   password: 'e140bjs4k6k',   order: 'WEB20260403F9I062XM' },
  { email: '99x2iz2zlz@palcbhk.shop',   password: '0b0b5hny45',    order: 'WEB202604038E74QT3N' },
];

// ── HTTP helpers ────────────────────────────────────────────────────
function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyBuf = Buffer.from(body, 'utf8');
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        'User-Agent': 'Mozilla/5.0',
        ...headers,
      },
      timeout: 15_000,
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

// ── Channel B step 1: Firebase signIn ───────────────────────────────
async function firebaseSignIn(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
  const res = await httpsPost(url, JSON.stringify({ email, password, returnSecureToken: true }));
  if (res.status >= 400) {
    const err = JSON.parse(res.body)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Firebase signIn failed: ${err}`);
  }
  const data = JSON.parse(res.body);
  if (!data.idToken) throw new Error('Firebase returned no idToken');
  return data.idToken;
}

// ── Channel B step 2: GetPlanStatus ────────────────────────────────
async function getPlanStatus(idToken) {
  const url = 'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus';
  const res = await httpsPost(
    url,
    JSON.stringify({ auth_token: idToken }),
    { 'X-Auth-Token': idToken }
  );
  if (res.status >= 400) throw new Error(`GetPlanStatus HTTP ${res.status}`);
  const data = JSON.parse(res.body);
  return data.planStatus ?? null;
}

// ── Classify usability ──────────────────────────────────────────────
function classify(ps) {
  if (!ps) return 'no_data';
  const daily  = ps.dailyQuotaRemainingPercent;
  const weekly = ps.weeklyQuotaRemainingPercent;
  if (daily === undefined && weekly === undefined) return 'no_data';
  if ((daily ?? 100) <= 0 && (weekly ?? 100) <= 0) return 'exhausted';
  if ((daily ?? 100) <= 10 || (weekly ?? 100) <= 10) return 'low';
  return 'usable';
}

// ── Main ─────────────────────────────────────────────────────────────
const results = [];
const __dir = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dir, '..', 'logs');

console.log(`\n🔍 Windsurf 账号配额批量检测 (Channel B · ${ACCOUNTS.length} 个账号)\n`);
console.log('─'.repeat(72));

for (const acc of ACCOUNTS) {
  process.stdout.write(`  ${acc.email.padEnd(38)} `);
  const row = {
    email: acc.email,
    order: acc.order,
    status: 'unknown',
    dailyRemainingPercent: null,
    weeklyRemainingPercent: null,
    planName: null,
    planEnd: null,
    error: null,
    testedAt: new Date().toISOString(),
  };

  try {
    const idToken = await firebaseSignIn(acc.email, acc.password);
    const ps = await getPlanStatus(idToken);

    if (ps) {
      row.dailyRemainingPercent  = ps.dailyQuotaRemainingPercent  ?? null;
      row.weeklyRemainingPercent = ps.weeklyQuotaRemainingPercent ?? null;
      row.planName = ps.planInfo?.planName ?? null;
      row.planEnd  = ps.planEnd ?? null;
      // 保留完整原始响应供调试
      row.rawPlanStatus = ps;
      row.status   = classify(ps);
    } else {
      row.status = 'no_data';
    }

    // 转为已用 % 输出（与 Windsurf UI "Daily quota usage: X%" 一致）
    const dailyUsed   = row.dailyRemainingPercent  !== null ? 100 - row.dailyRemainingPercent  : null;
    const weeklyUsed  = row.weeklyRemainingPercent !== null ? 100 - row.weeklyRemainingPercent : null;
    const dailyStr    = dailyUsed  !== null ? `日已用${dailyUsed}%`  : '日—';
    const weeklyStr   = weeklyUsed !== null ? `周已用${weeklyUsed}%` : '周—';
    const promptLeft  = row.rawPlanStatus?.availablePromptCredits ?? '?';
    const flowLeft    = row.rawPlanStatus?.availableFlowCredits   ?? '?';
    const statusIcon = {
      usable:   '✅',
      low:      '⚠️ ',
      exhausted:'❌',
      no_data:  '❓',
    }[row.status] ?? '?';
    const endStr = row.planEnd ? ` 到期${new Date(row.planEnd).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}` : '';
    console.log(`${statusIcon} ${dailyStr.padEnd(10)} ${weeklyStr.padEnd(10)} prompt:${String(promptLeft).padEnd(5)} flow:${String(flowLeft).padEnd(5)}${endStr}`);
  } catch (err) {
    row.status = 'error';
    row.error  = err.message;
    console.log(`💥 ${err.message.slice(0, 50)}`);
  }

  results.push(row);

  // 防 rate-limit
  if (ACCOUNTS.indexOf(acc) < ACCOUNTS.length - 1) {
    await new Promise(r => setTimeout(r, 600));
  }
}

// ── Summary ────────────────────────────────────────────────────────
const usable   = results.filter(r => r.status === 'usable').length;
const low      = results.filter(r => r.status === 'low').length;
const exhausted = results.filter(r => r.status === 'exhausted').length;
const errors   = results.filter(r => r.status === 'error').length;

console.log('\n' + '─'.repeat(72));
console.log(`\n📊 结果汇总:`);
console.log(`   ✅ 可用 (>10%):   ${usable} 个`);
console.log(`   ⚠️  低余额 (≤10%): ${low} 个`);
console.log(`   ❌ 已耗尽 (0%):   ${exhausted} 个`);
console.log(`   💥 获取失败:      ${errors} 个`);
console.log(`   ─ 总计:          ${results.length} 个\n`);

// ── Write JSON log ─────────────────────────────────────────────────
const dateStr = new Date().toISOString().slice(0, 10);
const outPath = path.join(logsDir, `quota-test-${dateStr}.json`);
await fs.mkdir(logsDir, { recursive: true });
const output = {
  generatedAt: new Date().toISOString(),
  source: 'orders_2026-04-04.txt (first 10 windsurf trial accounts)',
  method: 'Channel B: Firebase signIn → GetPlanStatus (web-backend.windsurf.com)',
  summary: { usable, low, exhausted, errors, total: results.length },
  results,
};
await fs.writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
console.log(`💾 结果已写入: logs/quota-test-${dateStr}.json\n`);
