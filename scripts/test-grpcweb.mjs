#!/usr/bin/env node
/**
 * 测试 gRPC-Web 帧格式 + sk-ws-01 token
 * gRPC-Web 帧: [0x00][4字节大端长度][JSON body]
 */
import { execFile } from 'node:child_process';
import { copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import https from 'node:https';

const DB_PATH = join(homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb');

async function sqliteQuery(sql) {
  const tmp = join(tmpdir(), `ws_g_${Date.now()}.db`);
  try {
    await copyFile(DB_PATH, tmp);
    return await new Promise((resolve, reject) => {
      execFile('sqlite3', [tmp, sql], { timeout: 5000 }, (err, out, se) => {
        if (err) reject(new Error(se || err.message));
        else resolve(out.trim());
      });
    });
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

function makeGrpcWebFrame(jsonBody) {
  const bodyBuf = Buffer.from(jsonBody, 'utf8');
  const frame = Buffer.alloc(5 + bodyBuf.length);
  frame[0] = 0x00; // not compressed
  frame.writeUInt32BE(bodyBuf.length, 1);
  bodyBuf.copy(frame, 5);
  return frame;
}

async function grpcWebPost(url, jsonBody, headers = {}) {
  const frame = makeGrpcWebFrame(jsonBody);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/grpc-web+json',
        'X-Grpc-Web': '1',
        'Content-Length': frame.length,
        ...headers
      },
      timeout: 12000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw, text: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(frame);
    req.end();
  });
}

function decodeGrpcWebResponse(raw) {
  // gRPC-Web 响应帧: [flag][4-byte length][data]
  const results = [];
  let pos = 0;
  while (pos + 5 <= raw.length) {
    const flag = raw[pos];
    const length = raw.readUInt32BE(pos + 1);
    pos += 5;
    if (flag === 0x80) {
      // trailer frame
      const trailer = raw.slice(pos, pos + length).toString('utf8');
      results.push({ type: 'trailer', data: trailer });
    } else {
      const data = raw.slice(pos, pos + length);
      results.push({ type: 'data', data, text: data.toString('utf8') });
    }
    pos += length;
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('🔬 gRPC-Web 帧格式测试\n');

const raw = await sqliteQuery("SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';");
const { apiKey } = JSON.parse(raw);
console.log(`apiKey: ${apiKey.slice(0, 25)}...\n`);

const endpoint = 'https://server.codeium.com/exa.language_server_pb.LanguageServerService/GetUserStatus';
const body = JSON.stringify({ metadata: { apiKey, ideName: 'vscode', extensionName: 'codeium.windsurf-windsurf', extensionVersion: '1.9.0' } });

console.log('--- 测试 1: gRPC-Web + apiKey in body ---');
try {
  const r1 = await grpcWebPost(endpoint, body);
  console.log(`HTTP ${r1.status}`);
  console.log('Headers:', JSON.stringify(r1.headers, null, 2).slice(0, 300));
  console.log(`Raw length: ${r1.raw.length}, Hex: ${r1.raw.slice(0, 40).toString('hex')}`);
  const frames = decodeGrpcWebResponse(r1.raw);
  console.log('Decoded frames:');
  for (const f of frames) {
    console.log(`  [${f.type}] ${f.text?.slice(0, 300) ?? f.data?.slice(0, 40).toString('hex')}`);
  }
} catch (e) { console.log('ERROR:', e.message); }

console.log('\n--- 测试 2: gRPC-Web + Authorization Bearer ---');
try {
  const body2 = JSON.stringify({ metadata: { ideName: 'vscode', extensionVersion: '1.9.0' } });
  const r2 = await grpcWebPost(endpoint, body2, { Authorization: `Bearer ${apiKey}` });
  console.log(`HTTP ${r2.status}`);
  console.log(`Raw length: ${r2.raw.length}, Hex: ${r2.raw.slice(0, 40).toString('hex')}`);
  const frames2 = decodeGrpcWebResponse(r2.raw);
  for (const f of frames2) {
    console.log(`  [${f.type}] ${f.text?.slice(0, 300) ?? f.data?.slice(0, 40).toString('hex')}`);
  }
} catch (e) { console.log('ERROR:', e.message); }

console.log('\n--- 测试 3: gRPC-Web + apiKey + Authorization ---');
try {
  const r3 = await grpcWebPost(endpoint, body, { Authorization: `Bearer ${apiKey}` });
  console.log(`HTTP ${r3.status}`);
  console.log(`Raw length: ${r3.raw.length}, Hex: ${r3.raw.slice(0, 40).toString('hex')}`);
  const frames3 = decodeGrpcWebResponse(r3.raw);
  for (const f of frames3) {
    console.log(`  [${f.type}] ${f.text?.slice(0, 300) ?? f.data?.slice(0, 40).toString('hex')}`);
  }
} catch (e) { console.log('ERROR:', e.message); }

console.log('\n--- 测试 4: ConnectRPC + empty message body + bearer ---');
try {
  const r4 = await new Promise((resolve, reject) => {
    const b = JSON.stringify({});
    const u = new URL(endpoint);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(b)
      },
      timeout: 8000
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ s: res.statusCode, b: d }));
    });
    req.on('error', reject);
    req.write(b); req.end();
  });
  console.log(`HTTP ${r4.s}: ${r4.b.slice(0, 200)}`);
} catch (e) { console.log('ERROR:', e.message); }
