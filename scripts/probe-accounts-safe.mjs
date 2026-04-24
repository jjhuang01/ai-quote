#!/usr/bin/env node
/**
 * Safe account probe for Windsurf/Quote accounts.
 *
 * Read-only behavior:
 * - reads the local Quote account store unless --file is provided
 * - probes accounts serially with a delay
 * - stops immediately on Firebase/Devin Auth rate limits
 * - prints redacted summaries only
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const DEFAULT_ACCOUNT_FILE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Windsurf',
  'User',
  'globalStorage',
  'opensource.ai-quote',
  'windsurf-accounts.json',
);

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function redactEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return String(email);
  return `${name.slice(0, 2)}***@${domain}`;
}

function isRateLimit(text) {
  const value = String(text).toLowerCase();
  return value.includes('http 429') || value.includes('too_many_attempts_try_later') || value.includes('too many requests') || value.includes('rate limit');
}

function post(url, body, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Origin: 'https://windsurf.com',
        Referer: 'https://windsurf.com/',
        'User-Agent': 'Mozilla/5.0',
        ...headers,
      },
      timeout: 15_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', (error) => resolve({ status: 0, body: `network error: ${error.message}` }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
    req.write(body);
    req.end();
  });
}

async function firebaseLogin(email, password) {
  const response = await post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    JSON.stringify({ email, password, returnSecureToken: true }),
  );
  if (response.status !== 200) {
    return { ok: false, status: response.status, error: parseError(response.body) };
  }
  const parsed = JSON.parse(response.body);
  return { ok: true, status: response.status, idToken: parsed.idToken };
}

async function devinConnections(email) {
  const response = await post(
    'https://windsurf.com/_devin-auth/connections',
    JSON.stringify({ email }),
  );
  if (response.status !== 200) {
    return { ok: false, status: response.status, error: parseError(response.body) };
  }
  const parsed = JSON.parse(response.body);
  return {
    ok: true,
    status: response.status,
    method: parsed.auth_method?.method,
    hasPassword: parsed.auth_method?.has_password === true,
  };
}

async function devinPasswordLogin(email, password) {
  const response = await post(
    'https://windsurf.com/_devin-auth/password/login',
    JSON.stringify({ email, password }),
  );
  if (response.status !== 200) {
    return { ok: false, status: response.status, error: parseError(response.body) };
  }
  const parsed = JSON.parse(response.body);
  return {
    ok: Boolean(parsed.token),
    status: response.status,
    tokenReturned: Boolean(parsed.token),
    userIdReturned: Boolean(parsed.user_id),
    emailMatches: String(parsed.email ?? '').toLowerCase() === String(email).toLowerCase(),
  };
}

async function getPlanStatus(idToken) {
  const response = await post(
    'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
    JSON.stringify({ auth_token: idToken }),
    { 'X-Auth-Token': idToken },
  );
  if (response.status !== 200) {
    return { ok: false, status: response.status, error: parseError(response.body) };
  }
  const parsed = JSON.parse(response.body);
  const status = parsed.planStatus ?? {};
  return {
    ok: true,
    status: response.status,
    planName: status.planInfo?.planName,
    billingStrategy: status.planInfo?.billingStrategy,
    dailyQuotaRemainingPercent: status.dailyQuotaRemainingPercent,
    weeklyQuotaRemainingPercent: status.weeklyQuotaRemainingPercent,
    dailyQuotaResetAtUnix: status.dailyQuotaResetAtUnix,
    weeklyQuotaResetAtUnix: status.weeklyQuotaResetAtUnix,
    planEnd: status.planEnd,
  };
}

function parseError(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message ?? JSON.stringify(parsed).slice(0, 200);
  } catch {
    return String(body).slice(0, 200);
  }
}

async function loadAccounts(filePath, limit) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  return accounts
    .filter((account) => account.email && account.password && account.password !== '***')
    .slice(0, limit);
}

async function main() {
  const filePath = argValue('--file', DEFAULT_ACCOUNT_FILE);
  const limit = Number(argValue('--limit', '5'));
  const delayMs = Number(argValue('--delay-ms', '5000'));
  const includeRaw = hasFlag('--raw');
  const accounts = await loadAccounts(filePath, Number.isFinite(limit) && limit > 0 ? limit : 5);
  const results = [];

  console.log(`Safe probe: ${accounts.length} account(s), delay=${delayMs}ms`);
  for (const account of accounts) {
    const item = { email: redactEmail(account.email), devin: undefined, login: undefined, quota: undefined };
    const devin = await devinConnections(account.email);
    item.devin = { connections: devin };
    if (!devin.ok) {
      results.push(item);
      console.log(JSON.stringify(item, null, 2));
      if (isRateLimit(devin.error) || devin.status === 429) {
        console.log('Rate limit detected. Stop probing remaining accounts.');
        break;
      }
    } else if (devin.method === 'auth1' && devin.hasPassword) {
      const devinLogin = await devinPasswordLogin(account.email, account.password);
      item.devin.passwordLogin = devinLogin;
      if (!devinLogin.ok && (isRateLimit(devinLogin.error) || devinLogin.status === 429)) {
        results.push(item);
        console.log(JSON.stringify(item, null, 2));
        console.log('Rate limit detected. Stop probing remaining accounts.');
        break;
      }
    }

    const login = await firebaseLogin(account.email, account.password);
    item.login = login.ok ? { ok: true, status: login.status } : login;
    if (!login.ok) {
      results.push(item);
      console.log(JSON.stringify(item, null, 2));
      if (isRateLimit(login.error) || login.status === 429) {
        console.log('Rate limit detected. Stop probing remaining accounts.');
        break;
      }
    } else {
      const quota = await getPlanStatus(login.idToken);
      item.quota = quota;
      results.push(item);
      console.log(JSON.stringify(item, null, 2));
      if (!quota.ok && (isRateLimit(quota.error) || quota.status === 429)) {
        console.log('Rate limit detected. Stop probing remaining accounts.');
        break;
      }
    }

    if (accounts.indexOf(account) < accounts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (includeRaw) {
    console.log(JSON.stringify({ results }, null, 2));
  }
}

main().catch((error) => {
  console.error(`Probe failed: ${error.message}`);
  process.exitCode = 1;
});
