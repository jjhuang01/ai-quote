import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createId } from "../utils/tool-name";
import type {
  QuoteEvent,
  QuoteMessage,
  QuoteStatus,
  McpDialogRequest,
  ImageAttachment,
  FirebaseLoginRequest,
  RemoteApiResponse,
  VerifyRequest,
  VersionInfo,
} from "./contracts";
import type { LoggerLike } from "./logger";
import {
  fetchRemoteVersion,
  loginWithFirebase,
  verifyRemoteCode,
} from "../adapters/remote-api";

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve((raw ? JSON.parse(raw) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Auth-Token",
  });
  response.end(JSON.stringify(payload));
}

function writeSseHeaders(response: http.ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
}

/** How often to send keepalive signals (SSE comment + MCP notifications) during dialog wait */
const KEEPALIVE_INTERVAL_MS = 3_000;

export type DialogCallback = (request: McpDialogRequest) => void;

interface PendingDialogTask {
  request: McpDialogRequest;
  sessionId: string;
  httpResponse: http.ServerResponse;
  clientProgressToken?: string | number;
  resolveResult: (value: string | undefined) => void;
}

export class QuoteBridge {
  private readonly messages: QuoteMessage[] = [];
  private readonly clients = new Map<string, http.ServerResponse>();
  private server?: http.Server;
  private configuredPaths: string[] = [];
  private lastConfiguredAt?: string;
  private activeDialog?: McpDialogRequest;
  private readonly queuedDialogs: PendingDialogTask[] = [];
  private processingDialog = false;
  private dialogCallback?: DialogCallback;
  private dialogResolvedCallback?: () => void;
  private sseClientChangeCallback?: () => void;
  // Key = dialogReq.id (stable across SSE reconnections), NOT sessionId
  private pendingDialogResolvers = new Map<
    string | number,
    (response: string, images?: ImageAttachment[], cancelled?: boolean) => void
  >();
  // Reverse mapping: sessionId → dialogKey for reliable resolver lookup (RC3)
  private sessionToDialogKey = new Map<string, string | number>();

  public constructor(
    private readonly logger: LoggerLike,
    private readonly requestedPort: number,
    private toolName: string,
    private readonly currentIde: string,
    private readonly dialogTimeoutMs: number = 0,
  ) {}

  public async start(): Promise<number> {
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    // Disable server-level timeouts to support indefinite dialog waits
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 0;
    this.server.requestTimeout = 0;

    await this.listenWithFallback(this.requestedPort);

    const address = this.server.address() as AddressInfo;
    this.logger.info("Quote bridge started.", {
      port: address.port,
      toolName: this.toolName,
    });
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

    for (const client of this.clients.values()) {
      client.end();
    }
    this.clients.clear();
    this.activeDialog = undefined;
    this.processingDialog = false;
    this.queuedDialogs.length = 0;
    // Resolve all pending dialog awaits so handleMcpRequest coroutines can exit cleanly.
    for (const resolver of this.pendingDialogResolvers.values()) {
      resolver("Bridge stopped", undefined, true);
    }
    this.pendingDialogResolvers.clear();
    this.sessionToDialogKey.clear();

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
    this.logger.info("Quote bridge stopped.");
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

  public updateToolName(newName: string): void {
    this.toolName = newName;
    this.logger.info("Tool name updated.", { toolName: newName });
  }

  public getStatus(): QuoteStatus {
    return {
      running: Boolean(this.server?.listening),
      port: this.getPort(),
      toolName: this.toolName,
      currentIde: this.currentIde,
      messageCount: this.messages.length,
      sseClientCount: this.clients.size,
      autoConfiguredPaths: this.configuredPaths,
      lastConfiguredAt: this.lastConfiguredAt,
      activeDialog: this.activeDialog,
      queuedDialogCount: this.queuedDialogs.length,
      pendingDialog: this.activeDialog,
    };
  }

  public async injectTestFeedback(): Promise<QuoteMessage> {
    return this.pushMessage({
      source: "test",
      text: "Quote bridge test feedback event.",
      metadata: { scenario: "testFeedback" },
    });
  }

  public registerDialogCallback(cb: DialogCallback): void {
    this.dialogCallback = cb;
    this.logger.info("Dialog callback registered.");
  }

  /** Called after every dialog resolution (real MCP or test) to allow callers to refresh UI state. */
  public registerDialogResolvedCallback(cb: () => void): void {
    this.dialogResolvedCallback = cb;
  }

  /** Called when SSE client connects or disconnects — use to refresh UI immediately. */
  public registerSseClientChangeCallback(cb: () => void): void {
    this.sseClientChangeCallback = cb;
  }

  public resolvePendingDialog(
    sessionId: string,
    response: string,
    images?: ImageAttachment[],
  ): void {
    // Try reverse mapping first (RC3), then activeDialog id, then sessionId
    const dialogKey = this.sessionToDialogKey.get(sessionId)
      ?? (this.activeDialog?.sessionId === sessionId ? this.activeDialog.id : undefined);
    const resolver = (dialogKey != null ? this.pendingDialogResolvers.get(dialogKey) : undefined)
      ?? this.pendingDialogResolvers.get(sessionId);
    if (resolver) {
      resolver(response, images);
      if (dialogKey != null) this.pendingDialogResolvers.delete(dialogKey);
      this.pendingDialogResolvers.delete(sessionId);
    } else {
      this.logger.warn("resolvePendingDialog: no resolver found — user response dropped!", {
        sessionId,
        dialogKey,
        responseLen: response.length,
        hasActiveDialog: !!this.activeDialog,
        activeDialogSessionId: this.activeDialog?.sessionId,
      });
    }
    this.sessionToDialogKey.delete(sessionId);
    if (this.activeDialog?.sessionId === sessionId) {
      this.activeDialog = undefined;
    }
  }

  /**
   * Programmatically inject a test dialog request (for debug panel / testDialog command).
   * Returns the unique sessionId so callers can resolve it via resolvePendingDialog().
   */
  public injectTestDialogRequest(
    req: McpDialogRequest,
    onResponse: (r: string) => void,
  ): void {
    this.sessionToDialogKey.set(req.sessionId, req.id);
    this.pendingDialogResolvers.set(req.id, (response: string) => {
      onResponse(response);
      if (this.activeDialog?.sessionId === req.sessionId) {
        this.activeDialog = undefined;
      }
      this.sessionToDialogKey.delete(req.sessionId);
    });
    this.activeDialog = req;
    this.logger.info("Test dialog injected.", { sessionId: req.sessionId });
    this.dialogCallback?.(req);
  }

  private async handleMcpRequest(
    body: Record<string, unknown>,
    sessionId: string | undefined,
    httpResponse: http.ServerResponse,
  ): Promise<void> {
    const method = body["method"];

    if (method === "initialize") {
      writeJson(httpResponse, 200, {
        jsonrpc: "2.0",
        id: body["id"] ?? null,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: {
            name: "quote-bridge",
            version: "0.1.0",
          },
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      httpResponse.writeHead(202, { "Access-Control-Allow-Origin": "*" });
      httpResponse.end();
      return;
    }

    if (method === "tools/list") {
      writeJson(httpResponse, 200, {
        jsonrpc: "2.0",
        id: body["id"] ?? null,
        result: {
          tools: [this.buildToolDef()],
        },
      });
      return;
    }

    if (method !== "tools/call") {
      writeJson(httpResponse, 400, {
        jsonrpc: "2.0",
        id: body["id"] ?? null,
        error: {
          code: -32601,
          message: `Unsupported MCP method: ${String(method)}`,
        },
      });
      return;
    }

    const params = (body["params"] ?? {}) as Record<string, unknown>;
    const argumentsObject = (params["arguments"] ?? {}) as Record<string, unknown>;
    const summary = String(argumentsObject["summary"] ?? "");
    const options = Array.isArray(argumentsObject["options"])
      ? argumentsObject["options"].filter((item): item is string => typeof item === "string")
      : undefined;
    const isMarkdown = argumentsObject["is_markdown"] !== false;
    const clientProgressToken = params["_meta"] && typeof params["_meta"] === "object"
      ? (params["_meta"] as Record<string, unknown>)["progressToken"] as string | number | undefined
      : undefined;

    if (!sessionId) {
      writeJson(httpResponse, 400, {
        jsonrpc: "2.0",
        id: body["id"] ?? null,
        error: {
          code: -32000,
          message: "Missing sessionId for MCP dialog request",
        },
      });
      return;
    }

    const dialogReq: McpDialogRequest = {
      id: body["id"] as string | number,
      sessionId,
      summary,
      options,
      isMarkdown,
      receivedAt: new Date().toISOString(),
    };

    await new Promise<void>((resolve) => {
      this.sessionToDialogKey.set(sessionId, dialogReq.id);
      this.queuedDialogs.push({
        request: dialogReq,
        sessionId,
        httpResponse,
        clientProgressToken,
        resolveResult: () => resolve(),
      });
      void this.processQueuedDialogs();
    });
  }

  private async processQueuedDialogs(): Promise<void> {
    if (this.processingDialog) {
      return;
    }
    this.processingDialog = true;
    try {
      while (this.queuedDialogs.length > 0) {
        const task = this.queuedDialogs.shift();
        if (!task) {
          break;
        }
        await this.runDialogTask(task);
      }
    } finally {
      this.processingDialog = false;
    }
  }

  private async runDialogTask(task: PendingDialogTask): Promise<void> {
    const { request: dialogReq, sessionId, httpResponse, clientProgressToken, resolveResult } = task;
    this.activeDialog = dialogReq;
    this.logger.info("MCP tools/call: awaiting dialog response.", {
      sessionId,
      summaryLen: dialogReq.summary.length,
      queuedDialogCount: this.queuedDialogs.length,
    });

    const findSseClient = (): http.ServerResponse | undefined => {
      const original = this.clients.get(sessionId);
      if (original && !original.writableEnded) {
        return original;
      }
      return undefined;
    };

    const writeSseEvent = (client: http.ServerResponse, data: string): void => {
      client.write(`event: message\ndata: ${data}\n\n`);
    };

    const buildRpcResponse = (result: unknown, error?: unknown): string => {
      const rpcResponse: Record<string, unknown> = {
        jsonrpc: "2.0",
        id: dialogReq.id ?? null,
      };
      if (error) rpcResponse["error"] = error;
      else rpcResponse["result"] = result;
      return JSON.stringify(rpcResponse);
    };

    let rpcResultData: string | undefined;
    const dialogKey = dialogReq.id;

    const dialogPromise = new Promise<void>((resolve) => {
      this.pendingDialogResolvers.set(
        dialogKey,
        (userResponse: string, images?: ImageAttachment[], cancelled?: boolean) => {
          clearInterval(keepAlive);
          clearTimeout(timeoutHandle);
          if (cancelled) {
            rpcResultData = buildRpcResponse(undefined, {
              code: -32001,
              message: userResponse,
            });
            this.logger.info("MCP dialog cancelled.", {
              sessionId,
              reason: userResponse,
            });
            resolve();
            return;
          }
          const content: Record<string, unknown>[] = [
            { type: "text", text: userResponse },
          ];
          if (images && images.length > 0) {
            for (const img of images) {
              content.push({
                type: "image",
                data: img.data,
                mimeType: img.media_type,
              });
            }
          }
          rpcResultData = buildRpcResponse({ content, isError: false });
          this.logger.info("MCP dialog response prepared.", {
            sessionId,
            responseLen: userResponse.length,
            imageCount: images?.length ?? 0,
          });
          resolve();
        },
      );
    });

    let progressCounter = 0;
    const keepAlive = setInterval(() => {
      const client = findSseClient();
      if (client) {
        progressCounter++;
        client.write(": keepalive\n\n");
        if (clientProgressToken !== undefined) {
          const progressNotification = JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: {
              progressToken: clientProgressToken,
              progress: progressCounter,
              message: "Waiting for user response...",
            },
          });
          writeSseEvent(client, progressNotification);
        }
        const logNotification = JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: {
            level: "info",
            logger: "quote-keepalive",
            data: `Waiting for user response... (${progressCounter * 3}s)`,
          },
        });
        writeSseEvent(client, logNotification);
      }
    }, KEEPALIVE_INTERVAL_MS);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (this.dialogTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        const resolver = this.pendingDialogResolvers.get(dialogKey);
        if (resolver) {
          this.pendingDialogResolvers.delete(dialogKey);
          this.sessionToDialogKey.delete(sessionId);
          this.activeDialog = undefined;
          this.logger.info("Dialog auto-dismissed due to timeout.", {
            sessionId,
            timeoutMs: this.dialogTimeoutMs,
          });
          resolver("Dialog timed out", undefined, true);
        }
      }, this.dialogTimeoutMs);
    }

    this.dialogCallback?.(dialogReq);
    await dialogPromise;
    clearInterval(keepAlive);
    clearTimeout(timeoutHandle);

    this.pendingDialogResolvers.delete(dialogKey);
    this.sessionToDialogKey.delete(sessionId);
    this.activeDialog = undefined;

    if (rpcResultData) {
      const sseClient = findSseClient();
      if (sseClient) {
        writeSseEvent(sseClient, rpcResultData);
        if (!httpResponse.writableEnded) {
          httpResponse.writeHead(202, { "Access-Control-Allow-Origin": "*" });
          httpResponse.end();
        }
        this.logger.info("MCP dialog response sent via SSE → 202.", {
          sessionId,
        });
      } else if (!httpResponse.writableEnded) {
        writeJson(httpResponse, 200, JSON.parse(rpcResultData));
        this.logger.info("MCP dialog response sent via HTTP fallback → 200.", {
          sessionId,
        });
      }
    } else if (!httpResponse.writableEnded) {
      httpResponse.writeHead(202, { "Access-Control-Allow-Origin": "*" });
      httpResponse.end();
    }

    this.dialogResolvedCallback?.();
    resolveResult(rpcResultData);
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      await this.routeRequest(request, response);
    } catch (err) {
      this.logger.error("Unhandled request error.", {
        error: String(err),
        url: request.url,
      });
      if (!response.headersSent) {
        writeJson(response, 500, {
          success: false,
          message: "Internal server error",
        });
      }
    }
  }

  private async routeRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Auth-Token",
      });
      response.end();
      return;
    }

    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    const pathname = url.pathname;

    const sessionId = url.searchParams.get("sessionId") ?? undefined;

    if (
      (pathname === "/events" || pathname === "/sse") &&
      request.method === "GET"
    ) {
      this.attachSseClient(response);
      return;
    }

    if (pathname === "/message" && request.method === "POST") {
      const body = await readJsonBody<Record<string, unknown>>(request);

      if (body["jsonrpc"] === "2.0") {
        await this.handleMcpRequest(body, sessionId, response);
        return;
      }

      const payload = body as Partial<QuoteMessage>;
      const message = await this.pushMessage({
        source: payload.source ?? "bridge",
        text: payload.text ?? "",
        metadata: payload.metadata,
      });
      writeJson(response, 200, { success: true, data: message });
      return;
    }

    if (
      (pathname === "/" ||
        pathname === "/api/version" ||
        pathname === "/mcp") &&
      request.method === "GET"
    ) {
      const version = await this.getVersionInfo();
      writeJson(response, 200, version);
      return;
    }

    if (pathname === "/api/verify" && request.method === "POST") {
      const payload = await readJsonBody<VerifyRequest>(request);
      const verifyResult = await verifyRemoteCode(payload);
      writeJson(response, verifyResult.success ? 200 : 501, verifyResult);
      return;
    }

    if (pathname === "/api/firebase/login" && request.method === "POST") {
      const payload = await readJsonBody<FirebaseLoginRequest>(request);
      const loginResult = await loginWithFirebase(payload);
      writeJson(response, loginResult.success ? 200 : 501, loginResult);
      return;
    }

    if (pathname === "/status" && request.method === "GET") {
      writeJson(response, 200, this.getStatus());
      return;
    }

    writeJson(response, 404, {
      success: false,
      message: `Unknown path: ${pathname}`,
    });
  }

  private attachSseClient(response: http.ServerResponse): void {
    const sid = createId("sess");
    writeSseHeaders(response);

    // TCP-level keepalive: prevent OS/firewall/proxy from killing idle connections
    const socket = response.socket;
    if (socket) {
      socket.setKeepAlive(true, 15_000); // TCP probe every 15s
      socket.setNoDelay(true); // disable Nagle — send keepalive bytes immediately
    }

    this.clients.set(sid, response);

    // MCP SSE transport: tell client where to POST requests
    response.write(`event: endpoint\n`);
    response.write(`data: /message?sessionId=${sid}\n\n`);

    // Also send our own status event for the webview
    this.sendEvent(
      {
        type: "status",
        timestamp: new Date().toISOString(),
        payload: this.getStatus(),
      },
      response,
    );

    this.logger.info("SSE client connected.", { sessionId: sid });
    this.sseClientChangeCallback?.();

    response.on("close", () => {
      this.clients.delete(sid);
      // Dialog resolvers are keyed by dialogReq.id (not sessionId),
      // so SSE reconnection does NOT kill pending dialogs.
      this.logger.info("SSE client disconnected.", { sessionId: sid });
      this.sseClientChangeCallback?.();
    });
  }


  private buildToolDef(): Record<string, unknown> {
    return {
      name: this.toolName,
      description:
        "Send a structured response to the user interface. The tool result contains the user's direct reply that should be addressed in your next response.",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Markdown content to display to the user.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional quick-reply options for the user.",
          },
          is_markdown: {
            type: "boolean",
            description:
              "Whether summary is Markdown formatted. Defaults to true.",
          },
        },
        required: ["summary"],
      },
    };
  }

  private async listenWithFallback(preferredPort: number): Promise<void> {
    try {
      await this.listen(preferredPort);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? Reflect.get(error, "code")
          : undefined;
      if (code !== "EADDRINUSE") {
        throw error;
      }

      this.logger.warn(
        "Preferred bridge port is in use. Falling back to a random port.",
        {
          preferredPort,
        },
      );
      await this.listen(0);
    }
  }

  private async listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("Bridge server was not initialized."));
        return;
      }

      const handleError = (error: Error): void => {
        server.off("listening", handleListening);
        reject(error);
      };

      const handleListening = (): void => {
        server.off("error", handleError);
        resolve();
      };

      server.once("error", handleError);
      server.once("listening", handleListening);
      server.listen(port, "127.0.0.1");
    });
  }

  private async getVersionInfo(): Promise<RemoteApiResponse<VersionInfo>> {
    const remote = await fetchRemoteVersion();
    return remote;
  }

  private async pushMessage(
    input: Pick<QuoteMessage, "source" | "text" | "metadata">,
  ): Promise<QuoteMessage> {
    const message: QuoteMessage = {
      id: createId("msg"),
      source: input.source,
      text: input.text,
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
    };
    this.messages.unshift(message);
    this.messages.splice(20);
    this.broadcast({
      type: "message",
      timestamp: new Date().toISOString(),
      payload: message,
    });
    this.logger.info("Bridge message stored.", {
      messageId: message.id,
      source: message.source,
    });
    return message;
  }

  private broadcast(event: QuoteEvent): void {
    for (const client of this.clients.values()) {
      this.sendEvent(event, client);
    }
  }

  private sendEvent(event: QuoteEvent, response: http.ServerResponse): void {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event.payload)}\n\n`);
  }
}
