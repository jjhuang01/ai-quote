#!/usr/bin/env node
/**
 * 配额诊断脚本 - 验证各通道读取到的真实数据
 * 重点: Channel E (proto) + Channel A (cachedPlanInfo) + Channel B (GetPlanStatus)
 */
import { execFile } from 'node:child_process';
import { copyFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import https from 'node:https';

const DB_PATH = join(homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb');

async function sql(query) {
  const tmp = join(tmpdir(), `diag_${Date.now()}.db`);
  try {
    await copyFile(DB_PATH, tmp);
    return await new Promise((resolve, reject) => {
      execFile('sqlite3', [tmp, query], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
  } finally { await unlink(tmp).catch(() => {}); }
}

// ── Proto 解码工具 ──
function decodeVarint(buf, offset) {
  let result = 0, shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, offset];
    shift += 7;
  }
  return [result, offset];
}

function parseProto(buf) {
  const fields = new Map();
  let offset = 0;
  while (offset < buf.length) {
    const [tag, newOff] = decodeVarint(buf, offset);
    offset = newOff;
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      const [val, o2] = decodeVarint(buf, offset);
      offset = o2;
      fields.set(fieldNum, val);
    } else if (wireType === 2) {
      const [len, o2] = decodeVarint(buf, offset);
      offset = o2;
      const data = buf.subarray(offset, offset + len);
      offset += len;
      fields.set(fieldNum, data);
    } else if (wireType === 5) {
      fields.set(fieldNum, buf.readUInt32LE(offset));
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      break;
    }
  }
  return fields;
}

function protoSub(parent, field) {
  const val = parent.get(field);
  if (val instanceof Uint8Array) return parseProto(val);
  return null;
}

function protoStr(parent, field) {
  const val = parent.get(field);
  if (val instanceof Uint8Array) return new TextDecoder().decode(val);
  return null;
}

function protoInt(parent, field) {
  const val = parent.get(field);
  return typeof val === 'number' ? val : null;
}

// ── Channel A: cachedPlanInfo ──
async function channelA() {
  console.log('\n═══ Channel A: cachedPlanInfo ═══');
  try {
    const raw = await sql("SELECT value FROM ItemTable WHERE key='windsurf.settings.cachedPlanInfo';");
    if (!raw) { console.log('❌ 空'); return; }
    const info = JSON.parse(raw);
    console.log('planName:', info.planName);
    console.log('billingStrategy:', info.billingStrategy);
    console.log('quotaUsage:', JSON.stringify(info.quotaUsage, null, 2));
    console.log('usage:', JSON.stringify(info.usage, null, 2));
  } catch (e) { console.log('❌', e.message); }
}

// ── Channel E: userStatusProtoBinaryBase64 ──
async function channelE() {
  console.log('\n═══ Channel E: userStatusProtoBinaryBase64 (proto) ═══');
  try {
    const raw = await sql("SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';");
    if (!raw) { console.log('❌ 空'); return; }
    const status = JSON.parse(raw);
    const b64 = status.userStatusProtoBinaryBase64;
    if (!b64) { console.log('❌ 无 userStatusProtoBinaryBase64 字段'); return; }

    const buf = Buffer.from(b64, 'base64');
    console.log(`Proto 大小: ${buf.length} bytes`);

    const outer = parseProto(buf);
    // userEmail = field 1
    const userEmail = protoStr(outer, 1);
    console.log('userEmail:', userEmail);

    // planStatus = field 13
    const planStatus = protoSub(outer, 13);
    if (!planStatus) { console.log('❌ 无 planStatus (field 13)'); return; }

    // planInfo = planStatus.field[1]
    const planInfoSub = protoSub(planStatus, 1);
    const planName = planInfoSub ? (protoStr(planInfoSub, 2) ?? 'Unknown') : 'Unknown';
    console.log('planName:', planName);

    // quota fields
    const dailyRemPct = protoInt(planStatus, 14);
    const weeklyRemPct = protoInt(planStatus, 15);
    const dailyResetUnix = protoInt(planStatus, 17);
    const weeklyResetUnix = protoInt(planStatus, 18);
    const messages = protoInt(planStatus, 8);
    const flowActions = protoInt(planStatus, 9);

    console.log(`dailyRemainingPercent (field 14): ${dailyRemPct}`);
    console.log(`weeklyRemainingPercent (field 15): ${weeklyRemPct}`);
    console.log(`dailyResetAtUnix (field 17): ${dailyResetUnix} → ${dailyResetUnix ? new Date(dailyResetUnix * 1000).toLocaleString() : 'N/A'}`);
    console.log(`weeklyResetAtUnix (field 18): ${weeklyResetUnix} → ${weeklyResetUnix ? new Date(weeklyResetUnix * 1000).toLocaleString() : 'N/A'}`);
    console.log(`messages (field 8): ${messages}`);
    console.log(`flowActions (field 9): ${flowActions}`);

    // 额外: availablePromptCredits = planStatus field 3, availableFlowCredits = field 4
    const promptCredits = protoInt(planStatus, 3);
    const flowCredits = protoInt(planStatus, 4);
    const flexCredits = protoInt(planStatus, 5);
    console.log(`availablePromptCredits (field 3): ${promptCredits}`);
    console.log(`availableFlowCredits (field 4): ${flowCredits}`);
    console.log(`availableFlexCredits (field 5): ${flexCredits}`);

    // 列出所有 planStatus 顶层 field
    console.log('\nplanStatus 所有字段:');
    for (const [k, v] of planStatus.entries()) {
      if (v instanceof Uint8Array) {
        console.log(`  field ${k}: bytes[${v.length}]`);
      } else {
        console.log(`  field ${k}: ${v}`);
      }
    }

    return { userEmail, dailyRemPct, weeklyRemPct, dailyResetUnix, weeklyResetUnix };
  } catch (e) { console.log('❌', e.message); }
}

// ── Channel B: Firebase + GetPlanStatus ──
async function channelB() {
  console.log('\n═══ Channel B: GetPlanStatus (当前账号 s1z6pkws4k@zyqwotq.shop) ═══');
  const FIREBASE_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
  const email = 's1z6pkws4k@zyqwotq.shop';
  // 从存储中读密码 - 或直接硬编码测试
  // 先尝试从 windsurf-accounts.json 读
  let password;
  try {
    const { readFile } = await import('node:fs/promises');
    const accPath = join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'undefined_publisher.ai-echo', 'windsurf-accounts.json');
    const accRaw = await readFile(accPath, 'utf8');
    const accData = JSON.parse(accRaw);
    const acc = accData.accounts?.find(a => a.email === email);
    password = acc?.password;
    if (!password) {
      console.log('⚠️ 未找到密码，尝试其他账号...');
      // 用第一个有密码的账号测试
      const anyAcc = accData.accounts?.find(a => a.password);
      if (anyAcc) {
        console.log(`  使用账号: ${anyAcc.email}`);
        password = anyAcc.password;
      }
    }
  } catch (e) {
    console.log('⚠️ 无法读取 windsurf-accounts.json:', e.message);
  }

  if (!password) {
    console.log('❌ 无密码可用，跳过 Channel B');
    return;
  }

  try {
    // Firebase 登录
    const loginBody = JSON.stringify({ email, password, returnSecureToken: true });
    const loginResp = await new Promise((resolve, reject) => {
      const u = new URL(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`);
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) },
        timeout: 15000
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.write(loginBody);
      req.end();
    });

    if (loginResp.status !== 200) {
      console.log(`❌ Firebase 登录失败: HTTP ${loginResp.status}`);
      return;
    }

    const idToken = JSON.parse(loginResp.body).idToken;
    console.log('✅ Firebase 登录成功');

    // GetPlanStatus
    const body = JSON.stringify({ auth_token: idToken });
    const resp = await new Promise((resolve, reject) => {
      const u = new URL('https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus');
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': idToken,
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Mozilla/5.0'
        },
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

    console.log(`GetPlanStatus HTTP ${resp.status}`);
    const data = JSON.parse(resp.body);
    const ps = data.planStatus;
    if (ps) {
      console.log('planInfo.planName:', ps.planInfo?.planName);
      console.log('dailyQuotaRemainingPercent:', ps.dailyQuotaRemainingPercent);
      console.log('weeklyQuotaRemainingPercent:', ps.weeklyQuotaRemainingPercent);
      console.log('dailyQuotaResetAtUnix:', ps.dailyQuotaResetAtUnix,
        '→', ps.dailyQuotaResetAtUnix ? new Date(Number(ps.dailyQuotaResetAtUnix) * 1000).toLocaleString() : 'N/A');
      console.log('weeklyQuotaResetAtUnix:', ps.weeklyQuotaResetAtUnix,
        '→', ps.weeklyQuotaResetAtUnix ? new Date(Number(ps.weeklyQuotaResetAtUnix) * 1000).toLocaleString() : 'N/A');
      console.log('availablePromptCredits:', ps.availablePromptCredits);
      console.log('availableFlowCredits:', ps.availableFlowCredits);
      console.log('\n完整 planStatus:');
      console.log(JSON.stringify(ps, null, 2));
    } else {
      console.log('❌ 无 planStatus');
      console.log('完整响应:', JSON.stringify(data, null, 2));
    }
  } catch (e) { console.log('❌', e.message); }
}

// ── MAIN ──
console.log('🔍 配额诊断 - ' + new Date().toLocaleString());
console.log('目标: 验证 Windsurf 显示 Daily 9% used / Weekly 5% used 的数据源');

await channelA();
const protoData = await channelE();
await channelB();

console.log('\n═══ 诊断结论 ═══');
if (protoData) {
  const dailyUsed = protoData.dailyRemPct !== null ? (100 - protoData.dailyRemPct) : '?';
  const weeklyUsed = protoData.weeklyRemPct !== null ? (100 - protoData.weeklyRemPct) : '?';
  console.log(`Proto 数据: Daily used ${dailyUsed}%, Weekly used ${weeklyUsed}%`);
  console.log(`应与 Windsurf UI (Daily 9%, Weekly 5%) 一致`);
}
