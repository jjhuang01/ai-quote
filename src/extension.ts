import * as vscode from "vscode";
import { QuoteBridge } from "./core/bridge";
import type { DialogCallback } from "./core/bridge";
import { getExtensionConfig } from "./core/config";
import { QuoteLogger } from "./core/logger";
import { DataManager } from "./core/data-manager";
import { detectCurrentIde, writeMcpConfig, removeMcpConfigEntry, ensureMcpConfigEntry } from "./adapters/mcp-config";
import { QuoteSidebarProvider } from "./webview/provider";
import { QuoteDialogPanel } from "./webview/dialog-panel";
import { loadOrCreateToolName, rotateToolName } from "./utils/tool-name";
import { configureGlobalRules } from "./adapters/rules";
// windsurf-patch 仅供 provider.ts 调试面板查询状态，此文件不再需要

let statusBarItem: vscode.StatusBarItem | undefined;
let logger: QuoteLogger | undefined;
let bridge: QuoteBridge | undefined;
let dataManager: DataManager | undefined;
let activeToolName: string | undefined;
let secondaryInstance = false;

async function updateStatusBar(): Promise<void> {
  if (!statusBarItem || !bridge) {
    return;
  }
  const status = bridge.getStatus();
  const waitingIcon = status.pendingDialog ? '$(pause-circle) ' : '';
  const onlineText = status.running ? `端口 ${status.port}` : '离线';
  statusBarItem.text = `${waitingIcon}$(comment) Quote (${onlineText})`;
  const toolTipMd = new vscode.MarkdownString(
    `**Quote 已激活 (${onlineText})**  \n` +
    `工具名: \`${status.toolName}\`  \n` +
    `IDE: ${status.currentIde}  \n` +
    `SSE 客户端: ${status.sseClientCount}` +
    (status.pendingDialog ? '  \n⏸ **LLM 等待响应...**' : '')
  );
  toolTipMd.isTrusted = true;
  statusBarItem.tooltip = toolTipMd;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  logger = new QuoteLogger(context);
  const config = getExtensionConfig();
  const currentIde = detectCurrentIde();
  let toolName = await loadOrCreateToolName(context.globalStorageUri.fsPath);

  dataManager = DataManager.getInstance(context, logger);
  await dataManager.initialize();

  bridge = new QuoteBridge(
    logger,
    config.serverPort,
    toolName,
    currentIde.name,
    config.dialogTimeoutSeconds > 0 ? config.dialogTimeoutSeconds * 1000 : 0,
  );
  const runningPort = await bridge.start();

  // Multi-window isolation: if port fell back, another instance owns the primary toolName.
  // Generate a session-scoped toolName so both windows have independent MCP entries.
  secondaryInstance = runningPort !== config.serverPort;
  if (secondaryInstance) {
    const { generateToolName } = await import('./utils/tool-name');
    toolName = generateToolName();
    bridge.updateToolName(toolName);
    logger.info('Secondary instance detected — using session-scoped toolName.', {
      primaryPort: config.serverPort, runningPort, toolName
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
  if (config.autoConfigureRules && vscode.workspace.isTrusted) {
    const sseUrl = `http://127.0.0.1:${runningPort}/sse`;
    const configuredPaths: string[] = [];
    try {
      const mcpPath = await writeMcpConfig(currentIde, toolName, sseUrl);
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

    // Periodic MCP config guard: re-write our entry if Windsurf settings UI overwrites it.
    // Checks every 30s — lightweight (single file read + optional write).
    const guardLogger = logger;
    const mcpGuardInterval = setInterval(async () => {
      try {
        const ok = await ensureMcpConfigEntry(currentIde, toolName, sseUrl);
        if (!ok) {
          guardLogger.warn('MCP config entry missing — re-written.');
        }
      } catch { /* ignore */ }
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
      QuoteDialogPanel.show(context.extensionUri, req, (sessionId, response, images) => {
        bridge?.resolvePendingDialog(sessionId, response, images);
        void updateStatusBar();
        sidebarProvider.postState();
      }, {
        enterToSend: settings.enterToSend,
        queueCount: sidebarProvider.getQueueCount(),
        queueItems: sidebarProvider.getQueueItems(),
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
      if (!bridge) return;
      const newName = await rotateToolName(context.globalStorageUri.fsPath);
      bridge.updateToolName(newName);
      // Re-write MCP config and rules so AI uses the new tool name
      const sseUrl = `http://127.0.0.1:${bridge.getPort()}/sse`;
      try {
        await writeMcpConfig(detectCurrentIde(), newName, sseUrl);
        await configureGlobalRules(newName);
        logger?.info('MCP config + rules re-written after rotation.', { newName });
      } catch (err) {
        logger?.warn('Re-write after rotation partially failed.', { error: String(err) });
      }
      // 清理旧 .mdc 规则文件（保留新名称，删除旧的 Quote 生成文件）
      try {
        const { cleanupStaleRules } = await import('./adapters/rules');
        const removed = await cleanupStaleRules(newName);
        if (removed.length > 0) {
          logger?.info('Stale rule files cleaned up after rotation.', { removed });
        }
      } catch (err) {
        logger?.warn('cleanupStaleRules after rotation failed (non-fatal).', { error: String(err) });
      }
      await updateStatusBar();
      sidebarProvider.postBootstrap();
      void vscode.window.showInformationMessage(`工具名已旋转为: ${newName}`);
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

  // 每次激活时自动显示侧边栏，确保 SSE 状态实时推送
  void vscode.commands.executeCommand(
    "workbench.view.extension.quote-sidebar",
  );

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
    if (switched) {
      sidebarProvider.postBootstrap();
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
      if (switched) {
        sidebarProvider.postBootstrap();
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
  // Clean up session-scoped MCP entry and rules for secondary instances
  if (secondaryInstance && activeToolName) {
    try {
      const ide = detectCurrentIde();
      await removeMcpConfigEntry(ide, activeToolName);
      // Remove session-scoped workspace rules if they reference our session tool
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (wsFolder) {
        const wsRules = path.join(wsFolder.uri.fsPath, '.windsurfrules');
        const content = await fs.readFile(wsRules, 'utf8').catch(() => '');
        if (content.includes(activeToolName)) {
          await fs.unlink(wsRules).catch(() => {});
        }
      }
      logger?.info('Secondary instance cleanup done.', { activeToolName });
    } catch (err) {
      logger?.warn('Secondary instance cleanup failed (non-fatal).', { error: String(err) });
    }
  }
  dataManager?.endSession();
  DataManager.resetInstance();
  await bridge?.stop();
  logger?.dispose();
}
