#!/usr/bin/env node
/**
 * GetPlanStatus 测试 - 来源: crispvibe/Windsurf-Tool/js/accountQuery.js
 *
 * 端点: https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus
 * 认证: auth_token (body) + X-Auth-Token (header)
 * 认证令牌: Firebase idToken (via signInWithPassword)
 */
import https from 'node:https';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const GET_PLAN_STATUS_URL = 'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus';
const REGISTER_URL = 'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser';

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
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers
      },
      timeout: 15000
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

async function testAccount(email, password) {
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`📧 ${email}`);
  console.log('═'.repeat(55));

  // Step 1: Firebase signInWithPassword
  const loginR = await post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    JSON.stringify({ email, password, returnSecureToken: true })
  );
  if (loginR.status !== 200) {
    const msg = (() => { try { return JSON.parse(loginR.body)?.error?.message; } catch { return loginR.body.slice(0,100); } })();
    console.log(`❌ Firebase login failed HTTP ${loginR.status}: ${msg}`);
    return;
  }
  const { idToken, refreshToken } = JSON.parse(loginR.body);
  console.log('✅ Firebase login OK');

  // Step 2: GetPlanStatus
  console.log('\n→ GetPlanStatus (web-backend.windsurf.com)...');
  const planR = await post(
    GET_PLAN_STATUS_URL,
    JSON.stringify({ auth_token: idToken }),
    {
      'X-Auth-Token': idToken,
      'x-client-version': 'Chrome/JsCore/11.0.0/FirebaseCore-web'
    }
  );
  console.log(`  HTTP ${planR.status}`);

  if (planR.status === 200) {
    try {
      const d = JSON.parse(planR.body);
      console.log('\n  ✅ GetPlanStatus 响应:');
      console.log(JSON.stringify(d, null, 2).slice(0, 2000));

      const ps = d.planStatus || d;
      console.log('\n  === 解析结果 ===');
      console.log(`  planName: ${ps.planInfo?.planName ?? ps.planName ?? '?'}`);
      console.log(`  availablePromptCredits: ${ps.availablePromptCredits}`);
      console.log(`  availableFlexCredits:   ${ps.availableFlexCredits}`);
      console.log(`  usedPromptCredits:      ${ps.usedPromptCredits}`);
      console.log(`  usedFlexCredits:        ${ps.usedFlexCredits}`);
      // quota-based fields
      console.log(`  dailyRemainingPercent:  ${ps.dailyRemainingPercent ?? ps.planInfo?.quotaUsage?.dailyRemainingPercent}`);
      console.log(`  weeklyRemainingPercent: ${ps.weeklyRemainingPercent ?? ps.planInfo?.quotaUsage?.weeklyRemainingPercent}`);
      console.log(`  planStart: ${ps.planStart ?? ps.planInfo?.startTimestamp}`);
      console.log(`  planEnd:   ${ps.planEnd ?? ps.planInfo?.endTimestamp}`);
    } catch (e) { console.log('  JSON parse error:', e.message); }
  } else {
    console.log(`  Body: ${planR.body.slice(0, 300)}`);
  }

  // Step 3: Also test with RegisterUser api_key → GetUserStatus on self-serve
  console.log('\n→ RegisterUser → api_key (for self-serve endpoint)...');
  const regR = await post(
    REGISTER_URL,
    JSON.stringify({ firebase_id_token: idToken })
  );
  if (regR.status === 200) {
    const { api_key, api_server_url } = JSON.parse(regR.body);
    console.log(`  api_key prefix: ${api_key?.slice(0,30)}...`);
    console.log(`  api_server_url: ${api_server_url}`);

    // GetUserStatus on api_server_url
    const statusUrl = `${api_server_url}/exa.language_server_pb.LanguageServerService/GetUserStatus`;
    console.log(`\n→ GetUserStatus on ${api_server_url}...`);
    const statusR = await post(
      statusUrl,
      JSON.stringify({ metadata: { apiKey: api_key, ideName: 'vscode', extensionVersion: '1.9.0' } }),
      {},
    );
    console.log(`  HTTP ${statusR.status}: ${statusR.body.slice(0, 400)}`);

    // Try with application/connect+json
    const statusR2 = await new Promise((resolve, reject) => {
      const u = new URL(statusUrl);
      const body = JSON.stringify({ metadata: { apiKey: api_key, ideName: 'vscode', extensionVersion: '1.9.0' } });
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/connect+json',
          'Connect-Protocol-Version': '1',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 12000
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
    console.log(`  (connect+json) HTTP ${statusR2.status}: ${statusR2.body.slice(0, 400)}`);
  } else {
    console.log(`  RegisterUser HTTP ${regR.status}: ${regR.body.slice(0,100)}`);
  }
}

console.log('🧪 GetPlanStatus 完整测试\n');
for (const acc of ACCOUNTS) {
  await testAccount(acc.email, acc.password);
  await new Promise(r => setTimeout(r, 800));
}
console.log('\n═══ 完成 ═══');
