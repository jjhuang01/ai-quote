import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  default: {},
  env: { appRoot: '/Applications/Windsurf.app/Contents/Resources/app' },
}));

import { buildHandleAuthTokenPatch } from '../../src/adapters/windsurf-patch';

describe('buildHandleAuthTokenPatch', () => {
  it('兼容新版 Windsurf 的混淆变量名并生成补丁函数', () => {
    const original =
      'prefix async handleAuthToken(A){const e=await(0,w.registerUser)(A),{apiKey:t,name:i}=e,n=(0,h.getApiServerUrl)(e.apiServerUrl);' +
      'if(!t)throw new Q.AuthMalformedLanguageServerResponseError("missing api key");' +
      'const r={id:"abc",account:{label:i},accessToken:t};' +
      'return this._sessionChangeEmitter.fire({added:[r],removed:[],changed:[]}),r} suffix';

    const patch = buildHandleAuthTokenPatch(original);

    expect(patch).toBeDefined();
    expect(patch?.original).toContain('async handleAuthToken(A)');
    expect(patch?.patched).toContain('async handleAuthTokenWithShit(A){const{apiKey:t,name:i}=A,n=(0,h.getApiServerUrl)(A.apiServerUrl);');
    expect(patch?.patched).not.toContain('registerUser');
    expect(patch?.patched).toContain('this._sessionChangeEmitter.fire({added:[r],removed:[],changed:[]}),r');
  });

  it('结构不匹配时返回 undefined', () => {
    expect(buildHandleAuthTokenPatch('async handleAuthToken(A){return A}')).toBeUndefined();
  });
});
