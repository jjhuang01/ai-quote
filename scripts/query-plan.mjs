/**
 * 直接调 Windsurf GetPlanStatus API 查看原始返回
 * Usage: node scripts/query-plan.mjs <email>
 */
import { readFileSync } from 'node:fs';
import https from 'node:https';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const targetEmail = process.argv[2];
const overridePassword = process.argv[3]; // optional: override stored password

if (!targetEmail) {
  console.error('Usage: node scripts/query-plan.mjs <email> [password]');
  process.exit(1);
}

// 1. 读取账号数据
const dataPath = '/Users/os/Library/Application Support/Windsurf/User/globalStorage/opensource.ai-quote/windsurf-accounts.json';
const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
const account = data.accounts.find(a => a.email.includes(targetEmail));
if (!account) { console.error('Account not found:', targetEmail); process.exit(1); }

console.log('=== Account ===');
console.log('Email:', account.email);
console.log('Stored plan:', account.plan);

// 2. Firebase signIn to get idToken
async function firebaseSignIn(email, password) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ email, password, returnSecureToken: true });
    const req = https.request({
      hostname: 'identitytoolkit.googleapis.com',
      path: `/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try {
          const r = JSON.parse(chunks);
          if (r.error) reject(new Error(r.error.message));
          else resolve(r.idToken);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 3. Call GetPlanStatus (与 src/adapters/quota-fetcher.ts callGetPlanStatus 完全对齐)
async function getPlanStatus(idToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ auth_token: idToken });
    const req = https.request({
      hostname: 'web-backend.windsurf.com',
      port: 443,
      path: '/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': idToken,
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 15000
    }, res => {
      let chunks = '';
      console.log('HTTP status:', res.statusCode);
      res.on('data', d => chunks += d);
      res.on('end', () => {
        console.log('Raw response:', chunks.slice(0, 1000));
        try { resolve(JSON.parse(chunks)); }
        catch(e) { resolve({ _raw: chunks.slice(0, 500) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

// 4. Call GetUserStatus (apiKey channel) as fallback
async function getUserStatus(apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const req = https.request({
      hostname: 'server.codeium.com',
      port: 443,
      path: '/exa.seat_management_pb.SeatManagementService/GetUserStatus',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${apiKey}-windsurf-user`,
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 15000
    }, res => {
      let chunks = '';
      console.log('GetUserStatus HTTP status:', res.statusCode);
      res.on('data', d => chunks += d);
      res.on('end', () => {
        console.log('GetUserStatus raw:', chunks.slice(0, 1000));
        try { resolve(JSON.parse(chunks)); }
        catch(e) { resolve({ _raw: chunks.slice(0, 500) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

// 5. RegisterUser to get apiKey
async function registerUser(idToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ firebase_id_token: idToken });
    const req = https.request({
      hostname: 'server.codeium.com',
      port: 443,
      path: '/exa.api_server_pb.ApiServerService/RegisterUser',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 15000
    }, res => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch(e) { resolve({ _raw: chunks.slice(0, 500) }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

try {
  const password = overridePassword || account.password;
  console.log('\n=== Firebase SignIn ===');
  console.log('Using password:', overridePassword ? '(from CLI)' : '(from stored data)');
  const idToken = await firebaseSignIn(account.email, password);
  console.log('idToken length:', idToken.length, '(ok)');

  console.log('\n=== [Channel B] GetPlanStatus ===');
  const result = await getPlanStatus(idToken);
  console.log(JSON.stringify(result, null, 2));

  console.log('\n=== RegisterUser → apiKey ===');
  const regResult = await registerUser(idToken);
  const apiKey = regResult.api_key;
  console.log('apiKey:', apiKey ? apiKey.slice(0, 20) + '...' : 'NONE');

  if (apiKey) {
    console.log('\n=== [Channel D] GetUserStatus ===');
    const userStatus = await getUserStatus(apiKey);
    console.log(JSON.stringify(userStatus, null, 2));
  }
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
