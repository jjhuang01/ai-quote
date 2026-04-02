#!/usr/bin/env node
/**
 * RegisterUser 正确调用方式 (来源: crispvibe/Windsurf-Tool)
 * Content-Type: application/json  (NOT connect+json!)
 * Field: firebase_id_token (snake_case)
 * Endpoint: register.windsurf.com
 */
import https from 'node:https';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const REGISTER_URL = 'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser';
const GET_USER_STATUS_URL = 'https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetUserStatus';

const ACCOUNTS = [
  { email: 'elzkuhyfd6@gicnsjt.shop', password: '96ahf4w9' },
  { email: 'n9559a03bp@mvdvnhn.shop', password: '09gzse2m63' },
  { email: '9ps5vxqrl8@yyyemno.shop', password: 'l33vpem9k' },
];

function post(url, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
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

async function processAccount(email, password) {
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`📧 ${email}`);
  console.log('═'.repeat(55));

  // Step 1: Firebase login
  const loginBody = JSON.stringify({ email, password, returnSecureToken: true });
  const loginR = await post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    loginBody
  );
  if (loginR.status !== 200) {
    const msg = (() => { try { return JSON.parse(loginR.body)?.error?.message; } catch { return loginR.body.slice(0,100); } })();
    console.log(`❌ Firebase login failed HTTP ${loginR.status}: ${msg}`);
    return;
  }
  const { idToken } = JSON.parse(loginR.body);
  console.log('✅ Firebase login OK');

  // Step 2: RegisterUser with plain application/json
  console.log('\n→ RegisterUser (application/json + snake_case)...');
  const regBody = JSON.stringify({ firebase_id_token: idToken });
  const regR = await post(REGISTER_URL, regBody, 'application/json');
  console.log(`  HTTP ${regR.status}`);
  console.log(`  Body: ${regR.body.slice(0, 600)}`);

  let apiKey = null;
  let planInfoFromReg = null;
  if (regR.status === 200) {
    try {
      const d = JSON.parse(regR.body);
      apiKey = d.api_key ?? d.apiKey ?? null;
      planInfoFromReg = d.plan_info ?? d.planInfo ?? null;
      console.log(`  api_key: ${apiKey ? apiKey.slice(0, 30) + '...' : 'none'}`);
      if (planInfoFromReg) {
        console.log(`  plan_info: ${JSON.stringify(planInfoFromReg).slice(0, 200)}`);
      }
    } catch { console.log('  JSON parse failed'); }
  }

  // Step 3: GetUserStatus with obtained api_key
  if (apiKey) {
    console.log('\n→ GetUserStatus with obtained api_key...');
    const statusBody = JSON.stringify({
      metadata: { apiKey, ideName: 'vscode', extensionName: 'codeium.windsurf-windsurf', extensionVersion: '1.9.0' }
    });
    const statusR = await post(GET_USER_STATUS_URL, statusBody, 'application/connect+json');
    console.log(`  HTTP ${statusR.status}`);
    console.log(`  Body: ${statusR.body.slice(0, 600)}`);

    if (statusR.status === 200) {
      try {
        const d = JSON.parse(statusR.body);
        const us = d.userStatus;
        const pi = us?.planInfo ?? us?.planStatus?.planInfo;
        if (pi) {
          console.log(`\n  ✅ QUOTA DATA:`);
          console.log(`     planName: ${pi.planName}`);
          console.log(`     dailyRemainingPercent:  ${pi.quotaUsage?.dailyRemainingPercent}%`);
          console.log(`     weeklyRemainingPercent: ${pi.quotaUsage?.weeklyRemainingPercent}%`);
          const dr = new Date((pi.quotaUsage?.dailyResetAtUnix ?? 0) * 1000);
          const wr = new Date((pi.quotaUsage?.weeklyResetAtUnix ?? 0) * 1000);
          console.log(`     dailyReset:  ${dr.toLocaleString()}`);
          console.log(`     weeklyReset: ${wr.toLocaleString()}`);
        }
      } catch { console.log('  JSON parse failed'); }
    }
  }
}

console.log('🧪 Windsurf RegisterUser + GetUserStatus 全流程测试');
console.log(`Firebase Key: ${FIREBASE_API_KEY}`);

for (const acc of ACCOUNTS) {
  await processAccount(acc.email, acc.password);
  await new Promise(r => setTimeout(r, 1000));
}

console.log('\n\n═══ 完成 ═══');
