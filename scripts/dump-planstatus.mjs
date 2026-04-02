#!/usr/bin/env node
import https from 'node:https';

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      timeout: 15000
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ s: res.statusCode, b: d })); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

const lr = await post(
  'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY',
  JSON.stringify({ email: 'elzkuhyfd6@gicnsjt.shop', password: '96ahf4w9', returnSecureToken: true })
);
const { idToken, refreshToken } = JSON.parse(lr.b);
console.log('Login OK. idToken prefix:', idToken.slice(0,20));

const pr = await post(
  'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
  JSON.stringify({ auth_token: idToken }),
  { 'X-Auth-Token': idToken, 'User-Agent': 'Mozilla/5.0' }
);
const data = JSON.parse(pr.b);

// Print just planStatus without planInfo internals (to avoid bloat)
const ps = data.planStatus;
console.log('\n=== planStatus top-level keys ===');
console.log(Object.keys(ps));

console.log('\n=== planStatus (no planInfo.cascadeAllowedModelsConfig) ===');
const display = { ...ps, planInfo: { ...ps.planInfo } };
delete display.planInfo.cascadeAllowedModelsConfig;
console.log(JSON.stringify(display, null, 2));

console.log('\n=== refreshToken (for later use) ===');
console.log(refreshToken.slice(0,40) + '...');
