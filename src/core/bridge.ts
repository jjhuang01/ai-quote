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

export class QuoteBridge {
  private readonly messages: QuoteMessage[] = [];
  private readonly clients = new Map<string, http.ServerResponse>();
  private server?: http.Server;
  private configuredPaths: string[] = [];
  private lastConfiguredAt?: string;
  private pendingDialog?: McpDialogRequest;
  private dialogCallback?: DialogCallback;
  private dialogResolvedCallback?: () => void;
  private sseClientChangeCallback?: () => void;
  // Key = dialogReq.id (stable across SSE reconnections), NOT sessionId
  private pendingDialogResolvers = new Map<
    string | number,
    (response: string, images?: ImageAttachment[]) => void
  >();

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
    this.pendingDialog = undefined;
    // Resolve all pending dialog awaits so handleMcpRequest coroutines can exit cleanly.
    for (const resolver of this.pendingDialogResolvers.values()) {
      resolver("(bridge stopped)");
    }
    this.pendingDialogResolvers.clear();

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
      pendingDialog: this.pendingDialog,
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
    // Try to find resolver by pendingDialog id (primary) or sessionId (fallback)
    const dialogId = this.pendingDialog?.sessionId === sessionId
      ? this.pendingDialog.id
      : sessionId;
    const resolver = this.pendingDialogResolvers.get(dialogId)
      ?? this.pendingDialogResolvers.get(sessionId);
    if (resolver) {
      resolver(response, images);
      this.pendingDialogResolvers.delete(dialogId);
      this.pendingDialogResolvers.delete(sessionId);
    } else {
      this.logger.warn("resolvePendingDialog: no resolver found.", {
        sessionId,
        dialogId,
      });
    }
    if (this.pendingDialog?.sessionId === sessionId) {
      this.pendingDialog = undefined;
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
    // Only clean up a previous TEST session (never resolve a real MCP session with a garbage string).
    // Real MCP sessions have sessionId like "sess_..." injected by attachSseClient.
    if (
      this.pendingDialog &&
      this.pendingDialog.sessionId.startsWith("test_")
    ) {
      const old = this.pendingDialog.sessionId;
      if (this.pendingDialogResolvers.has(old)) {
        this.pendingDialogResolvers.get(old)?.("(replaced by new test)");
        this.pendingDialogResolvers.delete(old);
      }
    }
    this.pendingDialog = req;
    this.pendingDialogResolvers.set(req.sessionId, (response: string) => {
      onResponse(response);
      if (this.pendingDialog?.sessionId === req.sessionId) {
        this.pendingDialog = undefined;
      }
    });
    this.logger.info("Test dialog injected.", { sessionId: req.sessionId });
    // Notify extension to open dialog panel (same as real MCP calls)
    this.dialogCallback?.(req);
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

  private async handleMcpRequest(
    body: Record<string, unknown>,
    sessionId: string | undefined,
    httpResponse: http.ServerResponse,
  ): Promise<void> {
    const method = body["method"] as string | undefined;
    const id = body["id"] as number | string | undefined;

    this.logger.info("MCP request received.", { method, id, sessionId });

    // Always ack immediately with 202
    httpResponse.writeHead(202, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    httpResponse.end(JSON.stringify({ accepted: true }));

    // Helper: find the best SSE client to write to.
    // Prefers the original session, but falls back to the latest connected client.
    // This ensures SSE reconnections (new sessionId) don't break response delivery.
    const findSseClient = (): http.ServerResponse | undefined => {
      if (sessionId) {
        const original = this.clients.get(sessionId);
        if (original && !original.writableEnded) return original;
      }
      // Fallback: use the most recently connected client (last in Map iteration order)
      let latest: http.ServerResponse | undefined;
      for (const c of this.clients.values()) {
        if (!c.writableEnded) latest = c;
      }
      return latest;
    };

    // Write a JSON-RPC message to SSE with proper `event: message` prefix (MCP spec)
    const writeSseEvent = (client: http.ServerResponse, data: string): void => {
      client.write(`event: message\ndata: ${data}\n\n`);
    };

    const pushJsonRpc = (result: unknown, error?: unknown): void => {
      const rpcResponse: Record<string, unknown> = {
        jsonrpc: "2.0",
        id: id ?? null,
      };
      if (error) rpcResponse["error"] = error;
      else rpcResponse["result"] = result;
      const data = JSON.stringify(rpcResponse);
      const client = findSseClient();
      if (client) {
        writeSseEvent(client, data);
      } else {
        // Broadcast to all if no active client found
        for (const c of this.clients.values()) {
          if (!c.writableEnded) writeSseEvent(c, data);
        }
      }
      this.logger.info("MCP response sent.", { method, id });
    };

    switch (method) {
      case "initialize": {
        pushJsonRpc({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: this.toolName, version: "1.0.0" },
          instructions:
            "Use the available tool to deliver responses to the user.",
        });
        break;
      }
      case "notifications/initialized":
        // No response needed for notifications
        break;
      case "tools/list":
      case "tools/list/": {
        pushJsonRpc({
          tools: [this.buildToolDef()],
        });
        break;
      }
      case "tools/call": {
        const params = body["params"] as Record<string, unknown> | undefined;
        const args = params?.["arguments"] as
          | Record<string, unknown>
          | undefined;
        const summary = (args?.["summary"] as string | undefined) ?? "";
        const rawOptions = args?.["options"];
        const options = Array.isArray(rawOptions)
          ? (rawOptions as string[])
          : undefined;
        const isMarkdown =
          (args?.["is_markdown"] as boolean | undefined) ?? true;

        if (!sessionId) {
          pushJsonRpc(undefined, {
            code: -32000,
            message: "tools/call requires SSE session",
          });
          break;
        }

        // B3: Validate tool name
        const calledName = params?.["name"] as string | undefined;
        if (calledName && calledName !== this.toolName) {
          pushJsonRpc(undefined, {
            code: -32601,
            message: `Tool not found: ${calledName}`,
          });
          this.logger.warn("tools/call: unknown tool name.", {
            calledName,
            expected: this.toolName,
          });
          break;
        }

        // B1: Handle concurrent/retry calls —
        // supersede old dialog instead of rejecting (supports Windsurf timeout retries)
        if (this.pendingDialog) {
          const oldKey = this.pendingDialog.id;
          const oldResolver = this.pendingDialogResolvers.get(oldKey);
          if (oldResolver) {
            this.pendingDialogResolvers.delete(oldKey);
            this.logger.info("tools/call: superseding previous dialog (retry).", {
              oldDialogId: oldKey,
              sessionId,
            });
            oldResolver("(superseded by retry)");
          }
          this.pendingDialog = undefined;
        }

        const dialogReq: McpDialogRequest = {
          id: id ?? createId("mcp"),
          sessionId,
          summary,
          options,
          isMarkdown,
          receivedAt: new Date().toISOString(),
        };
        this.pendingDialog = dialogReq;
        this.logger.info("MCP tools/call: awaiting dialog response.", {
          sessionId,
          summaryLen: summary.length,
        });

        // Extract progressToken for MCP progress notifications (resets client-side timeout)
        const meta = (params as Record<string, unknown> | undefined)?.[
          "_meta"
        ] as Record<string, unknown> | undefined;
        const clientProgressToken = meta?.["progressToken"] as
          | string
          | number
          | undefined;
        const dialogKey = dialogReq.id;
        // Set up resolver FIRST so dialogCallback can auto-reply synchronously
        // Key by dialogReq.id (stable) — NOT sessionId (dies on SSE reconnect)
        const dialogPromise = new Promise<void>((resolve) => {
          this.pendingDialogResolvers.set(
            dialogKey,
            (userResponse: string, images?: ImageAttachment[]) => {
              // Cleanup is handled by callers (resolvePendingDialog / timeout handler)
              clearInterval(keepAlive);
              clearTimeout(timeoutHandle);
              const content: Record<string, unknown>[] = [
                { type: "text", text: userResponse },
              ];
              if (images && images.length > 0) {
                for (const img of images) {
                  // MCP spec ImageContent: top-level data + mimeType
                  content.push({
                    type: "image",
                    data: img.data,
                    mimeType: img.media_type,
                  });
                }
              }
              pushJsonRpc({ content, isError: false });
              this.logger.info("MCP dialog response sent.", {
                sessionId,
                responseLen: userResponse.length,
                imageCount: images?.length ?? 0,
              });
              resolve();
            },
          );
        });

        this.logger.info("MCP tools/call: keepalive config.", {
          sessionId,
          clientProgressToken: clientProgressToken ?? "(none)",
        });

        // Multi-layer keepalive strategy to prevent Windsurf Cascade timeout.
        // Uses findSseClient() which auto-discovers the latest SSE connection
        // even after Windsurf drops + reconnects with a new sessionId.
        let progressCounter = 0;
        const keepAlive = setInterval(() => {
          const client = findSseClient();
          if (client) {
            progressCounter++;
            // L1: SSE comment — keeps TCP/proxy/LB connections alive
            client.write(": keepalive\n\n");

            // L2: MCP progress notification — resets client SDK request timeout.
            // Only send if client explicitly provided a progressToken.
            if (clientProgressToken !== undefined) {
              const progressNotification = JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: {
                  progressToken: clientProgressToken,
                  progress: progressCounter,
                  total: progressCounter + 1,
                  message: "Waiting for user response...",
                },
              });
              writeSseEvent(client, progressNotification);
            }

            // L3: MCP log notification — a real JSON-RPC named event.
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
          } else {
            // No active SSE client — broadcast keepalive comment to all
            for (const c of this.clients.values()) {
              if (!c.writableEnded) c.write(": keepalive\n\n");
            }
          }
        }, KEEPALIVE_INTERVAL_MS);

        // Optional auto-timeout (0 = wait indefinitely)
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        if (this.dialogTimeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            const resolver = this.pendingDialogResolvers.get(dialogKey);
            if (resolver) {
              this.pendingDialogResolvers.delete(dialogKey);
              this.pendingDialog = undefined;
              this.logger.info("Dialog auto-dismissed due to timeout.", {
                sessionId,
                timeoutMs: this.dialogTimeoutMs,
              });
              resolver("(timeout)");
            }
          }, this.dialogTimeoutMs);
        }

        // Notify extension to show dialog (resolver already registered — auto-reply works)
        if (this.dialogCallback) {
          this.dialogCallback(dialogReq);
        }

        await dialogPromise;
        clearInterval(keepAlive);
        clearTimeout(timeoutHandle);
        // Notify extension to refresh status bar etc.
        this.dialogResolvedCallback?.();
        break;
      }
      case "ping":
        pushJsonRpc({});
        break;
      default:
        pushJsonRpc(undefined, {
          code: -32601,
          message: `Method not found: ${method ?? "unknown"}`,
        });
    }
  }

  private buildToolDef(): Record<string, unknown> {
    return {
      name: this.toolName,
      description: "Send a structured response to the user interface.",
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
