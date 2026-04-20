import * as vscode from "vscode";
import type { WindsurfAccount } from "./core/contracts";
import { QuoteBridge } from "./core/bridge";
import type { DialogCallback } from "./core/bridge";
import { getExtensionConfig } from "./core/config";
import { QuoteLogger } from "./core/logger";
import { DataManager } from "./core/data-manager";
import { detectCurrentIde, writeMcpConfig, ensureMcpConfigEntry } from "./adapters/mcp-config";
import { QuoteSidebarProvider } from "./webview/provider";
import { QuoteDialogPanel } from "./webview/dialog-panel";
import { loadOrCreateToolName, rotateToolName } from "./utils/tool-name";
import { configureGlobalRules } from "./adapters/rules";
import { removeMcpConfigEntries } from "./adapters/mcp-config";
// windsurf-patch 仅供 provider.ts 调试面板查询状态，此文件不再需要

let statusBarItem: vscode.StatusBarItem | undefined;
let logger: QuoteLogger | undefined;
let bridge: QuoteBridge | undefined;
let dataManager: DataManager | undefined;
let activeToolName: string | undefined;
let secondaryInstance = false;
let extensionContext: vscode.ExtensionContext | undefined;
const OWNED_MCP_NAMES_KEY = 'ownedMcpNames';

function sanitizeAccount(account: WindsurfAccount): Omit<WindsurfAccount, "password"> & { password: string } {
  return {
    ...account,
    password: account.password ? "***" : "",
  };
}

function getOwnedMcpNames(context: vscode.ExtensionContext): string[] {
  const value = context.globalState.get<string[]>(OWNED_MCP_NAMES_KEY, []);
  return Array.isArray(value) ? value.filter((name) => typeof name === 'string' && name.length > 0) : [];
}

async function rememberOwnedMcpName(context: vscode.ExtensionContext, name: string): Promise<void> {
  const owned = new Set(getOwnedMcpNames(context));
  owned.add(name);
  await context.globalState.update(OWNED_MCP_NAMES_KEY, [...owned]);
}

async function refreshQuotaAfterSwitch(accountId: string, reason: string): Promise<void> {
  if (!dataManager) {
    return;
  }
  try {
    const quotaResult = await dataManager.windsurfAccounts.fetchRealQuota(accountId);
    if (!quotaResult.success) {
      logger?.warn("Fetch quota after account switch failed.", {
        accountId,
        reason,
        error: quotaResult.error,
      });
    }
  } catch (error) {
    logger?.warn("Fetch quota after account switch threw.", {
      accountId,
      reason,
      error: String(error),
    });
  }
}

async function updateStatusBar(): Promise<void> {
  if (!statusBarItem || !bridge) {
    return;
  }
  const status = bridge.getStatus();
  const waitingIcon = status.activeDialog ? '$(pause-circle) ' : '';
  const onlineText = status.running ? `端口 ${status.port}` : '离线';
  statusBarItem.text = `${waitingIcon}$(comment) Quote (${onlineText})`;
  const queuedText = status.queuedDialogCount > 0 ? `  \n队列中: ${status.queuedDialogCount}` : '';
  const toolTipMd = new vscode.MarkdownString(
    `**Quote 已激活 (${onlineText})**  \n` +
    `工具名: \`${status.toolName}\`  \n` +
    `IDE: ${status.currentIde}  \n` +
    `SSE 客户端: ${status.sseClientCount}` +
    (status.activeDialog ? '  \n⏸ **LLM 等待响应...**' : '') +
    queuedText
  );
  toolTipMd.isTrusted = true;
  statusBarItem.tooltip = toolTipMd;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  extensionContext = context;
  logger = new QuoteLogger(context);
  const config = getExtensionConfig();
  const currentIde = detectCurrentIde();
  let toolName = await loadOrCreateToolName(context.globalStorageUri.fsPath);
  await rememberOwnedMcpName(context, toolName);

  dataManager = DataManager.getInstance(context, logger);
  await dataManager.initialize();
  context.subscriptions.push({
    dispose: () => dataManager?.dispose(),
  });

  bridge = new QuoteBridge(
    logger,
    config.serverPort,
    toolName,
    currentIde.name,
    config.dialogTimeoutSeconds > 0 ? config.dialogTimeoutSeconds * 1000 : 0,
  );
  const runningPort = await bridge.start();
  bridge.registerAutopilotHandlers({
    getAccounts: async () => {
      const accounts = dataManager?.windsurfAccounts.getAll().map(sanitizeAccount) ?? [];
      return { success: true, accounts };
    },
    getQuota: async () => {
      const currentId = await dataManager?.windsurfAccounts.getDisplayCurrentAccountId();
      const accounts = dataManager?.windsurfAccounts.getAll() ?? [];
      const current = currentId ? accounts.find((account) => account.id === currentId) : undefined;
      return {
        success: true,
        current: current ? sanitizeAccount(current) : undefined,
        all: accounts.map(sanitizeAccount),
        snapshots: dataManager?.windsurfAccounts.getQuotaSnapshots() ?? [],
      };
    },
    switchAccount: async (accountId: string) => {
      if (!dataManager) {
        return { success: false, message: "DataManager unavailable" };
      }
      const result = await dataManager.windsurfAccounts.switchTo(accountId);
      if (result.success) {
        await refreshQuotaAfterSwitch(accountId, "autopilot.switchAccount");
        sidebarProvider.postBootstrap();
      }
      const account = dataManager.windsurfAccounts.getById(accountId);
      return {
        success: result.success,
        switchedTo: account ? sanitizeAccount(account) : undefined,
        message: result.success ? `Switched to ${account?.email ?? accountId}` : result.error ?? "Switch failed",
      };
    },
    switchNext: async () => {
      if (!dataManager) {
        return { success: false, message: "DataManager unavailable" };
      }
      const beforeId = await dataManager.windsurfAccounts.getDisplayCurrentAccountId();
      const switched = await dataManager.windsurfAccounts.autoSwitchIfNeeded();
      const afterId = await dataManager.windsurfAccounts.getDisplayCurrentAccountId();
      if (switched && afterId) {
        await refreshQuotaAfterSwitch(afterId, "autopilot.switchNext");
      }
      sidebarProvider.postBootstrap();
      return {
        success: switched,
        switchedTo: afterId && afterId !== beforeId ? sanitizeAccount(dataManager.windsurfAccounts.getById(afterId)!) : undefined,
        previousAccountId: beforeId,
        currentAccountId: afterId,
        message: switched ? "Auto switch completed" : "No switch performed",
      };
    },
    refreshQuotas: async () => {
      if (!dataManager) {
        return { success: 0, failed: 1, errors: ["DataManager unavailable"] };
      }
      const result = await dataManager.windsurfAccounts.fetchAllRealQuotas();
      sidebarProvider.postBootstrap();
      return result;
    },
  });

  // Multi-window isolation: if port fell back, another instance owns the primary toolName.
  // Generate a session-scoped toolName so each window keeps an independent MCP entry.
  secondaryInstance = runningPort !== config.serverPort;
  if (secondaryInstance) {
    const { generateToolName } = await import('./utils/tool-name');
    toolName = generateToolName();
    bridge.updateToolName(toolName);
    await rememberOwnedMcpName(context, toolName);
    logger.info('Secondary instance detected — using session-scoped toolName.', {
      primaryPort: config.serverPort,
      runningPort,
      toolName,
    });
  }
  activeToolName = toolName;

  const sidebarProvider = new QuoteSidebarProvider(
    context.extensionUri,
    bridge,
    logger,
    dataManager,
    context,
  );

  const rotateMcpName = async (): Promise<{ newName: string }> => {
    if (!bridge) {
      throw new Error('Bridge 未初始化');
    }
    const newName = await rotateToolName(context.globalStorageUri.fsPath);
    toolName = newName;
    bridge.updateToolName(newName);
    activeToolName = newName;
    await rememberOwnedMcpName(context, newName);
    const sseUrl = `http://127.0.0.1:${bridge.getPort()}/sse`;
    try {
      await writeMcpConfig(detectCurrentIde(), newName, sseUrl);
      await configureGlobalRules(newName);
      logger?.info('MCP config + rules re-written after rotation.', { newName });
    } catch (err) {
      logger?.warn('Re-write after rotation partially failed.', { error: String(err) });
    }
    try {
      const { cleanupStaleRules } = await import('./adapters/rules');
      const removed = await cleanupStaleRules(newName);
      if (removed.length > 0) {
        logger?.info('Stale rule files cleaned up after rotation.', { removed });
      }
    } catch (err) {
      logger?.warn('cleanupStaleRules after rotation failed (non-fatal).', { error: String(err) });
    }
    return { newName };
  };
  sidebarProvider.setRotateMcpNameCallback(rotateMcpName);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      QuoteSidebarProvider.viewId,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.command = "quote.showStatus";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Auto MCP config and rules writing
  const sseUrl = `http://127.0.0.1:${runningPort}/sse`;
  if (config.autoConfigureRules && vscode.workspace.isTrusted) {
    const configuredPaths: string[] = [];
    try {
      const mcpPath = await writeMcpConfig(currentIde, toolName, sseUrl);
      await rememberOwnedMcpName(context, toolName);
      configuredPaths.push(mcpPath);
      logger.info('MCP config written.', { mcpPath });
    } catch (err) {
      logger.warn('Failed to write MCP config.', { error: String(err) });
    }
    try {
      const ruleResults = await configureGlobalRules(toolName);
      configuredPaths.push(
        ...ruleResults.filter((r) => r.written).map((r) => r.path),
      );
      logger.info('Rules configured.', { ruleResults });
    } catch (err) {
      logger.warn('Failed to configure rules.', { error: String(err) });
    }
    bridge.setConfiguredPaths(configuredPaths);
    logger.info('Auto configuration completed.', { configuredPaths, secondaryInstance });

    const guardLogger = logger;
    const mcpGuardInterval = setInterval(async () => {
      try {
        const ok = await ensureMcpConfigEntry(currentIde, toolName, sseUrl);
        if (!ok) {
          guardLogger.warn('MCP config entry missing — re-written.');
        }
      } catch {
        /* ignore */
      }
    }, 30_000);
    context.subscriptions.push({ dispose: () => clearInterval(mcpGuardInterval) });
  }

  // Register MCP dialog callback: open QuoteDialogPanel (editor tab) on LLM call
  const dialogHandler: DialogCallback = (req) => {
    if (statusBarItem) {
      statusBarItem.text = `$(pause-circle) $(comment) Quote ${bridge?.getPort() ?? '?'}`;
      statusBarItem.tooltip = '⏸ LLM 等待用户响应...';
    }

    // ── Queue auto-reply: if queue has content, consume first item automatically ──
    const queueItems = sidebarProvider.getQueueItems();
    if (queueItems.length > 0) {
      const autoReply = queueItems[0];
      sidebarProvider.replaceQueue(queueItems.slice(1));
      bridge?.resolvePendingDialog(req.sessionId, autoReply);
      logger?.info('Auto-replied from queue.', {
        sessionId: req.sessionId,
        responseLen: autoReply.length,
        queueRemaining: queueItems.length - 1,
      });
      void updateStatusBar();
      sidebarProvider.postState();
      QuoteDialogPanel.syncQueueItems(sidebarProvider.getQueueItems());
      return;
    }

    // ── No queue items — show dialog panel and wait for user input ──
    // Notify sidebar for status display
    sidebarProvider.postPendingDialog(req);
    try {
      const settings = dataManager!.settings.get();
      // Load recent conversation history for display in dialog panel
      const recentHistory = dataManager!.history.getByType('conversation').slice(0, 20);
      QuoteDialogPanel.show(context.extensionUri, req, (sessionId, response, images) => {
        bridge?.resolvePendingDialog(sessionId, response, images);
        // Save this exchange to history
        void dataManager!.history.add({
          type: 'conversation',
          title: req.summary.slice(0, 80),
          content: JSON.stringify({ summary: req.summary, response, sessionId }),
        });
        void updateStatusBar();
        sidebarProvider.postState();
      }, {
        enterToSend: settings.enterToSend,
        queueCount: sidebarProvider.getQueueCount(),
        queueItems: sidebarProvider.getQueueItems(),
        soundAlert: settings.soundAlert ?? 'none',
        recentHistory: recentHistory.map(h => {
          try {
            const data = JSON.parse(h.content) as { summary: string; response: string };
            return { summary: data.summary, response: data.response, time: h.createdAt };
          } catch { return null; }
        }).filter((h): h is { summary: string; response: string; time: string } => h !== null),
        onQueueAdd: (items) => {
          sidebarProvider.addToQueue(items);
          QuoteDialogPanel.syncQueueItems(sidebarProvider.getQueueItems());
        },
        onQueueReplace: (items) => {
          sidebarProvider.replaceQueue(items);
          QuoteDialogPanel.syncQueueItems(sidebarProvider.getQueueItems());
        }
      });
    } catch (err) {
      logger?.error('Failed to open QuoteDialogPanel.', { error: String(err) });
      // Sidebar dialog card is the fallback — user can still respond from there
    }
  };
  bridge.registerDialogCallback(dialogHandler);
  bridge.registerDialogResolvedCallback(() => {
    // Show "sent" state in editor tab dialog panel — user closes manually via X button
    QuoteDialogPanel.showSentState();
    void updateStatusBar();
  });
  bridge.registerSseClientChangeCallback(() => {
    void updateStatusBar();
    sidebarProvider.postState();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("quote.openPanel", async () => {
      await vscode.commands.executeCommand(
        "workbench.view.extension.quote-sidebar",
      );
      sidebarProvider.reveal();
      sidebarProvider.postState();
    }),
    vscode.commands.registerCommand("quote.refresh", async () => {
      sidebarProvider.refresh();
      sidebarProvider.postState();
      await updateStatusBar();
      vscode.window.showInformationMessage("Quote sidebar refreshed.");
    }),
    vscode.commands.registerCommand("quote.testFeedback", async () => {
      const message = await bridge?.injectTestFeedback();
      sidebarProvider.postState();
      await updateStatusBar();
      vscode.window.showInformationMessage(
        `Feedback test sent: ${message?.id ?? "n/a"}`,
      );
    }),
    vscode.commands.registerCommand("quote.showStatus", async () => {
      if (!bridge) {
        return;
      }
      const status = bridge.getStatus();
      await updateStatusBar();
      void vscode.window.showInformationMessage(
        `Quote bridge ${status.running ? "running" : "stopped"} · port ${status.port} · IDE ${status.currentIde}`,
      );
    }),
    vscode.commands.registerCommand("quote.copyPort", () => {
      if (!bridge) return;
      const port = bridge.getPort();
      void vscode.env.clipboard.writeText(String(port)).then(() => {
        void vscode.window.showInformationMessage(`端口 ${port} 已复制`);
      });
    }),
    vscode.commands.registerCommand("quote.rotateName", async () => {
      const result = await rotateMcpName();
      await updateStatusBar();
      sidebarProvider.postBootstrap();
      void vscode.window.showInformationMessage(`工具名已旋转为: ${result.newName}`);
    }),
    vscode.commands.registerCommand("quote.testDialog", () => {
      if (!bridge) return;
      const sessionId = `test_${Date.now()}`;
      const req: import('./core/contracts').McpDialogRequest = {
        id: `test_${Date.now()}`,
        sessionId,
        summary: '## 对话框测试\n\n这是一条来自 **Quote 插件**的测试对话框请求。\n\n请选择一个选项或输入自定义回复：',
        options: ['✅ 确认', '❌ 取消', '🔄 重试'],
        isMarkdown: true,
        receivedAt: new Date().toISOString(),
      };

      // injectTestDialogRequest triggers dialogCallback which opens QuoteDialogPanel
      bridge.injectTestDialogRequest(req, (response) => {
        logger?.info('TestDialog: user responded.', { response });
        void vscode.window.showInformationMessage(`测试对话框收到回复: "${response}"`);
        void updateStatusBar();
      });
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      void bridge?.stop();
      logger?.dispose();
    },
  });

  await updateStatusBar();

  // ── autoSwitch 定时器：按 checkInterval 轮询，动态读取最新配置 ─────────
  // 使用固定10s轮询判断是否到达下次检查时间，避免配置变化后需要重建定时器
  let lastAutoSwitchCheckAt = 0;
  const autoSwitchPollInterval = setInterval(async () => {
    if (!dataManager) return;
    const cfg = dataManager.windsurfAccounts.getAutoSwitchConfig();
    if (!cfg.enabled) return;
    const intervalMs = Math.max(10, cfg.checkInterval) * 1000;
    if (Date.now() - lastAutoSwitchCheckAt < intervalMs) return;
    lastAutoSwitchCheckAt = Date.now();
    const switched = await dataManager.windsurfAccounts.autoSwitchIfNeeded();
    sidebarProvider.postBootstrap();
    if (switched) {
      logger?.info('Auto-switch triggered by timer.');
    }
  }, 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(autoSwitchPollInterval) });

  // ── 配额自动刷新（每5分钟）：确保 realQuota 数据新鲜，供 autoSwitch 使用 ──
  const QUOTA_AUTO_REFRESH_MS = 5 * 60_000;
  const quotaRefreshInterval = setInterval(async () => {
    if (!dataManager) return;
    const accounts = dataManager.windsurfAccounts.getAll();
    if (accounts.filter(a => a.password).length === 0) return;
    await dataManager.windsurfAccounts.fetchAllRealQuotas();
    sidebarProvider.postBootstrap();
    const cfg = dataManager.windsurfAccounts.getAutoSwitchConfig();
    if (cfg.enabled) {
      const switched = await dataManager.windsurfAccounts.autoSwitchIfNeeded();
      sidebarProvider.postBootstrap();
      if (switched) {
        logger?.info('Auto-switch triggered after quota refresh.');
      }
    }
  }, QUOTA_AUTO_REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(quotaRefreshInterval) });

  // 延迟刷新状态：等待 MCP 客户端连接后更新 SSE 计数
  setTimeout(() => {
    void updateStatusBar();
    sidebarProvider.postBootstrap();
  }, 3000);

  logger.info("Quote activated.", {
    currentIde: currentIde.name,
    requestedPort: config.serverPort,
    runningPort,
    autoConfigureRules: config.autoConfigureRules,
  });

  // ── 备用渠道：如果有 pending 切换则完成（兼容旧逻辑） ───────────────
  const pendingId = dataManager.windsurfAccounts.getPendingSwitchId();
  if (pendingId) {
    void completePendingSwitch(dataManager, sidebarProvider, logger, pendingId);
  }
}

async function completePendingSwitch(
  dataManager: DataManager,
  provider: QuoteSidebarProvider,
  log: QuoteLogger,
  pendingId: string,
): Promise<void> {
  // 无补丁方案：等待 Windsurf 完全加载（最多 15 秒）
  await new Promise<void>((r) => setTimeout(r, 5000));

  log.info("Resuming pending switch after reload.", { pendingId });
  const result = await dataManager.windsurfAccounts.switchTo(pendingId);

  // 清除 pending 标记
  await dataManager.windsurfAccounts.clearPendingSwitchId();

  if (result.success) {
    const account = dataManager.windsurfAccounts.getById(pendingId);
    const msg = `已切换到 ${account?.email ?? pendingId}`;
    provider.postBootstrap();
    vscode.window.setStatusBarMessage(`$(check) ${msg}`, 5000);
    void vscode.window.showInformationMessage(msg);
    log.info("Pending switch completed.", { pendingId });
  } else {
    log.warn("Pending switch failed.", { error: result.error });
    vscode.window.showErrorMessage(`切换失败: ${result.error ?? "未知错误"}`);
  }
}

export async function deactivate(): Promise<void> {
  // Clean up this window's MCP config entry and workspace rules.
  try {
    const context = extensionContext;
    const ide = detectCurrentIde();
    const ownedNames = context ? getOwnedMcpNames(context) : [];
    const namesToClean = new Set<string>(ownedNames);
    if (activeToolName) {
      namesToClean.add(activeToolName);
    }
    if (namesToClean.size > 0) {
      await removeMcpConfigEntries(ide, [...namesToClean]);
    }
    // Remove workspace rules only if they reference OUR toolName (not another window's)
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (wsFolder && activeToolName) {
      for (const rulesFile of ['.windsurfrules', 'AI_FEEDBACK_RULES.md']) {
        const rulesPath = path.join(wsFolder.uri.fsPath, rulesFile);
        const content = await fs.readFile(rulesPath, 'utf8').catch(() => '');
        if (content.includes(activeToolName)) {
          await fs.unlink(rulesPath).catch(() => {});
        }
      }
    }
    logger?.info('Deactivate cleanup done.', {
      activeToolName,
      secondaryInstance,
      ownedMcpNames: [...namesToClean],
    });
  } catch (err) {
    logger?.warn('Deactivate cleanup failed (non-fatal).', { error: String(err) });
  }
  extensionContext = undefined;
  dataManager?.endSession();
  dataManager?.dispose();
  DataManager.resetInstance();
  await bridge?.stop();
  logger?.dispose();
}
