#!/usr/bin/env node
/**
 * Channel B 最终验证: Firebase → GetPlanStatus
 * 模拟插件代码中的 WindsurfAuth + callGetPlanStatus 逻辑
 */
import https from 'node:https';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';

const ACCOUNTS = [
  { email: 'elzkuhyfd6@gicnsjt.shop', password: '96ahf4w9' },
  { email: 'n9559a03bp@mvdvnhn.shop', password: '09gzse2m63' },
  { email: '9ps5vxqrl8@yyyemno.shop', password: 'l33vpem9k' },
];

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      timeout: 15000
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ s: res.statusCode, b: d })); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

let pass = 0, fail = 0;

for (const acc of ACCOUNTS) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📧 ${acc.email}`);

  try {
    // Step 1: Firebase login
    const lr = await post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      JSON.stringify({ email: acc.email, password: acc.password, returnSecureToken: true })
    );
    if (lr.s !== 200) throw new Error(`Firebase login failed: HTTP ${lr.s}`);
    const { idToken } = JSON.parse(lr.b);

    // Step 2: GetPlanStatus
    const pr = await post(
      'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
      JSON.stringify({ auth_token: idToken }),
      { 'X-Auth-Token': idToken, 'User-Agent': 'Mozilla/5.0' }
    );
    if (pr.s !== 200) throw new Error(`GetPlanStatus failed: HTTP ${pr.s}`);
    const ps = JSON.parse(pr.b).planStatus;

    const daily  = ps.dailyQuotaRemainingPercent;
    const weekly = ps.weeklyQuotaRemainingPercent;
    const plan   = ps.planInfo?.planName ?? '?';
    const dReset = new Date(Number(ps.dailyQuotaResetAtUnix) * 1000).toLocaleString('zh-CN');
    const wReset = new Date(Number(ps.weeklyQuotaResetAtUnix) * 1000).toLocaleString('zh-CN');

    console.log(`  ✅ Plan: ${plan}`);
    console.log(`  📊 Daily  remaining: ${daily}%  (reset: ${dReset})`);
    console.log(`  📊 Weekly remaining: ${weekly}% (reset: ${wReset})`);
    console.log(`  💳 Prompt credits available: ${ps.availablePromptCredits}`);
    console.log(`  💳 Flow credits available:   ${ps.availableFlowCredits}`);

    // assertions
    console.assert(typeof daily === 'number' && daily >= 0 && daily <= 100, 'dailyQuotaRemainingPercent valid');
    console.assert(typeof weekly === 'number' && weekly >= 0 && weekly <= 100, 'weeklyQuotaRemainingPercent valid');
    console.assert(plan.length > 0, 'planName non-empty');
    pass++;
  } catch (e) {
    console.log(`  ❌ ${e.message}`);
    fail++;
  }

  await new Promise(r => setTimeout(r, 600));
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`结果: ${pass} 成功 / ${fail} 失败`);
if (fail === 0) console.log('✅ Channel B (GetPlanStatus) 对所有账号验证通过！');
