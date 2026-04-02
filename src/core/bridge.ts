import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createId } from '../utils/tool-name';
import type {
  EchoBridgeEvent,
  EchoBridgeMessage,
  EchoBridgeStatus,
  FirebaseLoginRequest,
  RemoteApiResponse,
  VerifyRequest,
  VersionInfo
} from './contracts';
import type { LoggerLike } from './logger';
import { fetchRemoteVersion, loginWithFirebase, verifyRemoteCode } from '../adapters/remote-api';

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', chunk => {
      raw += chunk;
    });
    request.on('end', () => {
      try {
        resolve((raw ? JSON.parse(raw) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token'
  });
  response.end(JSON.stringify(payload));
}

function writeSseHeaders(response: http.ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
}

export class EchoBridgeServer {
  private readonly messages: EchoBridgeMessage[] = [];
  private readonly clients = new Set<http.ServerResponse>();
  private server?: http.Server;
  private configuredPaths: string[] = [];
  private lastConfiguredAt?: string;

  public constructor(
    private readonly logger: LoggerLike,
    private readonly requestedPort: number,
    private readonly toolName: string,
    private readonly currentIde: string
  ) {}

  public async start(): Promise<number> {
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await this.listenWithFallback(this.requestedPort);

    const address = this.server.address() as AddressInfo;
    this.logger.info('Echo bridge started.', { port: address.port, toolName: this.toolName });
    return address.port;
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    if (!this.server.listening) {
      this.server = undefined;
      return;
    }

    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();

    await new Promise<void>((resolve, reject) => {
      this.server?.close(error => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
    this.logger.info('Echo bridge stopped.');
  }

  public getPort(): number {
    const address = this.server?.address() as AddressInfo | null;
    return address?.port ?? this.requestedPort;
  }

  public getSseUrl(): string {
    return `http://127.0.0.1:${this.getPort()}/sse`;
  }

  public setConfiguredPaths(paths: string[]): void {
    this.configuredPaths = paths;
    this.lastConfiguredAt = new Date().toISOString();
  }

  public getStatus(): EchoBridgeStatus {
    return {
      running: Boolean(this.server?.listening),
      port: this.getPort(),
      toolName: this.toolName,
      currentIde: this.currentIde,
      messageCount: this.messages.length,
      sseClientCount: this.clients.size,
      autoConfiguredPaths: this.configuredPaths,
      lastConfiguredAt: this.lastConfiguredAt
    };
  }

  public async injectTestFeedback(): Promise<EchoBridgeMessage> {
    return this.pushMessage({
      source: 'test',
      text: 'AI Echo rebuild test feedback event.',
      metadata: { scenario: 'testFeedback' }
    });
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      await this.routeRequest(request, response);
    } catch (err) {
      this.logger.error('Unhandled request error.', { error: String(err), url: request.url });
      if (!response.headersSent) {
        writeJson(response, 500, { success: false, message: 'Internal server error' });
      }
    }
  }

  private async routeRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token'
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;

    if ((pathname === '/events' || pathname === '/sse') && request.method === 'GET') {
      this.attachSseClient(response);
      return;
    }

    if (pathname === '/message' && request.method === 'POST') {
      const payload = await readJsonBody<Partial<EchoBridgeMessage>>(request);
      const message = await this.pushMessage({
        source: payload.source ?? 'bridge',
        text: payload.text ?? '',
        metadata: payload.metadata
      });
      writeJson(response, 200, { success: true, data: message });
      return;
    }

    if ((pathname === '/' || pathname === '/api/version' || pathname === '/mcp') && request.method === 'GET') {
      const version = await this.getVersionInfo();
      writeJson(response, 200, version);
      return;
    }

    if (pathname === '/api/verify' && request.method === 'POST') {
      const payload = await readJsonBody<VerifyRequest>(request);
      const verifyResult = await verifyRemoteCode(payload);
      writeJson(response, verifyResult.success ? 200 : 501, verifyResult);
      return;
    }

    if (pathname === '/api/firebase/login' && request.method === 'POST') {
      const payload = await readJsonBody<FirebaseLoginRequest>(request);
      const loginResult = await loginWithFirebase(payload);
      writeJson(response, loginResult.success ? 200 : 501, loginResult);
      return;
    }

    if (pathname === '/status' && request.method === 'GET') {
      writeJson(response, 200, this.getStatus());
      return;
    }

    writeJson(response, 404, {
      success: false,
      message: `Unknown path: ${pathname}`
    });
  }

  private attachSseClient(response: http.ServerResponse): void {
    writeSseHeaders(response);
    this.clients.add(response);
    this.sendEvent({
      type: 'status',
      timestamp: new Date().toISOString(),
      payload: this.getStatus()
    }, response);

    response.on('close', () => {
      this.clients.delete(response);
    });
  }

  private async listenWithFallback(preferredPort: number): Promise<void> {
    try {
      await this.listen(preferredPort);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? Reflect.get(error, 'code') : undefined;
      if (code !== 'EADDRINUSE') {
        throw error;
      }

      this.logger.warn('Preferred bridge port is in use. Falling back to a random port.', {
        preferredPort
      });
      await this.listen(0);
    }
  }

  private async listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error('Bridge server was not initialized.'));
        return;
      }

      const handleError = (error: Error): void => {
        server.off('listening', handleListening);
        reject(error);
      };

      const handleListening = (): void => {
        server.off('error', handleError);
        resolve();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(port, '127.0.0.1');
    });
  }

  private async getVersionInfo(): Promise<RemoteApiResponse<VersionInfo>> {
    const remote = await fetchRemoteVersion();
    return remote;
  }

  private async pushMessage(input: Pick<EchoBridgeMessage, 'source' | 'text' | 'metadata'>): Promise<EchoBridgeMessage> {
    const message: EchoBridgeMessage = {
      id: createId('msg'),
      source: input.source,
      text: input.text,
      createdAt: new Date().toISOString(),
      metadata: input.metadata
    };
    this.messages.unshift(message);
    this.messages.splice(20);
    this.broadcast({
      type: 'message',
      timestamp: new Date().toISOString(),
      payload: message
    });
    this.logger.info('Bridge message stored.', { messageId: message.id, source: message.source });
    return message;
  }

  private broadcast(event: EchoBridgeEvent): void {
    for (const client of this.clients) {
      this.sendEvent(event, client);
    }
  }

  private sendEvent(event: EchoBridgeEvent, response: http.ServerResponse): void {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event.payload)}\n\n`);
  }
}
