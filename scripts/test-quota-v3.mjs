#!/usr/bin/env node
/**
 * 配额 API 调研 v3
 * 重点: Channel E (proto decode) + sk-ws-01 多种格式测试 + Firebase key 候选测试
 */
import { execFile } from 'node:child_process';
import { access, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import https from 'node:https';

const DB_PATH = join(homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb');

// ── 工具 ──────────────────────────────────────────────────────────────────────

async function sqliteQuery(sql) {
  const tmp = join(tmpdir(), `ws_test_${Date.now()}.db`);
  try {
    await copyFile(DB_PATH, tmp);
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

function parseVarint(data, pos) {
  let result = 0n, shift = 0n;
  while (pos < data.length) {
    const b = data[pos++];
    result |= BigInt(b & 0x7F) << shift;
    shift += 7n;
    if (!(b & 0x80)) break;
  }
  return [result, pos];
}

function decodeProto(data) {
  const fields = new Map();
  let pos = 0;
  while (pos < data.length) {
    try {
      let tag; [tag, pos] = parseVarint(data, pos);
      const fieldNum = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (wireType === 0) {
        let val; [val, pos] = parseVarint(data, pos);
        if (!fields.has(fieldNum)) fields.set(fieldNum, []);
        fields.get(fieldNum).push({ type: 'varint', val: Number(val) });
      } else if (wireType === 2) {
        let len; [len, pos] = parseVarint(data, pos);
        const bytes = data.slice(pos, pos + Number(len));
        pos += Number(len);
        if (!fields.has(fieldNum)) fields.set(fieldNum, []);
        fields.get(fieldNum).push({ type: 'bytes', val: bytes });
      } else if (wireType === 5) {
        const val = data.readUInt32LE(pos); pos += 4;
        if (!fields.has(fieldNum)) fields.set(fieldNum, []);
        fields.get(fieldNum).push({ type: 'fixed32', val });
      } else if (wireType === 1) {
        const val = data.readBigUInt64LE(pos); pos += 8;
        if (!fields.has(fieldNum)) fields.set(fieldNum, []);
        fields.get(fieldNum).push({ type: 'fixed64', val: Number(val) });
      } else break;
    } catch { break; }
  }
  return fields;
}

function getStr(fields, n) {
  const arr = fields.get(n);
  if (!arr) return undefined;
  for (const e of arr) {
    if (e.type === 'bytes') {
      try { return e.val.toString('utf8'); } catch {}
    }
  }
  return undefined;
}

function getInt(fields, n) {
  const arr = fields.get(n);
  if (!arr) return undefined;
  return arr[0]?.val;
}

function getSub(fields, n) {
  const arr = fields.get(n);
  if (!arr) return undefined;
  for (const e of arr) {
    if (e.type === 'bytes') {
      try { return decodeProto(e.val); } catch {}
    }
  }
  return undefined;
}

// ── Channel E: userStatusProtoBinaryBase64 proto decode ──────────────────────

async function testChannelE() {
  console.log('\n' + '═'.repeat(60));
  console.log('Channel E: userStatusProtoBinaryBase64 (실시간 proto)');
  console.log('═'.repeat(60));

  const raw = await sqliteQuery("SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';");
  if (!raw) { console.log('❌ windsurfAuthStatus is empty'); return null; }

  const status = JSON.parse(raw);
  const b64 = status.userStatusProtoBinaryBase64;
  if (!b64) { console.log('❌ no userStatusProtoBinaryBase64'); return null; }

  const buf = Buffer.from(b64, 'base64');
  console.log(`Proto binary: ${buf.length} bytes`);

  const outer = decodeProto(buf);

  const userEmail = getStr(outer, 7) ?? getStr(outer, 3);
  console.log(`\n👤 userEmail (field[7]):  ${getStr(outer, 7)}`);
  console.log(`   displayName (field[3]): ${getStr(outer, 3)}`);

  const planStatus = getSub(outer, 13);
  if (!planStatus) { console.log('❌ field[13] not found'); return null; }

  const planInfoMsg = getSub(planStatus, 1);
  const planName = planInfoMsg ? getStr(planInfoMsg, 2) : '?';

  const dailyRemainingPct  = getInt(planStatus, 14);
  const weeklyRemainingPct = getInt(planStatus, 15);
  const dailyResetUnix     = getInt(planStatus, 17);
  const weeklyResetUnix    = getInt(planStatus, 18);
  const messagesTotal      = getInt(planStatus, 8);
  const flowActionsTotal   = getInt(planStatus, 9);

  // start/end plan timestamps
  const startMsg = getSub(planStatus, 2);
  const endMsg   = getSub(planStatus, 3);
  const startTs  = startMsg ? getInt(startMsg, 1) : undefined;
  const endTs    = endMsg   ? getInt(endMsg, 1)   : undefined;

  console.log(`\n📋 Plan: ${planName}`);
  console.log(`   Messages total: ${messagesTotal}, FlowActions total: ${flowActionsTotal}`);
  console.log(`\n📊 Quota (실시간):`);
  console.log(`   Daily remaining:  ${dailyRemainingPct}%  → used ${100 - (dailyRemainingPct ?? 0)}%`);
  console.log(`   Weekly remaining: ${weeklyRemainingPct}% → used ${100 - (weeklyRemainingPct ?? 0)}%`);

  if (dailyResetUnix)  console.log(`   Daily reset:  ${new Date(dailyResetUnix * 1000).toLocaleString()}`);
  if (weeklyResetUnix) console.log(`   Weekly reset: ${new Date(weeklyResetUnix * 1000).toLocaleString()}`);
  if (startTs) console.log(`   Plan start:   ${new Date(startTs * 1000).toLocaleString()}`);
  if (endTs)   console.log(`   Plan end:     ${new Date(endTs * 1000).toLocaleString()}`);

  console.log('\n✅ Channel E 成功');
  return { userEmail, planName, dailyRemainingPct, weeklyRemainingPct, dailyResetUnix, weeklyResetUnix };
}

// ── sk-ws-01 token: 尝试不同 content-type / 端点 ─────────────────────────────

async function testSkWs01Token() {
  console.log('\n' + '═'.repeat(60));
  console.log('sk-ws-01 token: 多格式尝试');
  console.log('═'.repeat(60));

  const raw = await sqliteQuery("SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';");
  const { apiKey } = JSON.parse(raw);

  const tests = [
    // 1. ConnectRPC JSON with bearer
    {
      label: 'ConnectRPC + Bearer header',
      url: 'https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetUserStatus',
      ct: 'application/connect+json',
      body: JSON.stringify({ metadata: { apiKey, ideName: 'vscode', extensionVersion: '1.9.0' } }),
      extraHeaders: { Authorization: `Bearer ${apiKey}` }
    },
    // 2. plain JSON REST POST
    {
      label: 'application/json REST',
      url: 'https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetUserStatus',
      ct: 'application/json',
      body: JSON.stringify({ metadata: { apiKey, ideName: 'vscode', extensionVersion: '1.9.0' } }),
      extraHeaders: {}
    },
    // 3. grpc-web
    {
      label: 'application/grpc-web+json',
      url: 'https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetUserStatus',
      ct: 'application/grpc-web+json',
      body: JSON.stringify({ metadata: { apiKey, ideName: 'vscode', extensionVersion: '1.9.0' } }),
      extraHeaders: {}
    },
    // 4. Windsurf-specific quota endpoint
    {
      label: 'windsurf.codeium.com /v1/user/status',
      url: 'https://windsurf.codeium.com/v1/user/status',
      ct: 'application/json',
      body: JSON.stringify({}),
      extraHeaders: { Authorization: `Bearer ${apiKey}` }
    },
    // 5. api.codeium.com REST
    {
      label: 'api.codeium.com /user/status',
      url: 'https://api.codeium.com/user/status',
      ct: 'application/json',
      body: JSON.stringify({}),
      extraHeaders: { Authorization: `Bearer ${apiKey}` }
    },
  ];

  for (const t of tests) {
    try {
      const r = await new Promise((resolve, reject) => {
        const u = new URL(t.url);
        const req = https.request({
          hostname: u.hostname, port: 443, path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': t.ct, 'Content-Length': Buffer.byteLength(t.body), ...t.extraHeaders },
          timeout: 8000
        }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ s: res.statusCode, b: d }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.write(t.body); req.end();
      });
      console.log(`  [${t.label}] HTTP ${r.s}: ${r.b.slice(0, 150)}`);
    } catch (e) {
      console.log(`  [${t.label}] ERROR: ${e.message}`);
    }
  }
}

// ── Firebase API key 候选测试 ─────────────────────────────────────────────────

async function testFirebaseKeyCandidates() {
  console.log('\n' + '═'.repeat(60));
  console.log('Firebase API Key 候选测试');
  console.log('═'.repeat(60));

  // 业界已公开的 Codeium Firebase API Key 候选 (来自开源项目/社区逆向)
  const candidates = [
    'AIzaSyAIqHMHAhFPkFiN3dDf8vPPqe-czq3tZoQ', // codeium-prod 常见引用
    'AIzaSyBxMqCRDSSAfweBBIb0_Q9cL5TeBclWXq4', // windsurf 相关
    'AIzaSy_v3DlUGp3p1JJfOVKnMl7nX1HMiIWHo4c', // 另一候选
  ];

  const testEmail = 'elzkuhyfd6@gicnsjt.shop';
  const testPassword = '96ahf4w9';

  for (const key of candidates) {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`;
    const body = JSON.stringify({ email: testEmail, password: testPassword, returnSecureToken: true });
    try {
      const r = await new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
          hostname: u.hostname, port: 443, path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 8000
        }, res => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ s: res.statusCode, b: d }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.write(body); req.end();
      });
      const preview = r.b.slice(0, 150);
      if (r.s === 200) {
        console.log(`  ✅ KEY WORKS: ${key}`);
        console.log(`     Response: ${preview}`);
        return key;
      } else {
        const err = JSON.parse(r.b)?.error?.message ?? r.b.slice(0, 80);
        console.log(`  ❌ ${key.slice(0, 30)}...: HTTP ${r.s} - ${err}`);
      }
    } catch (e) {
      console.log(`  ❌ ${key.slice(0, 30)}...: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('🔬 Windsurf Quota 调研 v3\n时间:', new Date().toLocaleString());

await testChannelE();
await testSkWs01Token();
const fbKey = await testFirebaseKeyCandidates();

if (fbKey) {
  console.log(`\n🎉 Firebase API Key 确认: ${fbKey}`);
} else {
  console.log('\n⚠️  Firebase API Key 未找到，需通过其他途径获取');
  console.log('   建议: 在 Windsurf 登录界面抓包，或从 web.codeium.com 提取');
}
