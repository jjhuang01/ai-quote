import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { ProxyAgent } from 'proxy-agent';
import type { FirebaseLoginRequest, RemoteApiResponse, VerifyRequest, VersionInfo } from '../core/contracts';

function getRemoteBaseUrl(): string | undefined {
  const value = process.env.QUOTE_REMOTE_BASE_URL?.trim();
  return value ? value.replace(/\/$/, '') : undefined;
}

function requestJson<TResponse>(urlString: string, method: 'GET' | 'POST', body?: unknown): Promise<TResponse> {
  const url = new URL(urlString);
  const payload = body ? JSON.stringify(body) : undefined;
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const agent = new ProxyAgent();
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: 8000,
        agent
      },
      res => {
        let chunks = '';
        res.on('data', chunk => {
          chunks += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(chunks) as TResponse);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Remote API request timed out.'));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

export async function fetchRemoteVersion(): Promise<RemoteApiResponse<VersionInfo>> {
  const base = getRemoteBaseUrl();
  if (!base) {
    return {
      success: true,
      message: 'Remote API not configured; using local rebuild mode.',
      data: {
        name: 'quote',
        version: '0.1.0',
        mode: 'local-rebuild'
      }
    };
  }

  return requestJson<RemoteApiResponse<VersionInfo>>(`${base}/api/version`, 'GET');
}

export async function verifyRemoteCode(request: VerifyRequest): Promise<RemoteApiResponse> {
  const base = getRemoteBaseUrl();
  if (!base) {
    return {
      success: false,
      message: 'Remote verify endpoint is not configured in this rebuild.'
    };
  }
  return requestJson<RemoteApiResponse>(`${base}/api/verify`, 'POST', request);
}

export async function loginWithFirebase(request: FirebaseLoginRequest): Promise<RemoteApiResponse> {
  const base = getRemoteBaseUrl();
  if (!base) {
    return {
      success: false,
      message: 'Remote Firebase login endpoint is not configured in this rebuild.'
    };
  }
  return requestJson<RemoteApiResponse>(`${base}/api/firebase/login`, 'POST', request);
}
