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
// 涵盖：4月新购 + 3月18日（有限速，~已过期）+ 3月10日（100积分，最老）
const ACCOUNTS = [
  // ── 4月新购（预期可用）
  { email: 's1z6pkws4k@zyqwotq.shop',   password: 'br07zq5',       order: 'WEB20260402CFAT1SC5',  note: '4月2日' },
  { email: 'elzkuhyfd6@gicnsjt.shop',   password: '96ahf4w9',      order: 'WEB20260402QYA87R14',  note: '4月2日' },
  { email: '7sbgxp5lpu@pqubzct.shop',   password: 'mk765ww4i1',    order: 'WEB20260404VFXH7YRT',  note: '4月4日新购' },
  { email: 'w7kuj84ngv@furybww.shop',   password: 'yf63f0q9',      order: 'WEB20260403KG2XRGBH',  note: '4月3日' },
  // ── 3月19日（应已过期 ~4月2日）
  { email: 'y5la7r2vcr@buyudazuozhan.com', password: 'r58a12ot',   order: 'WEB20260319JJ9LNE6P',  note: '3月19日/不限速' },
  // ── 3月18日（应已过期 ~4月1日）
  { email: 'gmbmxjyit1@zfkisry.shop',   password: 'si1997umci',    order: 'WEB20260318D578FMOO',  note: '3月18日/有限速' },
  { email: '1mj13sfn9c@zfkisry.shop',   password: 'i38r8yrm48o',   order: 'WEB20260318C08LY5FT',  note: '3月18日/有限速' },
  { email: 'angklmkfiv@zfkisry.shop',   password: 'fvk387a',       order: 'WEB20260318MP7ATE9I',  note: '3月18日/有限速' },
  // ── 3月10日（应已过期 ~3月24日，最老）
  { email: 'jjjeoq5vj4@lvjigan.shop',   password: '8f64gch0',      order: 'WEB2026031041W7Z5YE',  note: '3月10日/100积分' },
  { email: '9b269yk9r9@lvjigan.shop',   password: '9099vi4ygia',   order: 'WEB202603109F8L74Z5',  note: '3月10日/100积分' },
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
  // 过期判断（planEnd 在过去 → 无论 quota 百分比如何，账号已无效）
  if (ps.planEnd) {
    const end = new Date(ps.planEnd).getTime();
    if (end > 0 && end < Date.now()) return 'expired';
  }
  // 非正常 gracePeriod 状态
  if (ps.gracePeriodStatus && ps.gracePeriodStatus !== 'GRACE_PERIOD_STATUS_NONE') return 'expired';
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
    note: acc.note ?? '',
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
      expired:  '🚫',
      no_data:  '❓',
    }[row.status] ?? '?';
    const now = Date.now();
    const endTs = row.planEnd ? new Date(row.planEnd).getTime() : 0;
    const expiredFlag = endTs > 0 && endTs < now ? '已过期' : '';
    const endStr = row.planEnd
      ? ` 到期${new Date(row.planEnd).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}${expiredFlag ? '('+expiredFlag+')' : ''}`
      : '';
    const noteStr = acc.note ? ` [${acc.note}]` : '';
    console.log(`${statusIcon} ${dailyStr.padEnd(10)} ${weeklyStr.padEnd(10)} grace:${String(row.rawPlanStatus?.gracePeriodStatus??'?').replace('GRACE_PERIOD_STATUS_','').padEnd(6)}${endStr}${noteStr}`);
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
const usable    = results.filter(r => r.status === 'usable').length;
const low       = results.filter(r => r.status === 'low').length;
const exhausted = results.filter(r => r.status === 'exhausted').length;
const expired   = results.filter(r => r.status === 'expired').length;
const errors    = results.filter(r => r.status === 'error').length;

console.log('\n' + '─'.repeat(72));
console.log(`\n📊 结果汇总:`);
console.log(`   ✅ 可用 (>10%):       ${usable} 个`);
console.log(`   ⚠️  低余额 (≤10%):    ${low} 个`);
console.log(`   ❌ 已耗尽 (quota=0):  ${exhausted} 个`);
console.log(`   � 已过期 (planEnd):  ${expired} 个`);
console.log(`   � 获取失败:          ${errors} 个`);
console.log(`   ─ 总计:              ${results.length} 个\n`);

// ── Write JSON log ─────────────────────────────────────────────────
const dateStr = new Date().toISOString().slice(0, 10);
const outPath = path.join(logsDir, `quota-test-${dateStr}.json`);
await fs.mkdir(logsDir, { recursive: true });
const output = {
  generatedAt: new Date().toISOString(),
  source: 'orders_2026-04-04.txt (first 10 windsurf trial accounts)',
  method: 'Channel B: Firebase signIn → GetPlanStatus (web-backend.windsurf.com)',
  summary: { usable, low, exhausted, expired, errors, total: results.length },
  results,
};
await fs.writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
console.log(`💾 结果已写入: logs/quota-test-${dateStr}.json\n`);
