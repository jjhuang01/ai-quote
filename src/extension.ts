import * as vscode from "vscode";
import { QuoteBridge } from "./core/bridge";
import type { DialogCallback } from "./core/bridge";
import { getExtensionConfig } from "./core/config";
import { QuoteLogger } from "./core/logger";
import { DataManager } from "./core/data-manager";
import { detectCurrentIde, writeMcpConfig, removeMcpConfigEntry } from "./adapters/mcp-config";
import { QuoteSidebarProvider } from "./webview/provider";
import { QuoteDialogPanel } from "./webview/dialog-panel";
import { loadOrCreateToolName, rotateToolName } from "./utils/tool-name";
import { configureGlobalRules } from "./adapters/rules";
import { WindsurfPatchService } from "./adapters/windsurf-patch";

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

  // ── 提前应用 Windsurf 补丁，避免切号时才触发重启 ────────────────────
  void ensurePatchApplied(logger);

  // ── 备用渠道：如果有 pending 切换则完成（兼容旧逻辑） ───────────────
  const pendingId = dataManager.windsurfAccounts.getPendingSwitchId();
  if (pendingId) {
    void completePendingSwitch(dataManager, sidebarProvider, logger, pendingId);
  }
}

async function ensurePatchApplied(log: QuoteLogger): Promise<void> {
  try {
    const result = await WindsurfPatchService.checkAndApply(log);
    if (result.needsRestart) {
      log.info('Windsurf patch applied at activation, reloading window.');
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '切号功能初始化（仅首次），即将刷新...' },
        () => new Promise<void>(r => setTimeout(r, 1500))
      );
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, 1800);
    }
  } catch (err) {
    log.warn('Patch check at activation failed (non-fatal).', { error: String(err) });
  }
}

async function waitForPatchedCommand(maxWaitMs = 30_000): Promise<boolean> {
  const PATCHED_CMD = "windsurf.provideAuthTokenToAuthProviderWithShit";
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes(PATCHED_CMD)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function completePendingSwitch(
  dataManager: DataManager,
  provider: QuoteSidebarProvider,
  log: QuoteLogger,
  pendingId: string,
): Promise<void> {
  // 等待补丁命令注册就绪（最多 30 秒，每 2 秒检查一次）
  const ready = await waitForPatchedCommand(30_000);
  if (!ready) {
    await dataManager.windsurfAccounts.clearPendingSwitchId();
    vscode.window.showErrorMessage(
      "切换失败：Windsurf 补丁命令未加载，请手动重启后再次点击切换。",
    );
    log.warn(
      "Pending switch aborted: patched command not found after 30s wait.",
    );
    return;
  }

  log.info("Resuming pending switch after reload.", { pendingId });
  const result = await dataManager.windsurfAccounts.switchTo(pendingId);

  if (!result.success && result.needsRestart) {
    // 理论上不会再次触发 needsRestart（补丁刚写入），保底清除避免死循环
    await dataManager.windsurfAccounts.clearPendingSwitchId();
    vscode.window.showErrorMessage(
      "切换失败：补丁未生效，请手动重启 Windsurf 后再次点击切换。",
    );
    return;
  }

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
      // Remove session-scoped rules files (best-effort)
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const rulesDir = path.join(os.homedir(), '.codeium', 'windsurf', 'rules');
      await fs.unlink(path.join(rulesDir, `${activeToolName}.mdc`)).catch(() => {});
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (wsFolder) {
        // Only clean workspace rules if they reference our session tool
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
