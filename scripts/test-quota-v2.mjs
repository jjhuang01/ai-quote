#!/usr/bin/env node
/**
 * 配额 API 调研脚本 v2
 * 测试各通道是否能获取到 quota 数据
 *
 * 用法: node scripts/test-quota-v2.mjs
 */
import { execFile } from 'node:child_process';
import { access, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import https from 'node:https';

const DB_PATH = join(homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb');

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function httpsPost(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders
      },
      timeout: 15_000
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

function httpsPostConnect(url, body) {
  return httpsPost(url, body, {
    'Content-Type': 'application/connect+json',
    'Connect-Protocol-Version': '1',
  });
}

async function sqliteQuery(dbPath, sql) {
  const tmp = join(tmpdir(), `ws_test_${Date.now()}.db`);
  try {
    await copyFile(dbPath, tmp);
    return await new Promise((resolve, reject) => {
      execFile('sqlite3', [tmp, sql], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout.trim());
      });
    });
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ── 通道 A: 本地 cachedPlanInfo ──────────────────────────────────────────────

async function testChannelA() {
  console.log('\n' + '═'.repeat(60));
  console.log('通道 A: 本地 cachedPlanInfo (sqlite)');
  console.log('═'.repeat(60));
  try {
    await access(DB_PATH);
    const raw = await sqliteQuery(DB_PATH, "SELECT value FROM ItemTable WHERE key='windsurf.settings.cachedPlanInfo';");
    if (!raw) { console.log('❌ cachedPlanInfo 为空'); return null; }
    const info = JSON.parse(raw);
    console.log(`✅ planName: ${info.planName}, billingStrategy: ${info.billingStrategy}`);
    console.log(`   日配额剩余: ${info.quotaUsage?.dailyRemainingPercent}%, 周: ${info.quotaUsage?.weeklyRemainingPercent}%`);
    console.log(`   消息: ${info.usage?.usedMessages}/${info.usage?.messages}`);
    return info;
  } catch (e) {
    console.log('❌ 失败:', e.message);
    return null;
  }
}

// ── 通道 D: sk-ws-01 token → GetUserStatus ───────────────────────────────────

async function testChannelD_withSkWs01() {
  console.log('\n' + '═'.repeat(60));
  console.log('通道 D: sk-ws-01 session token → GetUserStatus');
  console.log('═'.repeat(60));
  try {
    await access(DB_PATH);
    const raw = await sqliteQuery(DB_PATH, "SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';");
    if (!raw) { console.log('❌ windsurfAuthStatus 为空'); return null; }
    const status = JSON.parse(raw);
    const apiKey = status.apiKey;
    if (!apiKey) { console.log('❌ 无 apiKey 字段'); return null; }
    console.log(`🔑 apiKey 前缀: ${apiKey.slice(0, 20)}...`);

    // 尝试 1: 标准 GetUserStatus（原始代码用法）
    console.log('\n  尝试 1: 标准 GetUserStatus...');
    const body1 = JSON.stringify({
      metadata: { apiKey, ideName: 'vscode', extensionName: 'codeium.windsurf-windsurf', extensionVersion: '1.9.0' }
    });
    const r1 = await httpsPostConnect(
      'https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetUserStatus',
      body1
    );
    console.log(`  HTTP ${r1.status}: ${r1.body.slice(0, 200)}`);

    // 尝试 2: Bearer 头方式
    console.log('\n  尝试 2: Authorization: Bearer...');
    const body2 = JSON.stringify({ metadata: { ideName: 'vscode', extensionVersion: '1.9.0' } });
    const r2 = await httpsPostConnect(
      'https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetUserStatus',
      body2,
      // 额外的 Authorization 头
    );
    // 实际上 httpsPostConnect 不接受额外头，用 httpsPost 手动
    const r2b = await new Promise((resolve, reject) => {
      const bodyStr = body2;
      const u = new URL('https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetUserStatus');
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/connect+json',
          'Connect-Protocol-Version': '1',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(bodyStr)
        },
        timeout: 15_000
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });
    console.log(`  HTTP ${r2b.status}: ${r2b.body.slice(0, 200)}`);

    // 尝试 3: token 直接放在 metadata.apiKey + Authorization
    console.log('\n  尝试 3: apiKey + Authorization Bearer 双发...');
    const body3 = JSON.stringify({
      metadata: { apiKey, ideName: 'vscode', extensionVersion: '1.9.0' }
    });
    const r3 = await new Promise((resolve, reject) => {
      const u = new URL('https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetUserStatus');
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/connect+json',
          'Connect-Protocol-Version': '1',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body3)
        },
        timeout: 15_000
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.write(body3);
      req.end();
    });
    console.log(`  HTTP ${r3.status}: ${r3.body.slice(0, 300)}`);

    return status;
  } catch (e) {
    console.log('❌ 失败:', e.message);
    return null;
  }
}

// ── 通道 E: windsurf.codeium.com API (新认证端点) ────────────────────────────

async function testChannelE_NewApi() {
  console.log('\n' + '═'.repeat(60));
  console.log('通道 E: windsurf.codeium.com 新端点探测');
  console.log('═'.repeat(60));

  try {
    const raw = await sqliteQuery(DB_PATH, "SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';");
    const status = JSON.parse(raw);
    const apiKey = status.apiKey;

    // 探测 GetPlanInfo 或 GetUsage 等端点
    const endpoints = [
      'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserInfo',
      'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetPlanInfo',
      'https://api.codeium.com/exa.language_server_pb.LanguageServerService/GetUserStatus',
    ];

    for (const ep of endpoints) {
      const body = JSON.stringify({
        metadata: { apiKey, ideName: 'vscode', extensionVersion: '1.9.0' }
      });
      try {
        const r = await new Promise((resolve, reject) => {
          const u = new URL(ep);
          const req = https.request({
            hostname: u.hostname, port: 443, path: u.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/connect+json',
              'Connect-Protocol-Version': '1',
              'Authorization': `Bearer ${apiKey}`,
              'Content-Length': Buffer.byteLength(body)
            },
            timeout: 8_000
          }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
          });
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('timeout')));
          req.write(body);
          req.end();
        });
        console.log(`  ${ep.split('/').pop()}: HTTP ${r.status} → ${r.body.slice(0, 150)}`);
      } catch (e) {
        console.log(`  ${ep.split('/').pop()}: 错误 ${e.message}`);
      }
    }
  } catch (e) {
    console.log('❌ 失败:', e.message);
  }
}

// ── 通道 B: Firebase Auth + Codeium RegisterUser ──────────────────────────────

async function testChannelB_Firebase(email, password, firebaseApiKey) {
  console.log(`\n  🔐 Firebase 登录: ${email}`);
  const loginBody = JSON.stringify({ email, password, returnSecureToken: true });
  const loginResp = await httpsPost(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
    loginBody
  );
  if (loginResp.status !== 200) {
    console.log(`  ❌ Firebase 登录失败 HTTP ${loginResp.status}: ${loginResp.body.slice(0, 200)}`);
    return null;
  }
  const loginData = JSON.parse(loginResp.body);
  const idToken = loginData.idToken;
  if (!idToken) {
    console.log('  ❌ 无 idToken');
    return null;
  }
  console.log(`  ✅ 登录成功, idToken 前缀: ${idToken.slice(0, 30)}...`);

  // 调用 RegisterUser
  const regBody = JSON.stringify({ firebaseIdToken: idToken });
  const regResp = await new Promise((resolve, reject) => {
    const u = new URL('https://server.codeium.com/exa.seat_management_pb.SeatManagementService/RegisterUser');
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        'Content-Length': Buffer.byteLength(regBody)
      },
      timeout: 15_000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(regBody);
    req.end();
  });
  console.log(`  RegisterUser HTTP ${regResp.status}: ${regResp.body.slice(0, 400)}`);

  if (regResp.status === 200) {
    try {
      const data = JSON.parse(regResp.body);
      if (data.planInfo) {
        console.log(`  ✅ planName: ${data.planInfo.planName}`);
        console.log(`     日配额剩余: ${data.planInfo.quotaUsage?.dailyRemainingPercent}%`);
        console.log(`     周配额剩余: ${data.planInfo.quotaUsage?.weeklyRemainingPercent}%`);
      }
      return data;
    } catch (e) {
      console.log('  ❌ JSON 解析失败');
    }
  }
  return null;
}

async function testAllChannelB(firebaseApiKey) {
  console.log('\n' + '═'.repeat(60));
  console.log('通道 B: Firebase Auth + Codeium RegisterUser');
  console.log('═'.repeat(60));

  if (!firebaseApiKey) {
    console.log('⚠️  跳过: 未提供 Firebase API Key');
    return;
  }

  const accounts = [
    { email: 'elzkuhyfd6@gicnsjt.shop', password: '96ahf4w9' },
    { email: 'n9559a03bp@mvdvnhn.shop', password: '09gzse2m63' },
    { email: '9ps5vxqrl8@yyyemno.shop', password: 'l33vpem9k' },
  ];

  for (const acc of accounts) {
    await testChannelB_Firebase(acc.email, acc.password, firebaseApiKey);
    await new Promise(r => setTimeout(r, 800));
  }
}

// ── 从 Windsurf 扩展 JS 中提取 Firebase API Key ──────────────────────────────

async function extractFirebaseApiKey() {
  console.log('\n' + '═'.repeat(60));
  console.log('提取 Firebase API Key (Windsurf 扩展内嵌)');
  console.log('═'.repeat(60));

  const candidates = [
    '/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js',
    '/Users/os/Desktop/code/tmp/ai-echo-rebuild/_evidence/original-vsix/extension/out/extension.js',
  ];

  for (const jsFile of candidates) {
    try {
      await access(jsFile);
      // 用 node 读文件并用正则搜索
      const key = await new Promise((resolve) => {
        execFile('grep', ['-oE', 'AIzaSy[A-Za-z0-9_-]{35}', jsFile], { timeout: 30000 }, (err, stdout) => {
          if (err || !stdout.trim()) resolve(null);
          else resolve(stdout.trim().split('\n')[0]);
        });
      });
      if (key) {
        console.log(`✅ 找到 Firebase API Key: ${key}`);
        console.log(`   来源: ${jsFile.split('/').pop()}`);
        return key;
      } else {
        // 尝试其他模式
        const key2 = await new Promise((resolve) => {
          execFile('grep', ['-oE', 'webApiKey[^"]*"[^"]{30,50}"', jsFile], { timeout: 30000 }, (err, stdout) => {
            if (err || !stdout.trim()) resolve(null);
            else resolve(stdout.trim().split('\n')[0]);
          });
        });
        if (key2) {
          console.log(`✅ webApiKey 模式: ${key2}`);
          return key2;
        }
        console.log(`⚠️  ${jsFile.split('/').pop()}: 未找到 AIzaSy 格式 key`);
      }
    } catch {
      console.log(`⚠️  文件不存在: ${jsFile}`);
    }
  }

  // 尝试从 secrets 读取
  console.log('\n  尝试从 windsurf_auth secrets 读取...');
  try {
    const raw = await sqliteQuery(DB_PATH, "SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';");
    const status = JSON.parse(raw);
    console.log('  windsurfAuthStatus keys:', Object.keys(status));
    // 有时 firebaseApiKey 也存在这里
    if (status.firebaseApiKey) {
      console.log('  ✅ firebaseApiKey in windsurfAuthStatus:', status.firebaseApiKey);
      return status.firebaseApiKey;
    }
  } catch (e) {
    console.log('  ❌', e.message);
  }

  return null;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

console.log('🚀 Windsurf Quota API 调研 v2\n');
console.log('时间:', new Date().toLocaleString());

await testChannelA();
await testChannelD_withSkWs01();
await testChannelE_NewApi();

const fbKey = await extractFirebaseApiKey();
await testAllChannelB(fbKey);

console.log('\n' + '═'.repeat(60));
console.log('调研完成');
console.log('═'.repeat(60));
