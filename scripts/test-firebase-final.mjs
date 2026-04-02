#!/usr/bin/env node
/**
 * Firebase API Key 验证 + RegisterUser 获取 quota
 * 来源: github.com/crispvibe/Windsurf-Tool/js/constants.js
 *
 * 关键发现:
 *   FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY'
 *   WINDSURF_REGISTER_API = 'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser'
 */
import https from 'node:https';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const REGISTER_API = 'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser';

const ACCOUNTS = [
  { email: 'elzkuhyfd6@gicnsjt.shop', password: '96ahf4w9' },
  { email: 'n9559a03bp@mvdvnhn.shop', password: '09gzse2m63' },
  { email: '9ps5vxqrl8@yyyemno.shop', password: 'l33vpem9k' },
];

function httpsPost(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders
      },
      timeout: 15000
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

async function testAccount(email, password) {
  console.log(`\n─── ${email} ───`);

  // Step 1: Firebase signIn
  const loginBody = JSON.stringify({ email, password, returnSecureToken: true });
  const loginResp = await httpsPost(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    loginBody
  );

  if (loginResp.status !== 200) {
    const errMsg = (() => { try { return JSON.parse(loginResp.body)?.error?.message; } catch { return loginResp.body.slice(0,100); } })();
    console.log(`  ❌ Firebase 登录失败 HTTP ${loginResp.status}: ${errMsg}`);
    return null;
  }

  const { idToken } = JSON.parse(loginResp.body);
  console.log(`  ✅ Firebase 登录成功`);

  // Step 2: RegisterUser — 尝试 snake_case 和 camelCase 两种字段名
  for (const [label, body] of [
    ['snake_case firebase_id_token', JSON.stringify({ firebase_id_token: idToken })],
    ['camelCase firebaseIdToken',    JSON.stringify({ firebaseIdToken: idToken })],
  ]) {
    const regResp = await new Promise((resolve, reject) => {
      const u = new URL(REGISTER_API);
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/connect+json',
          'Connect-Protocol-Version': '1',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 15000
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(body); req.end();
    });

    console.log(`  [${label}] HTTP ${regResp.status}: ${regResp.body.slice(0, 400)}`);

    if (regResp.status === 200) {
      try {
        const data = JSON.parse(regResp.body);
        const plan = data.planInfo;
        if (plan) {
          console.log(`  ✅ planName: ${plan.planName}, billingStrategy: ${plan.billingStrategy}`);
          console.log(`     日配额剩余: ${plan.quotaUsage?.dailyRemainingPercent}%`);
          console.log(`     周配额剩余: ${plan.quotaUsage?.weeklyRemainingPercent}%`);
        }
        return data;
      } catch { console.log('  ⚠️ JSON 解析失败'); }
    }
  }

  // Step 3: 也试 server.codeium.com RegisterUser
  console.log(`\n  [server.codeium.com RegisterUser] 对比测试...`);
  const oldBody = JSON.stringify({ firebaseIdToken: idToken });
  const oldResp = await new Promise((resolve, reject) => {
    const u = new URL('https://server.codeium.com/exa.seat_management_pb.SeatManagementService/RegisterUser');
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        'Content-Length': Buffer.byteLength(oldBody)
      },
      timeout: 15000
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(oldBody); req.end();
  });
  console.log(`  HTTP ${oldResp.status}: ${oldResp.body.slice(0, 300)}`);

  return null;
}

console.log('🔑 Firebase API Key 验证脚本');
console.log(`Key: ${FIREBASE_API_KEY}`);
console.log(`Endpoint: ${REGISTER_API}\n`);

for (const acc of ACCOUNTS) {
  await testAccount(acc.email, acc.password);
  await new Promise(r => setTimeout(r, 1000));
}

console.log('\n═══ 完成 ═══');
