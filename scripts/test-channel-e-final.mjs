#!/usr/bin/env node
/**
 * Channel E 端到端验证脚本
 * 模拟插件 quota-fetcher.ts 中 fetchFromLocalProto() 的完整逻辑
 * 期望结果与截图一致:
 *   - Daily quota usage: 22%  → dailyRemainingPercent = 78
 *   - Weekly quota usage: 11% → weeklyRemainingPercent = 89
 *   - Daily reset: 4月3日 GMT+8 16:00
 *   - Weekly reset: 4月5日 GMT+8 16:00
 */
import { execFile } from 'node:child_process';
import { access, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const DB_PATH = join(homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb');

// ── Minimal proto decoder (mirrors quota-fetcher.ts implementation) ───────────

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
      if (!fields.has(fieldNum)) fields.set(fieldNum, []);
      const arr = fields.get(fieldNum);
      if (wireType === 0) {
        let v; [v, pos] = parseVarint(data, pos);
        arr.push({ type: 'varint', val: Number(v) });
      } else if (wireType === 2) {
        let len; [len, pos] = parseVarint(data, pos);
        const n = Number(len);
        arr.push({ type: 'bytes', val: data.slice(pos, pos + n) });
        pos += n;
      } else if (wireType === 5) {
        arr.push({ type: 'fixed32', val: data.readUInt32LE(pos) }); pos += 4;
      } else if (wireType === 1) {
        arr.push({ type: 'fixed64', val: Number(data.readBigUInt64LE(pos)) }); pos += 8;
      } else break;
    } catch { break; }
  }
  return fields;
}

function protoStr(fields, n) {
  const arr = fields.get(n);
  if (!arr) return undefined;
  for (const e of arr) {
    if (e.type === 'bytes') { try { return e.val.toString('utf8'); } catch {} }
  }
  return undefined;
}

function protoInt(fields, n) { return fields.get(n)?.[0]?.val; }

function protoSub(fields, n) {
  const arr = fields.get(n);
  if (!arr) return undefined;
  for (const e of arr) {
    if (e.type === 'bytes') { try { return decodeProto(e.val); } catch {} }
  }
  return undefined;
}

// ── Main logic (mirrors fetchFromLocalProto) ─────────────────────────────────

async function fetchFromLocalProto(expectedEmail) {
  try {
    await access(DB_PATH);
  } catch {
    return { success: false, error: 'DB not found' };
  }

  const tmp = join(tmpdir(), `ws_e2e_${Date.now()}.db`);
  try {
    await copyFile(DB_PATH, tmp);
    const raw = await new Promise((resolve, reject) => {
      execFile('sqlite3', [tmp, "SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';"],
        { timeout: 5000 }, (err, out, se) => err ? reject(new Error(se || err.message)) : resolve(out.trim()));
    });
    await unlink(tmp).catch(() => {});

    if (!raw) return { success: false, error: 'windsurfAuthStatus empty' };

    const status = JSON.parse(raw);
    const b64 = status.userStatusProtoBinaryBase64;
    if (!b64) return { success: false, error: 'no userStatusProtoBinaryBase64' };

    const buf = Buffer.from(b64, 'base64');
    const outer = decodeProto(buf);

    const userEmail = protoStr(outer, 7) ?? protoStr(outer, 3);

    if (expectedEmail && userEmail && userEmail.toLowerCase() !== expectedEmail.toLowerCase()) {
      return { success: false, error: `email mismatch: got ${userEmail}, expected ${expectedEmail}` };
    }

    const planStatus = protoSub(outer, 13);
    if (!planStatus) return { success: false, error: 'no planStatus field[13]' };

    const planInfoSub = protoSub(planStatus, 1);
    const planName = planInfoSub ? (protoStr(planInfoSub, 2) ?? 'Unknown') : 'Unknown';

    const dailyRemainingPercent  = protoInt(planStatus, 14) ?? 100;
    const weeklyRemainingPercent = protoInt(planStatus, 15) ?? 100;
    const dailyResetAtUnix       = protoInt(planStatus, 17) ?? 0;
    const weeklyResetAtUnix      = protoInt(planStatus, 18) ?? 0;
    const messagesTotal          = protoInt(planStatus, 8)  ?? 0;
    const flowActionsTotal       = protoInt(planStatus, 9)  ?? 0;

    const startSub = protoSub(planStatus, 2);
    const endSub   = protoSub(planStatus, 3);
    const startMs  = (protoInt(startSub ?? new Map(), 1) ?? 0) * 1000;
    const endMs    = (protoInt(endSub   ?? new Map(), 1) ?? 0) * 1000;

    return {
      success: true, source: 'proto', userEmail, planName,
      dailyRemainingPercent, weeklyRemainingPercent,
      dailyResetAtUnix, weeklyResetAtUnix,
      messagesTotal, flowActionsTotal, startMs, endMs
    };
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ── Assertions ────────────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) { console.error(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }
  else { console.log(`  ✅ ${msg}`); }
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log('🧪 Channel E 端到端验证\n');

const r = await fetchFromLocalProto();

console.log('Raw result:');
console.log(JSON.stringify(r, null, 2));
console.log();

console.log('=== 断言 ===');
assert(r.success === true, 'fetchFromLocalProto succeeded');
assert(r.source === 'proto', 'source is proto');
assert(r.userEmail === 'elzkuhyfd6@gicnsjt.shop', `email = ${r.userEmail}`);
assert(r.planName === 'Trial', `planName = ${r.planName}`);

// 截图: Daily 22% used → 78% remaining
assert(r.dailyRemainingPercent === 78, `dailyRemainingPercent = ${r.dailyRemainingPercent} (expect 78)`);
// 截图: Weekly 11% used → 89% remaining
assert(r.weeklyRemainingPercent === 89, `weeklyRemainingPercent = ${r.weeklyRemainingPercent} (expect 89)`);

// 截图: Resets 4月3日 GMT+8 16:00 = 2026-04-03T08:00:00Z = 1775203200
assert(r.dailyResetAtUnix === 1775203200, `dailyResetAtUnix = ${r.dailyResetAtUnix} (expect 1775203200 = ${new Date(1775203200000).toLocaleString()})`);
// 截图: Resets 4月5日 GMT+8 16:00 = 2026-04-05T08:00:00Z = 1775376000
assert(r.weeklyResetAtUnix === 1775376000, `weeklyResetAtUnix = ${r.weeklyResetAtUnix} (expect 1775376000 = ${new Date(1775376000000).toLocaleString()})`);

assert(r.messagesTotal === 10000, `messagesTotal = ${r.messagesTotal}`);
assert(r.flowActionsTotal === 20000, `flowActionsTotal = ${r.flowActionsTotal}`);

// Plan period: 3月31 ~ 4月14
const startDate = new Date(r.startMs).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
const endDate   = new Date(r.endMs).toLocaleDateString('zh-CN',   { month: 'long', day: 'numeric' });
assert(r.startMs > 0, `plan startMs = ${r.startMs} (${startDate})`);
assert(r.endMs > r.startMs, `plan endMs = ${r.endMs} (${endDate})`);

console.log(`\n📊 显示预览 (对比截图):`);
console.log(`   Plan: ${r.planName}`);
console.log(`   Daily quota usage:  ${100 - r.dailyRemainingPercent}%  (remaining ${r.dailyRemainingPercent}%)`);
console.log(`   Weekly quota usage: ${100 - r.weeklyRemainingPercent}% (remaining ${r.weeklyRemainingPercent}%)`);
console.log(`   Daily reset:  ${new Date(r.dailyResetAtUnix * 1000).toLocaleString()}`);
console.log(`   Weekly reset: ${new Date(r.weeklyResetAtUnix * 1000).toLocaleString()}`);
console.log(`   Period: ${startDate} ~ ${endDate}`);

if (process.exitCode === 1) {
  console.log('\n❌ 部分断言失败');
} else {
  console.log('\n✅ 所有断言通过 — Channel E 实现正确');
}
