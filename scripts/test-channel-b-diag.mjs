#!/usr/bin/env node
/**
 * Channel B 诊断: Firebase Auth → GetPlanStatus
 * 验证 s1z6pkws4k@zyqwotq.shop 的实时配额
 */
import https from 'node:https';

const FIREBASE_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const EMAIL = 's1z6pkws4k@zyqwotq.shop';
const PASSWORD = 'br07zq5';

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      timeout: 15000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

console.log(`🔍 Channel B 诊断 - ${new Date().toLocaleString()}`);
console.log(`账号: ${EMAIL}\n`);

// Step 1: Firebase 登录
console.log('1️⃣  Firebase 登录...');
const loginResp = await post(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
  JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true })
);

if (loginResp.status !== 200) {
  console.log(`❌ 登录失败 HTTP ${loginResp.status}: ${loginResp.body.slice(0, 200)}`);
  process.exit(1);
}

const idToken = JSON.parse(loginResp.body).idToken;
console.log('✅ 登录成功\n');

// Step 2: GetPlanStatus
console.log('2️⃣  GetPlanStatus...');
const psResp = await post(
  'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
  JSON.stringify({ auth_token: idToken }),
  { 'X-Auth-Token': idToken, 'User-Agent': 'Mozilla/5.0' }
);

console.log(`HTTP ${psResp.status}\n`);
const data = JSON.parse(psResp.body);
const ps = data.planStatus;

if (!ps) {
  console.log('❌ 无 planStatus');
  console.log(JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log('═══ GetPlanStatus 完整响应 ═══');
console.log(JSON.stringify(ps, null, 2));

console.log('\n═══ 关键字段提取 ═══');
console.log(`planName: ${ps.planInfo?.planName}`);
console.log(`dailyQuotaRemainingPercent: ${ps.dailyQuotaRemainingPercent}`);
console.log(`weeklyQuotaRemainingPercent: ${ps.weeklyQuotaRemainingPercent}`);
console.log(`dailyQuotaResetAtUnix: ${ps.dailyQuotaResetAtUnix} → ${ps.dailyQuotaResetAtUnix ? new Date(Number(ps.dailyQuotaResetAtUnix) * 1000).toLocaleString() : 'N/A'}`);
console.log(`weeklyQuotaResetAtUnix: ${ps.weeklyQuotaResetAtUnix} → ${ps.weeklyQuotaResetAtUnix ? new Date(Number(ps.weeklyQuotaResetAtUnix) * 1000).toLocaleString() : 'N/A'}`);
console.log(`availablePromptCredits: ${ps.availablePromptCredits}`);
console.log(`availableFlowCredits: ${ps.availableFlowCredits}`);

const dailyUsed = ps.dailyQuotaRemainingPercent != null ? (100 - ps.dailyQuotaRemainingPercent) : '?';
const weeklyUsed = ps.weeklyQuotaRemainingPercent != null ? (100 - ps.weeklyQuotaRemainingPercent) : '?';
console.log(`\n📊 Daily used: ${dailyUsed}%, Weekly used: ${weeklyUsed}%`);
console.log(`   Windsurf UI 显示: Daily 9%, Weekly 5%`);
console.log(`   ${dailyUsed === 9 || dailyUsed === '9' ? '✅ 匹配!' : '⚠️ 不匹配 - 检查时间差'}`);
